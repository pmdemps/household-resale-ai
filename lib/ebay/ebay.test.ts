import { test } from "node:test";
import assert from "node:assert/strict";
import { EBAY_FALLBACK_CATEGORY_ID, EBAY_USER_SCOPES, ebayListingUrl, isEbayConfigured, missingEbayEnv, readEbayConfig } from "./config.ts";
import { basicAuthHeader, buildAuthorizeUrl, buildCodeExchangeBody, buildRefreshBody, expiryIso, signState, tokenEndpoint, verifyState } from "./oauth.ts";
import { buildInventoryItemBody, buildLocationBody, buildOfferBody, ebayTitle, mapCondition, merchantLocationKey, offerUpdateBody, toApiError } from "./api.ts";
import { buildGetBestOffersXml, buildRespondToBestOfferXml, parseAck, parseGetBestOffers, parseRespondToBestOffer, tagText, tradingHeaders } from "./trading.ts";
import { challengeBody, challengeResponse, isValidVerificationToken, parseAccountDeletionNotification } from "./account-deletion.ts";

const KEY = Buffer.alloc(32, 5).toString("base64");

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
test("eBay is not configured when env is empty, and names what is missing", () => {
  const env = {} as NodeJS.ProcessEnv;
  assert.equal(isEbayConfigured(env), false);
  assert.deepEqual(missingEbayEnv(env), ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RU_NAME", "TOKEN_ENCRYPTION_KEY"]);
  const cfg = readEbayConfig(env);
  assert.equal(cfg.env, "sandbox");
  assert.equal(cfg.hosts.api, "https://api.sandbox.ebay.com");
  assert.equal(cfg.appUrl, "http://localhost:3000");
  assert.equal(cfg.defaultCategoryId, EBAY_FALLBACK_CATEGORY_ID);
});

test("eBay config reads production hosts and APP_URL", () => {
  const env = { EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "sec", EBAY_RU_NAME: "Me-App-PRD-abc", EBAY_ENV: "production", TOKEN_ENCRYPTION_KEY: KEY, APP_URL: "https://household-resale-ai.vercel.app/" } as unknown as NodeJS.ProcessEnv;
  assert.equal(isEbayConfigured(env), true);
  const cfg = readEbayConfig(env);
  assert.equal(cfg.env, "production");
  assert.equal(cfg.hosts.auth, "https://auth.ebay.com");
  assert.equal(cfg.appUrl, "https://household-resale-ai.vercel.app");
  assert.equal(ebayListingUrl("1234", "production"), "https://www.ebay.com/itm/1234");
  assert.equal(ebayListingUrl("1234", "sandbox"), "https://sandbox.ebay.com/itm/1234");
});

// ---------------------------------------------------------------------------
// oauth
// ---------------------------------------------------------------------------
test("authorize URL carries client id, RuName as redirect_uri, scopes and state", () => {
  const url = new URL(buildAuthorizeUrl({ env: "sandbox", clientId: "MyApp-123", ruName: "Me-MyApp-SBX-xyz", state: "abc.def" }));
  assert.equal(url.origin + url.pathname, "https://auth.sandbox.ebay.com/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), "MyApp-123");
  assert.equal(url.searchParams.get("redirect_uri"), "Me-MyApp-SBX-xyz");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "abc.def");
  assert.equal(url.searchParams.get("prompt"), "login");
  const scopes = url.searchParams.get("scope")!.split(" ");
  assert.deepEqual(scopes, [...EBAY_USER_SCOPES]);
  assert.ok(scopes.includes("https://api.ebay.com/oauth/api_scope/sell.inventory"));
  assert.ok(scopes.includes("https://api.ebay.com/oauth/api_scope/sell.account"));
});

test("state round-trips, rejects tampering, other keys and stale timestamps", () => {
  const state = signState({ h: "house-1", u: "user-1", n: "nonce" }, KEY);
  const back = verifyState(state, KEY);
  assert.ok(back);
  assert.equal(back!.h, "house-1");
  assert.equal(back!.u, "user-1");
  assert.equal(back!.n, "nonce");
  assert.equal(verifyState(state, Buffer.alloc(32, 6).toString("base64")), null, "different key");
  const [body, sig] = state.split(".");
  const other = Buffer.from(JSON.stringify({ h: "house-2", u: "user-1", n: "nonce", t: Date.now() })).toString("base64url");
  assert.equal(verifyState(`${other}.${sig}`, KEY), null, "swapped payload");
  assert.equal(verifyState(`${body}.${sig}x`, KEY), null, "bad signature");
  assert.equal(verifyState(state, KEY, 15 * 60 * 1000, Date.now() + 16 * 60 * 1000), null, "expired");
  assert.equal(verifyState(null, KEY), null);
  assert.equal(verifyState("garbage", KEY), null);
});

test("token exchange / refresh bodies and headers follow eBay's form", () => {
  assert.equal(tokenEndpoint("production"), "https://api.ebay.com/identity/v1/oauth2/token");
  assert.equal(basicAuthHeader("id", "secret"), `Basic ${Buffer.from("id:secret").toString("base64")}`);
  const body = buildCodeExchangeBody("v%5E1.1%23i%5E1", "Me-App-SBX-x");
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "v^1.1#i^1", "code is decoded once before re-encoding");
  assert.equal(body.get("redirect_uri"), "Me-App-SBX-x");
  const r = buildRefreshBody("rt", ["a", "b"]);
  assert.equal(r.get("grant_type"), "refresh_token");
  assert.equal(r.get("scope"), "a b");
  const iso = expiryIso(7200, Date.UTC(2026, 9, 30, 0, 0, 0));
  assert.equal(iso, "2026-10-30T01:59:00.000Z");
});

// ---------------------------------------------------------------------------
// inventory builders
// ---------------------------------------------------------------------------
test("condition mapping covers every CONDITIONS value", () => {
  assert.equal(mapCondition("New with tags").condition, "NEW");
  assert.equal(mapCondition("New without tags").condition, "NEW_OTHER");
  assert.equal(mapCondition("Like new").condition, "USED_EXCELLENT");
  assert.equal(mapCondition("Good").condition, "USED_EXCELLENT");
  assert.equal(mapCondition("Fair").condition, "USED_EXCELLENT");
  assert.equal(mapCondition("For parts").condition, "FOR_PARTS_OR_NOT_WORKING");
  assert.equal(mapCondition(null).condition, "USED_EXCELLENT");
  assert.equal(mapCondition("New with tags").conditionDescription, undefined);
});

test("title stays within 80 characters and adds brand/size when not already present", () => {
  assert.equal(ebayTitle({ name: "Kids sneakers", brand: "Nike", size: "10" }), "Nike Kids sneakers Size 10");
  assert.equal(ebayTitle({ name: "Nike Air kids sneakers size 10", brand: "Nike", size: "10" }), "Nike Air kids sneakers size 10");
  const long = ebayTitle({ name: "A ".repeat(30) + "very long product name that keeps going and going beyond the limit", brand: "BrandName", size: "XL" });
  assert.ok(long.length <= 80, `got ${long.length}`);
  assert.ok(!long.endsWith(" "));
});

test("inventory item body: quantity 1, mapped condition, https images only, aspects, weight", () => {
  const body = buildInventoryItemBody(
    { id: "item-1", name: "Kids sneakers", brand: "Nike", size: "10", condition: "Good", category: "Shoes", weight_oz: 12.5 },
    ["https://cdn.example.com/a.jpg", "http://insecure.example.com/b.jpg"],
  ) as Record<string, unknown>;
  assert.deepEqual(body.availability, { shipToLocationAvailability: { quantity: 1 } });
  assert.equal(body.condition, "USED_EXCELLENT");
  assert.match(String(body.conditionDescription), /Good pre-owned/);
  const product = body.product as Record<string, unknown>;
  assert.equal(product.title, "Nike Kids sneakers Size 10");
  assert.deepEqual(product.imageUrls, ["https://cdn.example.com/a.jpg"]);
  assert.deepEqual(product.aspects, { Brand: ["Nike"], Size: ["10"] });
  assert.ok(!String(product.description).includes("garage"), "private notes never go in the description");
  assert.deepEqual(body.packageWeightAndSize, { weight: { value: 12.5, unit: "OUNCE" } });
  assert.throws(() => buildInventoryItemBody({ id: "x", name: "n", brand: null, size: null, condition: null, category: "Other", weight_oz: null }, []), /at least one photo/);
});

test("offer body: EBAY_US fixed price GTC with Best Offer auto-decline at the floor", () => {
  const body = buildOfferBody({
    sku: "item-1",
    categoryId: "88433",
    price: 19.99,
    floorPrice: 12,
    merchantLocationKey: "rhq-abc",
    policies: { fulfillmentPolicyId: "f1", paymentPolicyId: "p1", returnPolicyId: "r1" },
    description: "<p>desc</p>",
  });
  assert.equal(body.marketplaceId, "EBAY_US");
  assert.equal(body.format, "FIXED_PRICE");
  assert.equal(body.listingDuration, "GTC");
  assert.equal(body.availableQuantity, 1);
  assert.equal(body.categoryId, "88433");
  assert.equal(body.merchantLocationKey, "rhq-abc");
  assert.deepEqual(body.pricingSummary, { price: { value: "19.99", currency: "USD" } });
  assert.deepEqual(body.listingPolicies, {
    fulfillmentPolicyId: "f1",
    paymentPolicyId: "p1",
    returnPolicyId: "r1",
    bestOfferTerms: { bestOfferEnabled: true, autoDeclinePrice: { value: "12.00", currency: "USD" } },
  });
  const noFloor = buildOfferBody({ sku: "s", categoryId: "1", price: 5, floorPrice: null, merchantLocationKey: "k", policies: { fulfillmentPolicyId: null, paymentPolicyId: null, returnPolicyId: null } });
  assert.deepEqual(noFloor.listingPolicies, { bestOfferTerms: { bestOfferEnabled: true } });
  assert.throws(() => buildOfferBody({ sku: "s", categoryId: "1", price: 5, floorPrice: 6, merchantLocationKey: "k", policies: noFloor.listingPolicies as never }), /Floor price cannot be above/);
});

test("location key and body", () => {
  const key = merchantLocationKey("3f2a9b7c-1d2e-4f5a-8b9c-0d1e2f3a4b5c", "21401-1234");
  assert.ok(key.length <= 36, key);
  assert.equal(key, "rhq-3f2a9b7c1d2e4f5a8b9c-214011234");
  assert.deepEqual(buildLocationBody({ city: "Annapolis", stateOrProvince: "MD", postalCode: "21401" }).location, { address: { city: "Annapolis", stateOrProvince: "MD", postalCode: "21401", country: "US" } });
});

test("offer update keeps only writable fields and applies the patch", () => {
  const existing = { offerId: "o1", sku: "s", status: "PUBLISHED", listing: { listingId: "1" }, categoryId: "88433", pricingSummary: { price: { value: "9.99", currency: "USD" } }, listingPolicies: { paymentPolicyId: "p" } };
  const body = offerUpdateBody(existing, { pricingSummary: { price: { value: "8.99", currency: "USD" } } });
  assert.deepEqual(body, { categoryId: "88433", pricingSummary: { price: { value: "8.99", currency: "USD" } }, listingPolicies: { paymentPolicyId: "p" } });
});

test("eBay REST errors are summarized", () => {
  const e = toApiError(400, JSON.stringify({ errors: [{ errorId: 25002, message: "A user error has occurred.", longMessage: "Invalid value for header Content-Language." }] }));
  assert.equal(e.status, 400);
  assert.equal(e.errors[0].errorId, 25002);
  assert.match(e.message, /Content-Language/);
});

// ---------------------------------------------------------------------------
// trading XML
// ---------------------------------------------------------------------------
test("GetBestOffers and RespondToBestOffer requests", () => {
  const get = buildGetBestOffersXml({ itemId: "110000001", status: "Active" });
  assert.ok(get.startsWith('<?xml version="1.0" encoding="utf-8"?><GetBestOffersRequest xmlns="urn:ebay:apis:eBLBaseComponents">'));
  assert.ok(get.includes("<ItemID>110000001</ItemID>"));
  assert.ok(get.includes("<BestOfferStatus>Active</BestOfferStatus>"));
  assert.ok(get.includes("<DetailLevel>ReturnAll</DetailLevel>"));

  const counter = buildRespondToBestOfferXml({ itemId: "110000001", bestOfferId: "BO-9", action: "Counter", counterOfferPrice: 12, sellerResponse: "Thanks! <3 & best" });
  assert.ok(counter.includes("<Action>Counter</Action>"));
  assert.ok(counter.includes('<CounterOfferPrice currencyID="USD">12.00</CounterOfferPrice>'));
  assert.ok(counter.includes("<CounterOfferQuantity>1</CounterOfferQuantity>"));
  assert.ok(counter.includes("<SellerResponse>Thanks! &lt;3 &amp; best</SellerResponse>"));
  const decline = buildRespondToBestOfferXml({ itemId: "1", bestOfferId: "2", action: "Decline" });
  assert.ok(!decline.includes("CounterOfferPrice"));
  assert.throws(() => buildRespondToBestOfferXml({ itemId: "1", bestOfferId: "2", action: "Counter" }), /needs a price/);

  const h = tradingHeaders("GetBestOffers", "tok");
  assert.equal(h["X-EBAY-API-CALL-NAME"], "GetBestOffers");
  assert.equal(h["X-EBAY-API-SITEID"], "0");
  assert.equal(h["X-EBAY-API-IAF-TOKEN"], "tok");
  assert.equal(h["Content-Type"], "text/xml");
  assert.ok(h["X-EBAY-API-COMPATIBILITY-LEVEL"]);
});

const SAMPLE_GET_BEST_OFFERS = `<?xml version="1.0" encoding="UTF-8"?>
<GetBestOffersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Timestamp>2026-10-30T02:00:00.000Z</Timestamp>
  <Ack>Success</Ack>
  <Version>1423</Version>
  <Build>E1423_CORE_API_1234</Build>
  <ItemBestOffersArray>
    <ItemBestOffers>
      <BestOfferArray>
        <BestOffer>
          <BestOfferID>5001</BestOfferID>
          <ExpirationTime>2026-11-01T02:00:00.000Z</ExpirationTime>
          <Buyer>
            <Email>Invalid Request</Email>
            <FeedbackScore>12</FeedbackScore>
            <UserID>testuser_buyer</UserID>
          </Buyer>
          <Price currencyID="USD">12.5</Price>
          <Status>Active</Status>
          <Quantity>1</Quantity>
          <BuyerMessage>Would you take $12.50? &amp; thanks</BuyerMessage>
          <BestOfferCodeType>BuyerBestOffer</BestOfferCodeType>
        </BestOffer>
        <BestOffer>
          <BestOfferID>5002</BestOfferID>
          <ExpirationTime>2026-10-29T02:00:00.000Z</ExpirationTime>
          <Buyer><UserID>other_buyer</UserID></Buyer>
          <Price currencyID="USD">9</Price>
          <Status>Expired</Status>
          <Quantity>1</Quantity>
          <BestOfferCodeType>BuyerBestOffer</BestOfferCodeType>
        </BestOffer>
      </BestOfferArray>
      <Item>
        <ItemID>110000001</ItemID>
        <ListingDetails><EndTime>2026-12-01T00:00:00.000Z</EndTime></ListingDetails>
        <Title>Nike Kids sneakers Size 10</Title>
        <SellingStatus><CurrentPrice currencyID="USD">19.99</CurrentPrice></SellingStatus>
      </Item>
      <Role>Seller</Role>
    </ItemBestOffers>
  </ItemBestOffersArray>
  <PageNumber>1</PageNumber>
</GetBestOffersResponse>`;

test("parses a GetBestOffers response", () => {
  const { ack, offers } = parseGetBestOffers(SAMPLE_GET_BEST_OFFERS);
  assert.equal(ack.ok, true);
  assert.equal(ack.ack, "Success");
  assert.equal(offers.length, 2);
  const [a, b] = offers;
  assert.equal(a.bestOfferId, "5001");
  assert.equal(a.itemId, "110000001");
  assert.equal(a.buyerUserId, "testuser_buyer");
  assert.equal(a.price, 12.5);
  assert.equal(a.currency, "USD");
  assert.equal(a.status, "Active");
  assert.equal(a.quantity, 1);
  assert.equal(a.expirationTime, "2026-11-01T02:00:00.000Z");
  assert.equal(a.buyerMessage, "Would you take $12.50? & thanks");
  assert.equal(a.codeType, "BuyerBestOffer");
  assert.equal(a.itemEndTime, "2026-12-01T00:00:00.000Z");
  assert.equal(b.bestOfferId, "5002");
  assert.equal(b.status, "Expired");
  assert.equal(b.buyerMessage, null);
});

test("parses failures and RespondToBestOffer acks", () => {
  const fail = `<GetBestOffersResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Timestamp>t</Timestamp><Ack>Failure</Ack>
    <Errors><ShortMessage>Invalid item.</ShortMessage><LongMessage>The item ID is invalid.</LongMessage><ErrorCode>37</ErrorCode><SeverityCode>Error</SeverityCode></Errors></GetBestOffersResponse>`;
  const ack = parseAck(fail);
  assert.equal(ack.ok, false);
  assert.equal(ack.errors[0].code, "37");
  assert.equal(ack.errors[0].longMessage, "The item ID is invalid.");
  assert.deepEqual(parseGetBestOffers(fail).offers, []);
  const ok = `<RespondToBestOfferResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><RespondToBestOffer><BestOffer><BestOfferID>5001</BestOfferID><CallStatus>Success</CallStatus></BestOffer></RespondToBestOffer></RespondToBestOfferResponse>`;
  const r = parseRespondToBestOffer(ok);
  assert.equal(r.ack.ok, true);
  assert.equal(r.callStatus, "Success");
  assert.equal(tagText("<a><b>x</b></a>", "c"), null);
  assert.equal(tagText("<a><![CDATA[<raw>]]></a>", "a"), "<raw>");
});

// ---------------------------------------------------------------------------
// account deletion
// ---------------------------------------------------------------------------
test("challenge response = sha256(challengeCode + verificationToken + endpoint) as hex", () => {
  const code = "71745723-d031-455c-bfa5-f90d11b4f20a";
  const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
  const endpoint = "https://household-resale-ai.vercel.app/api/ebay/account-deletion";
  assert.equal(challengeResponse(code, token, endpoint), "a68ac754135c844c6c0d8c9d3a41a4c560309128ecbdc33c5f7eeb7ff7e98e28");
  assert.notEqual(challengeResponse(token, code, endpoint), challengeResponse(code, token, endpoint), "order matters");
  assert.deepEqual(Object.keys(challengeBody(code, token, endpoint)), ["challengeResponse"]);
  assert.equal(isValidVerificationToken(token), true);
  assert.equal(isValidVerificationToken("short"), false);
  assert.equal(isValidVerificationToken("has spaces ".padEnd(40, "x")), false);
});

test("account deletion notification shape check", () => {
  const good = parseAccountDeletionNotification({
    metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION", schemaVersion: "1.0", deprecated: false },
    notification: { notificationId: "n1", eventDate: "2026-10-30T00:00:00.000Z", publishDate: "2026-10-30T00:00:01.000Z", publishAttemptCount: 1, data: { username: "testuser_a", userId: "ma8vp1jySJC", eiasToken: "nY+sHZ2PrBmdj6wVnY+sEZ2PrA2dj6wFk4GhCpiHpQqdj6x9nY+seQ==" } },
  });
  assert.ok(good);
  assert.equal(good!.notification.data.userId, "ma8vp1jySJC");
  assert.equal(parseAccountDeletionNotification({ metadata: { topic: "OFFER_ACTIVITY" }, notification: { data: { userId: "x" } } }), null);
  assert.equal(parseAccountDeletionNotification({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { data: {} } }), null);
  assert.equal(parseAccountDeletionNotification("nope"), null);
});

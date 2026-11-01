import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assistantKeyFromHeaders, generateAssistantKey, hashAssistantKey, looksLikeAssistantKey } from "./keys.ts";
import {
  BadRequest,
  decisionSay,
  enrichOffers,
  handoffSay,
  mapDbError,
  normalizeDecision,
  offerMoney,
  parseAction,
  recordOfferSay,
  saleSay,
  summarizeInbox,
  type DecisionResult,
  type HandoffResult,
  type Inbox,
  type InboxOffer,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------
test("assistant keys are prefixed, URL-safe, hashed with plain sha256 and show a stable prefix", () => {
  const k = generateAssistantKey(Buffer.alloc(32, 7));
  assert.ok(k.token.startsWith("rhq_"));
  assert.equal(k.token.length, 4 + 43, "32 bytes of base64url without padding");
  assert.match(k.token, /^[A-Za-z0-9_-]+$/);
  assert.equal(k.hash, createHash("sha256").update(k.token, "utf8").digest("hex"), "same hash the database computes with sha256_hex");
  assert.equal(hashAssistantKey(k.token), k.hash);
  assert.equal(k.prefix, k.token.slice(0, 12));
  assert.notEqual(generateAssistantKey().token, generateAssistantKey().token, "random by default");
});

test("key shape check and header extraction", () => {
  const k = generateAssistantKey().token;
  assert.equal(looksLikeAssistantKey(k), true);
  assert.equal(looksLikeAssistantKey("short"), false);
  assert.equal(looksLikeAssistantKey("rhq_has spaces and is long enough to pass length"), false);
  assert.equal(looksLikeAssistantKey(null), false);
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
  assert.equal(assistantKeyFromHeaders(headers({ authorization: `Bearer ${k}` })), k);
  assert.equal(assistantKeyFromHeaders(headers({ authorization: `bearer   ${k}  ` })), k, "case-insensitive scheme, trimmed");
  assert.equal(assistantKeyFromHeaders(headers({ "x-assistant-key": k })), k);
  assert.equal(assistantKeyFromHeaders(headers({ authorization: "Basic abc" })), null);
  assert.equal(assistantKeyFromHeaders(headers({})), null);
});

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------
test("decision words from a person map to the stored values", () => {
  for (const w of ["accept", "Accepted", "take it", "yes", "YEP", "deal", "ok"]) assert.equal(normalizeDecision(w), "accepted", w);
  for (const w of ["decline", "no", "pass", "reject", "fuck no", "nah"]) assert.equal(normalizeDecision(w), "declined", w);
  for (const w of ["counter", "countered", "counter at 35"]) assert.equal(normalizeDecision(w), "countered", w);
  assert.equal(normalizeDecision("maybe"), null);
  assert.equal(normalizeDecision(undefined), null);
});

const OFFER = "9b3f1b6a-5a6e-4f2a-9c1d-2e3f4a5b6c7d";
const LISTING = "1b3f1b6a-5a6e-4f2a-9c1d-2e3f4a5b6c7e";

test("parseAction validates each action and rejects junk with a usable sentence", () => {
  assert.deepEqual(parseAction({ action: "decide", offer_id: OFFER, decision: "take it" }), {
    action: "decide", offer_id: OFFER, decision: "accepted", counter_amount: null, shipping_cost: 0, override_floor: false,
  });
  assert.deepEqual(parseAction({ action: "decide", offer_id: OFFER.toUpperCase(), decision: "counter", counter_amount: "$35.50", override_floor: true }), {
    action: "decide", offer_id: OFFER, decision: "countered", counter_amount: 35.5, shipping_cost: 0, override_floor: true,
  });
  assert.throws(() => parseAction({ action: "decide", offer_id: OFFER, decision: "counter" }), (e: Error) => e instanceof BadRequest && /counter_amount/.test(e.message));
  assert.throws(() => parseAction({ action: "decide", offer_id: "nope", decision: "yes" }), /offer_id/);
  assert.throws(() => parseAction({ action: "decide", offer_id: OFFER, decision: "dunno" }), /decision must be/);
  assert.throws(() => parseAction({ action: "decide", offer_id: OFFER, decision: "yes", shipping_cost: -3 }), /shipping_cost/);

  assert.deepEqual(parseAction({ action: "record_offer", listing_id: LISTING, amount: "30", buyer: " buyer1 ", note: "From Gmail: New offer", source: "email" }), {
    action: "record_offer", listing_id: LISTING, amount: 30, buyer: "buyer1", note: "From Gmail: New offer", source: "email",
  });
  assert.throws(() => parseAction({ action: "record_offer", listing_id: LISTING, amount: 30, source: "carrier pigeon" }), /source/);
  assert.throws(() => parseAction({ action: "record_offer", listing_id: LISTING }), /amount/);

  assert.deepEqual(parseAction({ action: "record_sale", listing_id: LISTING, sale_price: 12.345 }), { action: "record_sale", listing_id: LISTING, sale_price: 12.35, shipping_cost: 0 });
  assert.deepEqual(parseAction({ action: "note", text: "  Box is in the garage " }), { action: "note", text: "Box is in the garage", item_id: null });
  assert.throws(() => parseAction({ action: "note", text: "   " }), /needs text/);
  assert.deepEqual(parseAction({ action: "resolve_task", task_id: OFFER }), { action: "resolve_task", task_id: OFFER, status: "done" });
  assert.throws(() => parseAction({ action: "resolve_task", task_id: OFFER, status: "maybe" }), /status must be/);
  assert.deepEqual(parseAction({ action: "propose_task", title: "Buyer asked about size", kind: "message_reply", listing_id: LISTING }), {
    action: "propose_task", kind: "message_reply", title: "Buyer asked about size", detail: null, item_id: null, listing_id: LISTING,
  });
  assert.throws(() => parseAction({ action: "propose_task", title: "x", kind: "delist" }), /kind must be/);
  assert.throws(() => parseAction({ action: "fly" }), /Unknown action/);
  assert.throws(() => parseAction("decide"), /JSON object/);
  assert.throws(() => parseAction(null), /JSON object/);
});

// ---------------------------------------------------------------------------
// money + sentences
// ---------------------------------------------------------------------------
const offer = (over: Partial<InboxOffer> = {}): InboxOffer => ({
  offer_id: OFFER,
  amount: 30,
  buyer: "buyer1",
  received_at: "2026-10-31T12:00:00Z",
  expires_at: null,
  source: "email",
  note: null,
  is_new: true,
  via_api: false,
  listing: { id: LISTING, platform: "vinted", list_price: 39.99, url: null },
  item: { id: "item", name: "Motorcycle helmet wall mount", floor_price: 25, purchase_cost: 4 },
  ...over,
});

test("offer money matches the app: Vinted costs the seller nothing, eBay takes its cut, floor is flagged", () => {
  const v = offerMoney(offer());
  assert.equal(v.payout, 30);
  assert.equal(v.profit, 26);
  assert.equal(v.pct_off, 25);
  assert.equal(v.below_floor, false);
  assert.equal(v.payout_at_asking, 39.99);
  const e = offerMoney(offer({ listing: { id: LISTING, platform: "ebay", list_price: 39.99, url: null } }));
  assert.ok(e.payout < 30 && e.fees > 0, "eBay fees come off");
  const low = offerMoney(offer({ amount: 20 }));
  assert.equal(low.below_floor, true);
  assert.equal(offerMoney(offer({ item: { id: "i", name: "x", floor_price: null, purchase_cost: 0 } })).below_floor, false, "no floor, no flag");
});

test("inbox summary reads naturally and distinguishes new from still-waiting", () => {
  const inbox: Inbox = {
    household: { id: "h", name: "Our house" }, member: { id: "u", name: "Patrick" }, assistant: "muse",
    checked_at: "2026-10-31T19:00:00Z", new_since: "2026-10-31T17:00:00Z", ebay_connected: false,
    pending_offers: [offer(), offer({ offer_id: "2b3f1b6a-5a6e-4f2a-9c1d-2e3f4a5b6c7f", amount: 20, is_new: false, buyer: null })],
    tasks: [{ task_id: "t1", kind: "other", title: "Confirm sale: Kids bike on Vinted for $9", detail: null, created_at: "", is_new: true, item_id: null, listing_id: null, requested_by: "gmail-watcher" }],
    listings: [],
  };
  const enriched = enrichOffers(inbox.pending_offers, false);
  assert.equal(enriched[0].auto_reply, false);
  const say = summarizeInbox(inbox, enriched);
  assert.match(say, /^2 offers waiting \(1 new\)\./);
  assert.match(say, /New: \$30\.00 for Motorcycle helmet wall mount on Vinted; asking \$39\.99, 25% off; you'd pocket \$30\.00 after fees; floor \$25\.00; from buyer1\./);
  assert.match(say, /Still waiting on you: \$20\.00 for Motorcycle helmet wall mount on Vinted; asking \$39\.99, 50% off; you'd pocket \$20\.00 after fees; BELOW the \$25\.00 floor\./);
  assert.match(say, /1 to-do \(1 new\): Confirm sale: Kids bike on Vinted for \$9\./);
  assert.equal(summarizeInbox({ ...inbox, pending_offers: [], tasks: [] }, []), "Nothing waiting: no open offers and no to-dos.");
  assert.equal(enrichOffers([offer({ via_api: true, listing: { id: LISTING, platform: "ebay", list_price: 39.99, url: null } })], true)[0].auto_reply, true, "eBay offers pulled through the API can be answered by the app when eBay is connected");
  assert.equal(enrichOffers([offer({ via_api: true, listing: { id: LISTING, platform: "ebay", list_price: 39.99, url: null } })], false)[0].auto_reply, false, "...but not when eBay is not connected");
});

const decision = (over: Partial<DecisionResult> = {}): DecisionResult => ({
  offer_id: OFFER, decision: "accepted", amount: 30, counter_amount: null, buyer: "buyer1", offer_external_id: null,
  item: { id: "item", name: "Motorcycle helmet wall mount", floor_price: 25 },
  listing: { id: LISTING, platform: "vinted", list_price: 39.99, external_id: null, url: null },
  sale: { sale_id: "s", item_id: "item", item_name: "Motorcycle helmet wall mount", listing_id: LISTING, platform: "vinted", listing_url: null, sale_price: 30, platform_fees: 0, shipping_cost: 0, payout: 30, delist_tasks: 1 },
  tasks_closed: 1,
  ...over,
});

test("decision sentences say what was recorded and what a human still has to do", () => {
  assert.equal(
    decisionSay(decision(), { ebayUpdated: false }),
    "Accepted $30.00 for Motorcycle helmet wall mount on Vinted. Recorded the sale: about $30.00 after fees. 1 other listing must come down now (to-do created). Recorded here only: the buyer has not been told yet. Someone in the household must accept the offer in the Vinted app.",
  );
  assert.equal(
    decisionSay(decision({ decision: "countered", counter_amount: 35, sale: null, listing: { id: LISTING, platform: "ebay", list_price: 39.99, external_id: "1", url: null } }), { ebayUpdated: true }),
    "Countered $30.00 at $35.00 for Motorcycle helmet wall mount on eBay. eBay has been updated; the buyer sees your answer there.",
  );
  assert.match(
    decisionSay(decision({ decision: "declined", sale: null, listing: { id: LISTING, platform: "ebay", list_price: 39.99, external_id: "1", url: null } }), { ebayUpdated: false, ebayError: "No active eBay connection for this household." }),
    /^Declined \$30\.00 .*\(eBay could not be updated: No active eBay connection for this household\)\. Someone in the household must decline the offer in the eBay app\.$/,
  );
  assert.equal(saleSay(decision().sale!), "Recorded the sale of Motorcycle helmet wall mount on Vinted for $30.00: about $30.00 after fees. 1 other listing must come down now (to-do created).");
  assert.match(recordOfferSay({ offer_id: OFFER, duplicate: false, amount: 30, item: { id: "i", name: "Helmet mount" }, listing: { id: LISTING, platform: "etsy", list_price: 39.99 } }), /Recorded a \$30\.00 offer on Helmet mount \(Etsy, asking \$39\.99\)/);
  assert.match(recordOfferSay({ offer_id: OFFER, duplicate: true, amount: 30, item: { id: "i", name: "Helmet mount" }, listing: { id: LISTING, platform: "etsy", list_price: 39.99 } }), /already recorded/);
});

test("database errors map to HTTP answers the assistant can act on", () => {
  assert.equal(mapDbError({ code: "28000", message: "Invalid assistant key" }).status, 401);
  assert.equal(mapDbError({ code: "P0002", message: "Offer not found" }).status, 404);
  assert.equal(mapDbError({ code: "P0003", message: "This offer has already been decided (declined)." }).code, "already_done");
  const floor = mapDbError({ code: "P0004", message: "Offer of 20 is below the floor price of 25" });
  assert.equal(floor.status, 409);
  assert.equal(floor.code, "below_floor");
  assert.match(floor.hint ?? "", /override_floor/);
  assert.equal(mapDbError({ code: "22023", message: "A counter needs an amount above zero" }).status, 400);
  assert.equal(mapDbError({ code: "42501", message: "permission denied for function assistant_inbox" }).code, "misconfigured");
  assert.equal(mapDbError({ code: "PGRST202", message: "Could not find the function public.assistant_inbox" }).code, "misconfigured", "migration not applied yet");
  assert.equal(mapDbError(null).status, 500);
});

test("hand_off needs an offer or an item; the name is optional", () => {
  assert.deepEqual(parseAction({ action: "hand_off", to: " Lauren ", offer_id: OFFER }), { action: "hand_off", to: "Lauren", offer_id: OFFER, item_id: null });
  assert.deepEqual(parseAction({ action: "hand_off", item_id: OFFER }), { action: "hand_off", to: null, offer_id: null, item_id: OFFER });
  assert.throws(() => parseAction({ action: "hand_off", to: "Lauren" }), (e: unknown) => e instanceof BadRequest && /offer_id .* or item_id/.test((e as Error).message));
  assert.throws(() => parseAction({ action: "hand_off", offer_id: "nope" }), BadRequest);
});

const handoff = (over: Partial<HandoffResult> = {}): HandoffResult => ({
  item: { id: "i", name: "Motorcycle helmet wall mount" },
  to: { id: "l", name: "Lauren" },
  from: { id: "p", name: "Patrick" },
  offer: { id: OFFER, amount: 30, platform: "ebay", platform_name: "eBay" },
  task_id: "t",
  devices: 1,
  ...over,
});

test("hand-off sentences say who was asked, whether their phone buzzed, and whose it is now", () => {
  assert.equal(handoffSay(handoff()),
    "Handed the $30.00 offer on Motorcycle helmet wall mount (eBay) to Lauren. Lauren's phone was notified and asked how badly they want to sell it. Motorcycle helmet wall mount is now marked as Lauren's; either of you can still answer the offer.");
  const quiet = handoffSay(handoff({ devices: 0, offer: null }));
  assert.match(quiet, /^Handed Motorcycle helmet wall mount to Lauren\. Lauren does not have phone notifications on/);
  assert.match(quiet, /now marked as Lauren's\.$/);
  const unnamed = handoffSay(handoff({ to: { id: "l", name: null } }), "lauren");
  assert.match(unnamed, /to lauren\./);
  assert.match(unnamed, /lauren has not set a name in Resale HQ yet/);
  assert.match(handoffSay(handoff({ to: { id: "l", name: null } })), /to The other household member\./);
});

test("offers say whose thing it is and who was asked", () => {
  const [mine, hers] = enrichOffers([
    offer({ item: { id: "i", name: "Kids bike", floor_price: null, purchase_cost: 0, owner: { id: "u", name: "Patrick", is_you: true } } }),
    offer({ item: { id: "j", name: "Boots", floor_price: null, purchase_cost: 0, owner: { id: "l", name: null, is_you: false } }, asked: { id: "l", name: "Lauren", at: "" } }),
  ], false);
  const inbox: Inbox = {
    household: null, member: null, assistant: "muse", checked_at: "", new_since: "", ebay_connected: false,
    pending_offers: [mine, hers], tasks: [], listings: [],
  };
  const say = summarizeInbox(inbox, [mine, hers]);
  assert.match(say, /\$30\.00 for Kids bike \(yours\) on Vinted/);
  assert.match(say, /\$30\.00 for Boots \(the other household member's\) on Vinted/);
  assert.match(say, /Lauren has been asked about it/);
});

// --- Platform switches and comps for the assistant ------------------------------------------------
import { buildItemDetail, itemDetailSay, normalizePlatformWord, setPlatformSay, type ItemDetailRow } from "./protocol.ts";

const ITEM = "11111111-2222-3333-4444-555555555555";

test("set_platform accepts everyday words for platforms and on/off", () => {
  assert.deepEqual(parseAction({ action: "set_platform", item_id: ITEM, platform: "Facebook Marketplace", on: "off" }), { action: "set_platform", item_id: ITEM, platform: "facebook", on: false });
  assert.equal((parseAction({ action: "set_platform", item_id: ITEM, platform: "posh", on: true }) as { platform: string }).platform, "poshmark");
  assert.equal(normalizePlatformWord("Offer Up"), "offerup");
  assert.equal(normalizePlatformWord("craigslist"), null);
  assert.throws(() => parseAction({ action: "set_platform", item_id: ITEM, platform: "craigslist", on: true }), BadRequest);
  assert.throws(() => parseAction({ action: "set_platform", item_id: ITEM, platform: "ebay", on: "maybe" }), BadRequest);
});

test("add_comp needs a title, a price and an https link", () => {
  const a = parseAction({ action: "add_comp", item_id: ITEM, title: "Nike Air Max 90 size 10", price: "$40", shipping: 0, url: "https://www.ebay.com/itm/1", platform: "eBay", kind: "sold" });
  assert.equal((a as { price: number }).price, 40);
  assert.equal((a as { platform: string }).platform, "ebay");
  assert.equal((a as { kind: string }).kind, "sold");
  assert.throws(() => parseAction({ action: "add_comp", item_id: ITEM, title: "x", price: 5, url: "http://insecure.example" }), BadRequest);
  assert.throws(() => parseAction({ action: "add_comp", item_id: ITEM, price: 5 }), BadRequest);
});

test("switch replies say what happens next, plainly", () => {
  const base = { item_id: ITEM, item: "Nike Air Max 90", platform: "poshmark", platform_name: "Poshmark", wanted: false, task_id: "t", task_title: "Pull it" };
  assert.match(setPlatformSay({ ...base, outcome: "todo_pull" }), /still up until someone ends it in the Poshmark app/);
  assert.match(setPlatformSay({ ...base, platform: "ebay", platform_name: "eBay", wanted: true, outcome: "todo_post" }), /Post to eBay/);
  assert.doesNotMatch(setPlatformSay({ ...base, outcome: "todo_pull" }), /fuck|shit/i);
});

test("item detail: switches, comps verdict with closest links, paste-ready text", () => {
  const row: ItemDetailRow = {
    item: { item_id: ITEM, name: "Air Max 90", status: "listed", category: "Shoes", brand: "Nike", size: "10", condition: "Good", asking: 200, floor_price: 30, purchase_cost: 0, owner: null },
    switches: { poshmark: false, mercari: true },
    listings: [{ listing_id: "L1", platform: "poshmark", status: "active", list_price: 200, url: null }],
    pending_platform_todos: [{ task_id: "T1", kind: "delist", platform: "poshmark", title: "Pull it off Poshmark" }],
    comps: [
      { platform: "ebay", title: "A", price: 38, shipping: 0, url: "https://www.ebay.com/itm/1", condition: null, kind: "active", source: "ebay", captured_at: "" },
      { platform: "ebay", title: "B", price: 42, shipping: 8, url: "https://www.ebay.com/itm/2", condition: null, kind: "active", source: "ebay", captured_at: "" },
      { platform: "mercari", title: "C", price: 45, shipping: null, url: "https://www.mercari.com/us/item/3", condition: null, kind: "sold", source: "manual", captured_at: "" },
      { platform: "other", title: "D", price: 300, shipping: null, url: null, condition: null, kind: "active", source: "manual", captured_at: "" },
    ],
    photo_paths: ["h/i/a.jpg"],
  };
  const d = buildItemDetail(row, p => `https://cdn.example/${p}`);
  const posh = d.platforms.find(p => p.platform === "poshmark")!;
  assert.equal(posh.on, false);
  assert.equal(posh.live, true);
  assert.equal(posh.todo, "Pull it off Poshmark");
  assert.equal(d.platforms.find(p => p.platform === "mercari")!.on, true);
  assert.equal(d.platforms.find(p => p.platform === "ebay")!.on, false);
  assert.equal(d.comps.lowest?.price, 38);
  assert.equal(d.comps.verdict, "above");
  assert.match(d.comps.sentence ?? "", /above the typical/);
  assert.equal(d.comps.links.length, 3, "only comps with links");
  assert.deepEqual(d.comps.links.map(l => l.price), [38, 42, 45]);
  assert.ok(d.listing_text.mercari && d.listing_text.offerup && !d.listing_text.thredup);
  assert.equal(d.photos[0], "https://cdn.example/h/i/a.jpg");
});

test("a saved draft is not live, and the reply says so", () => {
  const row: ItemDetailRow = {
    item: { item_id: ITEM, name: "Helmet mount", status: "draft", category: "Other", brand: null, size: null, condition: "New without tags", asking: 39.99, floor_price: 25, purchase_cost: 2, owner: null },
    switches: {},
    listings: [
      { listing_id: "E", platform: "ebay", status: "draft", list_price: 39.99, url: null },
      { listing_id: "T", platform: "etsy", status: "active", list_price: 39.99, url: "https://www.etsy.com/listing/1" },
    ],
    pending_platform_todos: [],
    comps: [],
    photo_paths: [],
  };
  const d = buildItemDetail(row, p => p);
  const ebay = d.platforms.find(p => p.platform === "ebay")!;
  assert.equal(ebay.on, true, "a draft row still counts as switched on");
  assert.equal(ebay.live, false);
  assert.equal(ebay.status, "draft");
  assert.equal(d.platforms.find(p => p.platform === "etsy")!.live, true);
  assert.match(itemDetailSay(d), /eBay \(draft, not posted yet\)/);
});

// --- Adding items and photos ---------------------------------------------------------------------
import { checkImageUrl, normalizeCategory, normalizeCondition, addItemSay, photoSay } from "./protocol.ts";

test("add_item reads everyday words", () => {
  const a = parseAction({ action: "add_item", name: "Carhartt work boots", category: "shoes", brand: "Carhartt", size: "10", condition: "used", price: "$40", floor: 25, cost: 0 }) as Record<string, unknown>;
  assert.equal(a.name, "Carhartt work boots");
  assert.equal(a.category, "Shoes");
  assert.equal(a.condition, "Good");
  assert.equal(a.asking, 40);
  assert.equal(a.floor, 25);
  assert.equal(normalizeCategory("toys"), "Toys & games");
  assert.equal(normalizeCategory("kitchen gadgets"), "Other");
  assert.equal(normalizeCondition("NWT"), "New with tags");
  assert.throws(() => parseAction({ action: "add_item" }), BadRequest);
  assert.throws(() => parseAction({ action: "add_item", name: "x", asking: 10, floor: 20 }), BadRequest);
});

test("add_photo only fetches public https links", () => {
  const a = parseAction({ action: "add_photo", item_id: ITEM, image_url: "https://files.muse.example/abc/photo.jpg?sig=1" }) as { image_url: string };
  assert.match(a.image_url, /^https:\/\/files\.muse\.example\//);
  for (const bad of ["http://example.com/a.jpg", "https://localhost/a.jpg", "https://127.0.0.1/a.jpg", "https://192.168.1.10/a.jpg",
    "https://10.0.0.5/a.jpg", "https://169.254.169.254/latest/meta-data", "https://[::1]/a.jpg", "https://user:pw@example.com/a.jpg", "ftp://x/a.jpg", "not a url"]) {
    assert.equal(checkImageUrl(bad).ok, false, bad);
  }
  assert.throws(() => parseAction({ action: "add_photo", item_id: ITEM }), BadRequest);
  assert.throws(() => parseAction({ action: "add_photo", item_id: "nope", image_url: "https://example.com/a.jpg" }), BadRequest);
});

test("item and photo replies are plain and clean", () => {
  assert.match(addItemSay({ item_id: ITEM, name: "Boots", duplicate: false }), /Added Boots/);
  assert.match(addItemSay({ item_id: ITEM, name: "Boots", duplicate: true }), /already added/);
  assert.match(photoSay({ photo_id: "p", item_id: ITEM, position: 0, photo_count: 1, storage_path: "x" }), /cover photo/);
  assert.match(photoSay({ photo_id: "p", item_id: ITEM, position: 2, photo_count: 3, storage_path: "x" }), /photo 3/);
});

test("review fixes: link rules, category and condition handling", async () => {
  for (const bad of ["https://localhost./a.jpg", "https://foo.internal./a.jpg", "https://100.64.0.1/a.jpg", "https://intranet/a.jpg"]) {
    assert.equal(checkImageUrl(bad).ok, false, bad);
  }
  assert.equal(checkImageUrl("https://example.com./a.jpg").ok, true, "a trailing dot on a public host is still fine");
  assert.equal(normalizeCategory("c"), "Other", "one letter is not enough to guess a category");
  assert.equal(normalizeCondition("scuffed on the toe"), null);
  const a = parseAction({ action: "add_item", name: "Boots", condition: "scuffed on the toe", notes: "size 10" }) as { condition: string | null; notes: string };
  assert.equal(a.condition, null);
  assert.match(a.notes, /size 10\nCondition \(as described\): scuffed on the toe/);
  // The SQL whitelist in the migration must match the app's lists.
  const { readFileSync } = await import("node:fs");
  const { CATEGORIES, CONDITIONS } = await import("../types.ts");
  const sql = readFileSync(new URL("../../supabase/migrations/20261101060000_assistant_items_photos.sql", import.meta.url), "utf8");
  for (const c of [...CATEGORIES, ...CONDITIONS]) assert.ok(sql.includes(`'${c.replace(/'/g, "''")}'`), `SQL list has ${c}`);
});

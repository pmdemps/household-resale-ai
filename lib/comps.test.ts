import { test } from "node:test";
import assert from "node:assert/strict";
import { compSearchQuery, deliveredPrice, median, normalizeCompPlatform, safeCompUrl, summarizeComps, verdictFor, verdictSentence } from "./comps.ts";
import { buildBrowseSearchUrl, parseBrowseSearch } from "./ebay/browse.ts";

const fmt = (n: number) => `$${n.toFixed(2)}`;

test("median handles odd, even and empty lists", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(median([]), null);
});

test("delivered price adds known shipping, treats unknown as 0", () => {
  assert.equal(deliveredPrice({ price: 15.29, shipping: 7.08 }), 22.37);
  assert.equal(deliveredPrice({ price: 27.99, shipping: 0 }), 27.99);
  assert.equal(deliveredPrice({ price: 20, shipping: null }), 20);
});

test("summary finds the lowest active comp, typical price and verdict", () => {
  const comps = [
    { id: "a", price: 34.99, shipping: 10.3 },
    { id: "b", price: 39.99, shipping: 10.3 },
    { id: "c", price: 39.99, shipping: 5.99 },
    { id: "d", price: 27.99, shipping: 0 },
    { id: "e", price: 12, shipping: 3, kind: "sold" as const },
  ];
  const s = summarizeComps(comps, 39.99);
  assert.equal(s.count, 5);
  assert.equal(s.lowest?.id, "d"); // the sold one is cheaper but isn't on the market now
  assert.equal(s.typical, 34.99);
  assert.equal(s.low, 12);
  assert.equal(s.high, 39.99);
  assert.equal(s.verdict, "above");
  assert.equal(s.diffPct, 14);
});

test("lowest breaks price ties on delivered price", () => {
  const s = summarizeComps([{ id: "x", price: 39.99, shipping: 10.3 }, { id: "y", price: 39.99, shipping: 5.99 }], null);
  assert.equal(s.lowest?.id, "y");
  assert.equal(s.verdict, null);
});

test("only sold comps: lowest falls back to them", () => {
  const s = summarizeComps([{ price: 18, shipping: null, kind: "sold" as const }], 20);
  assert.equal(s.lowest?.price, 18);
  assert.equal(s.verdict, "above");
});

test("no comps gives an empty summary", () => {
  const s = summarizeComps([], 25);
  assert.deepEqual([s.count, s.lowest, s.typical, s.verdict], [0, null, null, null]);
});

test("verdict band is +-10% of typical", () => {
  assert.equal(verdictFor(22, 20), "comparable");
  assert.equal(verdictFor(18, 20), "comparable");
  assert.equal(verdictFor(17.99, 20), "below");
  assert.equal(verdictFor(22.01, 20), "above");
});

test("verdict sentence reads plainly", () => {
  assert.equal(verdictSentence({ verdict: "comparable", typical: 24.99, diffPct: -20 }, 19.99, fmt), "Your $19.99 is comparable to the typical $24.99.");
  assert.match(verdictSentence({ verdict: "below", typical: 30, diffPct: -33 }, 19.99, fmt) ?? "", /33% below the typical \$30\.00/);
  assert.equal(verdictSentence({ verdict: null, typical: null, diffPct: null }, 10, fmt), null);
});

test("search query drops filler words and duplicates", () => {
  assert.equal(compSearchQuery("Motorcycle helmet wall mount with key hook and glove shelf"), "Motorcycle helmet wall mount key hook glove shelf");
  assert.equal(compSearchQuery("Kids' sneakers (size 11)", "Nike"), "Nike Kids' sneakers size 11");
  assert.ok(compSearchQuery("x ".repeat(200)).length <= 100);
});

test("platform and url are normalised", () => {
  assert.equal(normalizeCompPlatform("Etsy"), "etsy");
  assert.equal(normalizeCompPlatform("craigslist"), "other");
  assert.equal(safeCompUrl("https://www.ebay.com/itm/1"), "https://www.ebay.com/itm/1");
  assert.equal(safeCompUrl("http://example.com"), null);
  assert.equal(safeCompUrl("javascript:alert(1)"), null);
  assert.equal(safeCompUrl(""), null);
});

test("Browse search URL is fixed-price USD with a capped query", () => {
  const u = new URL(buildBrowseSearchUrl("https://api.ebay.com", "helmet mount", 80));
  assert.equal(u.pathname, "/buy/browse/v1/item_summary/search");
  assert.equal(u.searchParams.get("q"), "helmet mount");
  assert.equal(u.searchParams.get("limit"), "50");
  assert.equal(u.searchParams.get("filter"), "buyingOptions:{FIXED_PRICE},priceCurrency:USD");
});

test("Browse parser keeps priced USD rows, drops our own listings, reads shipping", () => {
  const json = {
    itemSummaries: [
      { itemId: "v1|1|0", title: "Helmet hook", price: { value: "15.29", currency: "USD" }, shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "7.08", currency: "USD" } }], condition: "New", itemWebUrl: "https://www.ebay.com/itm/1?hash=x", seller: { username: "maker1" } },
      { itemId: "v1|2|0", title: "Free ship hook", price: { value: "27.99", currency: "USD" }, shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "0.00", currency: "USD" } }], itemWebUrl: "https://www.ebay.com/itm/2" },
      { itemId: "v1|3|0", title: "Calculated", price: { value: "20.00", currency: "USD" }, shippingOptions: [{ shippingCostType: "CALCULATED" }] },
      { itemId: "v1|4|0", title: "Ours", price: { value: "39.99", currency: "USD" }, seller: { username: "OurShop" } },
      { itemId: "v1|5|0", title: "Euro", price: { value: "10", currency: "EUR" } },
      { itemId: "v1|6|0", title: "No price" },
      { title: "No id", price: { value: "5", currency: "USD" } },
    ],
  };
  const rows = parseBrowseSearch(json, { excludeSeller: "ourshop" });
  assert.deepEqual(rows.map(r => r.externalId), ["v1|1|0", "v1|2|0", "v1|3|0"]);
  assert.equal(rows[0].shipping, 7.08);
  assert.equal(rows[0].url, "https://www.ebay.com/itm/1");
  assert.equal(rows[1].shipping, 0);
  assert.equal(rows[2].shipping, null);
  assert.deepEqual(parseBrowseSearch(null), []);
});

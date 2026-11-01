import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListingCopy, buildTitle, fitTitle, TITLE_MAX } from "./listing-copy.ts";
import { estimateFees } from "./fees.ts";
import { MANUAL_PLATFORMS, platformById } from "./platforms.ts";

const shirt = { name: "Flannel button-up shirt", category: "Clothing", brand: "Carhartt", size: "L", condition: "Good", target_price: 24.5 };

test("titles put brand first and size last", () => {
  assert.equal(buildTitle(shirt, 80), "Carhartt Flannel button-up shirt Size L");
});

test("brand and size aren't repeated when the name already has them", () => {
  assert.equal(buildTitle({ ...shirt, name: "Carhartt flannel size L" }, 80), "Carhartt flannel size L");
});

test("long titles are cut at a word boundary within the platform limit", () => {
  const t = fitTitle("word ".repeat(40), TITLE_MAX.offerup);
  assert.ok(t.length <= TITLE_MAX.offerup);
  assert.ok(!t.endsWith(" "));
  assert.ok(t.endsWith("word"));
});

test("every manual platform except ThredUp gets copy-ready text", () => {
  for (const p of MANUAL_PLATFORMS) {
    const copy = buildListingCopy(p.id, shirt);
    if (p.consignment) { assert.equal(copy, null, p.id); continue; }
    assert.ok(copy, p.id);
    assert.ok(copy.title.length > 0 && copy.title.length <= (TITLE_MAX[p.id] ?? 80), p.id);
    assert.match(copy.description, /Brand: Carhartt/);
    assert.ok(p.sellUrl?.startsWith("https://"), `${p.id} has a sell link`);
  }
});

test("buyer-facing copy stays clean", () => {
  for (const p of MANUAL_PLATFORMS) {
    const copy = buildListingCopy(p.id, shirt);
    if (!copy) continue;
    assert.doesNotMatch(copy.title + copy.description, /fuck|shit|damn|ass\b|hell\b/i, p.id);
  }
});

test("Facebook copy reminds us to hide from friends", () => {
  assert.ok(buildListingCopy("facebook", shirt)!.tips.some(t => /Hide from friends/.test(t)));
});

test("OfferUp shipped fee has a $1.99 minimum", () => {
  assert.equal(estimateFees("offerup", 5).totalFees, 1.99);
  assert.equal(estimateFees("offerup", 100).totalFees, 12.9);
});

test("ThredUp is consignment with no fee estimate", () => {
  assert.equal(platformById("thredup").consignment, true);
  assert.equal(estimateFees("thredup", 12).payout, 12);
});

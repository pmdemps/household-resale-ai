import { test } from "node:test";
import assert from "node:assert/strict";
import { breakEvenPrice, estimateFees } from "./fees.ts";

test("Poshmark flat fee under $15", () => {
  const e = estimateFees("poshmark", 3.99);
  assert.equal(e.totalFees, 2.95);
  assert.equal(e.payout, 1.04);
});

test("Poshmark 20% at $15 and up", () => {
  assert.equal(estimateFees("poshmark", 25).totalFees, 5);
});

test("Vinted charges sellers nothing", () => {
  const e = estimateFees("vinted", 5.99, { itemCost: 1 });
  assert.equal(e.totalFees, 0);
  assert.equal(e.profit, 4.99);
});

test("eBay 13.6% on item + shipping plus per-order fee tier", () => {
  assert.equal(estimateFees("ebay", 8).totalFees, 1.39); // 1.088 -> 1.09 + 0.30
  assert.equal(estimateFees("ebay", 25, { shippingChargedToBuyer: 7 }).totalFees, 4.75); // 4.352 -> 4.35 + 0.40
});

test("Mercari 10% includes buyer-paid shipping", () => {
  assert.equal(estimateFees("mercari", 25, { shippingChargedToBuyer: 7 }).totalFees, 3.2);
});

test("Facebook minimum fee", () => {
  assert.equal(estimateFees("facebook", 4).totalFees, 0.8);
});

test("Etsy listing fee can be excluded", () => {
  const withListing = estimateFees("etsy", 20).totalFees;
  const without = estimateFees("etsy", 20, { includeListingFee: false }).totalFees;
  assert.equal(Math.round((withListing - without) * 100) / 100, 0.2);
});

test("seller-paid label reduces payout", () => {
  assert.equal(estimateFees("vinted", 10, { sellerShippingCost: 4 }).payout, 6);
});

test("break-even price clears target payout", () => {
  const p = breakEvenPrice("ebay", 10);
  assert.ok(estimateFees("ebay", p).payout >= 10);
  assert.ok(estimateFees("ebay", p - 0.01).payout < 10);
});

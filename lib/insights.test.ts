import { test } from "node:test";
import assert from "node:assert/strict";
import { brandKey, byBrand, byCategory, byPlatform, daysToSell, slowMovers, topSales, totals, type InsightItem } from "./insights.ts";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const day = (n: number) => new Date(t0 + n * 86_400_000).toISOString();

function item(p: Partial<InsightItem> & { id: string }): InsightItem {
  return {
    name: p.id, brand: null, category: "Clothing", status: "listed", purchaseCost: 0,
    createdAt: day(0), firstListedAt: day(0), platforms: ["ebay"], sale: null, ...p,
  };
}

const items: InsightItem[] = [
  item({ id: "a", brand: "Nike", category: "Shoes", sale: { platform: "ebay", soldAt: day(4), payout: 30 }, purchaseCost: 5 }),
  item({ id: "b", brand: "nike ", category: "Shoes", sale: { platform: "ebay", soldAt: day(10), payout: 20 } }),
  item({ id: "c", brand: "NIKE", category: "Shoes", platforms: ["vinted"], sale: { platform: "vinted", soldAt: day(2), payout: 12 } }),
  item({ id: "d", brand: "The North Face", category: "Clothing", sale: { platform: "ebay", soldAt: day(20), payout: 40 } }),
  item({ id: "e", brand: "North Face", category: "Clothing" }),
  item({ id: "f", brand: "Carter's", category: "Kids & baby", platforms: ["poshmark"], purchaseCost: 4, sale: { platform: "poshmark", soldAt: day(3), payout: 2.05 } }),
  item({ id: "g", brand: "Carter's", category: "Kids & baby", platforms: ["vinted"] }),
  item({ id: "h", brand: "Old", status: "donated", sale: null }),
];

test("brand keys merge spelling variants", () => {
  assert.equal(brandKey("The North Face"), brandKey("north face"));
  assert.equal(brandKey("  NIKE "), "nike");
  assert.equal(brandKey(""), null);
});

test("byBrand totals, sell-through and labels", () => {
  const rows = byBrand(items);
  const nike = rows.find(r => r.key === "nike")!;
  assert.equal(nike.sold, 3);
  assert.equal(nike.totalProfit, 57); // 25 + 20 + 12
  assert.equal(nike.avgProfit, 19);
  assert.equal(nike.sellThrough, 1);
  assert.equal(nike.medianDaysToSell, 4);
  assert.equal(nike.enoughData, true);
  const tnf = rows.find(r => r.key === "north face")!;
  assert.equal(tnf.sold, 1);
  assert.equal(tnf.listed, 2);
  assert.equal(tnf.sellThrough, 0.5);
  assert.equal(tnf.enoughData, false);
  assert.equal(rows[0].key, "nike");
  assert.ok(!rows.some(r => r.key === "old"), "donated items excluded");
});

test("losses show up as negative profit", () => {
  const carters = byBrand(items).find(r => r.key === "carter s")!;
  assert.equal(carters.totalProfit, -1.95);
});

test("byCategory ranks by total profit", () => {
  assert.deepEqual(byCategory(items).map(r => r.key), ["Shoes", "Clothing", "Kids & baby"]);
});

test("byPlatform counts a sale only where it happened", () => {
  const rows = byPlatform(items);
  const ebay = rows.find(r => r.key === "ebay")!;
  assert.equal(ebay.sold, 3);
  assert.equal(ebay.totalProfit, 85); // 25 + 20 + 40
  const vinted = rows.find(r => r.key === "vinted")!;
  assert.equal(vinted.sold, 1);
  assert.equal(vinted.listed, 2);
});

test("days to sell falls back to created date", () => {
  assert.equal(daysToSell(item({ id: "x", firstListedAt: null, createdAt: day(1), sale: { platform: "ebay", soldAt: day(6), payout: 1 } })), 5);
});

test("slow movers and top sales", () => {
  const slow = slowMovers(items, 30, t0 + 45 * 86_400_000);
  assert.deepEqual(slow.map(s => s.item.id), ["e", "g"]);
  assert.deepEqual(topSales(items, 2).map(i => i.id), ["d", "a"]);
  const t = totals(items);
  assert.equal(t.sold, 5);
  assert.equal(t.losers, 1);
});

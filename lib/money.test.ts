import { test } from "node:test";
import assert from "node:assert/strict";
import { barPath, byPlatform, chartLayout, dollarScale, monthKey, monthlyProfit, profitSentence, saleNet, saleProfit, signedMoney, summarize, type SaleLike } from "./money.ts";

const NOW = new Date("2026-10-30T12:00:00Z");

const sale = (over: Partial<SaleLike>): SaleLike => ({
  item_id: "i1",
  platform: "ebay",
  sale_price: 40,
  shipping_charged: 0,
  platform_fees: 5.84,
  shipping_cost: 9.1,
  other_costs: 0,
  sold_at: "2026-10-10T12:00:00Z",
  ...over,
});

test("saleNet and saleProfit follow the fee formula", () => {
  const s = sale({ sale_price: 40, shipping_charged: 6, platform_fees: 5.84, shipping_cost: 9.1, other_costs: 1 });
  assert.equal(Math.round(saleNet(s) * 100) / 100, 30.06);
  assert.equal(Math.round(saleProfit(s, 4) * 100) / 100, 26.06);
  assert.equal(saleProfit(s, 0), saleNet(s));
});

test("monthKey groups by UTC month", () => {
  assert.equal(monthKey("2026-10-31T23:30:00Z"), "2026-10");
  assert.equal(monthKey("2026-11-01T00:00:00Z"), "2026-11");
  assert.equal(monthKey(new Date(Date.UTC(2025, 0, 15))), "2025-01");
});

test("monthlyProfit returns a full window ending on the current month, oldest first", () => {
  const points = monthlyProfit([], new Map(), { months: 12, now: NOW });
  assert.equal(points.length, 12);
  assert.equal(points[0].key, "2025-11");
  assert.equal(points[11].key, "2026-10");
  assert.equal(points[11].isCurrent, true);
  assert.equal(points.filter(p => p.isCurrent).length, 1);
  assert.deepEqual(points.map(p => p.profit), new Array(12).fill(0));
  assert.equal(points[11].label, "Oct");
  assert.equal(points[11].longLabel, "October 2026");
  assert.equal(points[0].label, "Nov");
  assert.equal(points[0].year, 2025);
});

test("monthlyProfit sums sales per month and subtracts what you paid", () => {
  const sales = [
    sale({ item_id: "a", sold_at: "2026-10-03T00:00:00Z", sale_price: 40, platform_fees: 5.84, shipping_cost: 9.1 }), // 25.06
    sale({ item_id: "b", sold_at: "2026-10-20T00:00:00Z", sale_price: 5, platform_fees: 2.95, shipping_cost: 0, platform: "poshmark" }), // 2.05 − 4 cost = −1.95
    sale({ item_id: "c", sold_at: "2026-08-15T00:00:00Z", sale_price: 10, platform_fees: 0, shipping_cost: 14 }), // −4
    sale({ item_id: "d", sold_at: "2024-01-15T00:00:00Z", sale_price: 999, platform_fees: 0, shipping_cost: 0 }), // outside the window
  ];
  const points = monthlyProfit(sales, { a: 0, b: 4, c: 0, d: 0 }, { months: 6, now: NOW });
  assert.equal(points.length, 6);
  const by = Object.fromEntries(points.map(p => [p.key, p]));
  assert.equal(by["2026-10"].profit, 23.11);
  assert.equal(by["2026-10"].net, 27.11);
  assert.equal(by["2026-10"].sold, 2);
  assert.equal(by["2026-08"].profit, -4);
  assert.equal(by["2026-09"].profit, 0);
  assert.equal(by["2026-09"].sold, 0);
  assert.equal(by["2024-01"], undefined);
});

test("monthlyProfit accepts a Map of costs too", () => {
  const points = monthlyProfit([sale({ item_id: "x", sale_price: 20, platform_fees: 0, shipping_cost: 0 })], new Map([["x", 7.5]]), { months: 1, now: NOW });
  assert.equal(points[0].profit, 12.5);
});

test("summarize compares this month with last month", () => {
  const sales = [
    sale({ item_id: "a", sold_at: "2026-10-03T00:00:00Z", sale_price: 30, platform_fees: 0, shipping_cost: 0 }),
    sale({ item_id: "b", sold_at: "2026-09-03T00:00:00Z", sale_price: 50, platform_fees: 0, shipping_cost: 0 }),
  ];
  const s = summarize(monthlyProfit(sales, {}, { months: 12, now: NOW }));
  assert.equal(s.thisMonth.profit, 30);
  assert.equal(s.lastMonth?.profit, 50);
  assert.equal(s.change, -20);
  const single = summarize(monthlyProfit(sales, {}, { months: 1, now: NOW }));
  assert.equal(single.lastMonth, null);
  assert.equal(single.change, 30);
});

test("profitSentence speaks plainly", () => {
  assert.equal(profitSentence({ profit: 23, sold: 2 }), "Up $23 this month. Fuck yeah.");
  assert.equal(profitSentence({ profit: 23.45, sold: 2 }), "Up $23.45 this month. Fuck yeah.");
  assert.equal(profitSentence({ profit: -4, sold: 1 }), "Down $4 this month. Well, fuck.");
  assert.equal(profitSentence({ profit: 0, sold: 0 }), "Haven't sold shit this month. Yet.");
  assert.equal(profitSentence({ profit: 0, sold: 1 }), "Broke even this month. Meh.");
});

test("signedMoney keeps the sign readable", () => {
  assert.equal(signedMoney(23.45), "+$23.45");
  assert.equal(signedMoney(-4), "−$4.00");
  assert.equal(signedMoney(0), "$0.00");
  assert.equal(signedMoney(1234.5), "+$1,234.50");
});

test("dollarScale always includes zero and uses round steps", () => {
  const up = dollarScale([12, 45, 33]);
  assert.equal(up.min, 0);
  assert.ok(up.max >= 45);
  assert.ok(up.ticks.includes(0));
  assert.ok(up.ticks.every(t => Number.isInteger(t * 100)));
  const mixed = dollarScale([-18, 40]);
  assert.ok(mixed.min <= -18 && mixed.max >= 40);
  assert.ok(mixed.ticks.includes(0));
  assert.ok(mixed.ticks.length >= 3 && mixed.ticks.length <= 8);
  const flat = dollarScale([0, 0, 0]);
  assert.ok(flat.max > flat.min);
  assert.ok(flat.ticks.includes(0));
});

test("chartLayout puts positive bars above the zero line and negative bars below", () => {
  const points = monthlyProfit(
    [
      sale({ item_id: "a", sold_at: "2026-10-03T00:00:00Z", sale_price: 40, platform_fees: 0, shipping_cost: 0 }),
      sale({ item_id: "b", sold_at: "2026-09-03T00:00:00Z", sale_price: 5, platform_fees: 0, shipping_cost: 25 }),
    ],
    {},
    { months: 3, now: NOW },
  );
  const l = chartLayout(points, { width: 340, height: 200 });
  assert.equal(l.bars.length, 3);
  const [aug, sep, oct] = l.bars;
  assert.equal(aug.height, 0);
  assert.equal(oct.positive, true);
  assert.ok(oct.y < l.zeroY && Math.abs(oct.y + oct.height - l.zeroY) < 0.02);
  assert.equal(sep.positive, false);
  assert.ok(Math.abs(sep.y - l.zeroY) < 0.02 && sep.height > 0);
  assert.ok(l.bars.every(b => b.width <= 24));
  assert.ok(l.bars.every(b => b.x >= l.padLeft && b.x + b.width <= l.width));
  assert.ok(l.ticks.some(t => t.value === 0 && Math.abs(t.y - l.zeroY) < 0.02));
});

test("barPath rounds the data end only and draws nothing for an empty bar", () => {
  assert.equal(barPath(10, 100, 100, 20), "");
  const up = barPath(10, 100, 60, 20, 4);
  assert.ok(up.startsWith("M10 100"));
  assert.ok(up.includes("Q10 60 14 60"));
  const down = barPath(10, 100, 140, 20, 4);
  assert.ok(down.includes("Q10 140 14 140"));
  // radius never exceeds half the width or the bar height
  assert.ok(barPath(0, 100, 99, 20, 4).includes("Q0 99 1 99"));
});

test("byPlatform counts live listings and money per platform, best first", () => {
  const rows = byPlatform(
    [
      sale({ item_id: "a", platform: "ebay", sale_price: 40, platform_fees: 5.84, shipping_cost: 9.1 }),
      sale({ item_id: "b", platform: "vinted", sale_price: 26, platform_fees: 0, shipping_cost: 0 }),
      sale({ item_id: "c", platform: "vinted", sale_price: 8, platform_fees: 0, shipping_cost: 0 }),
    ],
    [{ platform: "ebay" }, { platform: "ebay" }, { platform: "poshmark" }],
    { a: 0, b: 10, c: 0 },
  );
  assert.deepEqual(rows.map(r => r.platform), ["ebay", "vinted", "poshmark"]);
  assert.equal(rows[0].active, 2);
  assert.equal(rows[0].sold, 1);
  assert.equal(rows[0].net, 25.06);
  assert.equal(rows[1].sold, 2);
  assert.equal(rows[1].net, 34);
  assert.equal(rows[1].profit, 24);
  assert.equal(rows[2].active, 1);
  assert.equal(rows[2].sold, 0);
});

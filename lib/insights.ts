// What sells and what makes money, grouped by brand, category and platform.
// Pure functions (no I/O) so they're unit-tested and reusable by agents.

export type InsightItem = {
  id: string;
  name: string;
  brand: string | null;
  category: string;
  status: string;
  purchaseCost: number;
  createdAt: string;
  /** Earliest time any listing went live, if ever. */
  firstListedAt: string | null;
  /** Platforms the item is or was listed on. */
  platforms: string[];
  sale: null | { platform: string; soldAt: string; payout: number };
};

export type GroupStat = {
  key: string;
  label: string;
  /** Items that sold. */
  sold: number;
  /** Items that were listed (sold or still listed). */
  listed: number;
  /** sold / listed, 0..1. */
  sellThrough: number;
  totalProfit: number;
  avgProfit: number;
  /** Median days from first listing to sale; null when nothing sold. */
  medianDaysToSell: number | null;
  /** Below MIN_SALES the ranking is noise; the UI says so. */
  enoughData: boolean;
};

export const MIN_SALES = 3;
const DAY = 86_400_000;
const ENDED = new Set(["donated", "discarded", "returned"]);

export const itemProfit = (i: InsightItem) => (i.sale ? i.sale.payout - i.purchaseCost : null);

export function daysToSell(i: InsightItem): number | null {
  if (!i.sale) return null;
  const start = new Date(i.firstListedAt ?? i.createdAt).getTime();
  return Math.max(0, Math.round((new Date(i.sale.soldAt).getTime() - start) / DAY));
}

/** "The North Face" and "north face " group together. */
export function brandKey(brand: string | null): string | null {
  if (!brand) return null;
  const k = brand.trim().toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9&]+/g, " ").trim();
  return k || null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function summarize(key: string, label: string, items: InsightItem[], soldOn?: string): GroupStat {
  // For platform grouping, an item counts as "sold" only where it actually sold.
  const soldItems = items.filter(i => i.sale && (!soldOn || i.sale.platform === soldOn));
  const listed = items.filter(i => i.firstListedAt || i.sale).length;
  const profits = soldItems.map(i => itemProfit(i)!);
  const total = profits.reduce((a, b) => a + b, 0);
  return {
    key,
    label,
    sold: soldItems.length,
    listed,
    sellThrough: listed ? soldItems.length / listed : 0,
    totalProfit: Math.round(total * 100) / 100,
    avgProfit: soldItems.length ? Math.round((total / soldItems.length) * 100) / 100 : 0,
    medianDaysToSell: median(soldItems.map(i => daysToSell(i)!)),
    enoughData: soldItems.length >= MIN_SALES,
  };
}

function groupBy(items: InsightItem[], keyOf: (i: InsightItem) => string | null, labelOf: (i: InsightItem) => string) {
  const groups = new Map<string, { label: Map<string, number>; items: InsightItem[] }>();
  for (const i of items) {
    if (ENDED.has(i.status)) continue;
    const k = keyOf(i);
    if (!k) continue;
    const g = groups.get(k) ?? { label: new Map<string, number>(), items: [] as InsightItem[] };
    const l = labelOf(i);
    g.label.set(l, (g.label.get(l) ?? 0) + 1);
    g.items.push(i);
    groups.set(k, g);
  }
  // Most common spelling wins as the display label.
  return [...groups.entries()].map(([k, g]) => ({ key: k, label: [...g.label.entries()].sort((a, b) => b[1] - a[1])[0][0], items: g.items }));
}

/** Most profit first; ties broken by sell-through. Groups with no sales go last. */
const byProfit = (a: GroupStat, b: GroupStat) =>
  Number(b.sold > 0) - Number(a.sold > 0) || b.totalProfit - a.totalProfit || b.sellThrough - a.sellThrough;

export function byBrand(items: InsightItem[]): GroupStat[] {
  return groupBy(items, i => brandKey(i.brand), i => i.brand!.trim()).map(g => summarize(g.key, g.label, g.items)).sort(byProfit);
}

export function byCategory(items: InsightItem[]): GroupStat[] {
  return groupBy(items, i => i.category, i => i.category).map(g => summarize(g.key, g.label, g.items)).sort(byProfit);
}

export function byPlatform(items: InsightItem[], nameOf: (id: string) => string = id => id): GroupStat[] {
  const map = new Map<string, InsightItem[]>();
  for (const i of items) {
    if (ENDED.has(i.status)) continue;
    for (const p of new Set([...i.platforms, ...(i.sale ? [i.sale.platform] : [])])) {
      map.set(p, [...(map.get(p) ?? []), i]);
    }
  }
  return [...map.entries()].map(([p, its]) => summarize(p, nameOf(p), its, p)).sort(byProfit);
}

/** Listed, unsold, and live for at least `days`. Oldest first. */
export function slowMovers(items: InsightItem[], days = 30, now = Date.now()) {
  return items
    .filter(i => !i.sale && !ENDED.has(i.status) && i.firstListedAt)
    .map(i => ({ item: i, days: Math.floor((now - new Date(i.firstListedAt!).getTime()) / DAY) }))
    .filter(x => x.days >= days)
    .sort((a, b) => b.days - a.days);
}

export function topSales(items: InsightItem[], n = 5) {
  return items.filter(i => i.sale).sort((a, b) => itemProfit(b)! - itemProfit(a)!).slice(0, n);
}

export function totals(items: InsightItem[]) {
  const sold = items.filter(i => i.sale);
  const profits = sold.map(i => itemProfit(i)!);
  return {
    sold: sold.length,
    profit: Math.round(profits.reduce((a, b) => a + b, 0) * 100) / 100,
    losers: profits.filter(p => p < 0).length,
    medianDaysToSell: median(sold.map(i => daysToSell(i)!)),
  };
}

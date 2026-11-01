// Month-by-month profit for the Money page and the Home hero.
// Pure functions (no I/O, no imports) so `node --test` runs them directly and agents can reuse them.

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The sale columns the math needs. `Sale` from lib/types satisfies this. */
export type SaleLike = {
  item_id: string;
  platform: string;
  sale_price: number;
  shipping_charged: number;
  platform_fees: number;
  shipping_cost: number;
  other_costs: number;
  sold_at: string;
};

/** What you get after fees: price + shipping the buyer paid − fees − label − other costs. */
export const saleNet = (s: SaleLike): number =>
  num(s.sale_price) + num(s.shipping_charged) - num(s.platform_fees) - num(s.shipping_cost) - num(s.other_costs);

/** Profit on one sale: what you get after fees, minus what you paid for the item. */
export const saleProfit = (s: SaleLike, purchaseCost: number): number => saleNet(s) - num(purchaseCost);

export type MonthPoint = {
  /** "2026-10" (UTC). */
  key: string;
  /** "Oct" */
  label: string;
  /** "October 2026" */
  longLabel: string;
  year: number;
  /** 1–12 */
  month: number;
  profit: number;
  net: number;
  sold: number;
  isCurrent: boolean;
};

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10" for any ISO timestamp, grouped by UTC month so results don't depend on the server's zone. */
export function monthKey(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Profit per calendar month for the last `months` months, oldest first, ending with the current month.
 * Months with no sales are included as zero so the chart always shows a full window.
 */
export function monthlyProfit(
  sales: SaleLike[],
  costById: Map<string, number> | Record<string, number>,
  opts: { months?: number; now?: Date } = {},
): MonthPoint[] {
  const months = Math.max(1, opts.months ?? 12);
  const now = opts.now ?? new Date();
  const cost = (id: string) => num(costById instanceof Map ? costById.get(id) : costById[id]);

  const byKey = new Map<string, { profit: number; net: number; sold: number }>();
  for (const s of sales) {
    const k = monthKey(s.sold_at);
    const e = byKey.get(k) ?? { profit: 0, net: 0, sold: 0 };
    e.net += saleNet(s);
    e.profit += saleProfit(s, cost(s.item_id));
    e.sold++;
    byKey.set(k, e);
  }

  const out: MonthPoint[] = [];
  const y0 = now.getUTCFullYear();
  const m0 = now.getUTCMonth();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y0, m0 - i, 1));
    const key = monthKey(d);
    const e = byKey.get(key);
    out.push({
      key,
      label: SHORT[d.getUTCMonth()],
      longLabel: `${LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      profit: round2(e?.profit ?? 0),
      net: round2(e?.net ?? 0),
      sold: e?.sold ?? 0,
      isCurrent: i === 0,
    });
  }
  return out;
}

export type MonthSummary = {
  thisMonth: MonthPoint;
  lastMonth: MonthPoint | null;
  /** thisMonth.profit − lastMonth.profit (0 when there is no last month). */
  change: number;
};

export function summarize(points: MonthPoint[]): MonthSummary {
  const thisMonth = points[points.length - 1];
  const lastMonth = points.length > 1 ? points[points.length - 2] : null;
  return { thisMonth, lastMonth, change: round2(thisMonth.profit - (lastMonth?.profit ?? 0)) };
}

const whole = (n: number) => {
  const abs = Math.abs(n);
  return Number.isInteger(abs) ? `$${abs}` : `$${abs.toFixed(2)}`;
};

/** "Up $23 this month", "Down $4 this month", "No sales yet this month", "Broke even this month". */
export function profitSentence(point: Pick<MonthPoint, "profit" | "sold">): string {
  if (point.sold === 0) return "Haven't sold shit this month. Yet.";
  if (point.profit > 0.004) return `Up ${whole(point.profit)} this month. Fuck yeah.`;
  if (point.profit < -0.004) return `Down ${whole(point.profit)} this month. Well, fuck.`;
  return "Broke even this month. Meh.";
}

/** "+$23.45" / "−$4.00" / "$0.00" with a real minus sign, for headline numbers. */
export function signedMoney(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return n > 0.004 ? `+${abs}` : n < -0.004 ? `−${abs}` : abs;
}

export type Scale = { min: number; max: number; ticks: number[] };

/** A clean dollar axis that always includes zero, with 3–5 round ticks. */
export function dollarScale(values: number[]): Scale {
  const hi = Math.max(0, ...values);
  const lo = Math.min(0, ...values);
  const span = Math.max(hi - lo, 1);
  const rough = span / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => s >= rough) ?? pow * 10;
  const max = hi === 0 ? 0 : Math.ceil(hi / step) * step;
  const min = lo === 0 ? 0 : Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let t = min; t <= max + step / 1000; t += step) ticks.push(round2(t));
  return { min, max: max === min ? min + step : max, ticks };
}

export type Bar = { x: number; y: number; width: number; height: number; value: number; point: MonthPoint; positive: boolean };

export type ChartLayout = {
  width: number;
  height: number;
  /** Left gutter for tick labels. */
  padLeft: number;
  padTop: number;
  padBottom: number;
  zeroY: number;
  bars: Bar[];
  ticks: { value: number; y: number }[];
  slotWidth: number;
};

/** Positions for an inline SVG column chart. Bars grow from the zero line; width is capped so the slot keeps air. */
export function chartLayout(points: MonthPoint[], opts: { width?: number; height?: number; maxBar?: number; padLeft?: number } = {}): ChartLayout {
  const width = opts.width ?? 640;
  const height = opts.height ?? 220;
  const padLeft = opts.padLeft ?? 44;
  const padTop = 14;
  const padBottom = 26;
  const plotW = width - padLeft - 8;
  const plotH = height - padTop - padBottom;
  const scale = dollarScale(points.map(p => p.profit));
  const range = scale.max - scale.min || 1;
  const yOf = (v: number) => padTop + ((scale.max - v) / range) * plotH;
  const zeroY = yOf(0);
  const slotWidth = plotW / Math.max(points.length, 1);
  const barW = Math.min(opts.maxBar ?? 24, Math.max(6, slotWidth * 0.62));
  const bars: Bar[] = points.map((p, i) => {
    const x = padLeft + i * slotWidth + (slotWidth - barW) / 2;
    const y1 = yOf(p.profit);
    const top = Math.min(zeroY, y1);
    const h = Math.abs(zeroY - y1);
    return { x: round2(x), y: round2(top), width: round2(barW), height: round2(h), value: p.profit, point: p, positive: p.profit >= 0 };
  });
  return {
    width,
    height,
    padLeft,
    padTop,
    padBottom,
    zeroY: round2(zeroY),
    bars,
    ticks: scale.ticks.map(t => ({ value: t, y: round2(yOf(t)) })),
    slotWidth: round2(slotWidth),
  };
}

/** SVG path for a column with a rounded data end and a square base at the zero line. */
export function barPath(x: number, zeroY: number, valueY: number, w: number, r = 4): string {
  const h = Math.abs(zeroY - valueY);
  if (h < 0.5) return "";
  const rr = Math.min(r, w / 2, h);
  if (valueY < zeroY) {
    // grows upward: rounded top corners
    return `M${x} ${zeroY} V${valueY + rr} Q${x} ${valueY} ${x + rr} ${valueY} H${x + w - rr} Q${x + w} ${valueY} ${x + w} ${valueY + rr} V${zeroY} Z`;
  }
  // grows downward: rounded bottom corners
  return `M${x} ${zeroY} V${valueY - rr} Q${x} ${valueY} ${x + rr} ${valueY} H${x + w - rr} Q${x + w} ${valueY} ${x + w} ${valueY - rr} V${zeroY} Z`;
}

export type PlatformRow = { platform: string; active: number; sold: number; net: number; profit: number };

/** Per platform: live listings, items sold, what you got after fees, and profit after what you paid. */
export function byPlatform(
  sales: SaleLike[],
  activeListings: { platform: string }[],
  costById: Map<string, number> | Record<string, number>,
): PlatformRow[] {
  const cost = (id: string) => num(costById instanceof Map ? costById.get(id) : costById[id]);
  const rows = new Map<string, PlatformRow>();
  const get = (p: string) => {
    const e = rows.get(p) ?? { platform: p, active: 0, sold: 0, net: 0, profit: 0 };
    rows.set(p, e);
    return e;
  };
  for (const l of activeListings) get(l.platform).active++;
  for (const s of sales) {
    const e = get(s.platform);
    e.sold++;
    e.net = round2(e.net + saleNet(s));
    e.profit = round2(e.profit + saleProfit(s, cost(s.item_id)));
  }
  return [...rows.values()].sort((a, b) => b.profit - a.profit || b.sold - a.sold || a.platform.localeCompare(b.platform));
}

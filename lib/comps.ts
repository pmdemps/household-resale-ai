// Market comparables ("what others sell this for"). Pure module so it can be unit tested with node --test.
//
// A comp is someone else's listing (or sale) of a similar item. The item page shows:
//   - the lowest price on the market right now, with its shipping and a link
//   - the typical (median) price
//   - whether our asking price is below, comparable to, or above the market
//
// Prices are compared item-to-item (not including shipping), because shipping depends on the buyer's
// location and on who pays it. Shipping is shown alongside so people can see the delivered price.

export type CompInput = {
  price: number;
  /** null = unknown, 0 = free shipping */
  shipping: number | null;
  kind?: "active" | "sold";
};

export type Verdict = "below" | "comparable" | "above";

export type CompSummary<T extends CompInput> = {
  count: number;
  /** Cheapest active comp by item price (ties broken by delivered price). Null when there are none. */
  lowest: T | null;
  /** Median item price across all comps (active and sold). */
  typical: number | null;
  low: number | null;
  high: number | null;
  /** How the asking price sits against the typical price; null without comps or without an asking price. */
  verdict: Verdict | null;
  /** (asking - typical) / typical, rounded to whole percent. */
  diffPct: number | null;
};

/** Within this fraction of the typical price counts as "comparable". */
export const COMPARABLE_BAND = 0.1;

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function deliveredPrice(c: CompInput): number {
  return round2(c.price + (c.shipping ?? 0));
}

export function median(values: number[]): number | null {
  const v = values.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return round2(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
}

export function verdictFor(asking: number, typical: number, band = COMPARABLE_BAND): Verdict {
  if (asking < typical * (1 - band)) return "below";
  if (asking > typical * (1 + band)) return "above";
  return "comparable";
}

export function summarizeComps<T extends CompInput>(comps: readonly T[], askingPrice: number | null): CompSummary<T> {
  const valid = comps.filter(c => Number.isFinite(c.price) && c.price > 0);
  const prices = valid.map(c => c.price);
  const active = valid.filter(c => (c.kind ?? "active") === "active");
  const pool = active.length > 0 ? active : valid;
  const lowest = pool.reduce<T | null>((best, c) => {
    if (!best) return c;
    if (c.price !== best.price) return c.price < best.price ? c : best;
    return deliveredPrice(c) < deliveredPrice(best) ? c : best;
  }, null);
  const typical = median(prices);
  const asking = askingPrice !== null && Number.isFinite(askingPrice) && askingPrice > 0 ? askingPrice : null;
  return {
    count: valid.length,
    lowest,
    typical,
    low: prices.length ? round2(Math.min(...prices)) : null,
    high: prices.length ? round2(Math.max(...prices)) : null,
    verdict: asking !== null && typical ? verdictFor(asking, typical) : null,
    diffPct: asking !== null && typical ? Math.round(((asking - typical) / typical) * 100) : null,
  };
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  below: "Below market",
  comparable: "Comparable",
  above: "Above market",
};

/** One plain sentence for the item page, e.g. "Your $39.99 is comparable to the typical $37.49." */
export function verdictSentence(summary: Pick<CompSummary<CompInput>, "verdict" | "typical" | "diffPct">, asking: number, fmt: (n: number) => string): string | null {
  const { verdict, typical, diffPct } = summary;
  if (!verdict || typical === null || diffPct === null) return null;
  if (verdict === "comparable") return `Your ${fmt(asking)} is comparable to the typical ${fmt(typical)}.`;
  const pct = Math.abs(diffPct);
  return verdict === "below"
    ? `Your ${fmt(asking)} is ${pct}% below the typical ${fmt(typical)}. It should move fast; you may be leaving money on the table.`
    : `Your ${fmt(asking)} is ${pct}% above the typical ${fmt(typical)}. Expect lower offers, or explain what makes yours worth more.`;
}

/** Search words for an item: its name minus filler, capped for eBay's q parameter. */
export function compSearchQuery(name: string, brand?: string | null): string {
  const filler = new Set(["with", "and", "the", "a", "an", "for", "of", "w/", "&"]);
  const words = `${brand ?? ""} ${name}`
    .replace(/[^\p{L}\p{N}\s/&'-]/gu, " ")
    .split(/\s+/)
    .filter(w => w && !filler.has(w.toLowerCase()));
  const seen = new Set<string>();
  const unique = words.filter(w => (seen.has(w.toLowerCase()) ? false : (seen.add(w.toLowerCase()), true)));
  return unique.join(" ").slice(0, 100).trim();
}

export const COMP_PLATFORMS = ["ebay", "etsy", "mercari", "poshmark", "depop", "vinted", "facebook", "amazon", "other"] as const;

export function normalizeCompPlatform(raw: string | null | undefined): string {
  const v = (raw ?? "").trim().toLowerCase();
  return (COMP_PLATFORMS as readonly string[]).includes(v) ? v : "other";
}

/** Accepts only https URLs (what the table allows); anything else becomes null. */
export function safeCompUrl(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && v.length <= 1000 ? u.toString() : null;
  } catch {
    return null;
  }
}

// eBay Browse API: current Buy It Now listings for an item, used as market comparables.
// Application (client-credentials) token only, so it works before the household connects an eBay account.
// Request builder and response parser are exported for tests.

// Relative .ts imports (not "@/") so node --test can load this module without a bundler.
import { EBAY_APP_SCOPE, EBAY_MARKETPLACE_ID, type EbayConfig } from "./config.ts";
import { getAppToken } from "./oauth.ts";

type Fetch = typeof fetch;

export type BrowseComp = {
  externalId: string;
  title: string;
  price: number;
  /** null = eBay didn't say (calculated shipping), 0 = free */
  shipping: number | null;
  url: string | null;
  condition: string | null;
  seller: string | null;
};

export const BROWSE_LIMIT = 25;

export function buildBrowseSearchUrl(apiHost: string, query: string, limit = BROWSE_LIMIT): string {
  const url = new URL(`${apiHost}/buy/browse/v1/item_summary/search`);
  url.searchParams.set("q", query.slice(0, 100));
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 50)));
  // Fixed-price only: auction current bids aren't a price anyone has agreed to.
  url.searchParams.set("filter", "buyingOptions:{FIXED_PRICE},priceCurrency:USD");
  return url.toString();
}

type Money = { value?: string; currency?: string };
type Summary = {
  itemId?: string;
  title?: string;
  price?: Money;
  shippingOptions?: { shippingCostType?: string; shippingCost?: Money }[];
  condition?: string;
  itemWebUrl?: string;
  seller?: { username?: string };
};

const toNum = (m: Money | undefined): number | null => {
  if (!m || (m.currency && m.currency !== "USD")) return null;
  const n = Number(m.value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Parses item_summary/search. Drops rows without a USD price, and the seller's own listings when given. */
export function parseBrowseSearch(json: unknown, opts: { excludeSeller?: string | null } = {}): BrowseComp[] {
  const rows = ((json as { itemSummaries?: Summary[] } | null)?.itemSummaries ?? []) as Summary[];
  const own = opts.excludeSeller?.trim().toLowerCase() || null;
  const out: BrowseComp[] = [];
  for (const s of rows) {
    const price = toNum(s.price);
    if (!s.itemId || !s.title || price === null || price <= 0) continue;
    const seller = s.seller?.username ?? null;
    if (own && seller?.toLowerCase() === own) continue;
    const ship = s.shippingOptions?.[0];
    const shipping = ship?.shippingCostType === "CALCULATED" ? null : toNum(ship?.shippingCost);
    const url = s.itemWebUrl && /^https:\/\//i.test(s.itemWebUrl) ? s.itemWebUrl.split("?")[0] : null;
    out.push({ externalId: s.itemId.slice(0, 120), title: s.title.slice(0, 300), price, shipping, url, condition: s.condition?.slice(0, 80) ?? null, seller });
  }
  return out;
}

export async function searchEbayComps(cfg: EbayConfig, query: string, opts: { excludeSeller?: string | null; fetchImpl?: Fetch } = {}): Promise<BrowseComp[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = await getAppToken(cfg, EBAY_APP_SCOPE, fetchImpl);
  const res = await fetchImpl(buildBrowseSearchUrl(cfg.hosts.api, query), {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json", "X-EBAY-C-MARKETPLACE-ID": EBAY_MARKETPLACE_ID },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`eBay search failed (${res.status}).`);
  return parseBrowseSearch(await res.json(), { excludeSeller: opts.excludeSeller });
}

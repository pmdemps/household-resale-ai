// eBay REST client: bearer auth with automatic refresh (persisted through a TokenStore), plus the
// Inventory, Account and Taxonomy calls Resale HQ needs. Pure (no database access): the store adapter
// in lib/ebay/connection.ts wires it to marketplace_connections. Request builders are exported for tests.
//
// Listing pipeline (research doc §2): ensureInventoryLocation (once) → putInventoryItem (SKU = item id)
// → createOffer (EBAY_US, FIXED_PRICE, GTC, bestOfferTerms.autoDeclinePrice = floor) → publishOffer.

import { CONDITIONS } from "../types.ts";
import { EBAY_APP_SCOPE, EBAY_MARKETPLACE_ID, type EbayConfig } from "./config.ts";
import { getAppToken, refreshAccessToken, EbayOAuthError } from "./oauth.ts";

type Fetch = typeof fetch;

export type StoredTokens = {
  accessToken: string | null;
  accessExpiresAt: string | null;
  refreshToken: string | null;
  refreshExpiresAt: string | null;
};

/** How the client reads and persists tokens. Implemented over marketplace_connections in connection.ts. */
export type TokenStore = {
  load(): Promise<StoredTokens>;
  saveAccessToken(accessToken: string, accessExpiresAt: string): Promise<void>;
  markError(message: string): Promise<void>;
};

export type EbayErrorDetail = { errorId?: number; domain?: string; category?: string; message?: string; longMessage?: string; parameters?: { name: string; value: string }[] };

export class EbayApiError extends Error {
  readonly status: number;
  readonly errors: EbayErrorDetail[];
  readonly body: string;
  constructor(message: string, status: number, errors: EbayErrorDetail[] = [], body = "") {
    super(message);
    this.name = "EbayApiError";
    this.status = status;
    this.errors = errors;
    this.body = body;
  }
}

/** The refresh token is gone or rejected: the household must click "Connect eBay" again. */
export class EbayReauthError extends Error {
  constructor(message = "eBay needs you to sign in again. Go to Settings → Marketplaces → Connect eBay.") {
    super(message);
    this.name = "EbayReauthError";
  }
}

export class EbayClient {
  private inflightRefresh: Promise<string> | null = null;
  readonly cfg: EbayConfig;
  private readonly store: TokenStore;
  private readonly fetchImpl: Fetch;

  constructor(cfg: EbayConfig, store: TokenStore, fetchImpl: Fetch = fetch) {
    this.cfg = cfg;
    this.store = store;
    this.fetchImpl = fetchImpl;
  }

  /** A valid access token, refreshing (and persisting) when it is missing or within 2 minutes of expiry. */
  async accessToken(): Promise<string> {
    const t = await this.store.load();
    const soon = Date.now() + 120_000;
    if (t.accessToken && t.accessExpiresAt && new Date(t.accessExpiresAt).getTime() > soon) return t.accessToken;
    return this.refresh(t);
  }

  private refresh(t: StoredTokens): Promise<string> {
    if (this.inflightRefresh) return this.inflightRefresh;
    this.inflightRefresh = (async () => {
      if (!t.refreshToken) throw new EbayReauthError();
      if (t.refreshExpiresAt && new Date(t.refreshExpiresAt).getTime() < Date.now()) {
        await this.store.markError("Refresh token expired (eBay refresh tokens last ~18 months).");
        throw new EbayReauthError();
      }
      try {
        const res = await refreshAccessToken(this.cfg, t.refreshToken, undefined, this.fetchImpl);
        const expiresAt = new Date(Date.now() + Math.max(0, res.expires_in - 60) * 1000).toISOString();
        await this.store.saveAccessToken(res.access_token, expiresAt);
        return res.access_token;
      } catch (e) {
        if (e instanceof EbayOAuthError && (e.status === 400 || e.status === 401)) {
          await this.store.markError(`Token refresh rejected: ${e.message}`);
          throw new EbayReauthError();
        }
        throw e;
      } finally {
        this.inflightRefresh = null;
      }
    })();
    return this.inflightRefresh;
  }

  /** JSON request against the eBay API host for this environment. 204/empty bodies resolve to null. */
  async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; query?: Record<string, string | undefined>; retryOn401?: boolean } = {},
  ): Promise<{ status: number; data: T | null }> {
    const url = new URL(path, this.cfg.hosts.api);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const doFetch = async (token: string) =>
      this.fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(opts.headers ?? {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
      });

    let res = await doFetch(await this.accessToken());
    if (res.status === 401 && (opts.retryOn401 ?? true)) {
      // Token revoked server-side or clock skew: refresh once and retry.
      const fresh = await this.refresh(await this.store.load());
      res = await doFetch(fresh);
    }
    const text = await res.text();
    if (!res.ok) throw toApiError(res.status, text);
    if (!text) return { status: res.status, data: null };
    try {
      return { status: res.status, data: JSON.parse(text) as T };
    } catch {
      return { status: res.status, data: null };
    }
  }
}

export function toApiError(status: number, text: string): EbayApiError {
  let errors: EbayErrorDetail[] = [];
  try {
    const j = JSON.parse(text) as { errors?: EbayErrorDetail[] };
    errors = j.errors ?? [];
  } catch {
    /* non-JSON body */
  }
  const first = errors[0];
  const msg = first ? `${first.message ?? "eBay error"}${first.longMessage && first.longMessage !== first.message ? ` — ${first.longMessage}` : ""}` : text.slice(0, 300) || `HTTP ${status}`;
  return new EbayApiError(`eBay API ${status}: ${msg}`, status, errors, text);
}

// ---------------------------------------------------------------------------
// Pure builders (unit tested)
// ---------------------------------------------------------------------------
export const CONTENT_LANGUAGE = { "Content-Language": "en-US" } as const; // en_US with underscore fails

export const MAX_TITLE = 80;

/** Our CONDITIONS → eBay ConditionEnum. Used goods collapse to USED_EXCELLENT (condition id 3000,
 *  "Pre-owned"), which nearly every category accepts; the precise wording goes in conditionDescription. */
export function mapCondition(condition: string | null | undefined): { condition: string; conditionDescription?: string } {
  const c = (condition ?? "").trim() as (typeof CONDITIONS)[number] | "";
  switch (c) {
    case "New with tags":
      return { condition: "NEW" };
    case "New without tags":
      return { condition: "NEW_OTHER", conditionDescription: "New without tags." };
    case "Like new":
      return { condition: "USED_EXCELLENT", conditionDescription: "Like new: no visible wear." };
    case "Good":
      return { condition: "USED_EXCELLENT", conditionDescription: "Good pre-owned condition with light signs of use." };
    case "Fair":
      return { condition: "USED_EXCELLENT", conditionDescription: "Fair pre-owned condition with visible wear; see photos." };
    case "For parts":
      return { condition: "FOR_PARTS_OR_NOT_WORKING", conditionDescription: "For parts or not working." };
    default:
      return { condition: "USED_EXCELLENT", conditionDescription: "Pre-owned; see photos for condition." };
  }
}

export type ListableItem = {
  id: string;
  name: string;
  brand: string | null;
  size: string | null;
  condition: string | null;
  category: string;
  weight_oz: number | null;
};

/** "Brand Name Size" trimmed to eBay's 80-character limit, never cutting mid-word when avoidable. */
export function ebayTitle(item: Pick<ListableItem, "name" | "brand" | "size">): string {
  const parts = [item.name.trim()];
  if (item.brand && !item.name.toLowerCase().includes(item.brand.toLowerCase())) parts.unshift(item.brand.trim());
  if (item.size && !item.name.toLowerCase().includes(item.size.toLowerCase())) parts.push(`Size ${item.size.trim()}`);
  const full = parts.join(" ").replace(/\s+/g, " ").trim();
  if (full.length <= MAX_TITLE) return full;
  const cut = full.slice(0, MAX_TITLE);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);

/** Plain description from item facts only. Household notes/comments are private and never sent. */
export function defaultDescription(item: Pick<ListableItem, "name" | "brand" | "size" | "condition" | "category">): string {
  const lines = [escapeHtml(item.name)];
  const facts = [item.brand && `Brand: ${item.brand}`, item.size && `Size: ${item.size}`, item.condition && `Condition: ${item.condition}`, `Category: ${item.category}`].filter(Boolean) as string[];
  lines.push(facts.map(escapeHtml).join(" · "));
  lines.push("From a smoke-free home. Please see photos for details; message us with any questions.");
  return lines.map(l => `<p>${l}</p>`).join("");
}

export function buildInventoryItemBody(item: ListableItem, imageUrls: string[], description?: string) {
  if (imageUrls.length === 0) throw new Error("eBay requires at least one photo (HTTPS image URL).");
  const cond = mapCondition(item.condition);
  const aspects: Record<string, string[]> = {};
  if (item.brand) aspects.Brand = [item.brand.trim().slice(0, 65)];
  if (item.size) aspects.Size = [item.size.trim().slice(0, 65)];
  const body: Record<string, unknown> = {
    availability: { shipToLocationAvailability: { quantity: 1 } },
    condition: cond.condition,
    product: {
      title: ebayTitle(item),
      description: (description?.trim() || defaultDescription(item)).slice(0, 4000),
      imageUrls: imageUrls.filter(u => /^https:\/\//i.test(u)).slice(0, 24),
      ...(Object.keys(aspects).length ? { aspects } : {}),
    },
  };
  if (cond.conditionDescription && cond.condition !== "NEW") body.conditionDescription = cond.conditionDescription.slice(0, 1000);
  if (item.weight_oz && item.weight_oz > 0) body.packageWeightAndSize = { weight: { value: Math.round(item.weight_oz * 100) / 100, unit: "OUNCE" } };
  return body;
}

export type PolicyIds = { fulfillmentPolicyId: string | null; paymentPolicyId: string | null; returnPolicyId: string | null };

const usd = (n: number) => ({ value: (Math.round(n * 100) / 100).toFixed(2), currency: "USD" });

export function buildOfferBody(opts: {
  sku: string;
  categoryId: string;
  price: number;
  /** Floor price: eBay auto-declines Best Offers below it (AGENTS.md: floor is absolute). */
  floorPrice: number | null;
  merchantLocationKey: string;
  policies: PolicyIds;
  description?: string;
}) {
  if (!(opts.price > 0)) throw new Error("List price must be greater than zero.");
  if (opts.floorPrice !== null && opts.floorPrice > opts.price) throw new Error("Floor price cannot be above the list price.");
  const listingPolicies: Record<string, unknown> = {
    bestOfferTerms: {
      bestOfferEnabled: true,
      ...(opts.floorPrice !== null && opts.floorPrice > 0 ? { autoDeclinePrice: usd(opts.floorPrice) } : {}),
    },
  };
  if (opts.policies.fulfillmentPolicyId) listingPolicies.fulfillmentPolicyId = opts.policies.fulfillmentPolicyId;
  if (opts.policies.paymentPolicyId) listingPolicies.paymentPolicyId = opts.policies.paymentPolicyId;
  if (opts.policies.returnPolicyId) listingPolicies.returnPolicyId = opts.policies.returnPolicyId;
  return {
    sku: opts.sku,
    marketplaceId: EBAY_MARKETPLACE_ID,
    format: "FIXED_PRICE",
    listingDuration: "GTC",
    availableQuantity: 1,
    categoryId: opts.categoryId,
    ...(opts.description ? { listingDescription: opts.description.slice(0, 500000) } : {}),
    merchantLocationKey: opts.merchantLocationKey,
    pricingSummary: { price: usd(opts.price) },
    listingPolicies,
  };
}

export type ShipFrom = { city: string; stateOrProvince: string; postalCode: string; country?: string };

/** merchantLocationKey ≤ 36 chars, stable per household + postal code (the address is immutable on eBay). */
export function merchantLocationKey(householdId: string, postalCode: string): string {
  const compact = householdId.replace(/-/g, "").slice(0, 20);
  const zip = postalCode.replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
  return `rhq-${compact}-${zip}`.slice(0, 36);
}

export function buildLocationBody(shipFrom: ShipFrom) {
  return {
    name: "Home",
    location: {
      address: {
        city: shipFrom.city.trim(),
        stateOrProvince: shipFrom.stateOrProvince.trim(),
        postalCode: shipFrom.postalCode.trim(),
        country: shipFrom.country ?? "US",
      },
    },
    locationTypes: ["WAREHOUSE"],
    merchantLocationStatus: "ENABLED",
  };
}

// ---------------------------------------------------------------------------
// Inventory API
// ---------------------------------------------------------------------------
const INV = "/sell/inventory/v1";

export async function ensureInventoryLocation(client: EbayClient, key: string, shipFrom: ShipFrom): Promise<void> {
  try {
    await client.request("GET", `${INV}/location/${encodeURIComponent(key)}`);
    return;
  } catch (e) {
    if (!(e instanceof EbayApiError) || e.status !== 404) throw e;
  }
  await client.request("POST", `${INV}/location/${encodeURIComponent(key)}`, { body: buildLocationBody(shipFrom), headers: CONTENT_LANGUAGE });
}

export async function putInventoryItem(client: EbayClient, sku: string, body: Record<string, unknown>): Promise<void> {
  await client.request("PUT", `${INV}/inventory_item/${encodeURIComponent(sku)}`, { body, headers: CONTENT_LANGUAGE });
}

export type EbayOffer = { offerId: string; sku: string; status?: string; listing?: { listingId?: string; listingStatus?: string }; pricingSummary?: { price?: { value: string; currency: string } } } & Record<string, unknown>;

export async function getOffersForSku(client: EbayClient, sku: string): Promise<EbayOffer[]> {
  try {
    const { data } = await client.request<{ offers?: EbayOffer[] }>("GET", `${INV}/offer`, { query: { sku, marketplace_id: EBAY_MARKETPLACE_ID } });
    return data?.offers ?? [];
  } catch (e) {
    if (e instanceof EbayApiError && e.status === 404) return [];
    throw e;
  }
}

export async function getOffer(client: EbayClient, offerId: string): Promise<EbayOffer> {
  const { data } = await client.request<EbayOffer>("GET", `${INV}/offer/${encodeURIComponent(offerId)}`);
  if (!data) throw new EbayApiError("Empty offer response", 200);
  return data;
}

export async function createOffer(client: EbayClient, body: Record<string, unknown>): Promise<string> {
  const { data } = await client.request<{ offerId: string }>("POST", `${INV}/offer`, { body, headers: CONTENT_LANGUAGE });
  if (!data?.offerId) throw new EbayApiError("createOffer returned no offerId", 201);
  return data.offerId;
}

/** Fields eBay accepts on updateOffer (everything else in a GET response is read-only). */
const OFFER_WRITABLE = ["availableQuantity", "categoryId", "charity", "extendedProducerResponsibility", "hideBuyerDetails", "includeCatalogProductDetails", "listingDescription", "listingDuration", "listingPolicies", "listingStartDate", "lotSize", "merchantLocationKey", "pricingSummary", "quantityLimitPerBuyer", "regulatory", "secondaryCategoryId", "storeCategoryNames", "tax"] as const;

export function offerUpdateBody(existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of OFFER_WRITABLE) if (existing[k] !== undefined) out[k] = existing[k];
  return { ...out, ...patch };
}

export async function updateOffer(client: EbayClient, offerId: string, body: Record<string, unknown>): Promise<void> {
  await client.request("PUT", `${INV}/offer/${encodeURIComponent(offerId)}`, { body, headers: CONTENT_LANGUAGE });
}

/** Change the price (and keep auto-decline at the floor). Fetches the offer so required fields round-trip. */
export async function updateOfferPrice(client: EbayClient, offerId: string, price: number, floorPrice: number | null): Promise<void> {
  const existing = await getOffer(client, offerId);
  const policies = (existing.listingPolicies as Record<string, unknown> | undefined) ?? {};
  const bestOfferTerms = {
    bestOfferEnabled: true,
    ...(floorPrice !== null && floorPrice > 0 ? { autoDeclinePrice: usd(Math.min(floorPrice, price)) } : {}),
  };
  await updateOffer(client, offerId, offerUpdateBody(existing, { pricingSummary: { ...(existing.pricingSummary ?? {}), price: usd(price) }, listingPolicies: { ...policies, bestOfferTerms } }));
}

export async function publishOffer(client: EbayClient, offerId: string): Promise<string> {
  const { data } = await client.request<{ listingId: string }>("POST", `${INV}/offer/${encodeURIComponent(offerId)}/publish/`, { headers: CONTENT_LANGUAGE });
  if (!data?.listingId) throw new EbayApiError("publishOffer returned no listingId", 200);
  return data.listingId;
}

export async function withdrawOffer(client: EbayClient, offerId: string): Promise<string | null> {
  const { data } = await client.request<{ listingId?: string }>("POST", `${INV}/offer/${encodeURIComponent(offerId)}/withdraw`, { headers: CONTENT_LANGUAGE });
  return data?.listingId ?? null;
}

// ---------------------------------------------------------------------------
// Account API: business policies (first of each; nulls when the seller has none)
// ---------------------------------------------------------------------------
const ACCT = "/sell/account/v1";

export async function getFirstPolicies(client: EbayClient): Promise<PolicyIds> {
  const q = { marketplace_id: EBAY_MARKETPLACE_ID };
  const firstId = async (path: string, listKey: string, idKey: string): Promise<string | null> => {
    try {
      const { data } = await client.request<Record<string, unknown>>("GET", `${ACCT}/${path}`, { query: q });
      const list = (data?.[listKey] as Record<string, unknown>[] | undefined) ?? [];
      const id = list[0]?.[idKey];
      return typeof id === "string" && id ? id : null;
    } catch (e) {
      if (e instanceof EbayApiError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  };
  return {
    fulfillmentPolicyId: await firstId("fulfillment_policy", "fulfillmentPolicies", "fulfillmentPolicyId"),
    paymentPolicyId: await firstId("payment_policy", "paymentPolicies", "paymentPolicyId"),
    returnPolicyId: await firstId("return_policy", "returnPolicies", "returnPolicyId"),
  };
}

// ---------------------------------------------------------------------------
// Commerce Identity: the connected eBay username (needs commerce.identity.readonly)
// ---------------------------------------------------------------------------
export async function getEbayUser(cfg: EbayConfig, accessToken: string, fetchImpl: Fetch = fetch): Promise<{ username: string | null; userId: string | null }> {
  try {
    const res = await fetchImpl(`${cfg.hosts.api}/commerce/identity/v1/user/`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return { username: null, userId: null };
    const j = (await res.json()) as { username?: string; userId?: string };
    return { username: j.username ?? null, userId: j.userId ?? null };
  } catch {
    return { username: null, userId: null };
  }
}

// ---------------------------------------------------------------------------
// Taxonomy (client-credentials app token). Not supported in Sandbox → callers fall back to a default.
// ---------------------------------------------------------------------------
export type CategorySuggestion = { categoryId: string; categoryName: string };

export async function getCategorySuggestions(cfg: EbayConfig, query: string, fetchImpl: Fetch = fetch): Promise<CategorySuggestion[]> {
  const token = await getAppToken(cfg, EBAY_APP_SCOPE, fetchImpl);
  const url = new URL(`${cfg.hosts.api}/commerce/taxonomy/v1/category_tree/0/get_category_suggestions`);
  url.searchParams.set("q", query.slice(0, 200));
  const res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) return [];
  const j = (await res.json()) as { categorySuggestions?: { category?: { categoryId?: string; categoryName?: string } }[] };
  return (j.categorySuggestions ?? [])
    .map(s => ({ categoryId: s.category?.categoryId ?? "", categoryName: s.category?.categoryName ?? "" }))
    .filter(s => s.categoryId);
}

// eBay Trading API (XML) for buyer Best Offers: GetBestOffers + RespondToBestOffer. No REST method
// responds to a buyer's Best Offer, so this is the path (research doc §2). Uses the OAuth user token
// in X-EBAY-API-IAF-TOKEN; no RequesterCredentials. Tiny regex-based XML helpers — no new dependencies.
// Reference: https://developer.ebay.com/DevZone/XML/Docs/Reference/eBay/GetBestOffers.html
//            https://developer.ebay.com/DevZone/XML/Docs/Reference/eBay/RespondToBestOffer.html

import type { EbayClient } from "./api.ts";

export const TRADING_COMPATIBILITY_LEVEL = "1423";
export const TRADING_SITE_ID_US = "0";
const NS = "urn:ebay:apis:eBLBaseComponents";

export const xmlEscape = (s: string) => s.replace(/[<>&"']/g, ch => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch] as string);

const xmlUnescape = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

// ---------------------------------------------------------------------------
// Minimal XML extraction
// ---------------------------------------------------------------------------
/** Text of the first <tag> directly in `xml` (any depth). Returns null when absent. */
export function tagText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? xmlUnescape(m[1]).trim() : null;
}

/** Value of `attr` on the first <tag ...> in `xml`. */
export function tagAttr(xml: string, tag: string, attr: string): string | null {
  const m = new RegExp(`<${tag}\\s[^>]*?${attr}="([^"]*)"`).exec(xml);
  return m ? xmlUnescape(m[1]) : null;
}

/** Every <tag>…</tag> block (inner XML) at any depth, in document order. Tags are not expected to self-nest. */
export function tagBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------
export type BestOfferStatusFilter = "Active" | "All" | "Accepted" | "Declined" | "Expired" | "Retracted" | "Countered" | "Pending";

export function buildGetBestOffersXml(opts: { itemId?: string; bestOfferId?: string; status?: BestOfferStatusFilter; detailLevel?: "ReturnAll" } = {}): string {
  const parts = [`<?xml version="1.0" encoding="utf-8"?>`, `<GetBestOffersRequest xmlns="${NS}">`];
  parts.push(`<DetailLevel>${opts.detailLevel ?? "ReturnAll"}</DetailLevel>`);
  if (opts.itemId) parts.push(`<ItemID>${xmlEscape(opts.itemId)}</ItemID>`);
  if (opts.bestOfferId) parts.push(`<BestOfferID>${xmlEscape(opts.bestOfferId)}</BestOfferID>`);
  if (opts.status) parts.push(`<BestOfferStatus>${opts.status}</BestOfferStatus>`);
  parts.push(`</GetBestOffersRequest>`);
  return parts.join("");
}

export type RespondAction = "Accept" | "Decline" | "Counter";

export function buildRespondToBestOfferXml(opts: { itemId: string; bestOfferId: string; action: RespondAction; counterOfferPrice?: number; counterOfferQuantity?: number; sellerResponse?: string }): string {
  if (opts.action === "Counter" && !(opts.counterOfferPrice && opts.counterOfferPrice > 0)) throw new Error("A counter offer needs a price above zero.");
  const parts = [`<?xml version="1.0" encoding="utf-8"?>`, `<RespondToBestOfferRequest xmlns="${NS}">`];
  parts.push(`<ItemID>${xmlEscape(opts.itemId)}</ItemID>`);
  parts.push(`<BestOfferID>${xmlEscape(opts.bestOfferId)}</BestOfferID>`);
  parts.push(`<Action>${opts.action}</Action>`);
  if (opts.action === "Counter") {
    parts.push(`<CounterOfferPrice currencyID="USD">${(Math.round(opts.counterOfferPrice! * 100) / 100).toFixed(2)}</CounterOfferPrice>`);
    parts.push(`<CounterOfferQuantity>${opts.counterOfferQuantity ?? 1}</CounterOfferQuantity>`);
  }
  if (opts.sellerResponse) parts.push(`<SellerResponse>${xmlEscape(opts.sellerResponse.slice(0, 250))}</SellerResponse>`);
  parts.push(`</RespondToBestOfferRequest>`);
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------
export type TradingError = { code: string | null; shortMessage: string | null; longMessage: string | null; severity: string | null };

export type TradingAck = { ack: string | null; ok: boolean; errors: TradingError[]; timestamp: string | null };

export function parseAck(xml: string): TradingAck {
  const ack = tagText(xml, "Ack");
  const errors = tagBlocks(xml, "Errors").map(b => ({
    code: tagText(b, "ErrorCode"),
    shortMessage: tagText(b, "ShortMessage"),
    longMessage: tagText(b, "LongMessage"),
    severity: tagText(b, "SeverityCode"),
  }));
  const hasFailure = errors.some(e => e.severity === "Error");
  return { ack, ok: (ack === "Success" || ack === "Warning") && !hasFailure, errors, timestamp: tagText(xml, "Timestamp") };
}

export type BestOffer = {
  bestOfferId: string;
  itemId: string | null;
  codeType: string | null; // BuyerBestOffer | BuyerCounterOffer | SellerCounterOffer
  buyerUserId: string | null;
  price: number;
  currency: string | null;
  quantity: number;
  status: string | null; // Active | Accepted | Declined | Expired | Retracted | Countered | Pending ...
  expirationTime: string | null;
  buyerMessage: string | null;
  itemEndTime: string | null;
};

export function parseGetBestOffers(xml: string): { ack: TradingAck; offers: BestOffer[] } {
  const ack = parseAck(xml);
  const offers: BestOffer[] = [];
  // GetBestOffers groups offers per item: ItemBestOffersArray > ItemBestOffers > { BestOfferArray > BestOffer*, Item }.
  const groups = tagBlocks(xml, "ItemBestOffers");
  const scan = (group: string) => {
    const itemBlock = tagBlocks(group, "Item")[0] ?? "";
    const itemId = tagText(itemBlock, "ItemID") ?? tagText(group.replace(/<BestOfferArray>[\s\S]*?<\/BestOfferArray>/g, ""), "ItemID");
    const itemEndTime = itemBlock ? tagText(itemBlock, "EndTime") : null;
    for (const b of tagBlocks(group, "BestOffer")) {
      const id = tagText(b, "BestOfferID");
      if (!id) continue;
      const buyer = tagBlocks(b, "Buyer")[0] ?? "";
      offers.push({
        bestOfferId: id,
        itemId,
        codeType: tagText(b, "BestOfferCodeType"),
        buyerUserId: tagText(buyer, "UserID"),
        price: Number(tagText(b, "Price") ?? "0") || 0,
        currency: tagAttr(b, "Price", "currencyID"),
        quantity: Number(tagText(b, "Quantity") ?? "1") || 1,
        status: tagText(b, "Status"),
        expirationTime: tagText(b, "ExpirationTime"),
        buyerMessage: tagText(b, "BuyerMessage"),
        itemEndTime,
      });
    }
  };
  if (groups.length) groups.forEach(scan);
  else scan(xml); // some responses return a bare BestOfferArray
  return { ack, offers };
}

export function parseRespondToBestOffer(xml: string): { ack: TradingAck; callStatus: string | null } {
  return { ack: parseAck(xml), callStatus: tagText(xml, "CallStatus") };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
export function tradingHeaders(callName: string, iafToken: string): Record<string, string> {
  return {
    "X-EBAY-API-CALL-NAME": callName,
    "X-EBAY-API-SITEID": TRADING_SITE_ID_US,
    "X-EBAY-API-COMPATIBILITY-LEVEL": TRADING_COMPATIBILITY_LEVEL,
    "X-EBAY-API-IAF-TOKEN": iafToken,
    "Content-Type": "text/xml",
  };
}

export class EbayTradingError extends Error {
  readonly ack: TradingAck;
  readonly xml: string;
  constructor(message: string, ack: TradingAck, xml: string) {
    super(message);
    this.name = "EbayTradingError";
    this.ack = ack;
    this.xml = xml;
  }
}

/** POST an XML call to /ws/api.dll and return the raw response body (status errors throw). */
export async function callTrading(client: EbayClient, callName: string, xml: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const token = await client.accessToken();
  const res = await fetchImpl(`${client.cfg.hosts.api}/ws/api.dll`, { method: "POST", headers: tradingHeaders(callName, token), body: xml, cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new EbayTradingError(`eBay Trading ${callName} HTTP ${res.status}`, parseAck(text), text);
  return text;
}

export async function getBestOffers(client: EbayClient, opts: Parameters<typeof buildGetBestOffersXml>[0] = {}, fetchImpl?: typeof fetch): Promise<BestOffer[]> {
  const xml = await callTrading(client, "GetBestOffers", buildGetBestOffersXml(opts), fetchImpl);
  const { ack, offers } = parseGetBestOffers(xml);
  if (!ack.ok) {
    // Error 21917122-style "no offers" results are not failures for us.
    const msg = ack.errors.map(e => `${e.code ?? "?"}: ${e.longMessage ?? e.shortMessage ?? ""}`).join("; ");
    throw new EbayTradingError(`GetBestOffers failed: ${msg || ack.ack}`, ack, xml);
  }
  return offers;
}

export async function respondToBestOffer(client: EbayClient, opts: Parameters<typeof buildRespondToBestOfferXml>[0], fetchImpl?: typeof fetch): Promise<{ callStatus: string | null }> {
  const xml = await callTrading(client, "RespondToBestOffer", buildRespondToBestOfferXml(opts), fetchImpl);
  const { ack, callStatus } = parseRespondToBestOffer(xml);
  if (!ack.ok) {
    const msg = ack.errors.map(e => `${e.code ?? "?"}: ${e.longMessage ?? e.shortMessage ?? ""}`).join("; ");
    throw new EbayTradingError(`RespondToBestOffer failed: ${msg || ack.ack}`, ack, xml);
  }
  return { callStatus };
}

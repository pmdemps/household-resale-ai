import { estimateFees } from "../fees.ts";
import { platformName } from "../platforms.ts";
import { money, num } from "../types.ts";

// Pure half of /api/assistant: the shapes the SQL functions return, request validation, and the plain
// sentences ("say") an assistant can read out to the household. Nothing here touches the network, so it
// is unit-tested in assistant.test.ts. Text in this file leaves the app (it is read by a third-party
// assistant), so it stays clean and professional (AGENTS.md).

// ---------------------------------------------------------------------------
// What the database returns (public.assistant_inbox and friends)
// ---------------------------------------------------------------------------
export type InboxOffer = {
  offer_id: string;
  amount: number;
  buyer: string | null;
  received_at: string;
  expires_at: string | null;
  source: string;
  note: string | null;
  is_new: boolean;
  via_api: boolean;
  listing: { id: string; platform: string; list_price: number; url: string | null };
  item: { id: string; name: string; floor_price: number | null; purchase_cost: number };
};

export type InboxTask = {
  task_id: string;
  kind: string;
  title: string;
  detail: string | null;
  created_at: string;
  is_new: boolean;
  item_id: string | null;
  listing_id: string | null;
  requested_by: string;
};

export type InboxListing = {
  listing_id: string;
  item_id: string;
  item: string;
  platform: string;
  status: string;
  list_price: number;
  floor_price: number | null;
  url: string | null;
};

export type Inbox = {
  household: { id: string; name: string } | null;
  member: { id: string; name: string } | null;
  assistant: string;
  checked_at: string;
  new_since: string;
  /** The household has an active eBay connection, so eBay offers pulled through the API can be answered by the app. */
  ebay_connected: boolean;
  pending_offers: InboxOffer[];
  tasks: InboxTask[];
  listings: InboxListing[];
};

export type DecisionResult = {
  offer_id: string;
  decision: "accepted" | "declined" | "countered";
  amount: number;
  counter_amount: number | null;
  buyer: string | null;
  offer_external_id: string | null;
  item: { id: string; name: string; floor_price: number | null };
  listing: { id: string; platform: string; list_price: number; external_id: string | null; url: string | null };
  sale: SaleResult | null;
  tasks_closed: number;
};

export type SaleResult = {
  sale_id: string;
  item_id: string;
  item_name: string;
  listing_id: string;
  platform: string;
  listing_url: string | null;
  sale_price: number;
  platform_fees: number;
  shipping_cost: number;
  payout: number;
  delist_tasks: number;
};

export type RecordOfferResult = {
  offer_id: string;
  duplicate: boolean;
  amount: number;
  item: { id: string; name: string; floor_price?: number | null };
  listing: { id: string; platform: string; list_price: number };
};

// ---------------------------------------------------------------------------
// Enrichment: fee math the household sees in the app, so the assistant quotes the same numbers
// ---------------------------------------------------------------------------
export type OfferMoney = {
  /** What lands in the account after platform fees (no shipping label assumed). */
  payout: number;
  /** payout minus what the item cost. */
  profit: number;
  fees: number;
  /** Discount from the asking price, whole percent. */
  pct_off: number;
  below_floor: boolean;
  /** Payout at the full asking price, for comparison. */
  payout_at_asking: number;
};

export function offerMoney(o: InboxOffer): OfferMoney {
  const amount = num(o.amount);
  const asking = num(o.listing.list_price);
  const cost = num(o.item.purchase_cost);
  const atOffer = estimateFees(o.listing.platform, amount, { itemCost: cost, includeListingFee: false });
  const atAsking = estimateFees(o.listing.platform, asking, { itemCost: cost, includeListingFee: false });
  const floor = o.item.floor_price === null || o.item.floor_price === undefined ? null : num(o.item.floor_price);
  return {
    payout: atOffer.payout,
    profit: atOffer.profit,
    fees: atOffer.totalFees,
    pct_off: asking > 0 ? Math.max(0, Math.round((1 - amount / asking) * 100)) : 0,
    below_floor: floor !== null && amount < floor,
    payout_at_asking: atAsking.payout,
  };
}

export type EnrichedOffer = InboxOffer & { money: OfferMoney; platform_name: string; /** True when the answer can be sent to the marketplace by the app (eBay offers pulled through the API). */ auto_reply: boolean };

export function enrichOffers(offers: InboxOffer[], ebayConnected: boolean): EnrichedOffer[] {
  return offers.map(o => ({
    ...o,
    money: offerMoney(o),
    platform_name: platformName(o.listing.platform),
    auto_reply: ebayConnected && o.listing.platform === "ebay" && o.via_api,
  }));
}

// ---------------------------------------------------------------------------
// Plain sentences for the assistant to relay
// ---------------------------------------------------------------------------
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function describeOffer(o: EnrichedOffer): string {
  const floor = o.item.floor_price === null || o.item.floor_price === undefined ? null : num(o.item.floor_price);
  const parts = [
    `${money(num(o.amount))} for ${o.item.name} on ${o.platform_name}`,
    `asking ${money(num(o.listing.list_price))}${o.money.pct_off > 0 ? `, ${o.money.pct_off}% off` : ""}`,
    `you'd pocket ${money(o.money.payout)} after fees`,
  ];
  if (floor !== null) parts.push(o.money.below_floor ? `BELOW the ${money(floor)} floor` : `floor ${money(floor)}`);
  if (o.buyer) parts.push(`from ${o.buyer}`);
  return parts.join("; ");
}

export function summarizeInbox(inbox: Inbox, offers: EnrichedOffer[]): string {
  const newOffers = offers.filter(o => o.is_new);
  const oldOffers = offers.filter(o => !o.is_new);
  const newTasks = inbox.tasks.filter(t => t.is_new);
  const oldTasks = inbox.tasks.filter(t => !t.is_new);
  if (offers.length === 0 && inbox.tasks.length === 0) return "Nothing waiting: no open offers and no to-dos.";

  const lines: string[] = [];
  if (offers.length) lines.push(`${plural(offers.length, "offer")} waiting${newOffers.length ? ` (${newOffers.length} new)` : ""}.`);
  if (newOffers.length) lines.push(`New: ${newOffers.map(describeOffer).join(" | ")}.`);
  if (oldOffers.length) lines.push(`Still waiting on you: ${oldOffers.map(describeOffer).join(" | ")}.`);
  if (inbox.tasks.length) {
    lines.push(`${plural(inbox.tasks.length, "to-do")}${newTasks.length ? ` (${newTasks.length} new)` : ""}: ${[...newTasks, ...oldTasks].map(t => t.title).join(" | ")}.`);
  }
  return lines.join(" ");
}

export type NextStep = { platform: string; manual: boolean; text: string };

/** What still has to happen on the marketplace after a decision was recorded here. */
export function decisionSay(r: DecisionResult, opts: { ebayUpdated: boolean; ebayError?: string | null }): string {
  const platform = platformName(r.listing.platform);
  const amount = money(num(r.amount));
  const verb = r.decision === "accepted" ? `Accepted ${amount}` : r.decision === "declined" ? `Declined ${amount}` : `Countered ${amount} at ${money(num(r.counter_amount ?? 0))}`;
  const lines = [`${verb} for ${r.item.name} on ${platform}.`];

  if (r.decision === "accepted" && r.sale) {
    lines.push(`Recorded the sale: about ${money(num(r.sale.payout))} after fees.`);
    if (r.sale.delist_tasks > 0) lines.push(`${plural(r.sale.delist_tasks, "other listing")} must come down now (to-do created).`);
  }

  if (opts.ebayUpdated) {
    lines.push("eBay has been updated; the buyer sees your answer there.");
  } else {
    const action = r.decision === "accepted" ? "accept" : r.decision === "declined" ? "decline" : `send the ${money(num(r.counter_amount ?? 0))} counter on`;
    const why = opts.ebayError ? ` (eBay could not be updated: ${opts.ebayError.trim().replace(/\.$/, "")})` : "";
    lines.push(`Recorded here only: the buyer has not been told yet${why}. Someone in the household must ${action} the offer in the ${platform} app.`);
  }
  return lines.join(" ");
}

export function saleSay(s: SaleResult): string {
  const lines = [`Recorded the sale of ${s.item_name} on ${platformName(s.platform)} for ${money(num(s.sale_price))}: about ${money(num(s.payout))} after fees.`];
  if (s.delist_tasks > 0) lines.push(`${plural(s.delist_tasks, "other listing")} must come down now (to-do created).`);
  return lines.join(" ");
}

export function recordOfferSay(r: RecordOfferResult): string {
  if (r.duplicate) return `That ${money(num(r.amount))} offer on ${r.item.name} (${platformName(r.listing.platform)}) was already recorded; nothing added.`;
  return `Recorded a ${money(num(r.amount))} offer on ${r.item.name} (${platformName(r.listing.platform)}, asking ${money(num(r.listing.list_price))}). Ask the household whether to accept, counter or decline.`;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DecisionWord = "accepted" | "declined" | "countered";

/** Accepts the words a person uses ("take it", "yes", "no", "pass", "counter") as well as the stored values. */
export function normalizeDecision(raw: unknown): DecisionWord | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/^(accept(ed)?|take( it)?|yes|yeah|yep|deal|sure|ok(ay)?|sold)$/.test(s)) return "accepted";
  if (/^(decline(d)?|no|nope|nah|pass|reject(ed)?|hell no|fuck no|no thanks)$/.test(s)) return "declined";
  if (/^counter/.test(s)) return "countered";
  return null;
}

export type AssistantAction =
  | { action: "decide"; offer_id: string; decision: DecisionWord; counter_amount: number | null; shipping_cost: number; override_floor: boolean }
  | { action: "record_offer"; listing_id: string; amount: number; buyer: string | null; note: string | null; source: "email" | "agent" | "manual" }
  | { action: "record_sale"; listing_id: string; sale_price: number; shipping_cost: number }
  | { action: "note"; text: string; item_id: string | null }
  | { action: "resolve_task"; task_id: string; status: "approved" | "rejected" | "done" | "cancelled" }
  | { action: "propose_task"; kind: "price_change" | "listing_draft" | "relist" | "message_reply" | "other"; title: string; detail: string | null; item_id: string | null; listing_id: string | null };

export class BadRequest extends Error {}

const str = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().slice(0, max);
  return s.length ? s : null;
};
const uuid = (v: unknown, field: string): string => {
  const s = str(v, 64);
  if (!s || !UUID.test(s)) throw new BadRequest(`${field} must be an id from the inbox (a UUID).`);
  return s.toLowerCase();
};
const optUuid = (v: unknown, field: string): string | null => (v === null || v === undefined || v === "" ? null : uuid(v, field));
const amount = (v: unknown, field: string): number => {
  const n = typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new BadRequest(`${field} must be a non-negative number.`);
  return Math.round(n * 100) / 100;
};
const optAmount = (v: unknown, field: string): number | null => (v === null || v === undefined || v === "" ? null : amount(v, field));

export const ASSISTANT_ACTIONS = ["decide", "record_offer", "record_sale", "note", "resolve_task", "propose_task"] as const;

/** Validates a POST body. Throws BadRequest with a sentence the assistant can act on. */
export function parseAction(body: unknown): AssistantAction {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("Send a JSON object with an \"action\".");
  const b = body as Record<string, unknown>;
  const action = String(b.action ?? "").trim();
  switch (action) {
    case "decide": {
      const decision = normalizeDecision(b.decision);
      if (!decision) throw new BadRequest("decision must be accept, decline or counter.");
      const counter = optAmount(b.counter_amount ?? b.amount, "counter_amount");
      if (decision === "countered" && !(counter && counter > 0)) throw new BadRequest("A counter needs counter_amount above zero.");
      return {
        action,
        offer_id: uuid(b.offer_id, "offer_id"),
        decision,
        counter_amount: decision === "countered" ? counter : null,
        shipping_cost: optAmount(b.shipping_cost, "shipping_cost") ?? 0,
        override_floor: b.override_floor === true,
      };
    }
    case "record_offer": {
      const source = str(b.source, 10) ?? "agent";
      if (!["email", "agent", "manual"].includes(source)) throw new BadRequest("source must be email, agent or manual.");
      return {
        action,
        listing_id: uuid(b.listing_id, "listing_id"),
        amount: amount(b.amount, "amount"),
        buyer: str(b.buyer ?? b.buyer_handle, 120),
        note: str(b.note, 1000),
        source: source as "email" | "agent" | "manual",
      };
    }
    case "record_sale":
      return { action, listing_id: uuid(b.listing_id, "listing_id"), sale_price: amount(b.sale_price ?? b.amount, "sale_price"), shipping_cost: optAmount(b.shipping_cost, "shipping_cost") ?? 0 };
    case "note": {
      const text = str(b.text ?? b.body, 4000);
      if (!text) throw new BadRequest("A note needs text.");
      return { action, text, item_id: optUuid(b.item_id, "item_id") };
    }
    case "resolve_task": {
      const status = str(b.status, 20) ?? "done";
      if (!["approved", "rejected", "done", "cancelled"].includes(status)) throw new BadRequest("status must be approved, rejected, done or cancelled.");
      return { action, task_id: uuid(b.task_id, "task_id"), status: status as "approved" | "rejected" | "done" | "cancelled" };
    }
    case "propose_task": {
      const kind = str(b.kind, 20) ?? "other";
      if (!["price_change", "listing_draft", "relist", "message_reply", "other"].includes(kind)) throw new BadRequest("kind must be price_change, listing_draft, relist, message_reply or other.");
      const title = str(b.title, 300);
      if (!title) throw new BadRequest("A task needs a title.");
      return { action, kind: kind as "price_change" | "listing_draft" | "relist" | "message_reply" | "other", title, detail: str(b.detail, 2000), item_id: optUuid(b.item_id, "item_id"), listing_id: optUuid(b.listing_id, "listing_id") };
    }
    default:
      throw new BadRequest(`Unknown action "${action}". Use one of: ${ASSISTANT_ACTIONS.join(", ")}.`);
  }
}

// ---------------------------------------------------------------------------
// Database errors → HTTP
// ---------------------------------------------------------------------------
export type ApiFailure = { status: number; code: string; error: string; hint?: string };

/** Maps a PostgREST/Postgres error (SQLSTATE in `code`) from the assistant functions to an HTTP answer. */
export function mapDbError(err: { code?: string | null; message?: string | null } | null | undefined): ApiFailure {
  const code = err?.code ?? "";
  const message = (err?.message ?? "Database error").replace(/^[^:]*: /, "").slice(0, 300);
  switch (code) {
    case "28000":
      return { status: 401, code: "unauthorized", error: "This assistant key is not valid or was revoked. Ask a household member for a new one in Settings." };
    case "P0002":
      return { status: 404, code: "not_found", error: message, hint: "Ids come from GET /api/assistant; it may have changed since you last checked." };
    case "P0003":
      return { status: 409, code: "already_done", error: message, hint: "Check the inbox again; this was already handled, maybe by the other household member." };
    case "P0004":
      return { status: 409, code: "below_floor", error: message, hint: "The household set a floor price for this item. Only if the member explicitly says to go below it, repeat the request with override_floor: true." };
    case "22023":
    case "22P02":
    case "23514":
      return { status: 400, code: "bad_request", error: message };
    case "42501": // permission denied
    case "42883": // undefined function
    case "42P01": // undefined table
    case "PGRST202": // PostgREST: function not found in schema cache
      return { status: 500, code: "misconfigured", error: "The database is missing the assistant functions. The app's migrations (supabase/migrations) have not all been applied; tell a household member." };
    default:
      return { status: 500, code: "error", error: message };
  }
}

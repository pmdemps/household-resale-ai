import { summarizeComps, verdictSentence } from "../comps.ts";
import { estimateFees } from "../fees.ts";
import { buildListingCopy, type ListingCopy } from "../listing-copy.ts";
import { MANUAL_PLATFORMS, platformName } from "../platforms.ts";
import { CATEGORIES, CONDITIONS, money, num } from "../types.ts";

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
  item: {
    id: string;
    name: string;
    floor_price: number | null;
    purchase_cost: number;
    /** Whose thing it is; null when it's shared. name is null for a member who hasn't set one. */
    owner?: { id: string; name: string | null; is_you: boolean } | null;
  };
  /** Set when the offer was handed to a member ("that's Lauren's, go ask her"). */
  asked?: { id: string; name: string | null; at: string } | null;
};

export type InboxMember = { id: string; name: string | null; is_you: boolean };

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
  /** Whose thing it is (display name), or null when it's shared or the owner hasn't set a name. */
  owner?: string | null;
  owner_id?: string | null;
};

export type Inbox = {
  household: { id: string; name: string } | null;
  member: { id: string; name: string } | null;
  /** Everyone in the household, so a hand-off can name them. */
  members?: InboxMember[];
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

/** What public.assistant_handoff / handoff_item return. */
export type HandoffResult = {
  item: { id: string; name: string };
  to: { id: string; name: string | null };
  from: { id: string; name: string | null };
  offer: { id: string; amount: number; platform: string; platform_name: string } | null;
  task_id: string | null;
  /** How many of that member's phones have notifications on. */
  devices: number;
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

const OTHER_MEMBER = "the other household member";

/** "Lauren" → "Lauren's", "James" → "James'". */
export function possessive(name: string): string {
  const n = name.trim();
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}

/** "(yours)", "(Lauren's)" or "" for a shared item. */
function ownerTag(owner: { name: string | null; is_you: boolean } | null | undefined): string {
  if (!owner) return "";
  return owner.is_you ? " (yours)" : ` (${possessive(owner.name?.trim() || OTHER_MEMBER)})`;
}

export function describeOffer(o: EnrichedOffer): string {
  const floor = o.item.floor_price === null || o.item.floor_price === undefined ? null : num(o.item.floor_price);
  const parts = [
    `${money(num(o.amount))} for ${o.item.name}${ownerTag(o.item.owner)} on ${o.platform_name}`,
    `asking ${money(num(o.listing.list_price))}${o.money.pct_off > 0 ? `, ${o.money.pct_off}% off` : ""}`,
    `you'd pocket ${money(o.money.payout)} after fees`,
  ];
  if (floor !== null) parts.push(o.money.below_floor ? `BELOW the ${money(floor)} floor` : `floor ${money(floor)}`);
  if (o.buyer) parts.push(`from ${o.buyer}`);
  if (o.asked) parts.push(`${o.asked.name?.trim() || OTHER_MEMBER} has been asked about it`);
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

/** What happened after "that's Lauren's, go ask her". `askedFor` is the name the member used. */
export function handoffSay(r: HandoffResult, askedFor?: string | null): string {
  const to = r.to.name?.trim() || askedFor?.trim() || "The other household member";
  const about = r.offer ? `the ${money(num(r.offer.amount))} offer on ${r.item.name} (${r.offer.platform_name})` : r.item.name;
  const lines = [`Handed ${about} to ${to}.`];
  lines.push(
    r.devices > 0
      ? `${possessive(to)} phone was notified and asked how badly they want to sell it.`
      : `${to} does not have phone notifications on in Resale HQ, so tell them directly.`,
  );
  lines.push(`${r.item.name} is now marked as ${possessive(to)}${r.offer ? "; either of you can still answer the offer" : ""}.`);
  if (!r.to.name) lines.push(`${to} has not set a name in Resale HQ yet (Settings, Your name).`);
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
  | { action: "propose_task"; kind: "price_change" | "listing_draft" | "relist" | "message_reply" | "other"; title: string; detail: string | null; item_id: string | null; listing_id: string | null }
  | { action: "hand_off"; to: string | null; offer_id: string | null; item_id: string | null }
  | { action: "set_platform"; item_id: string; platform: string; on: boolean }
  | { action: "add_item"; name: string; category: string; brand: string | null; size: string | null; condition: string | null; asking: number; floor: number | null; cost: number; notes: string | null }
  | { action: "add_photo"; item_id: string; image_url: string }
  | { action: "add_comp"; item_id: string; platform: string; title: string; price: number; shipping: number | null; url: string | null; kind: "active" | "sold"; condition: string | null; note: string | null };

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

export const ASSISTANT_ACTIONS = ["decide", "record_offer", "record_sale", "note", "resolve_task", "propose_task", "hand_off", "set_platform", "add_comp", "add_item", "add_photo"] as const;

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
    case "hand_off": {
      const offerId = optUuid(b.offer_id, "offer_id");
      const itemId = optUuid(b.item_id, "item_id");
      if (!offerId && !itemId) throw new BadRequest("A hand-off needs offer_id (from pending_offers) or item_id (from listings).");
      return { action, to: str(b.to ?? b.member ?? b.name, 40), offer_id: offerId, item_id: itemId };
    }
    case "set_platform": {
      const platform = normalizePlatformWord(b.platform);
      if (!platform) throw new BadRequest(`platform must be one of: ${SWITCH_PLATFORMS.join(", ")}.`);
      const on = normalizeOnOff(b.on ?? b.wanted ?? b.state);
      if (on === null) throw new BadRequest("on must be true (list it there) or false (take it down).");
      return { action, item_id: uuid(b.item_id, "item_id"), platform, on };
    }
    case "add_item": {
      const name = str(b.name ?? b.title, 200);
      if (!name) throw new BadRequest("An item needs a name, e.g. \"Carhartt work boots\".");
      const asking = optAmount(b.asking ?? b.price ?? b.target_price, "asking") ?? 0;
      const floor = optAmount(b.floor ?? b.floor_price, "floor");
      if (floor !== null && asking > 0 && floor > asking) throw new BadRequest("floor can't be above the asking price.");
      return {
        action, name,
        category: normalizeCategory(b.category),
        brand: str(b.brand, 120), size: str(b.size, 60),
        condition: normalizeCondition(b.condition),
        asking, floor, cost: optAmount(b.cost ?? b.purchase_cost, "cost") ?? 0,
        notes: str(b.notes ?? b.description, 4000),
      };
    }
    case "add_photo": {
      const url = str(b.image_url ?? b.url, 2000);
      if (!url) throw new BadRequest("add_photo needs image_url (an https link to the photo), or send the file as multipart/form-data with a \"file\" field.");
      const check = checkImageUrl(url);
      if (!check.ok) throw new BadRequest(check.reason);
      return { action, item_id: uuid(b.item_id, "item_id"), image_url: check.url };
    }
    case "add_comp": {
      const title = str(b.title, 300);
      if (!title) throw new BadRequest("A comp needs the title of the listing you found.");
      const url = str(b.url, 1000);
      if (url && !/^https:\/\//i.test(url)) throw new BadRequest("url must start with https://");
      const kind = str(b.kind, 10) === "sold" ? "sold" : "active";
      return {
        action,
        item_id: uuid(b.item_id, "item_id"),
        platform: (str(b.platform, 40) ?? "other").toLowerCase(),
        title,
        price: amount(b.price ?? b.amount, "price"),
        shipping: optAmount(b.shipping, "shipping"),
        url,
        kind,
        condition: str(b.condition, 80),
        note: str(b.note, 300),
      };
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

// ---------------------------------------------------------------------------
// Platform switches and comps (migration 20261101040000_assistant_switches_comps.sql)
// ---------------------------------------------------------------------------
export const SWITCH_PLATFORMS = ["ebay", "vinted", "etsy", "facebook", "poshmark", "mercari", "offerup", "thredup", "depop"] as const;

const PLATFORM_ALIASES: Record<string, string> = {
  fb: "facebook", "facebook marketplace": "facebook", marketplace: "facebook", fbmp: "facebook",
  posh: "poshmark", "offer up": "offerup", "thred up": "thredup", "thred-up": "thredup", "offer-up": "offerup",
};

/** "Facebook Marketplace", "posh", "OfferUp" → the platform id, or null. */
export function normalizePlatformWord(v: unknown): string | null {
  const w = String(v ?? "").trim().toLowerCase();
  const id = PLATFORM_ALIASES[w] ?? w.replace(/\s+/g, "");
  return (SWITCH_PLATFORMS as readonly string[]).includes(id) ? id : null;
}

function normalizeOnOff(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  const w = String(v ?? "").trim().toLowerCase();
  if (["on", "true", "yes", "1", "list", "post"].includes(w)) return true;
  if (["off", "false", "no", "0", "remove", "pull", "delist"].includes(w)) return false;
  return null;
}

export type SetPlatformResult = {
  item_id: string;
  item: string;
  platform: string;
  platform_name: string;
  wanted: boolean;
  outcome: "already_live" | "todo_post" | "already_off" | "dropped_draft" | "todo_pull";
  task_id: string | null;
  task_title: string | null;
};

export function setPlatformSay(r: SetPlatformResult): string {
  switch (r.outcome) {
    case "already_live": return `${r.item} is switched on for ${r.platform_name}, and it's already live there.`;
    case "todo_post": return r.platform === "ebay"
      ? `Switched ${r.platform_name} on for ${r.item}. Open the item in Resale HQ and tap Post to eBay (or flip the eBay switch) and the app posts it. It's on the to-do list.`
      : `Switched ${r.platform_name} on for ${r.item}. It's on the to-do list to post; the listing text is ready under "Post it ourselves" on the item page.`;
    case "already_off": return `${r.item} is switched off for ${r.platform_name}. It wasn't listed there, so nothing to pull.`;
    case "dropped_draft": return `Switched ${r.platform_name} off for ${r.item} and dropped the draft that never went up.`;
    case "todo_pull": return r.platform === "ebay"
      ? `Switched ${r.platform_name} off for ${r.item}. Flip the eBay switch off in the app (or tap End listing) and the app ends it. It's on the to-do list.`
      : `Switched ${r.platform_name} off for ${r.item}. It's still up until someone ends it in the ${r.platform_name} app; that's on the to-do list.`;
  }
}

export type FoundItem = { item_id: string; name: string; status: string; category: string; brand: string | null; size: string | null; asking: number; owner: string | null };

export function findItemsSay(items: FoundItem[], query: string | null): string {
  if (items.length === 0) return query ? `No item matching "${query}". Try a shorter word, or the brand.` : "No unsold items yet.";
  if (items.length === 1) return `Found it: ${items[0].name}.`;
  const names = items.slice(0, 5).map(i => i.name).join("; ");
  return `${items.length} matches${query ? ` for "${query}"` : ""}: ${names}${items.length > 5 ? "; and more" : ""}. Which one?`;
}

export type ItemDetailRow = {
  item: { item_id: string; name: string; status: string; category: string; brand: string | null; size: string | null; condition: string | null; asking: number; floor_price: number | null; purchase_cost: number; owner: string | null };
  switches: Record<string, boolean>;
  listings: { listing_id: string; platform: string; status: string; list_price: number; url: string | null }[];
  pending_platform_todos: { task_id: string; kind: string; platform: string | null; title: string }[];
  comps: { platform: string; title: string; price: number; shipping: number | null; url: string | null; condition: string | null; kind: "active" | "sold"; source: string; captured_at: string }[];
  photo_paths: string[];
};

export type ItemDetail = {
  item: ItemDetailRow["item"];
  /** status: the listing row's status ("draft", "active", "paused"), or null when there is none. live = active or paused. */
  platforms: { platform: string; platform_name: string; on: boolean; live: boolean; status: string | null; listing_id: string | null; list_price: number | null; url: string | null; todo: string | null }[];
  comps: {
    count: number;
    lowest: { title: string; price: number; shipping: number | null; platform: string; url: string | null } | null;
    typical: number | null;
    low: number | null;
    high: number | null;
    verdict: "below" | "comparable" | "above" | null;
    sentence: string | null;
    /** Up to five closest-priced comps with links, cheapest first, for "show me the links". */
    links: { title: string; price: number; shipping: number | null; platform: string; url: string; kind: string }[];
  };
  /** Paste-ready text for each platform without an API (clean, buyer-facing). ThredUp has none. */
  listing_text: Record<string, ListingCopy>;
  photos: string[];
};

/** Turns the raw assistant_item row into what the assistant reads: switch states, comp summary, paste-ready text. */
export function buildItemDetail(row: ItemDetailRow, photoUrl: (path: string) => string): ItemDetail {
  const asking = num(row.item.asking);
  const liveBy = new Map(row.listings.map(l => [l.platform, l]));
  const todoBy = new Map(row.pending_platform_todos.filter(t => t.platform).map(t => [t.platform as string, t.title]));
  const platforms = (SWITCH_PLATFORMS as readonly string[]).map(p => {
    const l = liveBy.get(p) ?? null;
    const on = p in row.switches ? row.switches[p] : Boolean(l);
    // "live" means buyers can see it (active or paused); a saved draft that never went up is not live.
    const live = Boolean(l) && l!.status !== "draft";
    return { platform: p, platform_name: platformName(p), on, live, status: l?.status ?? null, listing_id: l?.listing_id ?? null, list_price: l ? num(l.list_price) : null, url: l?.url ?? null, todo: todoBy.get(p) ?? null };
  });

  const comps = row.comps.map(c => ({ ...c, price: num(c.price), shipping: c.shipping === null ? null : num(c.shipping) }));
  const summary = summarizeComps(comps, asking > 0 ? asking : null);
  const withLinks = comps.filter(c => c.url);
  const ref = summary.typical ?? asking;
  const links = [...withLinks]
    .sort((a, b) => Math.abs(a.price - ref) - Math.abs(b.price - ref))
    .slice(0, 5)
    .sort((a, b) => a.price - b.price)
    .map(c => ({ title: c.title, price: c.price, shipping: c.shipping, platform: c.platform, url: c.url as string, kind: c.kind }));

  const copyItem = { name: row.item.name, category: row.item.category, brand: row.item.brand, size: row.item.size, condition: row.item.condition, target_price: asking };
  const listing_text: Record<string, ListingCopy> = {};
  for (const p of MANUAL_PLATFORMS) {
    const copy = buildListingCopy(p.id, copyItem);
    if (copy) listing_text[p.id] = copy;
  }

  return {
    item: row.item,
    platforms,
    comps: {
      count: summary.count,
      lowest: summary.lowest ? { title: summary.lowest.title, price: summary.lowest.price, shipping: summary.lowest.shipping, platform: summary.lowest.platform, url: summary.lowest.url } : null,
      typical: summary.typical,
      low: summary.low,
      high: summary.high,
      verdict: summary.verdict,
      sentence: asking > 0 ? verdictSentence(summary, asking, money) : null,
      links,
    },
    listing_text,
    photos: row.photo_paths.map(photoUrl),
  };
}

export function itemDetailSay(d: ItemDetail): string {
  const on = d.platforms.filter(p => p.on).map(p => p.platform_name + (p.live ? "" : p.status === "draft" ? " (draft, not posted yet)" : " (not up yet)"));
  const where = on.length ? `Switched on: ${on.join(", ")}.` : "Not switched on anywhere yet.";
  if (d.comps.count === 0) return `${d.item.name}: ${where} No comps recorded yet; search for similar listings and send them with add_comp.`;
  const low = d.comps.lowest ? ` Lowest right now is ${money(d.comps.lowest.price)}${d.comps.lowest.platform ? ` on ${platformName(d.comps.lowest.platform)}` : ""}.` : "";
  const typical = d.comps.typical !== null ? ` Typical is ${money(d.comps.typical)} across ${d.comps.count} comps.` : "";
  return `${d.item.name}: ${where}${low}${typical}${d.comps.sentence ? " " + d.comps.sentence : ""}`;
}

// ---------------------------------------------------------------------------
// Adding items and photos (migration 20261101060000_assistant_items_photos.sql)
// ---------------------------------------------------------------------------
/** Matches a category the app knows ("shoes" -> "Shoes", "toys" -> "Toys & games"); anything else is "Other". */
export function normalizeCategory(v: unknown): string {
  const w = String(v ?? "").trim().toLowerCase();
  if (!w) return "Other";
  const exact = CATEGORIES.find(c => c.toLowerCase() === w);
  if (exact) return exact;
  const starts = CATEGORIES.find(c => c.toLowerCase().startsWith(w) || w.startsWith(c.toLowerCase().split(/[ &]/)[0]));
  return starts ?? "Other";
}

/** Matches a condition the app knows ("nwt" -> "New with tags", "used" -> "Good"); unknown stays as written. */
export function normalizeCondition(v: unknown): string | null {
  const w = String(v ?? "").trim();
  if (!w) return null;
  const l = w.toLowerCase();
  const alias: Record<string, string> = { nwt: "New with tags", nwot: "New without tags", new: "New without tags", "like-new": "Like new", used: "Good", "for parts": "For parts" };
  if (alias[l]) return alias[l];
  return CONDITIONS.find(c => c.toLowerCase() === l) ?? w.slice(0, 60);
}

/** Largest photo the server downloads or accepts (the item-photos bucket's own limit). */
export const MAX_ASSISTANT_PHOTO_BYTES = 10 * 1024 * 1024;

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[.*\])$/i;

/** Only public https links are fetched: no http, no IP-literal or private hosts, no credentials in the URL. */
export function checkImageUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, reason: "image_url isn't a valid link." }; }
  if (u.protocol !== "https:") return { ok: false, reason: "image_url must start with https://" };
  if (u.username || u.password) return { ok: false, reason: "image_url can't contain a username or password." };
  if (PRIVATE_HOST.test(u.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return { ok: false, reason: "image_url must be a public web address, not an IP or local address." };
  return { ok: true, url: u.toString() };
}

export type AddItemResult = { item_id: string; name: string; duplicate: boolean };
export type RecordPhotoResult = { photo_id: string; item_id: string; position: number; photo_count: number; storage_path: string };

export function addItemSay(r: AddItemResult): string {
  return r.duplicate
    ? `${r.name} was already added a moment ago, so I used that one. Send photos to item ${r.item_id}.`
    : `Added ${r.name} to Resale HQ as a draft. Send its photos next.`;
}

export function photoSay(r: RecordPhotoResult, itemName?: string | null): string {
  const what = itemName ? ` for ${itemName}` : "";
  return r.position === 0
    ? `Saved the first photo${what}; it's the cover photo.`
    : `Saved photo ${r.photo_count}${what}.`;
}

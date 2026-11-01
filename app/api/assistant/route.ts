import { NextResponse, type NextRequest } from "next/server";
import { assistantKeyFromHeaders } from "@/lib/assistant/keys";
import {
  BadRequest,
  decisionSay,
  enrichOffers,
  handoffSay,
  parseAction,
  recordOfferSay,
  saleSay,
  summarizeInbox,
  type AssistantAction,
  type DecisionResult,
  type HandoffResult,
  type Inbox,
  type RecordOfferResult,
  type SaleResult,
} from "@/lib/assistant/protocol";
import { AssistantApiError, callAssistantFunction } from "@/lib/assistant/server";
import { isEbayConfigured } from "@/lib/ebay/config";
import { respondToEbayOfferDecision } from "@/lib/ebay/respond";
import { estimateFees } from "@/lib/fees";
import { platformName } from "@/lib/platforms";
import { createServiceClient } from "@/lib/supabase/service";
import { money, num } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// The household's personal assistant (Muse, ChatGPT, ...) talks to Resale HQ here.
//
//   GET  /api/assistant            what needs a decision (offers, to-dos) and the live listings; `?peek=1`
//                                  leaves the "new since last check" watermark alone.
//   POST /api/assistant            { action: decide | record_offer | record_sale | note | resolve_task | propose_task | hand_off, ... }
//
// Credential: an assistant key from Settings, sent as `Authorization: Bearer <key>` (or `X-Assistant-Key`).
// The key is checked inside the database functions, which also attribute every write to the member who owns
// it (decided_by / actor_user) with actor_agent = the key's label. Floor prices are enforced there too.
//
// Every answer carries `say`: one or two plain sentences the assistant can relay as-is. Text here leaves the
// app, so it stays clean (AGENTS.md). Paste-ready instructions for the assistant: docs/agents/assistant-concierge.md.

type Json = Record<string, unknown>;

const json = (body: Json, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

const HELP = {
  authentication: "Authorization: Bearer <assistant key from Settings>",
  get: "GET /api/assistant (add ?peek=1 to look without marking items as seen)",
  post: {
    decide: { offer_id: "<from pending_offers>", decision: "accept | decline | counter", counter_amount: "number, for counter", override_floor: "true only when the member explicitly allows going below the floor price" },
    record_offer: { listing_id: "<from listings>", amount: "number", buyer: "optional", note: "optional, e.g. the email subject", source: "email | agent | manual" },
    record_sale: { listing_id: "<from listings>", sale_price: "number", shipping_cost: "optional number" },
    note: { text: "string", item_id: "optional" },
    resolve_task: { task_id: "<from tasks>", status: "done | approved | rejected | cancelled" },
    propose_task: { kind: "message_reply | price_change | listing_draft | relist | other", title: "string", detail: "optional", item_id: "optional", listing_id: "optional" },
    hand_off: { to: "a household member's name (blank = the only other member)", offer_id: "<from pending_offers>", item_id: "<from listings>, when there is no offer" },
  },
};

function unauthorized() {
  return json({ ok: false, code: "unauthorized", error: "Missing or malformed assistant key. Send it as 'Authorization: Bearer <key>'. A household member creates keys in Settings.", help: HELP }, 401);
}

function failure(e: unknown) {
  if (e instanceof BadRequest) return json({ ok: false, code: "bad_request", error: e.message, help: HELP.post }, 400);
  if (e instanceof AssistantApiError) return json({ ok: false, ...e.failure, status: undefined }, e.failure.status);
  console.error("[api/assistant]", e);
  return json({ ok: false, code: "error", error: "Something went wrong on the server. Try again in a minute." }, 500);
}

/** True when this deployment can carry eBay decisions to eBay for this household. */
function canAutoReplyOnEbay(inbox: Inbox): boolean {
  return inbox.ebay_connected && isEbayConfigured() && createServiceClient() !== null;
}

async function loadInbox(key: string, markSeen: boolean): Promise<Inbox> {
  return callAssistantFunction<Inbox>("assistant_inbox", { p_key: key, p_mark_seen: markSeen });
}

export async function GET(request: NextRequest) {
  const key = assistantKeyFromHeaders(request.headers);
  if (!key) return unauthorized();
  try {
    const peek = request.nextUrl.searchParams.get("peek") === "1";
    const inbox = await loadInbox(key, !peek);
    const offers = enrichOffers(inbox.pending_offers, canAutoReplyOnEbay(inbox));
    return json({
      ok: true,
      say: summarizeInbox(inbox, offers),
      household: inbox.household,
      member: inbox.member,
      members: inbox.members ?? [],
      assistant: inbox.assistant,
      checked_at: inbox.checked_at,
      new_since: inbox.new_since,
      counts: {
        pending_offers: offers.length,
        new_offers: offers.filter(o => o.is_new).length,
        pending_tasks: inbox.tasks.length,
        new_tasks: inbox.tasks.filter(t => t.is_new).length,
      },
      pending_offers: offers,
      tasks: inbox.tasks,
      listings: inbox.listings.map(l => ({ ...l, platform_name: platformName(l.platform) })),
      ebay_auto_reply: canAutoReplyOnEbay(inbox),
      help: HELP,
    });
  } catch (e) {
    return failure(e);
  }
}

export async function POST(request: NextRequest) {
  const key = assistantKeyFromHeaders(request.headers);
  if (!key) return unauthorized();
  let action: AssistantAction;
  try {
    action = parseAction(await request.json().catch(() => { throw new BadRequest("The body must be JSON."); }));
  } catch (e) {
    return failure(e);
  }
  try {
    switch (action.action) {
      case "decide": return await decide(key, action);
      case "record_offer": return await recordOffer(key, action);
      case "record_sale": return await recordSale(key, action);
      case "note": {
        const r = await callAssistantFunction<{ note_id: string; item_id: string | null }>("assistant_add_note", { p_key: key, p_body: action.text, p_item_id: action.item_id });
        return json({ ok: true, say: action.item_id ? "Saved the comment on the item." : "Saved the note for the household.", result: r });
      }
      case "resolve_task": {
        const r = await callAssistantFunction<{ task_id: string; kind: string; status: string }>("assistant_resolve_task", { p_key: key, p_task_id: action.task_id, p_status: action.status });
        const extra = r.kind === "delist" && r.status === "done" ? " The listing is marked ended here." : "";
        return json({ ok: true, say: `Marked that to-do as ${r.status}.${extra}`, result: r });
      }
      case "propose_task": {
        const r = await callAssistantFunction<{ task_id: string; duplicate: boolean; title: string }>("assistant_propose_task", {
          p_key: key, p_kind: action.kind, p_title: action.title, p_detail: action.detail, p_item_id: action.item_id, p_listing_id: action.listing_id,
        });
        return json({ ok: true, say: r.duplicate ? `"${r.title}" is already on the to-do list.` : `Added "${r.title}" to the household's to-do list.`, result: r });
      }
      case "hand_off": {
        const r = await callAssistantFunction<HandoffResult>("assistant_handoff", {
          p_key: key, p_to: action.to, p_offer_id: action.offer_id, p_item_id: action.item_id,
        });
        return json({ ok: true, say: handoffSay(r, action.to), result: r });
      }
    }
  } catch (e) {
    return failure(e);
  }
}

async function decide(key: string, a: Extract<AssistantAction, { action: "decide" }>) {
  // Fees are the app's business (lib/fees.ts), so look the offer up first and pass the estimate in.
  const inbox = await loadInbox(key, false);
  const offer = inbox.pending_offers.find(o => o.offer_id === a.offer_id);
  const fees = offer && a.decision === "accepted" ? estimateFees(offer.listing.platform, num(offer.amount), { sellerShippingCost: a.shipping_cost }).totalFees : 0;

  const result = await callAssistantFunction<DecisionResult>("assistant_decide_offer", {
    p_key: key,
    p_offer_id: a.offer_id,
    p_decision: a.decision,
    p_counter_amount: a.counter_amount,
    p_platform_fees: fees,
    p_shipping_cost: a.shipping_cost,
    p_override_floor: a.override_floor,
  });

  // eBay Best Offers pulled through the API: carry the answer to eBay when this deployment can.
  let ebayUpdated = false;
  let ebayError: string | null = null;
  const isEbayApiOffer = result.listing.platform === "ebay" && Boolean(result.offer_external_id);
  if (isEbayApiOffer) {
    const service = isEbayConfigured() ? createServiceClient() : null;
    if (!service) {
      ebayError = isEbayConfigured() ? "eBay sync is not set up on the server (SUPABASE_SERVICE_ROLE_KEY)." : "eBay is not connected to this app yet.";
    } else if (inbox.household && inbox.member) {
      const outcome = await respondToEbayOfferDecision(service, {
        householdId: inbox.household.id,
        actorUser: inbox.member.id,
        offerId: result.offer_id,
        bestOfferId: String(result.offer_external_id),
        ebayItemId: result.listing.external_id,
        decision: result.decision,
        counterAmount: result.counter_amount,
      });
      ebayUpdated = outcome.ok;
      ebayError = outcome.ok ? null : outcome.error;
    }
  }

  const manual = !ebayUpdated;
  return json({
    ok: true,
    say: decisionSay(result, { ebayUpdated, ebayError }),
    result,
    marketplace: {
      platform: result.listing.platform,
      platform_name: platformName(result.listing.platform),
      updated_by_app: ebayUpdated,
      error: ebayError,
      // What a household member still has to do by hand. Assistants must not automate marketplace sites or apps.
      manual_step: manual
        ? `${result.decision === "accepted" ? "Accept" : result.decision === "declined" ? "Decline" : `Counter at ${money(num(result.counter_amount ?? 0))}`} the ${money(num(result.amount))} offer in the ${platformName(result.listing.platform)} app${result.listing.url ? ` (${result.listing.url})` : ""}.`
        : null,
    },
  });
}

async function recordOffer(key: string, a: Extract<AssistantAction, { action: "record_offer" }>) {
  const r = await callAssistantFunction<RecordOfferResult>("assistant_record_offer", {
    p_key: key, p_listing_id: a.listing_id, p_amount: a.amount, p_buyer_handle: a.buyer, p_note: a.note, p_source: a.source,
  });
  const est = estimateFees(r.listing.platform, num(r.amount), { includeListingFee: false });
  const floor = r.item.floor_price === null || r.item.floor_price === undefined ? null : num(r.item.floor_price);
  return json({
    ok: true,
    say: recordOfferSay(r) + (r.duplicate ? "" : ` They'd pocket about ${money(est.payout)} after fees${floor !== null ? (num(r.amount) < floor ? `; note this is BELOW the ${money(floor)} floor` : `; floor is ${money(floor)}`) : ""}.`),
    result: { ...r, money: { payout: est.payout, fees: est.totalFees, below_floor: floor !== null && num(r.amount) < floor } },
  });
}

async function recordSale(key: string, a: Extract<AssistantAction, { action: "record_sale" }>) {
  const inbox = await loadInbox(key, false);
  const listing = inbox.listings.find(l => l.listing_id === a.listing_id);
  const fees = listing ? estimateFees(listing.platform, a.sale_price, { sellerShippingCost: a.shipping_cost }).totalFees : 0;
  const r = await callAssistantFunction<SaleResult>("assistant_record_sale", {
    p_key: key, p_listing_id: a.listing_id, p_sale_price: a.sale_price, p_platform_fees: fees, p_shipping_cost: a.shipping_cost,
  });
  return json({ ok: true, say: saleSay(r), result: r });
}

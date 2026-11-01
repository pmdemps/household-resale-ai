import { NextResponse, type NextRequest } from "next/server";
import { assistantKeyFromHeaders } from "@/lib/assistant/keys";
import {
  BadRequest,
  addItemSay,
  photoSay,
  buildItemDetail,
  findItemsSay,
  itemDetailSay,
  setPlatformSay,
  decisionSay,
  enrichOffers,
  handoffSay,
  parseAction,
  recordOfferSay,
  saleSay,
  summarizeInbox,
  type AssistantAction,
  type DecisionResult,
  type AddItemResult,
  type FoundItem,
  type ItemDetailRow,
  type SetPlatformResult,
  type HandoffResult,
  type Inbox,
  type RecordOfferResult,
  type SaleResult,
} from "@/lib/assistant/protocol";
import { AssistantApiError, callAssistantFunction } from "@/lib/assistant/server";
import { downloadImage, storeAssistantPhoto } from "@/lib/assistant/photos";
import { isEbayConfigured } from "@/lib/ebay/config";
import { respondToEbayOfferDecision } from "@/lib/ebay/respond";
import { estimateFees } from "@/lib/fees";
import { platformName } from "@/lib/platforms";
import { publicPhotoUrl } from "@/lib/photos";
import { createServiceClient } from "@/lib/supabase/service";
import { money, num } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// The household's personal assistant (Muse, ChatGPT, ...) talks to Resale HQ here.
//
//   GET  /api/assistant            what needs a decision (offers, to-dos) and the live listings; `?peek=1`
//                                  leaves the "new since last check" watermark alone.
//   GET  /api/assistant?find=nike  unsold items matching a name or brand (ids for the calls below)
//   GET  /api/assistant?item_id=…  one item in full: platform switches, live listings, what others sell it for
//                                  (lowest, typical, verdict, links) and paste-ready listing text per platform
//   POST /api/assistant            { action: decide | record_offer | record_sale | note | resolve_task | propose_task | hand_off
//                                    | set_platform | add_comp | add_item | add_photo, ... }
//   POST /api/assistant (multipart)  action=add_photo, item_id, file: the photo itself (under ~4 MB, Vercel's cap)
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
  find: "GET /api/assistant?find=<words from the item name or brand> → items with item_id (also finds things not listed anywhere yet)",
  item: "GET /api/assistant?item_id=<id> → platform switches, live listings, comps (lowest, typical, verdict, links) and paste-ready listing text",
  post: {
    decide: { offer_id: "<from pending_offers>", decision: "accept | decline | counter", counter_amount: "number, for counter", override_floor: "true only when the member explicitly allows going below the floor price" },
    record_offer: { listing_id: "<from listings>", amount: "number", buyer: "optional", note: "optional, e.g. the email subject", source: "email | agent | manual" },
    record_sale: { listing_id: "<from listings>", sale_price: "number", shipping_cost: "optional number" },
    note: { text: "string", item_id: "optional" },
    resolve_task: { task_id: "<from tasks>", status: "done | approved | rejected | cancelled" },
    propose_task: { kind: "message_reply | price_change | listing_draft | relist | other", title: "string", detail: "optional", item_id: "optional", listing_id: "optional" },
    hand_off: { to: "a household member's name (blank = the only other member)", offer_id: "<from pending_offers>", item_id: "<from listings>, when there is no offer" },
    set_platform: { item_id: "<from find or listings>", platform: "ebay | mercari | poshmark | offerup | facebook | vinted | etsy | thredup | depop", on: "true to list it there, false to take it down" },
    add_item: { name: "what it is, e.g. Carhartt work boots", category: "Clothing | Shoes | Toys & games | Kids & baby | Home & kitchen | Electronics | Tools | Books & media | Collectibles | Other", brand: "optional", size: "optional", condition: "New with tags | New without tags | Like new | Good | Fair | For parts", asking: "optional number", floor: "optional number, lowest we'd take", cost: "optional number, what we paid", notes: "optional" },
    add_photo: { item_id: "<from add_item, find or listings>", image_url: "https link to the photo; it is downloaded right away, so a temporary link is fine. Or POST multipart/form-data with action=add_photo, item_id and a file field (under 4 MB). JPEG, PNG or WebP, up to 10 MB by link; longest side 2000 px is plenty." },
    add_comp: { item_id: "<from find or listings>", title: "the other listing's title", price: "number (item price, not including shipping)", shipping: "optional number, 0 = free", url: "https link to the listing", platform: "where it's listed", kind: "active | sold", condition: "optional" },
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
    const params = request.nextUrl.searchParams;
    if (params.has("find")) {
      const q = (params.get("find") ?? "").trim().slice(0, 100) || null;
      const items = await callAssistantFunction<FoundItem[]>("assistant_find_items", { p_key: key, p_query: q });
      return json({ ok: true, say: findItemsSay(items, q), items, help: HELP });
    }
    if (params.has("item_id")) {
      const itemId = (params.get("item_id") ?? "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(itemId)) return failure(new BadRequest("item_id must be an id from find or listings (a UUID)."));
      const row = await callAssistantFunction<ItemDetailRow>("assistant_item", { p_key: key, p_item_id: itemId });
      const detail = buildItemDetail(row, publicPhotoUrl);
      return json({ ok: true, say: itemDetailSay(detail), ...detail, help: HELP });
    }
    const peek = params.get("peek") === "1";
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
  if ((request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return uploadPhoto(key, request);
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
      case "set_platform": {
        const r = await callAssistantFunction<SetPlatformResult>("assistant_set_platform", {
          p_key: key, p_item_id: action.item_id, p_platform: action.platform, p_wanted: action.on,
        });
        return json({ ok: true, say: setPlatformSay(r), result: r });
      }
      case "add_item": {
        const r = await callAssistantFunction<AddItemResult>("assistant_add_item", {
          p_key: key, p_name: action.name, p_category: action.category, p_brand: action.brand, p_size: action.size,
          p_condition: action.condition, p_asking: action.asking, p_floor: action.floor, p_cost: action.cost, p_notes: action.notes,
        });
        return json({ ok: true, say: addItemSay(r), result: r });
      }
      case "add_photo": {
        const bytes = await downloadImage(action.image_url);
        const r = await storeAssistantPhoto(key, action.item_id, bytes);
        return json({ ok: true, say: photoSay(r), result: r });
      }
      case "add_comp": {
        const r = await callAssistantFunction<{ comp_id: string; item_id: string }>("assistant_add_comp", {
          p_key: key, p_item_id: action.item_id, p_platform: action.platform, p_title: action.title, p_price: action.price,
          p_shipping: action.shipping, p_url: action.url, p_kind: action.kind, p_condition: action.condition, p_note: action.note,
        });
        return json({ ok: true, say: `Saved that comp (${money(action.price)}${action.shipping !== null ? ` + ${money(action.shipping)} shipping` : ""}) on the item.`, result: r });
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

/** multipart/form-data upload: action=add_photo, item_id, file. Kept under Vercel's ~4.5 MB request cap by the sender. */
async function uploadPhoto(key: string, request: NextRequest) {
  try {
    let form: FormData;
    try { form = await request.formData(); } catch { throw new BadRequest("Couldn't read the upload. Send multipart/form-data with action, item_id and file."); }
    const action = String(form.get("action") ?? "add_photo");
    if (action !== "add_photo") throw new BadRequest("File uploads are only for action add_photo.");
    const itemId = String(form.get("item_id") ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(itemId)) throw new BadRequest("item_id must be an id from add_item, find or listings (a UUID).");
    const file = form.get("file") ?? form.get("photo") ?? form.get("image");
    if (!file || typeof file === "string") throw new BadRequest("Attach the photo in a field called \"file\".");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await storeAssistantPhoto(key, itemId, bytes);
    return json({ ok: true, say: photoSay(r), result: r });
  } catch (e) {
    return failure(e);
  }
}

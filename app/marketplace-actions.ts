"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireHousehold } from "@/lib/household";
import { loadPhotos } from "@/lib/photos";
import { num, type InventoryItem, type Listing } from "@/lib/types";
import {
  buildInventoryItemBody,
  buildOfferBody,
  createOffer,
  EbayReauthError,
  ensureInventoryLocation,
  getCategorySuggestions,
  getFirstPolicies,
  getOffersForSku,
  merchantLocationKey,
  offerUpdateBody,
  publishOffer,
  putInventoryItem,
  updateOffer,
  updateOfferPrice,
  withdrawOffer,
} from "@/lib/ebay/api";
import { ebayListingUrl, isEbayConfigured, readEbayConfig } from "@/lib/ebay/config";
import { ebayClientFor, isUsableConnection, loadEbayConnection, loadShipFrom, writeSyncState } from "@/lib/ebay/connection";
import { setEbayNotice } from "@/lib/ebay/notice";
import { syncEbayOffers } from "@/lib/ebay/sync";

// Server actions for marketplace integrations (eBay today). Every outside effect here happens because a
// household member clicked a button, so no agent_task is created; results are logged to activity_log.
// Errors are surfaced through a short-lived notice cookie read by the eBay components, then we redirect.

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

function text(form: FormData, key: string, max = 500): string {
  return String(form.get(key) ?? "").trim().slice(0, max);
}
function optAmount(form: FormData, key: string): number | null {
  const raw = String(form.get(key) ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
  return Math.round(n * 100) / 100;
}
async function log(ctx: Ctx, action: string, entityType: string, entityId: string | null, detail: Record<string, unknown> = {}) {
  await ctx.supabase.from("activity_log").insert({ household_id: ctx.household.id, actor_user: ctx.userId, action, entity_type: entityType, entity_id: entityId, detail });
}

/** Run an eBay action; on failure log it, leave a notice for the UI, and still redirect (never a 500 page). */
async function withEbayNotice(ctx: Ctx, backTo: string, entity: { type: string; id: string | null }, fn: () => Promise<string>): Promise<never> {
  try {
    const okMessage = await fn();
    await setEbayNotice("ok", okMessage);
  } catch (e) {
    const message = e instanceof EbayReauthError ? e.message : `eBay: ${(e as Error).message}`.slice(0, 400);
    console.error("[marketplace-actions]", message);
    await log(ctx, "ebay_action_failed", entity.type, entity.id, { error: message.slice(0, 500), action: backTo });
    await setEbayNotice("error", message);
  }
  revalidatePath(backTo);
  revalidatePath("/");
  redirect(backTo);
}

async function requireEbay(ctx: Ctx) {
  if (!isEbayConfigured()) throw new Error("eBay is not set up on this deployment yet (see docs/ebay-setup.md).");
  const conn = await loadEbayConnection(ctx.supabase, ctx.household.id);
  if (!isUsableConnection(conn)) throw new EbayReauthError("eBay isn't connected for your household. Go to Settings → Marketplaces → Connect eBay.");
  return { conn, client: ebayClientFor(ctx.supabase, conn), cfg: readEbayConfig() };
}

/** Public HTTPS photo URLs for eBay, cover first. HEIC is skipped (eBay rejects it). */
async function listingImageUrls(ctx: Ctx, itemId: string): Promise<string[]> {
  const photos = await loadPhotos(ctx, itemId);
  return photos.filter(p => !/\.heic$/i.test(p.storage_path) && /^https:\/\//i.test(p.url)).map(p => p.url).slice(0, 24);
}

// ---------------------------------------------------------------------------
// Post an item to eBay: location → inventory item → offer → publish → listings row
// ---------------------------------------------------------------------------
export async function postItemToEbay(form: FormData) {
  const ctx = await requireHousehold();
  const itemId = text(form, "item_id", 64);
  const backTo = `/inventory/${itemId}`;
  return withEbayNotice(ctx, backTo, { type: "item", id: itemId }, async () => {
    const { conn, client, cfg } = await requireEbay(ctx);
    const { data: itemRow, error: itemErr } = await ctx.supabase.from("inventory_items").select("*").eq("household_id", ctx.household.id).eq("id", itemId).maybeSingle();
    if (itemErr) throw new Error(itemErr.message);
    const item = itemRow as InventoryItem | null;
    if (!item) throw new Error("That item isn't in your household.");
    if (item.status === "sold") throw new Error("This item is already sold.");

    const price = optAmount(form, "list_price") ?? num(item.target_price);
    if (!(price > 0)) throw new Error("Set an asking price first.");
    const floor = item.floor_price === null ? null : num(item.floor_price);
    if (floor !== null && floor > price) throw new Error("The floor price is above the list price. Lower the floor or raise the price.");

    const imageUrls = await listingImageUrls(ctx, itemId);
    if (imageUrls.length === 0) throw new Error("Add at least one photo first (JPEG, PNG or WebP). eBay needs a picture to publish.");

    const { data: existing } = await ctx.supabase.from("listings").select("id, status").eq("item_id", itemId).eq("platform", "ebay").in("status", ["draft", "active", "paused"]).maybeSingle();
    if (existing?.status === "active") throw new Error("This item is already live on eBay.");

    // Ship-from location: saved once per household (Settings → eBay). Defaults are a placeholder the owner must set.
    const shipFrom = await loadShipFrom(ctx.supabase, ctx.household.id);
    if (!shipFrom) throw new Error("Set your ship-from city, state and ZIP under Settings → Marketplaces → eBay first.");
    const locationKey = merchantLocationKey(ctx.household.id, shipFrom.postalCode);
    await ensureInventoryLocation(client, locationKey, shipFrom);

    const sku = item.id; // SKU = our item id (≤50 chars)
    await putInventoryItem(client, sku, buildInventoryItemBody(item, imageUrls));

    const policies = await getFirstPolicies(client);
    let categoryId = text(form, "category_id", 20) || cfg.defaultCategoryId;
    if (!text(form, "category_id", 20) && cfg.env === "production") {
      try {
        const suggestions = await getCategorySuggestions(cfg, [item.brand, item.name].filter(Boolean).join(" "));
        if (suggestions[0]) categoryId = suggestions[0].categoryId;
      } catch {
        /* keep the default category */
      }
    }

    const offerBody = buildOfferBody({ sku, categoryId, price, floorPrice: floor, merchantLocationKey: locationKey, policies });
    const current = (await getOffersForSku(client, sku))[0];
    let offerId: string;
    if (current) {
      // An unpublished/withdrawn offer already exists for this SKU: refresh it instead of creating a duplicate.
      offerId = current.offerId;
      await updateOffer(client, offerId, offerUpdateBody(current, offerBody));
    } else {
      offerId = await createOffer(client, offerBody);
    }
    const listingId = await publishOffer(client, offerId);
    const url = ebayListingUrl(listingId, conn.environment);
    const now = new Date().toISOString();

    const row = {
      household_id: ctx.household.id,
      item_id: itemId,
      platform: "ebay",
      status: "active",
      list_price: price,
      listing_url: url,
      external_id: listingId,
      external_offer_id: offerId,
      sku,
      listed_at: now,
      ended_at: null,
      created_by: ctx.userId,
    };
    const saved = existing
      ? await ctx.supabase.from("listings").update(row).eq("id", existing.id).select("id").single()
      : await ctx.supabase.from("listings").insert(row).select("id").single();
    if (saved.error) throw new Error(`Published on eBay (${url}) but could not save the listing here: ${saved.error.message}`);
    await ctx.supabase.from("inventory_items").update({ status: "listed" }).eq("id", itemId).in("status", ["draft", "researching"]);
    await log(ctx, "ebay_listing_published", "listing", saved.data!.id, { listingId, offerId, price, floor, environment: conn.environment, categoryId, photos: imageUrls.length });
    return `Boom, it's live on eBay at $${price.toFixed(2)}${floor !== null ? ` (offers under $${floor.toFixed(2)} auto-declined)` : ""}.`;
  });
}

// ---------------------------------------------------------------------------
// Price change on a live eBay listing (keeps auto-decline at the floor)
// ---------------------------------------------------------------------------
export async function updateEbayPrice(form: FormData) {
  const ctx = await requireHousehold();
  const listingId = text(form, "listing_id", 64);
  const itemId = text(form, "item_id", 64);
  const backTo = `/inventory/${itemId}`;
  return withEbayNotice(ctx, backTo, { type: "listing", id: listingId }, async () => {
    const { client } = await requireEbay(ctx);
    const price = optAmount(form, "list_price");
    if (price === null || !(price > 0)) throw new Error("Enter a price above zero.");
    const { data } = await ctx.supabase.from("listings").select("*, inventory_items(floor_price)").eq("household_id", ctx.household.id).eq("id", listingId).eq("platform", "ebay").maybeSingle();
    const listing = data as (Listing & { inventory_items: { floor_price: number | null } | null }) | null;
    if (!listing?.external_offer_id) throw new Error("This listing was not published through Resale HQ, so its price can't be changed here.");
    const floorRaw = listing.inventory_items?.floor_price ?? null;
    const floor = floorRaw === null ? null : num(floorRaw);
    if (floor !== null && price < floor) throw new Error(`That price is below your floor of $${floor.toFixed(2)}.`);
    await updateOfferPrice(client, listing.external_offer_id, price, floor);
    const { error } = await ctx.supabase.from("listings").update({ list_price: price }).eq("id", listingId);
    if (error) throw new Error(error.message);
    await log(ctx, "ebay_price_updated", "listing", listingId, { price, previous: num(listing.list_price) });
    return `eBay price updated to $${price.toFixed(2)}.`;
  });
}

// ---------------------------------------------------------------------------
// End a live eBay listing (withdraw the offer; the inventory item stays for relisting)
// ---------------------------------------------------------------------------
export async function endEbayListing(form: FormData) {
  const ctx = await requireHousehold();
  const listingId = text(form, "listing_id", 64);
  const itemId = text(form, "item_id", 64);
  const backTo = `/inventory/${itemId}`;
  return withEbayNotice(ctx, backTo, { type: "listing", id: listingId }, async () => {
    const { client } = await requireEbay(ctx);
    const { data } = await ctx.supabase.from("listings").select("*").eq("household_id", ctx.household.id).eq("id", listingId).eq("platform", "ebay").maybeSingle();
    const listing = data as Listing | null;
    if (!listing) throw new Error("Listing not found.");
    if (!listing.external_offer_id) throw new Error("This listing was not published through Resale HQ. End it in the eBay app, then mark it ended here.");
    await withdrawOffer(client, listing.external_offer_id);
    const now = new Date().toISOString();
    const { error } = await ctx.supabase.from("listings").update({ status: "ended", ended_at: now }).eq("id", listingId);
    if (error) throw new Error(error.message);
    await ctx.supabase.from("agent_tasks").update({ status: "done", decided_by: ctx.userId, decided_at: now }).eq("listing_id", listingId).eq("kind", "delist").eq("status", "pending");
    await log(ctx, "ebay_listing_ended", "listing", listingId, { listingId: listing.external_id });
    return "eBay listing ended.";
  });
}

// ---------------------------------------------------------------------------
// Manual "Sync offers now" (same logic as the cron route, scoped to this household, user session)
// ---------------------------------------------------------------------------
export async function syncEbayOffersNow(form: FormData) {
  const ctx = await requireHousehold();
  // Only a same-origin path: "//host" or "/\host" would be a protocol-relative redirect off the site.
  const requested = text(form, "back_to", 200);
  const backTo = /^\/(?![\/\\])[^\s]*$/.test(requested) ? requested : "/settings";
  return withEbayNotice(ctx, backTo, { type: "household", id: ctx.household.id }, async () => {
    const { conn } = await requireEbay(ctx);
    const r = await syncEbayOffers(ctx.supabase, conn, { actorUser: ctx.userId, actorAgent: null });
    revalidatePath("/offers");
    const parts = [`${r.newOffers} new offer${r.newOffers === 1 ? "" : "s"}`, `${r.listingsChecked} listing${r.listingsChecked === 1 ? "" : "s"} checked`];
    if (r.expiredOffers) parts.push(`${r.expiredOffers} expired`);
    if (r.errors.length) parts.push(`${r.errors.length} error${r.errors.length === 1 ? "" : "s"}: ${r.errors[0]}`);
    return `eBay sync done: ${parts.join(", ")}.`;
  });
}

// ---------------------------------------------------------------------------
// Ship-from location (needed once before the first eBay listing)
// ---------------------------------------------------------------------------
export async function saveEbayShipFrom(form: FormData) {
  const ctx = await requireHousehold();
  return withEbayNotice(ctx, "/settings", { type: "household", id: ctx.household.id }, async () => {
    const city = text(form, "city", 80);
    const stateOrProvince = text(form, "state", 40).toUpperCase();
    const postalCode = text(form, "postal_code", 12);
    if (!city || !stateOrProvince || !/^\d{5}(-\d{4})?$/.test(postalCode)) throw new Error("Enter a city, a 2-letter state and a 5-digit ZIP.");
    await writeSyncState(ctx.supabase, ctx.household.id, "ebay_ship_from", { city, stateOrProvince, postalCode });
    await log(ctx, "ebay_ship_from_saved", "household", ctx.household.id, { city, stateOrProvince });
    return "Ship-from location saved.";
  });
}

// ---------------------------------------------------------------------------
// Disconnect: forget the tokens (eBay keeps the listings; revoke app access at ebay.com if wanted)
// ---------------------------------------------------------------------------
export async function disconnectEbay() {
  const ctx = await requireHousehold();
  return withEbayNotice(ctx, "/settings", { type: "household", id: ctx.household.id }, async () => {
    const { error } = await ctx.supabase
      .from("marketplace_connections")
      .update({ status: "revoked", access_token_enc: null, refresh_token_enc: null, access_expires_at: null, refresh_expires_at: null, last_error: "Disconnected by a household member" })
      .eq("household_id", ctx.household.id)
      .eq("platform", "ebay");
    if (error) throw new Error(error.message);
    await log(ctx, "ebay_disconnected", "household", ctx.household.id);
    return "eBay disconnected. Your listings stay on eBay; reconnect any time.";
  });
}

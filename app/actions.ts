"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContext, requireHousehold } from "@/lib/household";
import type { DecisionResult } from "@/lib/assistant/protocol";
import { isEbayConfigured } from "@/lib/ebay/config";
import { respondToEbayOfferDecision } from "@/lib/ebay/respond";
import { estimateFees } from "@/lib/fees";
import { PLATFORMS } from "@/lib/platforms";
import { noteListingRecorded } from "@/lib/platform-wants";
import { CATEGORIES, ITEM_STATUSES, LISTING_STATUSES, num } from "@/lib/types";

const PLATFORM_IDS = PLATFORMS.map(p => p.id) as string[];

function text(form: FormData, key: string, max = 500): string {
  return String(form.get(key) ?? "").trim().slice(0, max);
}
function optText(form: FormData, key: string, max = 500): string | null {
  const v = text(form, key, max);
  return v.length ? v : null;
}
function amount(form: FormData, key: string): number {
  const n = Number(form.get(key));
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
  return Math.round(n * 100) / 100;
}
function optAmount(form: FormData, key: string): number | null {
  const raw = String(form.get(key) ?? "").trim();
  return raw === "" ? null : amount(form, key);
}
function fail(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;
async function log(ctx: Ctx, action: string, entityType: string, entityId: string | null, detail: Record<string, unknown> = {}) {
  await ctx.supabase.from("activity_log").insert({
    household_id: ctx.household.id,
    actor_user: ctx.userId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    detail,
  });
}

// ---------------------------------------------------------------------------
// Household
// ---------------------------------------------------------------------------
export async function createHousehold(form: FormData) {
  const ctx = await getContext();
  const name = text(form, "name", 120) || "Our household";
  const { data: householdId, error } = await ctx.supabase.rpc("create_household", { p_name: name });
  fail(error);
  const displayName = text(form, "display_name", 40);
  if (displayName && householdId) {
    await ctx.supabase.from("household_members").update({ display_name: displayName })
      .eq("household_id", householdId).eq("user_id", ctx.userId);
  }
  redirect("/");
}

export async function addMemberByEmail(form: FormData): Promise<void> {
  const ctx = await requireHousehold();
  const email = text(form, "email", 320);
  if (!email) return;
  const { data, error } = await ctx.supabase.rpc("add_household_member_by_email", {
    p_household_id: ctx.household.id,
    p_email: email,
    p_role: "member",
  });
  fail(error);
  if (!data) redirect("/settings?member=not_found");
  await log(ctx, "member_added", "household", ctx.household.id, { email });
  redirect("/settings?member=added");
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
function itemFields(form: FormData) {
  const category = text(form, "category", 60);
  return {
    name: text(form, "name", 200),
    category: (CATEGORIES as readonly string[]).includes(category) ? category : "Other",
    brand: optText(form, "brand", 120),
    size: optText(form, "size", 40),
    condition: optText(form, "condition", 40),
    storage_location: optText(form, "storage_location", 120),
    weight_oz: optAmount(form, "weight_oz"),
    source: text(form, "source", 120) || "Household",
    purchase_cost: optAmount(form, "purchase_cost") ?? 0,
    target_price: optAmount(form, "target_price") ?? 0,
    floor_price: optAmount(form, "floor_price"),
    notes: optText(form, "notes", 4000),
  };
}

export async function createItem(form: FormData) {
  const ctx = await requireHousehold();
  const fields = itemFields(form);
  if (!fields.name) throw new Error("Item name is required");
  const { data, error } = await ctx.supabase
    .from("inventory_items")
    .insert({ ...fields, household_id: ctx.household.id, created_by: ctx.userId, status: "draft" })
    .select("id")
    .single();
  fail(error);
  await log(ctx, "item_created", "item", data!.id, { name: fields.name });
  revalidatePath("/");
  // Photos are added on the item page: the browser uploads them straight to Storage (components/photo-uploader.tsx),
  // which keeps multi-megabyte phone photos clear of the server-action body limit. ?saved=1 shows the nudge.
  redirect(form.get("another") ? "/inventory/new?added=1" : `/inventory/${data!.id}?saved=1`);
}

export async function updateItem(form: FormData) {
  const ctx = await requireHousehold();
  const id = text(form, "id", 64);
  const fields = itemFields(form);
  const status = text(form, "status", 30);
  const patch = { ...fields, ...((ITEM_STATUSES as readonly string[]).includes(status) ? { status } : {}) };
  const { error } = await ctx.supabase.from("inventory_items").update(patch).eq("id", id).eq("household_id", ctx.household.id);
  fail(error);
  await log(ctx, "item_updated", "item", id);
  revalidatePath(`/inventory/${id}`);
  redirect(`/inventory/${id}`);
}

/** "Whose shit is it?" on the item page: a member's id, or blank for ours. The database checks they're in the household. */
export async function setItemOwner(form: FormData) {
  const ctx = await requireHousehold();
  const id = text(form, "item_id", 64);
  const owner = optText(form, "owner_user", 64);
  fail((await ctx.supabase.from("inventory_items").update({ owner_user: owner }).eq("id", id).eq("household_id", ctx.household.id)).error);
  await log(ctx, "item_owner_set", "item", id, { owner_user: owner });
  revalidatePath(`/inventory/${id}`);
  revalidatePath("/offers");
  revalidatePath("/");
}

/**
 * "That's Lauren's, go ask her": marks the thing as theirs and buzzes only their phone with
 * "<you> says this is your shit. How badly do you wanna sell it?". Anyone can still answer the offer.
 */
export async function handOffOffer(form: FormData) {
  const ctx = await requireHousehold();
  const offerId = text(form, "offer_id", 64);
  const to = text(form, "to_user", 64);
  const { data, error } = await ctx.supabase.rpc("handoff_item", { p_household_id: ctx.household.id, p_to: to, p_offer_id: offerId });
  fail(error);
  const itemId = (data as { item?: { id?: string } } | null)?.item?.id;
  revalidatePath("/");
  revalidatePath("/offers");
  if (itemId) revalidatePath(`/inventory/${itemId}`);
}

export async function setItemStatus(form: FormData) {
  const ctx = await requireHousehold();
  const id = text(form, "id", 64);
  const status = text(form, "status", 30);
  if (!(ITEM_STATUSES as readonly string[]).includes(status)) throw new Error("Invalid status");
  const { error } = await ctx.supabase.from("inventory_items").update({ status }).eq("id", id).eq("household_id", ctx.household.id);
  fail(error);
  await log(ctx, "item_status", "item", id, { status });
  revalidatePath(`/inventory/${id}`);
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------
export async function addListing(form: FormData) {
  const ctx = await requireHousehold();
  const itemId = text(form, "item_id", 64);
  const platform = text(form, "platform", 20);
  if (!PLATFORM_IDS.includes(platform)) throw new Error("Unknown platform");
  const status = text(form, "status", 20) === "active" ? "active" : "draft";
  const { data, error } = await ctx.supabase
    .from("listings")
    .insert({
      household_id: ctx.household.id,
      item_id: itemId,
      platform,
      status,
      list_price: amount(form, "list_price"),
      listing_url: optText(form, "listing_url", 1000),
      listed_at: status === "active" ? new Date().toISOString() : null,
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error?.code === "23505") throw new Error("This item already has a live listing on that platform.");
  fail(error);
  if (status === "active") {
    await ctx.supabase.from("inventory_items").update({ status: "listed" }).eq("id", itemId).in("status", ["draft", "researching"]);
  }
  await noteListingRecorded(ctx, itemId, platform).catch(() => {}); // wants table may not be migrated yet
  await log(ctx, "listing_added", "listing", data!.id, { platform, status });
  revalidatePath(`/inventory/${itemId}`);
  revalidatePath("/");
}

export async function updateListing(form: FormData) {
  const ctx = await requireHousehold();
  const id = text(form, "id", 64);
  const itemId = text(form, "item_id", 64);
  const status = text(form, "status", 20);
  const patch: Record<string, unknown> = {};
  if (form.has("list_price")) patch.list_price = amount(form, "list_price");
  if (form.has("listing_url")) patch.listing_url = optText(form, "listing_url", 1000);
  if ((LISTING_STATUSES as readonly string[]).includes(status)) {
    patch.status = status;
    if (status === "active") patch.listed_at = new Date().toISOString();
    if (status === "ended" || status === "sold") patch.ended_at = new Date().toISOString();
  }
  const { error } = await ctx.supabase.from("listings").update(patch).eq("id", id).eq("household_id", ctx.household.id);
  fail(error);
  if (patch.status === "active") {
    await ctx.supabase.from("inventory_items").update({ status: "listed" }).eq("id", itemId).in("status", ["draft", "researching"]);
  }
  await log(ctx, "listing_updated", "listing", id, patch);
  revalidatePath(`/inventory/${itemId}`);
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------
export async function recordOffer(form: FormData) {
  const ctx = await requireHousehold();
  const listingId = text(form, "listing_id", 64);
  const itemId = text(form, "item_id", 64);
  const offerAmount = amount(form, "amount");
  const { data, error } = await ctx.supabase
    .from("offers")
    .insert({
      household_id: ctx.household.id,
      listing_id: listingId,
      amount: offerAmount,
      buyer_handle: optText(form, "buyer_handle", 120),
      note: optText(form, "note", 1000),
      source: "manual",
    })
    .select("id")
    .single();
  fail(error);
  await ctx.supabase.from("agent_tasks").insert({
    household_id: ctx.household.id,
    kind: "offer_decision",
    title: `Decide on $${offerAmount.toFixed(2)} offer`,
    listing_id: listingId,
    offer_id: data!.id,
    item_id: itemId || null,
    requested_by: "human",
  });
  await log(ctx, "offer_recorded", "offer", data!.id, { amount: offerAmount });
  revalidatePath("/offers");
  if (itemId) revalidatePath(`/inventory/${itemId}`);
}

/**
 * Accept / decline / counter an offer. The work happens in the database function public.decide_offer
 * (supabase/migrations/20261031000000_assistant_access.sql): offer status, the sale with the fees estimated
 * here, item and listing marked sold, other pending offers declined, "delist" tasks for every other live
 * listing so the item can't be sold twice, and the activity log entry. The same core serves the assistant
 * API (app/api/assistant), so a decision tapped here and one relayed by Muse do exactly the same thing.
 * A member looking at the lowball warning may still take an offer below the floor (override true).
 */
export async function decideOffer(form: FormData) {
  const ctx = await requireHousehold();
  const offerId = text(form, "offer_id", 64);
  const decision = text(form, "decision", 20);
  if (!["accepted", "declined", "countered"].includes(decision)) throw new Error("Invalid decision");
  const counter = decision === "countered" ? amount(form, "counter_amount") : null;
  const shippingCost = optAmount(form, "shipping_cost") ?? 0;

  let fees = 0;
  if (decision === "accepted") {
    const { data: offer, error } = await ctx.supabase
      .from("offers")
      .select("amount, listings!inner(platform)")
      .eq("id", offerId)
      .eq("household_id", ctx.household.id)
      .single();
    fail(error);
    const platform = (offer?.listings as unknown as { platform?: string } | null)?.platform ?? "other";
    fees = estimateFees(platform, num(offer?.amount), { sellerShippingCost: shippingCost }).totalFees;
  }

  const { data, error } = await ctx.supabase.rpc("decide_offer", {
    p_offer_id: offerId,
    p_decision: decision,
    p_counter_amount: counter,
    p_platform_fees: fees,
    p_shipping_cost: shippingCost,
    p_override_floor: true,
  });
  fail(error);
  const result = data as DecisionResult;

  // eBay integration: if this is a Best Offer we pulled from eBay (offers.external_id = BestOfferID) and the
  // household has an active eBay connection, carry the human's decision to eBay (RespondToBestOffer).
  // The local decision above is already recorded; a failure here is logged to activity_log and noted on the
  // task (see lib/ebay/respond.ts) rather than thrown, so the page never errors because eBay was unreachable.
  if (result.listing.platform === "ebay" && result.offer_external_id && isEbayConfigured()) {
    await respondToEbayOfferDecision(ctx.supabase, {
      householdId: ctx.household.id,
      actorUser: ctx.userId,
      offerId,
      bestOfferId: String(result.offer_external_id),
      ebayItemId: result.listing.external_id,
      decision,
      counterAmount: result.counter_amount,
    });
  }
  revalidatePath("/");
  revalidatePath("/offers");
  revalidatePath(`/inventory/${result.item.id}`);
}

// ---------------------------------------------------------------------------
// Direct sale (no offer, e.g. bought at list price)
// ---------------------------------------------------------------------------
export async function recordSale(form: FormData) {
  const ctx = await requireHousehold();
  const listingId = text(form, "listing_id", 64);
  const { data: listing, error } = await ctx.supabase.from("listings").select("id, item_id, platform").eq("id", listingId).single();
  fail(error);
  const salePrice = amount(form, "sale_price");
  const shippingCost = optAmount(form, "shipping_cost") ?? 0;
  const feesOverride = optAmount(form, "platform_fees");
  const fees = feesOverride ?? estimateFees(listing!.platform, salePrice, { sellerShippingCost: shippingCost }).totalFees;
  // Shared core (public.record_sale → apply_sale): sale row, listing + item marked sold, pending offers
  // declined, delist tasks for the item's other live listings, activity log. Same path as the assistant API.
  const { error: saleErr } = await ctx.supabase.rpc("record_sale", {
    p_listing_id: listingId,
    p_sale_price: salePrice,
    p_platform_fees: fees,
    p_shipping_cost: shippingCost,
  });
  fail(saleErr);
  revalidatePath("/");
  revalidatePath(`/inventory/${listing!.item_id}`);
}

// ---------------------------------------------------------------------------
// Approval queue
// ---------------------------------------------------------------------------
export async function resolveTask(form: FormData) {
  const ctx = await requireHousehold();
  const id = text(form, "id", 64);
  const status = text(form, "status", 20);
  if (!["approved", "rejected", "done", "cancelled"].includes(status)) throw new Error("Invalid status");
  const { data: task } = await ctx.supabase.from("agent_tasks").select("kind, listing_id").eq("id", id).single();
  fail((await ctx.supabase.from("agent_tasks").update({ status, decided_by: ctx.userId, decided_at: new Date().toISOString() }).eq("id", id)).error);
  // Marking a delist task done means the listing has been taken down.
  if (task?.kind === "delist" && status === "done" && task.listing_id) {
    await ctx.supabase.from("listings").update({ status: "ended", ended_at: new Date().toISOString() }).eq("id", task.listing_id);
  }
  await log(ctx, `task_${status}`, "agent_task", id);
  revalidatePath("/");
  revalidatePath("/offers");
}

export async function signOut() {
  const ctx = await getContext();
  await ctx.supabase.auth.signOut();
  redirect("/login");
}

// ---------------------------------------------------------------------------
// Notes & comments (household-only; never sent to marketplaces)
// ---------------------------------------------------------------------------
export async function addNote(form: FormData) {
  const ctx = await requireHousehold();
  const body = text(form, "body", 4000);
  if (!body) return;
  const itemId = optText(form, "item_id", 64);
  const { data, error } = await ctx.supabase
    .from("notes")
    .insert({ household_id: ctx.household.id, item_id: itemId, author: ctx.userId, body })
    .select("id")
    .single();
  fail(error);
  await log(ctx, itemId ? "comment_added" : "note_added", "note", data!.id, { item_id: itemId });
  revalidatePath("/notes");
  revalidatePath("/");
  if (itemId) revalidatePath(`/inventory/${itemId}`);
}

export async function toggleNotePin(form: FormData) {
  const ctx = await requireHousehold();
  const id = text(form, "id", 64);
  const pinned = text(form, "pinned", 5) === "true";
  fail((await ctx.supabase.from("notes").update({ pinned }).eq("id", id).eq("household_id", ctx.household.id)).error);
  revalidatePath("/notes");
  revalidatePath("/");
}

export async function deleteNote(form: FormData) {
  const ctx = await requireHousehold();
  const id = text(form, "id", 64);
  const itemId = optText(form, "item_id", 64);
  fail((await ctx.supabase.from("notes").delete().eq("id", id).eq("household_id", ctx.household.id)).error);
  revalidatePath("/notes");
  revalidatePath("/");
  if (itemId) revalidatePath(`/inventory/${itemId}`);
}

export async function setDisplayName(form: FormData) {
  const ctx = await requireHousehold();
  const name = text(form, "display_name", 40);
  fail(
    (
      await ctx.supabase
        .from("household_members")
        .update({ display_name: name || null })
        .eq("household_id", ctx.household.id)
        .eq("user_id", ctx.userId)
    ).error,
  );
  revalidatePath("/", "layout");
  redirect("/settings?name=saved");
}

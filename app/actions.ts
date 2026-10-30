"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getContext, requireHousehold } from "@/lib/household";
import { isEbayConfigured } from "@/lib/ebay/config";
import { respondToEbayOfferDecision } from "@/lib/ebay/respond";
import { estimateFees } from "@/lib/fees";
import { PLATFORMS, platformName } from "@/lib/platforms";
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
  await log(ctx, "listing_added", "listing", data!.id, { platform, status });
  revalidatePath(`/inventory/${itemId}`);
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
 * Accept / decline / counter an offer. Accepting records the sale with estimated fees,
 * marks the item sold, and queues "delist" tasks for every other live listing so the
 * item can't be sold twice.
 */
export async function decideOffer(form: FormData) {
  const ctx = await requireHousehold();
  const offerId = text(form, "offer_id", 64);
  const decision = text(form, "decision", 20);
  if (!["accepted", "declined", "countered"].includes(decision)) throw new Error("Invalid decision");

  const { data: offer, error: offerErr } = await ctx.supabase
    .from("offers")
    .select("*, listings!inner(id, item_id, platform, status, external_id)")
    .eq("id", offerId)
    .eq("household_id", ctx.household.id)
    .single();
  fail(offerErr);
  if (!offer || offer.status !== "pending") throw new Error("This offer has already been decided.");
  const listing = offer.listings as { id: string; item_id: string; platform: string };
  const now = new Date().toISOString();

  const patch: Record<string, unknown> = { status: decision, decided_at: now, decided_by: ctx.userId };
  if (decision === "countered") patch.counter_amount = amount(form, "counter_amount");
  fail((await ctx.supabase.from("offers").update(patch).eq("id", offerId)).error);

  if (decision === "accepted") {
    const salePrice = num(offer.amount);
    const shippingCost = optAmount(form, "shipping_cost") ?? 0;
    const fees = estimateFees(listing.platform, salePrice, { sellerShippingCost: shippingCost });
    fail(
      (
        await ctx.supabase.from("sales").insert({
          household_id: ctx.household.id,
          item_id: listing.item_id,
          listing_id: listing.id,
          platform: listing.platform,
          sale_price: salePrice,
          platform_fees: fees.totalFees,
          shipping_cost: shippingCost,
          sold_at: now,
          created_by: ctx.userId,
        })
      ).error,
    );
    await ctx.supabase.from("listings").update({ status: "sold", ended_at: now }).eq("id", listing.id);
    await ctx.supabase.from("inventory_items").update({ status: "sold", sold_price: salePrice, sold_at: now }).eq("id", listing.item_id);
    // Decline other pending offers on this listing.
    await ctx.supabase.from("offers").update({ status: "declined", decided_at: now, decided_by: ctx.userId })
      .eq("listing_id", listing.id).eq("status", "pending");

    const { data: others } = await ctx.supabase
      .from("listings")
      .select("id, platform")
      .eq("item_id", listing.item_id)
      .neq("id", listing.id)
      .in("status", ["draft", "active", "paused"]);
    if (others?.length) {
      await ctx.supabase.from("agent_tasks").insert(
        others.map(o => ({
          household_id: ctx.household.id,
          kind: "delist",
          title: `Remove sold item from ${platformName(o.platform)}`,
          listing_id: o.id,
          item_id: listing.item_id,
          requested_by: "system",
          detail: "Item sold on another platform. End this listing now to avoid selling it twice.",
        })),
      );
    }
  }

  await ctx.supabase.from("agent_tasks").update({ status: "done", decided_by: ctx.userId, decided_at: now })
    .eq("offer_id", offerId).eq("status", "pending");
  await log(ctx, `offer_${decision}`, "offer", offerId, { amount: num(offer.amount), counter: patch.counter_amount ?? null });

  // eBay integration: if this is a Best Offer we pulled from eBay (offers.external_id = BestOfferID) and the
  // household has an active eBay connection, carry the human's decision to eBay (RespondToBestOffer).
  // The local decision above is already recorded; a failure here is logged to activity_log and noted on the
  // task (see lib/ebay/respond.ts) rather than thrown, so the page never errors because eBay was unreachable.
  if (listing.platform === "ebay" && offer.external_id && isEbayConfigured()) {
    await respondToEbayOfferDecision(ctx.supabase, {
      householdId: ctx.household.id,
      actorUser: ctx.userId,
      offerId,
      bestOfferId: String(offer.external_id),
      ebayItemId: (offer.listings as { external_id?: string | null }).external_id ?? null,
      decision,
      counterAmount: (patch.counter_amount as number | undefined) ?? null,
    });
  }
  revalidatePath("/");
  revalidatePath("/offers");
  revalidatePath(`/inventory/${listing.item_id}`);
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
  const now = new Date().toISOString();
  fail(
    (
      await ctx.supabase.from("sales").insert({
        household_id: ctx.household.id,
        item_id: listing!.item_id,
        listing_id: listing!.id,
        platform: listing!.platform,
        sale_price: salePrice,
        platform_fees: fees,
        shipping_cost: shippingCost,
        sold_at: now,
        created_by: ctx.userId,
      })
    ).error,
  );
  await ctx.supabase.from("listings").update({ status: "sold", ended_at: now }).eq("id", listing!.id);
  await ctx.supabase.from("inventory_items").update({ status: "sold", sold_price: salePrice, sold_at: now }).eq("id", listing!.item_id);
  const { data: others } = await ctx.supabase.from("listings").select("id, platform")
    .eq("item_id", listing!.item_id).neq("id", listing!.id).in("status", ["draft", "active", "paused"]);
  if (others?.length) {
    await ctx.supabase.from("agent_tasks").insert(others.map(o => ({
      household_id: ctx.household.id, kind: "delist", title: `Remove sold item from ${platformName(o.platform)}`,
      listing_id: o.id, item_id: listing!.item_id, requested_by: "system",
      detail: "Item sold on another platform. End this listing now to avoid selling it twice.",
    })));
  }
  await log(ctx, "sale_recorded", "sale", listing!.item_id, { platform: listing!.platform, salePrice });
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

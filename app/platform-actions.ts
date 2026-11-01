"use server";

// Platform toggles (item page): "I want this on Mercari, not on Poshmark." Flipping a switch records what we
// want (item_platform_wants) and then closes the gap between that and what's actually live (listings):
//   eBay, connected   post or end the listing now through the existing human-triggered eBay actions
//   anything else     a to-do that buzzes the phones: "Post it on Mercari" / "Pull it off Poshmark"
// Agents read item_platform_gaps and do the same, except they never touch the sites (AGENTS.md).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { endEbayListing, postItemToEbay } from "@/app/marketplace-actions";
import { isEbayConfigured } from "@/lib/ebay/config";
import { isUsableConnection, loadEbayConnection } from "@/lib/ebay/connection";
import { requireHousehold } from "@/lib/household";
import { platformById, PLATFORMS } from "@/lib/platforms";
import { type InventoryItem, type Listing } from "@/lib/types";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;
const LIVE = ["draft", "active", "paused"];

function text(form: FormData, key: string, max = 100): string {
  return String(form.get(key) ?? "").trim().slice(0, max);
}
async function log(ctx: Ctx, action: string, entityType: string, entityId: string | null, detail: Record<string, unknown> = {}) {
  await ctx.supabase.from("activity_log").insert({ household_id: ctx.household.id, actor_user: ctx.userId, action, entity_type: entityType, entity_id: entityId, detail });
}

/** A pending to-do of this kind for this item and platform, if there is one. */
async function pendingTask(ctx: Ctx, itemId: string, platform: string, kind: "listing_draft" | "delist") {
  const { data } = await ctx.supabase
    .from("agent_tasks")
    .select("id")
    .eq("household_id", ctx.household.id)
    .eq("item_id", itemId)
    .eq("kind", kind)
    .eq("status", "pending")
    .contains("payload", { platform })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function cancelTask(ctx: Ctx, id: string | null, why: string) {
  if (!id) return;
  await ctx.supabase.from("agent_tasks").update({ status: "cancelled", decided_by: ctx.userId, decided_at: new Date().toISOString(), detail: why }).eq("id", id);
}

/** Flip a platform on or off for an item. Form: item_id, platform, wanted ("1" or "0"). */
export async function setPlatformWant(form: FormData) {
  const ctx = await requireHousehold();
  const itemId = text(form, "item_id", 64);
  const platform = text(form, "platform", 40);
  const wanted = text(form, "wanted", 1) === "1";
  if (!PLATFORMS.some(p => p.id === platform && p.id !== "other")) throw new Error("Unknown platform");

  const { data: itemRow, error: itemErr } = await ctx.supabase.from("inventory_items").select("*").eq("household_id", ctx.household.id).eq("id", itemId).maybeSingle();
  if (itemErr) throw new Error(itemErr.message);
  const item = itemRow as InventoryItem | null;
  if (!item) throw new Error("That item isn't in your household.");
  if (item.status === "sold") throw new Error("It already sold. Nothing to list.");

  const { error: upErr } = await ctx.supabase
    .from("item_platform_wants")
    .upsert({ household_id: ctx.household.id, item_id: itemId, platform, wanted, set_by: ctx.userId, updated_at: new Date().toISOString() }, { onConflict: "item_id,platform" });
  if (upErr) throw new Error(upErr.message);
  await log(ctx, wanted ? "platform_on" : "platform_off", "item", itemId, { platform });

  const { data: liveRows } = await ctx.supabase.from("listings").select("*").eq("household_id", ctx.household.id).eq("item_id", itemId).eq("platform", platform).in("status", LIVE).limit(1);
  const live = (liveRows?.[0] ?? null) as Listing | null;
  const name = platformById(platform).name;
  const backTo = `/inventory/${itemId}`;

  if (wanted) {
    // Switched on: drop any "pull it off" to-do, then get it listed.
    await cancelTask(ctx, await pendingTask(ctx, itemId, platform, "delist"), `Switched ${name} back on.`);
    if (live) { revalidatePath(backTo); redirect(backTo); }

    if (platform === "ebay" && isEbayConfigured() && isUsableConnection(await loadEbayConnection(ctx.supabase, ctx.household.id).catch(() => null))) {
      const f = new FormData();
      f.set("item_id", itemId);
      return postItemToEbay(f); // posts now and redirects back with a notice
    }

    if (!(await pendingTask(ctx, itemId, platform, "listing_draft"))) {
      const { error } = await ctx.supabase.from("agent_tasks").insert({
        household_id: ctx.household.id,
        kind: "listing_draft",
        title: `Post "${item.name}" on ${name}`,
        detail: `We switched ${name} on for this. The listing text is ready under "Post it ourselves" on the item page. Paste it in, then tap "We posted it".`,
        payload: { platform, reason: "switched_on" },
        item_id: itemId,
        requested_by: "human",
      });
      if (error) throw new Error(error.message);
    }
  } else {
    // Switched off: drop any "post it" to-do, then get it taken down.
    await cancelTask(ctx, await pendingTask(ctx, itemId, platform, "listing_draft"), `Switched ${name} off.`);
    if (!live) { revalidatePath(backTo); redirect(backTo); }

    if (platform === "ebay" && live.external_offer_id && isEbayConfigured()) {
      const f = new FormData();
      f.set("listing_id", live.id);
      f.set("item_id", itemId);
      return endEbayListing(f); // ends it now (also closes delist to-dos) and redirects back
    }

    if (live.status === "draft") {
      // Never went up anywhere; just drop the draft.
      await ctx.supabase.from("listings").update({ status: "ended", ended_at: new Date().toISOString() }).eq("id", live.id);
    } else if (!(await pendingTask(ctx, itemId, platform, "delist"))) {
      const { error } = await ctx.supabase.from("agent_tasks").insert({
        household_id: ctx.household.id,
        kind: "delist",
        title: `Pull "${item.name}" off ${name}, we turned it off`,
        detail: `End the listing in the ${name} app, then mark this done and the app records it as ended.`,
        payload: { platform, reason: "switched_off" },
        item_id: itemId,
        listing_id: live.id,
        requested_by: "human",
      });
      if (error) throw new Error(error.message);
    }
  }

  revalidatePath(backTo);
  revalidatePath("/");
  redirect(backTo);
}

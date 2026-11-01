import "server-only";
import type { requireHousehold } from "@/lib/household";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

/**
 * Called when a listing is recorded by hand ("We posted it on Mercari"): the switch is on now, and any
 * "post it" to-do for that platform is done.
 */
export async function noteListingRecorded(ctx: Ctx, itemId: string, platform: string) {
  await ctx.supabase
    .from("item_platform_wants")
    .upsert({ household_id: ctx.household.id, item_id: itemId, platform, wanted: true, set_by: ctx.userId, updated_at: new Date().toISOString() }, { onConflict: "item_id,platform" });
  await ctx.supabase
    .from("agent_tasks")
    .update({ status: "done", decided_by: ctx.userId, decided_at: new Date().toISOString() })
    .eq("household_id", ctx.household.id)
    .eq("item_id", itemId)
    .eq("kind", "listing_draft")
    .eq("status", "pending")
    .contains("payload", { platform });
}

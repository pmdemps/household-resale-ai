import "server-only";
import type { AppContext } from "@/lib/household";
import type { OfferWithContext } from "@/components/offer-card";
import type { AgentTask, InventoryItem, Listing, Sale } from "@/lib/types";
import { num } from "@/lib/types";

type Ctx = AppContext & { household: { id: string } };

type RawOffer = {
  id: string; amount: number; buyer_handle: string | null; received_at: string; note: string | null;
  listings: {
    id: string; platform: string; list_price: number; listing_url: string | null;
    inventory_items: { id: string; name: string; purchase_cost: number; floor_price: number | null };
  };
};

export async function loadPendingOffers(ctx: Ctx, itemId?: string): Promise<OfferWithContext[]> {
  let q = ctx.supabase
    .from("offers")
    .select("id, amount, buyer_handle, received_at, note, listings!inner(id, platform, list_price, listing_url, item_id, inventory_items!inner(id, name, purchase_cost, floor_price))")
    .eq("household_id", ctx.household.id)
    .eq("status", "pending")
    .order("received_at", { ascending: false });
  if (itemId) q = q.eq("listings.item_id", itemId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as RawOffer[]).map(o => ({
    id: o.id,
    amount: num(o.amount),
    buyer_handle: o.buyer_handle,
    received_at: o.received_at,
    note: o.note,
    listing: { id: o.listings.id, platform: o.listings.platform, list_price: num(o.listings.list_price), listing_url: o.listings.listing_url },
    item: {
      id: o.listings.inventory_items.id,
      name: o.listings.inventory_items.name,
      purchase_cost: num(o.listings.inventory_items.purchase_cost),
      floor_price: o.listings.inventory_items.floor_price === null ? null : num(o.listings.inventory_items.floor_price),
    },
  }));
}

export async function loadOverview(ctx: Ctx) {
  const hid = ctx.household.id;
  const [items, listings, sales, tasks, activity] = await Promise.all([
    ctx.supabase.from("inventory_items").select("id, status, purchase_cost, target_price").eq("household_id", hid),
    ctx.supabase.from("listings").select("id, status, list_price, platform").eq("household_id", hid),
    ctx.supabase.from("sales").select("*").eq("household_id", hid).order("sold_at", { ascending: false }),
    ctx.supabase.from("agent_tasks").select("*").eq("household_id", hid).eq("status", "pending").neq("kind", "offer_decision").order("created_at", { ascending: false }),
    ctx.supabase.from("activity_log").select("*").eq("household_id", hid).order("created_at", { ascending: false }).limit(12),
  ]);
  for (const r of [items, listings, sales, tasks, activity]) if (r.error) throw new Error(r.error.message);

  const itemRows = (items.data ?? []) as Pick<InventoryItem, "id" | "status" | "purchase_cost" | "target_price">[];
  const listingRows = (listings.data ?? []) as Pick<Listing, "id" | "status" | "list_price" | "platform">[];
  const saleRows = (sales.data ?? []) as Sale[];
  const costById = new Map(itemRows.map(i => [i.id, num(i.purchase_cost)]));

  const unsold = itemRows.filter(i => !["sold", "donated", "discarded", "returned"].includes(i.status));
  const active = listingRows.filter(l => l.status === "active");
  const revenue = saleRows.reduce((s, x) => s + num(x.sale_price) + num(x.shipping_charged), 0);
  const payout = saleRows.reduce(
    (s, x) => s + num(x.sale_price) + num(x.shipping_charged) - num(x.platform_fees) - num(x.shipping_cost) - num(x.other_costs),
    0,
  );
  const profit = saleRows.reduce(
    (s, x) => s + num(x.sale_price) + num(x.shipping_charged) - num(x.platform_fees) - num(x.shipping_cost) - num(x.other_costs) - (costById.get(x.item_id) ?? 0),
    0,
  );
  const byPlatform = new Map<string, { active: number; sold: number; payout: number }>();
  for (const l of active) {
    const e = byPlatform.get(l.platform) ?? { active: 0, sold: 0, payout: 0 };
    e.active++;
    byPlatform.set(l.platform, e);
  }
  for (const s of saleRows) {
    const e = byPlatform.get(s.platform) ?? { active: 0, sold: 0, payout: 0 };
    e.sold++;
    e.payout += num(s.sale_price) + num(s.shipping_charged) - num(s.platform_fees) - num(s.shipping_cost) - num(s.other_costs);
    byPlatform.set(s.platform, e);
  }

  return {
    counts: {
      unsold: unsold.length,
      needsListing: unsold.filter(i => i.status === "draft" || i.status === "researching").length,
      activeListings: active.length,
      sold: saleRows.length,
    },
    activeValue: active.reduce((s, l) => s + num(l.list_price), 0),
    revenue,
    payout,
    profit,
    byPlatform: [...byPlatform.entries()].map(([platform, v]) => ({ platform, ...v })),
    tasks: (tasks.data ?? []) as AgentTask[],
    activity: activity.data ?? [],
  };
}

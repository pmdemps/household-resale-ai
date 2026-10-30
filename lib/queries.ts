import "server-only";
import type { AppContext } from "@/lib/household";
import type { OfferWithContext } from "@/components/offer-card";
import type { AgentTask, InventoryItem, Listing, Note, Sale } from "@/lib/types";
import { num } from "@/lib/types";
import type { InsightItem } from "@/lib/insights";
import { byPlatform as platformRows, monthlyProfit, saleNet, saleProfit, summarize } from "@/lib/money";

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
    ctx.supabase.from("inventory_items").select("id, name, status, purchase_cost, target_price, created_at").eq("household_id", hid),
    ctx.supabase.from("listings").select("id, status, list_price, platform").eq("household_id", hid),
    ctx.supabase.from("sales").select("*").eq("household_id", hid).order("sold_at", { ascending: false }),
    ctx.supabase.from("agent_tasks").select("*").eq("household_id", hid).eq("status", "pending").neq("kind", "offer_decision").order("created_at", { ascending: false }),
    ctx.supabase.from("activity_log").select("*").eq("household_id", hid).order("created_at", { ascending: false }).limit(12),
  ]);
  for (const r of [items, listings, sales, tasks, activity]) if (r.error) throw new Error(r.error.message);

  const itemRows = (items.data ?? []) as Pick<InventoryItem, "id" | "name" | "status" | "purchase_cost" | "target_price" | "created_at">[];
  const listingRows = (listings.data ?? []) as Pick<Listing, "id" | "status" | "list_price" | "platform">[];
  const saleRows = (sales.data ?? []) as Sale[];
  const costById = new Map(itemRows.map(i => [i.id, num(i.purchase_cost)]));

  const unsold = itemRows.filter(i => !["sold", "donated", "discarded", "returned"].includes(i.status));
  const active = listingRows.filter(l => l.status === "active");
  const revenue = saleRows.reduce((s, x) => s + num(x.sale_price) + num(x.shipping_charged), 0);
  const payout = saleRows.reduce((s, x) => s + saleNet(x), 0);
  const profit = saleRows.reduce((s, x) => s + saleProfit(x, costById.get(x.item_id) ?? 0), 0);
  const byPlatform = platformRows(saleRows, active, costById).map(r => ({ platform: r.platform, active: r.active, sold: r.sold, payout: r.net, profit: r.profit }));
  const months = summarize(monthlyProfit(saleRows, costById, { months: 2 }));

  const nameById = new Map(itemRows.map(i => [i.id, i.name]));
  const recentSales = saleRows.slice(0, 6).map(x => ({
    id: x.id,
    itemId: x.item_id,
    name: nameById.get(x.item_id) ?? "Item",
    platform: x.platform,
    soldAt: x.sold_at,
    payout: saleNet(x),
    profit: saleProfit(x, costById.get(x.item_id) ?? 0),
  }));

  // Newest unlisted items, so something just added is visible on the overview, not only counted.
  const needsListing = unsold
    .filter(i => i.status === "draft" || i.status === "researching")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(i => ({ id: i.id, name: i.name, targetPrice: num(i.target_price), createdAt: i.created_at }));

  return {
    recentSales,
    needsListing: needsListing.slice(0, 5),
    counts: {
      unsold: unsold.length,
      needsListing: needsListing.length,
      activeListings: active.length,
      sold: saleRows.length,
    },
    activeValue: active.reduce((s, l) => s + num(l.list_price), 0),
    revenue,
    payout,
    profit,
    /** This calendar month vs last, for the "How are we doing?" hero. */
    thisMonth: months.thisMonth,
    lastMonth: months.lastMonth,
    byPlatform,
    tasks: (tasks.data ?? []) as AgentTask[],
    activity: activity.data ?? [],
  };
}

/** Everything the Money page shows: month-by-month profit, totals, and the per-platform table. */
export async function loadMoney(ctx: Ctx, opts: { months?: number } = {}) {
  const hid = ctx.household.id;
  const [items, listings, sales] = await Promise.all([
    ctx.supabase.from("inventory_items").select("id, purchase_cost").eq("household_id", hid),
    ctx.supabase.from("listings").select("platform, status").eq("household_id", hid).eq("status", "active"),
    ctx.supabase.from("sales").select("*").eq("household_id", hid).order("sold_at", { ascending: false }),
  ]);
  for (const r of [items, listings, sales]) if (r.error) throw new Error(r.error.message);
  const costById = new Map(((items.data ?? []) as Pick<InventoryItem, "id" | "purchase_cost">[]).map(i => [i.id, num(i.purchase_cost)]));
  const saleRows = (sales.data ?? []) as Sale[];
  const active = ((listings.data ?? []) as Pick<Listing, "platform" | "status">[]).filter(l => l.status === "active");
  const months = monthlyProfit(saleRows, costById, { months: opts.months ?? 12 });
  return {
    months,
    summary: summarize(months),
    totals: {
      sold: saleRows.length,
      profit: saleRows.reduce((s, x) => s + saleProfit(x, costById.get(x.item_id) ?? 0), 0),
      net: saleRows.reduce((s, x) => s + saleNet(x), 0),
      revenue: saleRows.reduce((s, x) => s + num(x.sale_price) + num(x.shipping_charged), 0),
    },
    byPlatform: platformRows(saleRows, active, costById),
  };
}

export type MemberNames = Record<string, string>;

/** user_id -> display name for everyone in the household. */
export async function loadMemberNames(ctx: Ctx): Promise<MemberNames> {
  const { data } = await ctx.supabase
    .from("household_members")
    .select("user_id, display_name, role")
    .eq("household_id", ctx.household.id)
    .order("created_at");
  const names: MemberNames = {};
  (data ?? []).forEach((m, i) => {
    names[m.user_id as string] = (m.display_name as string | null)?.trim() || (m.user_id === ctx.userId ? "You" : `Member ${i + 1}`);
  });
  return names;
}

export async function loadNotes(ctx: Ctx, opts: { itemId?: string; limit?: number } = {}) {
  let q = ctx.supabase
    .from("notes")
    .select("*, inventory_items(id, name)")
    .eq("household_id", ctx.household.id);
  if (opts.itemId) q = q.eq("item_id", opts.itemId).order("created_at", { ascending: true });
  else q = q.order("pinned", { ascending: false }).order("created_at", { ascending: false });
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as (Note & { inventory_items: { id: string; name: string } | null })[];
}

/** Items shaped for lib/insights.ts. */
export async function loadInsightItems(ctx: Ctx): Promise<InsightItem[]> {
  const { data, error } = await ctx.supabase
    .from("inventory_items")
    .select("id, name, brand, category, status, purchase_cost, created_at, listings(platform, listed_at), sales(platform, sold_at, sale_price, shipping_charged, platform_fees, shipping_cost, other_costs)")
    .eq("household_id", ctx.household.id)
    .limit(5000);
  if (error) throw new Error(error.message);
  type Row = {
    id: string; name: string; brand: string | null; category: string; status: string; purchase_cost: number; created_at: string;
    listings: { platform: string; listed_at: string | null }[];
    sales: Sale[] | Sale | null;
  };
  return ((data ?? []) as unknown as Row[]).map(r => {
    const s = Array.isArray(r.sales) ? r.sales[0] : r.sales;
    const listedTimes = r.listings.map(l => l.listed_at).filter((x): x is string => Boolean(x)).sort();
    return {
      id: r.id,
      name: r.name,
      brand: r.brand,
      category: r.category,
      status: r.status,
      purchaseCost: num(r.purchase_cost),
      createdAt: r.created_at,
      firstListedAt: listedTimes[0] ?? null,
      platforms: [...new Set(r.listings.map(l => l.platform))],
      sale: s
        ? {
            platform: s.platform,
            soldAt: s.sold_at,
            payout: num(s.sale_price) + num(s.shipping_charged) - num(s.platform_fees) - num(s.shipping_cost) - num(s.other_costs),
          }
        : null,
    };
  });
}

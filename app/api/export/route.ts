import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { toCsv } from "@/lib/csv";
import { platformName } from "@/lib/platforms";
import { num } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get("type") ?? "items";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { data: membership } = await supabase.from("household_members").select("household_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!membership) return NextResponse.json({ error: "No household" }, { status: 404 });
  const hid = membership.household_id as string;

  let header: string[] = [];
  let rows: unknown[][] = [];

  if (type === "items") {
    const { data, error } = await supabase.from("inventory_items").select("*, sales(platform, sale_price, shipping_charged, platform_fees, shipping_cost, other_costs, sold_at)").eq("household_id", hid).order("created_at");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    header = ["id", "name", "category", "brand", "size", "condition", "storage_location", "status", "asking_price", "floor_price", "cost", "sold_on", "sold_price", "fees", "shipping_paid", "payout", "profit", "sold_at", "created_at", "notes"];
    rows = (data ?? []).map(i => {
      const s = (i.sales as Record<string, number | string>[] | null)?.[0];
      const payout = s ? num(s.sale_price) + num(s.shipping_charged) - num(s.platform_fees) - num(s.shipping_cost) - num(s.other_costs) : null;
      return [i.id, i.name, i.category, i.brand, i.size, i.condition, i.storage_location, i.status, i.target_price, i.floor_price, i.purchase_cost,
        s ? platformName(String(s.platform)) : "", s?.sale_price ?? "", s?.platform_fees ?? "", s?.shipping_cost ?? "",
        payout === null ? "" : payout.toFixed(2), payout === null ? "" : (payout - num(i.purchase_cost)).toFixed(2), s?.sold_at ?? "", i.created_at, i.notes];
    });
  } else if (type === "listings") {
    const { data, error } = await supabase.from("listings").select("*, inventory_items(name)").eq("household_id", hid).order("created_at");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    header = ["id", "item", "platform", "status", "list_price", "listing_url", "listed_at", "ended_at"];
    rows = (data ?? []).map(l => [l.id, (l.inventory_items as { name: string } | null)?.name, platformName(l.platform), l.status, l.list_price, l.listing_url, l.listed_at, l.ended_at]);
  } else if (type === "offers") {
    const { data, error } = await supabase.from("offers").select("*, listings(platform, list_price, inventory_items(name))").eq("household_id", hid).order("received_at");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    header = ["id", "item", "platform", "list_price", "offer", "status", "counter", "buyer", "received_at", "decided_at"];
    rows = (data ?? []).map(o => {
      const l = o.listings as { platform: string; list_price: number; inventory_items: { name: string } | null } | null;
      return [o.id, l?.inventory_items?.name, l ? platformName(l.platform) : "", l?.list_price, o.amount, o.status, o.counter_amount, o.buyer_handle, o.received_at, o.decided_at];
    });
  } else if (type === "sales") {
    const { data, error } = await supabase.from("sales").select("*, inventory_items(name, purchase_cost)").eq("household_id", hid).order("sold_at");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    header = ["sold_at", "item", "platform", "sale_price", "shipping_charged", "fees", "shipping_paid", "other_costs", "payout", "cost", "profit"];
    rows = (data ?? []).map(s => {
      const item = s.inventory_items as { name: string; purchase_cost: number } | null;
      const payout = num(s.sale_price) + num(s.shipping_charged) - num(s.platform_fees) - num(s.shipping_cost) - num(s.other_costs);
      return [s.sold_at, item?.name, platformName(s.platform), s.sale_price, s.shipping_charged, s.platform_fees, s.shipping_cost, s.other_costs, payout.toFixed(2), item?.purchase_cost ?? 0, (payout - num(item?.purchase_cost)).toFixed(2)];
    });
  } else {
    return NextResponse.json({ error: "Unknown export type" }, { status: 400 });
  }

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(toCsv(header, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="resale-${type}-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

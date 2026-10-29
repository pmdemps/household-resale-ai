import Link from "next/link";
import { Download, MapPin, Plus, Search } from "lucide-react";
import { requireHousehold } from "@/lib/household";
import { platformName } from "@/lib/platforms";
import { money, num, type InventoryItem } from "@/lib/types";

const FILTERS = [
  { id: "open", label: "To sell" },
  { id: "unlisted", label: "Not listed" },
  { id: "listed", label: "Listed" },
  { id: "sold", label: "Sold" },
  { id: "all", label: "All" },
] as const;

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-slate-400/10 text-slate-300",
  researching: "bg-slate-400/10 text-slate-300",
  listed: "bg-accent/15 text-accent",
  pending_sale: "bg-amber-300/15 text-amber-200",
  sold: "bg-emerald-400/15 text-emerald-300",
  returned: "bg-rose-400/15 text-rose-300",
  donated: "bg-slate-400/10 text-slate-400",
  discarded: "bg-slate-400/10 text-slate-500",
};

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const ctx = await requireHousehold();
  const { q = "", status = "open" } = await searchParams;

  let query = ctx.supabase
    .from("inventory_items")
    .select("*, listings(platform, status, list_price)")
    .eq("household_id", ctx.household.id)
    .order("created_at", { ascending: false })
    .limit(500);
  if (status === "open") query = query.in("status", ["researching", "draft", "listed", "pending_sale"]);
  if (status === "unlisted") query = query.in("status", ["researching", "draft"]);
  if (status === "listed") query = query.in("status", ["listed", "pending_sale"]);
  if (status === "sold") query = query.eq("status", "sold");
  const term = q.trim().replace(/[%,()]/g, " ").slice(0, 80);
  if (term) query = query.or(`name.ilike.%${term}%,brand.ilike.%${term}%,storage_location.ilike.%${term}%,category.ilike.%${term}%`);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const items = (data ?? []) as (InventoryItem & { listings: { platform: string; status: string; list_price: number }[] })[];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Inventory</h1>
        <div className="flex gap-2">
          <a href={`/api/export?type=items`} className="btn-secondary"><Download size={16} /> CSV</a>
          <Link href="/inventory/new" className="btn-primary"><Plus size={17} /> Add item</Link>
        </div>
      </header>

      <form className="flex gap-2" role="search">
        <input type="hidden" name="status" value={status} />
        <div className="relative flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input name="q" defaultValue={q} className="field pl-9" placeholder="Search name, brand, location…" />
        </div>
        <button className="btn-secondary">Search</button>
      </form>

      <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1">
        {FILTERS.map(f => (
          <Link
            key={f.id}
            href={{ pathname: "/inventory", query: { status: f.id, ...(q ? { q } : {}) } }}
            className={"shrink-0 rounded-full px-3 py-1.5 text-sm " + (status === f.id ? "bg-white/10 text-white" : "text-slate-400 hover:text-white")}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        <div className="surface p-8 text-center text-sm text-slate-400">
          Nothing here yet. <Link href="/inventory/new" className="text-accent hover:underline">Add an item</Link>
        </div>
      ) : (
        <ul className="surface divide-y divide-line">
          {items.map(item => {
            const live = item.listings.filter(l => ["active", "paused", "draft"].includes(l.status));
            return (
              <li key={item.id}>
                <Link href={`/inventory/${item.id}`} className="flex items-center gap-4 px-4 py-3.5 hover:bg-white/[0.03]">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">{item.name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
                      <span>{item.category}</span>
                      {item.size && <span>· {item.size}</span>}
                      {item.storage_location && <span className="inline-flex items-center gap-1">· <MapPin size={11} />{item.storage_location}</span>}
                    </p>
                    {live.length > 0 && (
                      <p className="mt-1 text-[11px] text-slate-500">{live.map(l => `${platformName(l.platform)} ${money(num(l.list_price))}`).join(" · ")}</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <span className={"rounded-full px-2 py-0.5 text-[11px] " + (STATUS_STYLE[item.status] ?? "")}>{item.status.replace("_", " ")}</span>
                    <p className="mt-1 text-sm tabular-nums text-slate-200">
                      {item.status === "sold" && item.sold_price !== null ? money(num(item.sold_price)) : num(item.target_price) > 0 ? money(num(item.target_price)) : "—"}
                    </p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-slate-500">{items.length} item{items.length === 1 ? "" : "s"}</p>
    </div>
  );
}

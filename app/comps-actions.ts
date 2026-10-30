"use server";

import { revalidatePath } from "next/cache";
import { requireHousehold } from "@/lib/household";
import { compSearchQuery, normalizeCompPlatform, safeCompUrl } from "@/lib/comps";
import { searchEbayComps } from "@/lib/ebay/browse";
import { readEbayConfig } from "@/lib/ebay/config";
import { loadEbayConnection } from "@/lib/ebay/connection";

// Market comparables ("what others sell this for"). Reading other people's listings has no outside
// effect, so these run straight away; nothing here touches our own listings or prices.

export type CompsResult = { error: string | null; found?: number };

const text = (form: FormData, key: string, max: number) => String(form.get(key) ?? "").trim().slice(0, max);
function price(form: FormData, key: string): number | null {
  const raw = text(form, key, 20).replace(/[$,\s]/g, "");
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n < 1_000_000 ? Math.round(n * 100) / 100 : null;
}

/** True when the app has eBay app keys, which is all the Browse API needs (no account connection). */
export async function ebayCompsAvailable(): Promise<boolean> {
  return Boolean(process.env.EBAY_CLIENT_ID?.trim() && process.env.EBAY_CLIENT_SECRET?.trim());
}

/**
 * "Check eBay prices": searches current Buy It Now listings for the item (Browse API, app token) and
 * replaces the item's previous eBay comps with the fresh set. Our own listings are left out.
 * Optional field `query` overrides the search words.
 */
export async function checkEbayPrices(form: FormData): Promise<CompsResult> {
  const ctx = await requireHousehold();
  const hid = ctx.household.id;
  const itemId = text(form, "item_id", 64);
  if (!(await ebayCompsAvailable())) return { error: "eBay isn't set up yet. Add EBAY_CLIENT_ID and EBAY_CLIENT_SECRET (see docs/ebay-setup.md)." };

  const { data: item, error: itemErr } = await ctx.supabase.from("inventory_items").select("id, name, brand").eq("household_id", hid).eq("id", itemId).maybeSingle();
  if (itemErr) return { error: itemErr.message };
  if (!item) return { error: "Item not found." };

  const query = text(form, "query", 100) || compSearchQuery(item.name as string, item.brand as string | null);
  if (!query) return { error: "Give the item a name first." };

  try {
    const conn = await loadEbayConnection(ctx.supabase, hid).catch(() => null);
    const rows = await searchEbayComps(readEbayConfig(), query, { excludeSeller: conn?.account_handle ?? null });
    const now = new Date().toISOString();
    const { error: delErr } = await ctx.supabase.from("item_comps").delete().eq("household_id", hid).eq("item_id", itemId).eq("source", "ebay");
    if (delErr) return { error: delErr.message };
    if (rows.length > 0) {
      const { error: insErr } = await ctx.supabase.from("item_comps").insert(
        rows.map(r => ({
          household_id: hid,
          item_id: itemId,
          source: "ebay",
          platform: "ebay",
          title: r.title,
          price: r.price,
          shipping: r.shipping,
          url: r.url,
          condition: r.condition,
          kind: "active",
          external_id: r.externalId,
          captured_at: now,
        })),
      );
      if (insErr) return { error: insErr.message };
    }
    await ctx.supabase.from("activity_log").insert({
      household_id: hid,
      actor_user: ctx.userId,
      action: "comps_checked",
      entity_type: "item",
      entity_id: itemId,
      detail: { source: "ebay", query, found: rows.length },
    });
    revalidatePath(`/inventory/${itemId}`);
    return { error: null, found: rows.length };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "eBay search failed." };
  }
}

/** Record a comparable found anywhere (Etsy, Mercari, a web search...). */
export async function addComp(form: FormData): Promise<void> {
  const ctx = await requireHousehold();
  const hid = ctx.household.id;
  const itemId = text(form, "item_id", 64);
  const amount = price(form, "price");
  const title = text(form, "title", 300);
  if (!itemId || amount === null || amount <= 0 || !title) throw new Error("A comparable needs a title and a price.");
  const { data, error } = await ctx.supabase
    .from("item_comps")
    .insert({
      household_id: hid,
      item_id: itemId,
      source: "manual",
      platform: normalizeCompPlatform(text(form, "platform", 40)),
      title,
      price: amount,
      shipping: price(form, "shipping"),
      url: safeCompUrl(text(form, "url", 1000)),
      kind: text(form, "kind", 10) === "sold" ? "sold" : "active",
      note: text(form, "note", 300) || null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  await ctx.supabase.from("activity_log").insert({ household_id: hid, actor_user: ctx.userId, action: "comp_added", entity_type: "item", entity_id: itemId, detail: { comp_id: data.id, price: amount } });
  revalidatePath(`/inventory/${itemId}`);
}

export async function deleteComp(form: FormData): Promise<void> {
  const ctx = await requireHousehold();
  const id = text(form, "id", 64);
  const { data, error } = await ctx.supabase.from("item_comps").delete().eq("household_id", ctx.household.id).eq("id", id).select("item_id").maybeSingle();
  if (error) throw new Error(error.message);
  if (data) revalidatePath(`/inventory/${data.item_id}`);
}

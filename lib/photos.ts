import "server-only";
import type { AppContext } from "@/lib/household";
import { isValidPhotoPath, MAX_PHOTOS_PER_ITEM, normalizePhotoType, PHOTO_BUCKET, PHOTO_TYPES, photoUrl } from "@/lib/photo-url";
import type { ItemPhoto } from "@/lib/types";

type Ctx = AppContext & { household: { id: string }; userId: string };

/** A photo row plus the public HTTPS URL marketplaces (and <img>) can load it from. */
export type ItemPhotoWithUrl = ItemPhoto & { url: string };

/** Public URL for a stored photo. Safe to hand to eBay/Etsy as a listing image URL. */
export function publicPhotoUrl(storagePath: string): string {
  return photoUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", storagePath);
}

const withUrl = (p: ItemPhoto): ItemPhotoWithUrl => ({ ...p, url: publicPhotoUrl(p.storage_path) });

/** All photos of one item, cover first. */
export async function loadPhotos(ctx: Ctx, itemId: string): Promise<ItemPhotoWithUrl[]> {
  const { data, error } = await ctx.supabase
    .from("item_photos")
    .select("*")
    .eq("household_id", ctx.household.id)
    .eq("item_id", itemId)
    .order("position")
    .order("created_at");
  if (error) throw new Error(error.message);
  return ((data ?? []) as ItemPhoto[]).map(withUrl);
}

/** Cover photo URL per item (one query), for list thumbnails. Items without photos are absent. */
export async function loadCoverPhotos(ctx: Ctx, itemIds: string[]): Promise<Map<string, string>> {
  const covers = new Map<string, string>();
  if (itemIds.length === 0) return covers;
  const wanted = new Set(itemIds);
  const { data, error } = await ctx.supabase
    .from("item_photos")
    .select("item_id, storage_path, position, created_at")
    .eq("household_id", ctx.household.id)
    .eq("position", 0)
    .order("created_at");
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as Pick<ItemPhoto, "item_id" | "storage_path">[]) {
    if (wanted.has(row.item_id) && !covers.has(row.item_id)) covers.set(row.item_id, publicPhotoUrl(row.storage_path));
  }
  return covers;
}

export type RecordPhotoInput = {
  itemId: string;
  /** Object key the browser uploaded to: <household_id>/<item_id>/<uuid>.<jpg|jpeg|png|webp>. */
  storagePath: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  contentType: string | null;
};

/**
 * Records a photo the browser has already uploaded to the item-photos bucket (components/photo-uploader.tsx
 * does the resize + upload with the member's JWT, so storage RLS has already limited the path to the
 * member's household folder). This re-checks the full path shape for THIS household and item, enforces
 * the per-item limit, appends the row after the existing ones and logs "photo_added". When the row cannot
 * be written the uploaded object is removed (best-effort) so nothing orphaned stays in the bucket.
 */
export async function recordPhoto(ctx: Ctx, input: RecordPhotoInput): Promise<ItemPhotoWithUrl> {
  const hid = ctx.household.id;
  const { itemId, storagePath } = input;
  if (!isValidPhotoPath(storagePath, hid, itemId)) throw new Error("That upload doesn't belong to this item.");
  const ext = storagePath.slice(storagePath.lastIndexOf(".") + 1).replace(/^jpeg$/, "jpg");
  const type = normalizePhotoType(input.contentType);
  if (!type || PHOTO_TYPES[type] !== ext) {
    await discardObject(ctx, storagePath);
    throw new Error("The photo's type doesn't match its file name.");
  }

  const { data: item, error: itemErr } = await ctx.supabase.from("inventory_items").select("id").eq("household_id", hid).eq("id", itemId).maybeSingle();
  if (itemErr) throw new Error(itemErr.message);
  if (!item) {
    await discardObject(ctx, storagePath);
    throw new Error("That item isn't in your household.");
  }

  const { data: existing, error: existingErr } = await ctx.supabase.from("item_photos").select("position").eq("household_id", hid).eq("item_id", itemId);
  if (existingErr) throw new Error(existingErr.message);
  const count = existing?.length ?? 0;
  if (count >= MAX_PHOTOS_PER_ITEM) {
    await discardObject(ctx, storagePath);
    throw new Error(`Up to ${MAX_PHOTOS_PER_ITEM} photos per item (this one already has ${count}).`);
  }
  const position = (existing ?? []).reduce((m, p) => Math.max(m, Number(p.position) + 1), 0);

  const { data, error } = await ctx.supabase
    .from("item_photos")
    .insert({
      household_id: hid,
      item_id: itemId,
      storage_path: storagePath,
      position,
      width: positiveInt(input.width),
      height: positiveInt(input.height),
      bytes: input.bytes !== null && Number.isInteger(input.bytes) && input.bytes >= 0 ? input.bytes : null,
      created_by: ctx.userId,
    })
    .select("*")
    .single();
  if (error) {
    await discardObject(ctx, storagePath);
    throw new Error(error.message);
  }
  const row = data as ItemPhoto;
  await ctx.supabase.from("activity_log").insert({
    household_id: hid,
    actor_user: ctx.userId,
    action: "photo_added",
    entity_type: "item",
    entity_id: itemId,
    detail: { count: 1, photo_id: row.id, content_type: type, bytes: row.bytes, width: row.width, height: row.height },
  });
  return withUrl(row);
}

/** Removes the row, closes the gap so positions stay 0..n-1 (cover = 0), then deletes the file best-effort. */
export async function removePhoto(ctx: Ctx, photoId: string): Promise<ItemPhoto | null> {
  const hid = ctx.household.id;
  const { data: photo, error } = await ctx.supabase.from("item_photos").select("*").eq("household_id", hid).eq("id", photoId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!photo) return null;
  const row = photo as ItemPhoto;
  const { error: delErr } = await ctx.supabase.from("item_photos").delete().eq("household_id", hid).eq("id", row.id);
  if (delErr) throw new Error(delErr.message);
  await renumber(ctx, row.item_id);
  // The row is what the household sees; a leftover object sits at an unguessable path and is harmless,
  // so a storage hiccup must not fail the delete.
  await discardObject(ctx, row.storage_path);
  await ctx.supabase.from("activity_log").insert({ household_id: hid, actor_user: ctx.userId, action: "photo_removed", entity_type: "item", entity_id: row.item_id, detail: {} });
  return row;
}

/** Moves one photo to position 0 and shifts the rest down in their current order. */
export async function setCoverPhoto(ctx: Ctx, photoId: string): Promise<ItemPhoto | null> {
  const hid = ctx.household.id;
  const { data: photo, error } = await ctx.supabase.from("item_photos").select("*").eq("household_id", hid).eq("id", photoId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!photo) return null;
  const row = photo as ItemPhoto;
  await renumber(ctx, row.item_id, row.id);
  await ctx.supabase.from("activity_log").insert({ household_id: hid, actor_user: ctx.userId, action: "photo_cover", entity_type: "item", entity_id: row.item_id, detail: { photo_id: row.id } });
  return row;
}

/** Best-effort delete of a storage object (the member's JWT; storage RLS applies). Never throws. */
async function discardObject(ctx: Ctx, storagePath: string): Promise<void> {
  try {
    const { error } = await ctx.supabase.storage.from(PHOTO_BUCKET).remove([storagePath]);
    if (error) console.warn("[photos] could not remove storage object:", error.message);
  } catch (e) {
    console.warn("[photos] could not remove storage object:", e instanceof Error ? e.message : e);
  }
}

function positiveInt(n: number | null): number | null {
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}

async function renumber(ctx: Ctx, itemId: string, firstId?: string) {
  const { data, error } = await ctx.supabase
    .from("item_photos")
    .select("id, position")
    .eq("household_id", ctx.household.id)
    .eq("item_id", itemId)
    .order("position")
    .order("created_at");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Pick<ItemPhoto, "id" | "position">[];
  const ordered = firstId ? [...rows.filter(r => r.id === firstId), ...rows.filter(r => r.id !== firstId)] : rows;
  for (const [i, r] of ordered.entries()) {
    if (Number(r.position) === i) continue;
    const { error: upErr } = await ctx.supabase.from("item_photos").update({ position: i }).eq("household_id", ctx.household.id).eq("id", r.id);
    if (upErr) throw new Error(upErr.message);
  }
}

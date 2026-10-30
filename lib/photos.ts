import "server-only";
import { randomUUID } from "node:crypto";
import type { AppContext } from "@/lib/household";
import { imageDimensions, MAX_PHOTO_BYTES, MAX_PHOTOS_PER_ITEM, normalizePhotoType, PHOTO_BUCKET, PHOTO_TYPES, photoUrl, sniffImageType } from "@/lib/photo-url";
import type { ItemPhoto } from "@/lib/types";

type Ctx = AppContext & { household: { id: string }; userId: string };

/** A photo row plus the public HTTPS URL marketplaces (and <img>) can load it from. */
export type ItemPhotoWithUrl = ItemPhoto & { url: string };

/** Public URL for a stored photo. Safe to hand to eBay/Etsy as a listing image URL. */
export function publicPhotoUrl(storagePath: string): string {
  return photoUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", storagePath);
}

const withUrl = (p: ItemPhoto): ItemPhotoWithUrl => ({ ...p, url: publicPhotoUrl(p.storage_path) });

/** Files from a multipart form field, skipping the empty entry browsers send for an untouched file input. */
export function filesFrom(form: FormData, key = "files"): File[] {
  return form.getAll(key).filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f && (f as File).size > 0);
}

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

/**
 * Validates and stores uploaded files for an item: checks the real image type and size, uploads to
 * <household>/<item>/<uuid>.<ext> with the user's JWT (storage RLS applies), inserts item_photos rows
 * after the existing ones, and logs "photo_added". HEIC is stored as-is (no conversion).
 */
export async function attachPhotos(ctx: Ctx, itemId: string, files: File[]): Promise<ItemPhotoWithUrl[]> {
  const hid = ctx.household.id;
  const real = files.filter(f => f.size > 0);
  if (real.length === 0) return [];

  const { data: item, error: itemErr } = await ctx.supabase.from("inventory_items").select("id").eq("household_id", hid).eq("id", itemId).maybeSingle();
  if (itemErr) throw new Error(itemErr.message);
  if (!item) throw new Error("That item isn't in your household.");

  const { data: existing, error: existingErr } = await ctx.supabase.from("item_photos").select("position").eq("household_id", hid).eq("item_id", itemId);
  if (existingErr) throw new Error(existingErr.message);
  if ((existing?.length ?? 0) + real.length > MAX_PHOTOS_PER_ITEM) {
    throw new Error(`Up to ${MAX_PHOTOS_PER_ITEM} photos per item (this one has ${existing?.length ?? 0}).`);
  }
  let position = (existing ?? []).reduce((m, p) => Math.max(m, Number(p.position) + 1), 0);

  // Check everything before uploading anything, so a bad file in a batch doesn't leave half of it stored.
  const prepared = await Promise.all(
    real.map(async file => {
      if (file.size > MAX_PHOTO_BYTES) throw new Error(`"${file.name}" is over 10 MB. Try a smaller photo.`);
      const buffer = Buffer.from(await file.arrayBuffer());
      const type = sniffImageType(buffer) ?? normalizePhotoType(file.type);
      if (!type || !(type in PHOTO_TYPES)) throw new Error(`"${file.name}" isn't a JPEG, PNG, WebP or HEIC photo.`);
      return { file, buffer, type, dims: imageDimensions(buffer, type) };
    }),
  );

  const added: ItemPhotoWithUrl[] = [];
  for (const { buffer, type, dims } of prepared) {
    const path = `${hid}/${itemId}/${randomUUID()}.${PHOTO_TYPES[type]}`;
    const { error: upErr } = await ctx.supabase.storage.from(PHOTO_BUCKET).upload(path, buffer, { contentType: type, upsert: false, cacheControl: "31536000" });
    if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
    const { data, error } = await ctx.supabase
      .from("item_photos")
      .insert({ household_id: hid, item_id: itemId, storage_path: path, position: position++, width: dims?.width ?? null, height: dims?.height ?? null, bytes: buffer.byteLength, created_by: ctx.userId })
      .select("*")
      .single();
    if (error) {
      await ctx.supabase.storage.from(PHOTO_BUCKET).remove([path]);
      throw new Error(error.message);
    }
    added.push(withUrl(data as ItemPhoto));
  }

  await ctx.supabase.from("activity_log").insert({
    household_id: hid,
    actor_user: ctx.userId,
    action: "photo_added",
    entity_type: "item",
    entity_id: itemId,
    detail: { count: added.length },
  });
  return added;
}

/** Removes the file and the row, then closes the gap so positions stay 0..n-1 (cover = 0). */
export async function removePhoto(ctx: Ctx, photoId: string): Promise<ItemPhoto | null> {
  const hid = ctx.household.id;
  const { data: photo, error } = await ctx.supabase.from("item_photos").select("*").eq("household_id", hid).eq("id", photoId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!photo) return null;
  const row = photo as ItemPhoto;
  const { error: rmErr } = await ctx.supabase.storage.from(PHOTO_BUCKET).remove([row.storage_path]);
  if (rmErr) throw new Error(`Couldn't delete the file: ${rmErr.message}`);
  const { error: delErr } = await ctx.supabase.from("item_photos").delete().eq("household_id", hid).eq("id", row.id);
  if (delErr) throw new Error(delErr.message);
  await renumber(ctx, row.item_id);
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

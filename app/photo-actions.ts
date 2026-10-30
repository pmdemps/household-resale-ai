"use server";

import { revalidatePath } from "next/cache";
import { requireHousehold } from "@/lib/household";
import { recordPhoto, removePhoto, setCoverPhoto } from "@/lib/photos";

export type RecordPhotoResult = { error: string | null; id?: string; url?: string };

function id(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim().slice(0, 64);
}
function str(form: FormData, key: string, max: number): string {
  return String(form.get(key) ?? "").trim().slice(0, max);
}
function int(form: FormData, key: string): number | null {
  const raw = String(form.get(key) ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Records one photo the browser has already uploaded to Storage (see components/photo-uploader.tsx: the
 * file never passes through the server, which keeps it clear of Vercel's 4.5 MB request-body cap).
 * Fields: item_id, storage_path, width, height, bytes, content_type. The path must be
 * <this household>/<item_id>/<uuid>.<jpg|jpeg|png|webp>; anything else is refused and the object discarded.
 * Returns the error as data so the uploader can show it inline instead of crashing the page.
 */
export async function recordItemPhoto(form: FormData): Promise<RecordPhotoResult> {
  const ctx = await requireHousehold();
  const itemId = id(form, "item_id");
  if (!itemId) return { error: "Missing item." };
  try {
    const photo = await recordPhoto(ctx, {
      itemId,
      storagePath: str(form, "storage_path", 200),
      width: int(form, "width"),
      height: int(form, "height"),
      bytes: int(form, "bytes"),
      contentType: str(form, "content_type", 60) || null,
    });
    revalidatePath(`/inventory/${itemId}`);
    revalidatePath("/inventory");
    return { error: null, id: photo.id, url: photo.url };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't save the photo." };
  }
}

export async function deleteItemPhoto(form: FormData): Promise<void> {
  const ctx = await requireHousehold();
  const photo = await removePhoto(ctx, id(form, "id"));
  if (photo) {
    revalidatePath(`/inventory/${photo.item_id}`);
    revalidatePath("/inventory");
  }
}

export async function makeCoverPhoto(form: FormData): Promise<void> {
  const ctx = await requireHousehold();
  const photo = await setCoverPhoto(ctx, id(form, "id"));
  if (photo) {
    revalidatePath(`/inventory/${photo.item_id}`);
    revalidatePath("/inventory");
  }
}

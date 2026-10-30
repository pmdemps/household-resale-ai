"use server";

import { revalidatePath } from "next/cache";
import { requireHousehold } from "@/lib/household";
import { attachPhotos, filesFrom, removePhoto, setCoverPhoto } from "@/lib/photos";

export type PhotoActionState = { error: string | null; added?: number };

function id(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim().slice(0, 64);
}

/**
 * Adds one or more photos (field `files`, multipart) to an item (field `item_id`).
 * Shaped for useActionState so the uploader can show the error inline instead of crashing the page.
 */
export async function uploadItemPhotos(_prev: PhotoActionState, form: FormData): Promise<PhotoActionState> {
  const ctx = await requireHousehold();
  const itemId = id(form, "item_id");
  const files = filesFrom(form);
  if (!itemId) return { error: "Missing item." };
  if (files.length === 0) return { error: "Pick at least one photo." };
  try {
    const added = await attachPhotos(ctx, itemId, files);
    revalidatePath(`/inventory/${itemId}`);
    revalidatePath("/inventory");
    return { error: null, added: added.length };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Upload failed." };
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

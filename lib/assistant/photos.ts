import "server-only";
import { randomUUID } from "node:crypto";
import { imageDimensions, PHOTO_BUCKET, PHOTO_TYPES, photoStoragePath, sniffImageType } from "@/lib/photo-url";
import { publicPhotoUrl } from "@/lib/photos";
import { createServiceClient } from "@/lib/supabase/service";
import { checkImageUrl, MAX_ASSISTANT_PHOTO_BYTES, type RecordPhotoResult } from "./protocol";
import { AssistantApiError, callAssistantFunction } from "./server";

// Photos sent by the household's assistant (POST /api/assistant, action add_photo).
//
// The assistant's links are temporary (Muse's expire within 48 hours), so the photo is downloaded right
// away and Resale HQ keeps its own copy in the item-photos bucket. The bytes decide the type, never the
// link or the header. The key, household and 12-photo limit are checked in SQL before (assistant_photo_slot)
// and after (assistant_record_photo) the upload; the server only ever writes under the household id the
// database returned. Writing to Storage needs SUPABASE_SERVICE_ROLE_KEY (Vercel env), because the
// assistant has no member session.

const DOWNLOAD_TIMEOUT_MS = 15_000;

function bad(error: string, status = 400, code = "bad_request"): never {
  throw new AssistantApiError({ status, code, error });
}

/** Downloads an image from a public https link, refusing anything over the size limit or not an image. */
export async function downloadImage(url: string): Promise<Uint8Array> {
  const check = checkImageUrl(url);
  if (!check.ok) bad(check.reason);
  let res: Response;
  try {
    res = await fetch(check.url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), headers: { Accept: "image/jpeg,image/png,image/webp,image/*;q=0.8" } });
  } catch {
    bad("Couldn't download the photo from that link (it timed out or the site refused). Send it again, or upload the file itself.", 422, "download_failed");
  }
  if (!checkImageUrl(res.url || check.url).ok) bad("The photo link redirected somewhere that isn't a public https address.", 422, "download_failed");
  if (!res.ok) bad(`The photo link answered ${res.status}. It may have expired; send a fresh link.`, 422, "download_failed");
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_ASSISTANT_PHOTO_BYTES) bad("That photo is over 10 MB. Shrink it (longest side 2000 px, JPEG) and send it again.", 413, "too_large");
  if (!res.body) bad("The photo link returned nothing.", 422, "download_failed");

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ASSISTANT_PHOTO_BYTES) {
      await reader.cancel().catch(() => {});
      bad("That photo is over 10 MB. Shrink it (longest side 2000 px, JPEG) and send it again.", 413, "too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/** Checks the bytes, uploads them to this item's folder, and records the photo. Removes the file if recording fails. */
export async function storeAssistantPhoto(key: string, itemId: string, bytes: Uint8Array): Promise<RecordPhotoResult & { url: string; width: number | null; height: number | null }> {
  if (bytes.byteLength === 0) bad("The photo was empty.");
  if (bytes.byteLength > MAX_ASSISTANT_PHOTO_BYTES) bad("That photo is over 10 MB. Shrink it and send it again.", 413, "too_large");
  const type = sniffImageType(bytes);
  if (type === "image/heic") bad("That's an iPhone HEIC photo. Convert it to JPEG first, then send it again.", 415, "unsupported_type");
  if (!type || !(type in PHOTO_TYPES)) bad("That file isn't a JPEG, PNG or WebP photo.", 415, "unsupported_type");

  const service = createServiceClient();
  if (!service) bad("Photo uploads aren't switched on yet: the server needs SUPABASE_SERVICE_ROLE_KEY. Tell the household to add it in Vercel.", 503, "photos_not_configured");

  // Key, household and room for another photo are checked before anything is written.
  const slot = await callAssistantFunction<{ household_id: string; item_id: string; count: number }>("assistant_photo_slot", { p_key: key, p_item_id: itemId });
  const path = photoStoragePath(slot.household_id, slot.item_id, randomUUID(), PHOTO_TYPES[type]);
  const dims = imageDimensions(bytes, type);

  const { error: upErr } = await service.storage.from(PHOTO_BUCKET).upload(path, bytes, { contentType: type, upsert: false, cacheControl: "31536000" });
  if (upErr) bad(`Couldn't store the photo: ${upErr.message}`, 502, "storage_failed");

  try {
    const r = await callAssistantFunction<RecordPhotoResult>("assistant_record_photo", {
      p_key: key, p_item_id: slot.item_id, p_storage_path: path,
      p_width: dims?.width ?? null, p_height: dims?.height ?? null, p_bytes: bytes.byteLength,
    });
    return { ...r, url: publicPhotoUrl(path), width: dims?.width ?? null, height: dims?.height ?? null };
  } catch (e) {
    await service.storage.from(PHOTO_BUCKET).remove([path]).catch(() => {});
    throw e;
  }
}

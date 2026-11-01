import "server-only";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { MAX_PHOTO_EDGE, PHOTO_BUCKET, photoStoragePath, sniffImageType } from "@/lib/photo-url";
import { publicPhotoUrl } from "@/lib/photos";
import { createServiceClient } from "@/lib/supabase/service";
import { checkImageUrl, MAX_ASSISTANT_PHOTO_BYTES, type RecordPhotoResult } from "./protocol";
import { AssistantApiError, callAssistantFunction } from "./server";

// Photos sent by the household's assistant (POST /api/assistant, action add_photo).
//
// Order matters: the key, the household and room for another photo are checked in SQL FIRST
// (reservePhotoSlot -> assistant_photo_slot), so a bad key never makes the server fetch anything. Then the
// photo is downloaded right away (assistant links are temporary; Muse's expire within 48 hours), every
// redirect hop is re-checked, and the bytes decide the type, never the link or header. The photo is
// re-encoded like the browser uploader does: turned upright from its EXIF orientation, longest side at most
// 2000 px, JPEG, and with ALL metadata dropped (phone photos carry GPS, and the bucket is public).
// assistant_record_photo re-checks the key, the path shape and the 12-photo limit before the row is written.
// Writing to Storage needs SUPABASE_SERVICE_ROLE_KEY (Vercel env): the assistant has no member session.

const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const JPEG_QUALITY = 86;

export type PhotoSlot = { household_id: string; item_id: string; count: number };

function bad(error: string, status = 400, code = "bad_request"): never {
  throw new AssistantApiError({ status, code, error });
}

const TOO_BIG = "That photo is over 10 MB. Shrink it (longest side 2000 px, JPEG) and send it again.";
const NO_DOWNLOAD = "Couldn't download the photo from that link (it timed out or the site refused). Send it again, or upload the file itself.";

/** Key check, household and room for another photo, before anything is fetched or written. */
export async function reservePhotoSlot(key: string, itemId: string): Promise<PhotoSlot> {
  if (!createServiceClient()) bad("Photo uploads aren't switched on yet: the server needs SUPABASE_SERVICE_ROLE_KEY. Tell the household to add it in Vercel.", 503, "photos_not_configured");
  return callAssistantFunction<PhotoSlot>("assistant_photo_slot", { p_key: key, p_item_id: itemId });
}

/** Downloads an image from a public https link. Follows at most 3 redirects, checking every hop. */
export async function downloadImage(url: string): Promise<Uint8Array> {
  let current = url;
  let res: Response | null = null;
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = checkImageUrl(current);
    if (!check.ok) bad(hop === 0 ? check.reason : "The photo link redirected somewhere that isn't a public https address.", hop === 0 ? 400 : 422, hop === 0 ? "bad_request" : "download_failed");
    try {
      res = await fetch(check.url, { redirect: "manual", signal, headers: { Accept: "image/jpeg,image/png,image/webp,image/*;q=0.8" } });
    } catch {
      bad(NO_DOWNLOAD, 422, "download_failed");
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) bad("The photo link redirected without saying where.", 422, "download_failed");
      current = new URL(loc, check.url).toString();
      res = null;
      continue;
    }
    break;
  }
  if (!res) bad("The photo link redirected too many times.", 422, "download_failed");
  if (!res.ok) bad(`The photo link answered ${res.status}. It may have expired; send a fresh link.`, 422, "download_failed");
  if (Number(res.headers.get("content-length") ?? "0") > MAX_ASSISTANT_PHOTO_BYTES) bad(TOO_BIG, 413, "too_large");
  if (!res.body) bad("The photo link returned nothing.", 422, "download_failed");

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ASSISTANT_PHOTO_BYTES) {
        await reader.cancel().catch(() => {});
        bad(TOO_BIG, 413, "too_large");
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof AssistantApiError) throw e;
    bad(NO_DOWNLOAD, 422, "download_failed");
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/** Upright, at most 2000 px on the longest side, JPEG, no metadata. */
async function normalizePhoto(bytes: Uint8Array): Promise<{ data: Buffer; width: number; height: number }> {
  if (bytes.byteLength === 0) bad("The photo was empty.");
  if (bytes.byteLength > MAX_ASSISTANT_PHOTO_BYTES) bad(TOO_BIG, 413, "too_large");
  const type = sniffImageType(bytes);
  if (type === "image/heic") bad("That's an iPhone HEIC photo. Convert it to JPEG first, then send it again.", 415, "unsupported_type");
  if (type !== "image/jpeg" && type !== "image/png" && type !== "image/webp") bad("That file isn't a JPEG, PNG or WebP photo.", 415, "unsupported_type");
  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: 50_000_000 })
      .rotate() // apply EXIF orientation, then the metadata is dropped on output
      .resize({ width: MAX_PHOTO_EDGE, height: MAX_PHOTO_EDGE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }) // transparent PNGs become white, like a listing photo should
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    bad("That photo couldn't be read. Send it again as a normal JPEG.", 415, "unsupported_type");
  }
}

/** Re-encodes the photo, uploads it to the reserved item's folder, and records it. Removes the file if recording fails. */
export async function storeAssistantPhoto(key: string, slot: PhotoSlot, bytes: Uint8Array): Promise<RecordPhotoResult & { url: string; width: number; height: number }> {
  const service = createServiceClient();
  if (!service) bad("Photo uploads aren't switched on yet: the server needs SUPABASE_SERVICE_ROLE_KEY. Tell the household to add it in Vercel.", 503, "photos_not_configured");
  const photo = await normalizePhoto(bytes);
  const path = photoStoragePath(slot.household_id, slot.item_id, randomUUID(), "jpg");

  const { error: upErr } = await service.storage.from(PHOTO_BUCKET).upload(path, photo.data, { contentType: "image/jpeg", upsert: false, cacheControl: "31536000" });
  if (upErr) bad(`Couldn't store the photo: ${upErr.message}`, 502, "storage_failed");

  try {
    const r = await callAssistantFunction<RecordPhotoResult>("assistant_record_photo", {
      p_key: key, p_item_id: slot.item_id, p_storage_path: path,
      p_width: photo.width, p_height: photo.height, p_bytes: photo.data.byteLength,
    });
    return { ...r, url: publicPhotoUrl(path), width: photo.width, height: photo.height };
  } catch (e) {
    await service.storage.from(PHOTO_BUCKET).remove([path]).catch(() => {});
    throw e;
  }
}

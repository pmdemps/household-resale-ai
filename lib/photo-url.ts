// Pure helpers for item photos: no Supabase, no React, no DOM, so they can be unit-tested with node --test
// and imported from both the browser uploader (lib/photo-client.ts) and the server (lib/photos.ts).

export const PHOTO_BUCKET = "item-photos";
/** Largest file the browser may send as-is when it cannot re-encode it (also the bucket's file_size_limit). */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_PHOTOS_PER_ITEM = 12;
/** Photos are downscaled in the browser so the longest side is at most this many pixels. */
export const MAX_PHOTO_EDGE = 2000;
/** JPEG quality for the browser re-encode (0.86 keeps a 2000px photo around 0.5-1.5 MB). */
export const PHOTO_JPEG_QUALITY = 0.86;

/** Types that may be stored, and the file extension used for each. Must match the bucket's allowed_mime_types. */
export const PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Object key for a new photo: <household_id>/<item_id>/<random uuid>.<ext>. Storage RLS trusts the first
 * segment (the member's household); recordItemPhoto re-checks the whole shape with isValidPhotoPath.
 */
export function photoStoragePath(householdId: string, itemId: string, uuid: string, ext: string): string {
  return `${householdId}/${itemId}/${uuid}.${ext}`;
}

/**
 * True when `path` is exactly `<householdId>/<itemId>/<uuid>.<jpg|jpeg|png|webp>` for the given ids
 * (case-sensitive, lower-case uuid, no extra segments). The server uses this before recording a row,
 * so a client can only ever attach objects from its own household's folder for the item it names.
 */
export function isValidPhotoPath(path: string, householdId: string, itemId: string): boolean {
  if (!isUuid(householdId) || !isUuid(itemId)) return false;
  if (typeof path !== "string" || path.length > 200) return false;
  const re = new RegExp(`^${householdId}/${itemId}/${UUID_RE}\\.(jpg|jpeg|png|webp)$`);
  return re.test(path);
}

export function isUuid(value: string): boolean {
  return typeof value === "string" && new RegExp(`^${UUID_RE}$`).test(value);
}

/** Target size for an image so that its longest side is at most `maxEdge`, keeping the aspect ratio. */
export function fitWithin(width: number, height: number, maxEdge: number = MAX_PHOTO_EDGE): { width: number; height: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: w, height: h };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * Public HTTPS URL for a photo in the item-photos bucket. Marketplaces fetch listing images from this.
 * A storage_path that is already a full https:// or data:image URL is returned unchanged, which lets
 * fixtures and externally hosted images reuse the same column.
 */
export function photoUrl(baseUrl: string, storagePath: string): string {
  if (/^(https:\/\/|data:image\/)/i.test(storagePath)) return storagePath;
  const base = baseUrl.replace(/\/+$/, "");
  const path = storagePath.split("/").map(encodeURIComponent).join("/");
  return `${base}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`;
}

/** Normalises what a browser reports (image/jpg, image/heif…) to a canonical type, or null. HEIC is
 *  recognised (so messages can name it) but is not in PHOTO_TYPES: the browser converts it to JPEG first. */
export function normalizePhotoType(mime: string | null | undefined): string | null {
  const m = (mime ?? "").toLowerCase().split(";")[0].trim();
  if (m === "image/jpg" || m === "image/pjpeg") return "image/jpeg";
  if (m === "image/heif" || m === "image/heic") return "image/heic";
  return m in PHOTO_TYPES ? m : null;
}

/** Detects the real image type from the first bytes, so a renamed file can't lie about what it is. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis"].includes(brand)) return "image/heic";
  }
  return null;
}

/** Pixel size read from the header, without decoding. Null when unknown (e.g. HEIC). */
export function imageDimensions(bytes: Uint8Array, type: string): { width: number; height: number } | null {
  const b = bytes;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ok = (w: number, h: number) => (w > 0 && h > 0 ? { width: w, height: h } : null);
  if (type === "image/png" && b.length >= 24) return ok(dv.getUint32(16), dv.getUint32(20));
  if (type === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return ok(dv.getUint16(i + 7), dv.getUint16(i + 5));
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      i += 2 + dv.getUint16(i + 2);
    }
    return null;
  }
  if (type === "image/webp" && b.length >= 30) {
    const chunk = ascii(b, 12, 16);
    if (chunk === "VP8X") return ok(1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
    if (chunk === "VP8 ") return ok(dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff);
    if (chunk === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return ok(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
    }
  }
  return null;
}

function ascii(b: Uint8Array, from: number, to: number) {
  let s = "";
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]);
  return s;
}

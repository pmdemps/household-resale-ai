// Browser-only photo preparation for the uploader (components/photo-uploader.tsx). No node imports and
// no "server-only": this runs in the client bundle. The pure, unit-tested pieces live in lib/photo-url.ts.
//
// Why re-encode in the browser: Vercel caps request bodies at 4.5 MB, so phone photos (3-5 MB, often
// HEIC) cannot travel through a server action. The browser decodes the photo, shrinks it so the longest
// side is at most MAX_PHOTO_EDGE, re-encodes it as JPEG and uploads straight to Supabase Storage.
// Side effects we want anyway: HEIC becomes JPEG wherever the browser can decode HEIC (Safari, iOS),
// EXIF metadata (including GPS location) is dropped before a photo goes onto a public bucket, and
// every stored photo is a sane size for marketplaces.

import { fitWithin, imageDimensions, MAX_PHOTO_BYTES, MAX_PHOTO_EDGE, PHOTO_JPEG_QUALITY, PHOTO_TYPES, sniffImageType } from "./photo-url";

export type PreparedPhoto = {
  blob: Blob;
  contentType: string;
  /** File extension to store under (jpg, png, webp). */
  ext: string;
  width: number | null;
  height: number | null;
  /** True when the browser re-encoded the photo; false when the original went up as-is. */
  resized: boolean;
};

/** A problem with one photo that the user can act on (shown inline next to the uploader). */
export class PhotoPrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoPrepareError";
  }
}

/**
 * Decode → downscale → JPEG. When the browser cannot decode the file at all, the original is used only if
 * it really is a JPEG/PNG/WebP under MAX_PHOTO_BYTES; HEIC that cannot be decoded here is rejected with
 * advice, because nothing (not this app, not eBay) could display it.
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const decoded = await decodeImage(file);
  if (decoded) {
    try {
      const { width, height } = fitWithin(decoded.width, decoded.height, MAX_PHOTO_EDGE);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(decoded.source, 0, 0, width, height);
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", PHOTO_JPEG_QUALITY));
        if (blob && blob.size > 0) return { blob, contentType: "image/jpeg", ext: "jpg", width, height, resized: true };
      }
    } finally {
      decoded.release();
    }
  }

  // Could not decode (or the canvas refused): fall back to the untouched original when it is safe to.
  const head = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
  const type = sniffImageType(head);
  if (type === "image/heic") {
    throw new PhotoPrepareError("This browser can't convert HEIC photos. Upload from an iPhone/iPad or Safari, or set the camera to Most Compatible (JPEG).");
  }
  if (!type || !(type in PHOTO_TYPES)) throw new PhotoPrepareError("Not a JPEG, PNG, WebP or HEIC photo.");
  if (file.size > MAX_PHOTO_BYTES) throw new PhotoPrepareError("Couldn't resize this photo and it is over 10 MB. Try a smaller copy.");
  const dims = imageDimensions(head, type);
  return { blob: file, contentType: type, ext: PHOTO_TYPES[type], width: dims?.width ?? null, height: dims?.height ?? null, resized: false };
}

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void };

/** createImageBitmap first (fast, off the main thread, honours EXIF orientation), then an <img> + object URL. */
async function decodeImage(file: File): Promise<Decoded | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      if (bitmap.width > 0 && bitmap.height > 0) return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
      bitmap.close();
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("undecodable"));
      img.src = url;
    });
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
    }
  } catch {
    /* undecodable */
  }
  URL.revokeObjectURL(url);
  return null;
}

/** crypto.randomUUID() needs a secure context; plain-http LAN testing gets a v4 built from getRandomValues. */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

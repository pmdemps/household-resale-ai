import { test } from "node:test";
import assert from "node:assert/strict";
import { imageDimensions, normalizePhotoType, photoUrl, sniffImageType } from "./photo-url.ts";

const HOUSE = "11111111-1111-1111-1111-111111111111";

test("photoUrl builds the public object URL", () => {
  assert.equal(
    photoUrl("https://abc.supabase.co", `${HOUSE}/item-1/photo.jpg`),
    `https://abc.supabase.co/storage/v1/object/public/item-photos/${HOUSE}/item-1/photo.jpg`,
  );
});

test("photoUrl tolerates a trailing slash and encodes odd characters per segment", () => {
  assert.equal(photoUrl("https://abc.supabase.co/", "h/i/my photo#1.jpg"), "https://abc.supabase.co/storage/v1/object/public/item-photos/h/i/my%20photo%231.jpg");
});

test("photoUrl passes through full https and data URLs", () => {
  assert.equal(photoUrl("https://abc.supabase.co", "https://cdn.example.com/x.jpg"), "https://cdn.example.com/x.jpg");
  assert.equal(photoUrl("https://abc.supabase.co", "data:image/svg+xml,%3Csvg%3E"), "data:image/svg+xml,%3Csvg%3E");
  // Not a public URL scheme: treated as a storage path.
  assert.match(photoUrl("https://abc.supabase.co", "javascript:alert(1)"), /^https:\/\/abc\.supabase\.co\/storage/);
});

test("normalizePhotoType maps browser variants and rejects everything else", () => {
  assert.equal(normalizePhotoType("image/jpg"), "image/jpeg");
  assert.equal(normalizePhotoType("IMAGE/PNG; charset=binary"), "image/png");
  assert.equal(normalizePhotoType("image/heif"), "image/heic");
  assert.equal(normalizePhotoType("image/gif"), null);
  assert.equal(normalizePhotoType("application/pdf"), null);
  assert.equal(normalizePhotoType(undefined), null);
});

const png = (w: number, h: number) => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const jpeg = (w: number, h: number) => {
  // SOI, APP0 (length 16, filler), SOF0 with height/width, then nothing else.
  const b = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 0, 0, 0, 0]);
  const dv = new DataView(b.buffer);
  dv.setUint16(2 + 2 + 16 + 5, h);
  dv.setUint16(2 + 2 + 16 + 7, w);
  return b;
};

test("sniffImageType recognises jpeg, png, webp, heic and rejects others", () => {
  assert.equal(sniffImageType(jpeg(10, 10)), "image/jpeg");
  assert.equal(sniffImageType(png(1, 1)), "image/png");
  const webp = new Uint8Array(30);
  webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  assert.equal(sniffImageType(webp), "image/webp");
  const heic = new Uint8Array(12);
  heic.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
  assert.equal(sniffImageType(heic), "image/heic");
  assert.equal(sniffImageType(new TextEncoder().encode("GIF89a......")), null);
  assert.equal(sniffImageType(new TextEncoder().encode("<svg xmlns=")), null);
});

test("imageDimensions reads png, jpeg and webp headers", () => {
  assert.deepEqual(imageDimensions(png(1200, 1600), "image/png"), { width: 1200, height: 1600 });
  assert.deepEqual(imageDimensions(jpeg(640, 480), "image/jpeg"), { width: 640, height: 480 });
  const webp = new Uint8Array(30);
  webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0]);
  webp.set([0x1f, 0x03, 0x00, 0x57, 0x02, 0x00], 24); // canvas 800x600 (value - 1, little endian 24-bit)
  assert.deepEqual(imageDimensions(webp, "image/webp"), { width: 800, height: 600 });
  assert.equal(imageDimensions(new Uint8Array(40), "image/heic"), null);
  assert.equal(imageDimensions(new Uint8Array(4), "image/png"), null);
});

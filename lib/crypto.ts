// AES-256-GCM encryption for marketplace OAuth tokens at rest, plus an HMAC helper for signed
// OAuth `state` values. Server-side only: import this from server actions, route handlers and
// lib/ebay/*, never from a client component. (No `server-only` import so node --test can load it.)
//
// Key: TOKEN_ENCRYPTION_KEY, base64 of 32 random bytes. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Ciphertext format: "v1:<iv b64>:<ciphertext b64>:<auth tag b64>". The "v1" prefix is the key
// version; rotate by introducing v2 and re-encrypting lazily on read.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ENCRYPTION_KEY_ENV = "TOKEN_ENCRYPTION_KEY";
const VERSION = "v1";
const IV_BYTES = 12;

export class CryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoConfigError";
  }
}

export function isEncryptionConfigured(key: string | undefined = process.env[ENCRYPTION_KEY_ENV]): boolean {
  try {
    loadKey(key);
    return true;
  } catch {
    return false;
  }
}

/** Decode and validate the base64 key (32 bytes). Throws a clear error otherwise. */
export function loadKey(key: string | undefined = process.env[ENCRYPTION_KEY_ENV]): Buffer {
  if (!key || !key.trim()) {
    throw new CryptoConfigError(
      `${ENCRYPTION_KEY_ENV} is not set. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  const buf = Buffer.from(key.trim(), "base64");
  if (buf.length !== 32) {
    throw new CryptoConfigError(`${ENCRYPTION_KEY_ENV} must be base64 of exactly 32 bytes (got ${buf.length}).`);
  }
  return buf;
}

/** Generate a fresh base64 key (same as the documented node -e one-liner). */
export function generateKey(): string {
  return randomBytes(32).toString("base64");
}

export function encrypt(plaintext: string, key: string | undefined = process.env[ENCRYPTION_KEY_ENV]): string {
  const k = loadKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), ct.toString("base64"), tag.toString("base64")].join(":");
}

export function decrypt(payload: string, key: string | undefined = process.env[ENCRYPTION_KEY_ENV]): string {
  const k = loadKey(key);
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Unrecognized ciphertext format (expected v1:iv:ciphertext:tag).");
  }
  const [, ivB64, ctB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error("Corrupt ciphertext (bad iv or tag length).");
  const decipher = createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAuthTag(tag);
  // Throws "Unsupported state or unable to authenticate data" when tampered or wrong key.
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** Base64url HMAC-SHA256 of `data` keyed by the token encryption key (used for OAuth state). */
export function hmacSign(data: string, key: string | undefined = process.env[ENCRYPTION_KEY_ENV]): string {
  return createHmac("sha256", loadKey(key)).update(data).digest("base64url");
}

export function hmacVerify(data: string, signature: string, key: string | undefined = process.env[ENCRYPTION_KEY_ENV]): boolean {
  const expected = Buffer.from(hmacSign(data, key));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

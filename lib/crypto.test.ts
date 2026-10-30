import { test } from "node:test";
import assert from "node:assert/strict";
import { CryptoConfigError, decrypt, encrypt, generateKey, hmacSign, hmacVerify, isEncryptionConfigured, loadKey } from "./crypto.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER = Buffer.alloc(32, 9).toString("base64");

test("round-trips a token and uses the v1:iv:ct:tag format", () => {
  const token = "v^1.1#i^1#p^3#f^0#r^1#I^3#t^Ul4xMF80OjQ1NEQ...";
  const enc = encrypt(token, KEY);
  const parts = enc.split(":");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], "v1");
  assert.equal(Buffer.from(parts[1], "base64").length, 12);
  assert.equal(Buffer.from(parts[3], "base64").length, 16);
  assert.equal(decrypt(enc, KEY), token);
});

test("every encryption uses a fresh iv", () => {
  assert.notEqual(encrypt("same", KEY), encrypt("same", KEY));
});

test("wrong key or tampered ciphertext fails to decrypt", () => {
  const enc = encrypt("secret", KEY);
  assert.throws(() => decrypt(enc, OTHER));
  const [v, iv, ct, tag] = enc.split(":");
  const flipped = Buffer.from(ct, "base64");
  flipped[0] ^= 0xff;
  assert.throws(() => decrypt([v, iv, flipped.toString("base64"), tag].join(":"), KEY));
  assert.throws(() => decrypt("v2:a:b:c", KEY), /Unrecognized/);
});

test("missing or wrong-length key gives a clear error", () => {
  assert.throws(() => loadKey(undefined), (e: unknown) => e instanceof CryptoConfigError && /TOKEN_ENCRYPTION_KEY is not set/.test((e as Error).message));
  assert.throws(() => loadKey(""), CryptoConfigError);
  assert.throws(() => encrypt("x", Buffer.alloc(16, 1).toString("base64")), /exactly 32 bytes \(got 16\)/);
  assert.equal(isEncryptionConfigured(undefined), false);
  assert.equal(isEncryptionConfigured(KEY), true);
});

test("generateKey produces a valid 32-byte base64 key", () => {
  const k = generateKey();
  assert.equal(Buffer.from(k, "base64").length, 32);
  assert.equal(decrypt(encrypt("hello", k), k), "hello");
});

test("hmac sign/verify is deterministic, keyed and tamper-evident", () => {
  const sig = hmacSign("household:abc", KEY);
  assert.equal(sig, hmacSign("household:abc", KEY));
  assert.ok(hmacVerify("household:abc", sig, KEY));
  assert.equal(hmacVerify("household:abd", sig, KEY), false);
  assert.equal(hmacVerify("household:abc", sig, OTHER), false);
  assert.equal(hmacVerify("household:abc", sig + "x", KEY), false);
});

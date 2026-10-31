import { createHash, randomBytes } from "node:crypto";

// Assistant keys: the credential a personal AI assistant (Muse, ChatGPT, ...) presents to /api/assistant.
// The plaintext is shown once when a member creates it in Settings; the database keeps only the SHA-256
// (assistant_keys.key_hash), compared in SQL with public.sha256_hex, so the hashing here must stay
// "sha256 of the UTF-8 bytes, lowercase hex".

export const ASSISTANT_KEY_PREFIX = "rhq_";
/** Characters of the key shown in Settings so two keys can be told apart. */
export const ASSISTANT_KEY_PREFIX_CHARS = 12;

export type GeneratedAssistantKey = { token: string; hash: string; prefix: string };

export function hashAssistantKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 32 random bytes, base64url, behind a recognizable prefix: 47 characters, no padding, URL-safe. */
export function generateAssistantKey(bytes: Buffer = randomBytes(32)): GeneratedAssistantKey {
  const token = ASSISTANT_KEY_PREFIX + bytes.toString("base64url");
  return { token, hash: hashAssistantKey(token), prefix: token.slice(0, ASSISTANT_KEY_PREFIX_CHARS) };
}

/** Cheap shape check before hitting the database (the database does the real check). */
export function looksLikeAssistantKey(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 200 && /^[A-Za-z0-9_-]+$/.test(value);
}

/** Pulls the key out of `Authorization: Bearer <key>` or `X-Assistant-Key: <key>`. */
export function assistantKeyFromHeaders(headers: { get(name: string): string | null }): string | null {
  const auth = headers.get("authorization") ?? "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const direct = headers.get("x-assistant-key")?.trim();
  const candidate = bearer || direct || null;
  return looksLikeAssistantKey(candidate) ? candidate : null;
}

// eBay OAuth 2.0 authorization-code grant: consent URL, code exchange, refresh, and a signed
// `state` that carries the household id + nonce (HMAC with TOKEN_ENCRYPTION_KEY).
// Reference: https://developer.ebay.com/api-docs/static/oauth-consent-request.html
//            https://developer.ebay.com/api-docs/static/oauth-auth-code-grant-request.html
//            https://developer.ebay.com/api-docs/static/oauth-refresh-token-request.html

import { randomBytes } from "node:crypto";
import { hmacSign, hmacVerify } from "../crypto.ts";
import { EBAY_HOSTS, EBAY_USER_SCOPES, type EbayConfig, type EbayEnv } from "./config.ts";

export type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  token_type: string;
};

export class EbayOAuthError extends Error {
  readonly status: number | undefined;
  readonly body: string | undefined;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "EbayOAuthError";
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Signed state
// ---------------------------------------------------------------------------
export type OAuthState = { h: string; u: string; n: string; t: number };

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");

export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

/** state = base64url(json).signature — the household id and user id travel with the round trip. */
export function signState(payload: Omit<OAuthState, "t"> & { t?: number }, key?: string): string {
  const full: OAuthState = { ...payload, t: payload.t ?? Date.now() };
  const body = b64url(JSON.stringify(full));
  return `${body}.${hmacSign(body, key)}`;
}

/** Returns the payload when the signature is valid and the state is younger than maxAgeMs (default 15 min). */
export function verifyState(state: string | null | undefined, key?: string, maxAgeMs = 15 * 60 * 1000, now = Date.now()): OAuthState | null {
  if (!state) return null;
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  try {
    if (!hmacVerify(body, sig, key)) return null;
    const parsed = JSON.parse(unb64url(body)) as Partial<OAuthState>;
    if (typeof parsed.h !== "string" || typeof parsed.u !== "string" || typeof parsed.n !== "string" || typeof parsed.t !== "number") return null;
    if (now - parsed.t > maxAgeMs || parsed.t - now > 60_000) return null;
    return parsed as OAuthState;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Consent URL
// ---------------------------------------------------------------------------
export function buildAuthorizeUrl(opts: { env: EbayEnv; clientId: string; ruName: string; state: string; scopes?: readonly string[]; promptLogin?: boolean }): string {
  const url = new URL(`${EBAY_HOSTS[opts.env].auth}/oauth2/authorize`);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.ruName);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (opts.scopes ?? EBAY_USER_SCOPES).join(" "));
  url.searchParams.set("state", opts.state);
  if (opts.promptLogin ?? true) url.searchParams.set("prompt", "login");
  return url.toString();
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------
export function tokenEndpoint(env: EbayEnv): string {
  return `${EBAY_HOSTS[env].api}/identity/v1/oauth2/token`;
}

export function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

/** Body for the code→token exchange. eBay returns the code URL-encoded; URLSearchParams re-encodes it once. */
export function buildCodeExchangeBody(code: string, ruName: string): URLSearchParams {
  return new URLSearchParams({ grant_type: "authorization_code", code: safeDecode(code), redirect_uri: ruName });
}

export function buildRefreshBody(refreshToken: string, scopes: readonly string[] = EBAY_USER_SCOPES): URLSearchParams {
  return new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, scope: scopes.join(" ") });
}

export function buildClientCredentialsBody(scope: string): URLSearchParams {
  return new URLSearchParams({ grant_type: "client_credentials", scope });
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

type Fetch = typeof fetch;

async function postToken(cfg: EbayConfig, body: URLSearchParams, fetchImpl: Fetch = fetch): Promise<TokenResponse> {
  const res = await fetchImpl(tokenEndpoint(cfg.env), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuthHeader(cfg.clientId, cfg.clientSecret) },
    body: body.toString(),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const j = JSON.parse(text) as { error?: string; error_description?: string };
      detail = [j.error, j.error_description].filter(Boolean).join(": ") || text;
    } catch {
      /* keep raw text */
    }
    throw new EbayOAuthError(`eBay token request failed (${res.status}): ${detail.slice(0, 300)}`, res.status, text);
  }
  const json = JSON.parse(text) as TokenResponse;
  if (!json.access_token) throw new EbayOAuthError("eBay token response had no access_token", res.status, text);
  return json;
}

export async function exchangeCode(cfg: EbayConfig, code: string, fetchImpl?: Fetch): Promise<TokenResponse> {
  return postToken(cfg, buildCodeExchangeBody(code, cfg.ruName), fetchImpl);
}

export async function refreshAccessToken(cfg: EbayConfig, refreshToken: string, scopes?: readonly string[], fetchImpl?: Fetch): Promise<TokenResponse> {
  return postToken(cfg, buildRefreshBody(refreshToken, scopes), fetchImpl);
}

/** Application (client-credentials) token, e.g. for the Taxonomy API. */
export async function getAppToken(cfg: EbayConfig, scope: string, fetchImpl?: Fetch): Promise<TokenResponse> {
  return postToken(cfg, buildClientCredentialsBody(scope), fetchImpl);
}

/** Convert expires_in seconds (from `issuedAt`) to an ISO timestamp, minus a small safety margin. */
export function expiryIso(expiresInSeconds: number, issuedAt = Date.now(), marginSeconds = 60): string {
  return new Date(issuedAt + Math.max(0, expiresInSeconds - marginSeconds) * 1000).toISOString();
}

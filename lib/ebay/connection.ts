import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt, encrypt } from "@/lib/crypto";
import type { MarketplaceConnection } from "@/lib/types";
import { EbayClient, EbayReauthError, type TokenStore } from "./api";
import { readEbayConfig } from "./config";
import type { TokenResponse } from "./oauth";

// Glue between marketplace_connections rows and the pure EbayClient. Works with either the user's
// RLS-scoped client (server actions) or the service-role client (the sync route).

export type Db = SupabaseClient;

export async function loadEbayConnection(db: Db, householdId: string): Promise<MarketplaceConnection | null> {
  const { data, error } = await db.from("marketplace_connections").select("*").eq("household_id", householdId).eq("platform", "ebay").maybeSingle();
  if (error) throw new Error(error.message);
  return (data as MarketplaceConnection | null) ?? null;
}

export function isUsableConnection(conn: MarketplaceConnection | null): conn is MarketplaceConnection {
  return Boolean(conn && conn.status === "active" && conn.refresh_token_enc);
}

/** Encrypted column values for a fresh token response (code exchange). */
export function tokenColumns(tokens: TokenResponse, issuedAt = Date.now()) {
  return {
    access_token_enc: encrypt(tokens.access_token),
    refresh_token_enc: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
    access_expires_at: new Date(issuedAt + Math.max(0, tokens.expires_in - 60) * 1000).toISOString(),
    refresh_expires_at: tokens.refresh_token_expires_in ? new Date(issuedAt + tokens.refresh_token_expires_in * 1000).toISOString() : null,
  };
}

function storeFor(db: Db, conn: MarketplaceConnection): TokenStore {
  return {
    async load() {
      if (conn.status !== "active") throw new EbayReauthError();
      return {
        accessToken: conn.access_token_enc ? decrypt(conn.access_token_enc) : null,
        accessExpiresAt: conn.access_expires_at,
        refreshToken: conn.refresh_token_enc ? decrypt(conn.refresh_token_enc) : null,
        refreshExpiresAt: conn.refresh_expires_at,
      };
    },
    async saveAccessToken(accessToken, accessExpiresAt) {
      const enc = encrypt(accessToken);
      const { error } = await db.from("marketplace_connections").update({ access_token_enc: enc, access_expires_at: accessExpiresAt, last_error: null }).eq("id", conn.id);
      if (error) throw new Error(`Could not store refreshed eBay token: ${error.message}`);
      conn.access_token_enc = enc;
      conn.access_expires_at = accessExpiresAt;
    },
    async markError(message) {
      await db.from("marketplace_connections").update({ status: "error", last_error: message.slice(0, 500) }).eq("id", conn.id);
      conn.status = "error";
      conn.last_error = message;
    },
  };
}

/** An API client bound to this connection; refreshed tokens are written back encrypted. */
export function ebayClientFor(db: Db, conn: MarketplaceConnection): EbayClient {
  const cfg = readEbayConfig();
  // A connection made against the other eBay environment cannot be used with these keys.
  if (conn.environment !== cfg.env) throw new EbayReauthError(`This eBay connection is for ${conn.environment}, but the app is configured for ${cfg.env}. Reconnect eBay.`);
  return new EbayClient(cfg, storeFor(db, conn));
}

export type ShipFromState = { city: string; stateOrProvince: string; postalCode: string };

export async function loadShipFrom(db: Db, householdId: string): Promise<ShipFromState | null> {
  const { data } = await db.from("sync_state").select("value").eq("household_id", householdId).eq("key", "ebay_ship_from").maybeSingle();
  const v = (data?.value ?? null) as Partial<ShipFromState> | null;
  if (!v || !v.city || !v.stateOrProvince || !v.postalCode) return null;
  return { city: v.city, stateOrProvince: v.stateOrProvince, postalCode: v.postalCode };
}

export async function writeSyncState(db: Db, householdId: string, key: string, value: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("sync_state").upsert({ household_id: householdId, key, value }, { onConflict: "household_id,key" });
  if (error) throw new Error(error.message);
}

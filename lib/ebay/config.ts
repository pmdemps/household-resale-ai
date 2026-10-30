// eBay integration configuration. Pure module (env in, values out) so it can be unit tested.
// Everything degrades gracefully when the EBAY_* variables are absent: isEbayConfigured() is false
// and the UI shows setup instructions instead of a Connect button. See docs/ebay-setup.md.

// Relative .ts imports (not "@/") so node --test can load this module without a bundler.
import { isEncryptionConfigured } from "../crypto.ts";

export type EbayEnv = "sandbox" | "production";

export const EBAY_HOSTS: Record<EbayEnv, { auth: string; api: string; web: string }> = {
  sandbox: { auth: "https://auth.sandbox.ebay.com", api: "https://api.sandbox.ebay.com", web: "https://sandbox.ebay.com" },
  production: { auth: "https://auth.ebay.com", api: "https://api.ebay.com", web: "https://www.ebay.com" },
};

/** User-consent scopes requested at connect time (see research: Inventory, Account, Fulfillment, Notification, Identity). */
export const EBAY_USER_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/commerce.notification.subscription",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
] as const;

/** Client-credentials scope used for the Taxonomy API (no user needed). */
export const EBAY_APP_SCOPE = "https://api.ebay.com/oauth/api_scope";

export const EBAY_MARKETPLACE_ID = "EBAY_US";

/** Leaf category used when Taxonomy suggestions are unavailable (sandbox) and no override is set.
 *  88433 = "Everything Else > Every Other Thing". Override with EBAY_DEFAULT_CATEGORY_ID. */
export const EBAY_FALLBACK_CATEGORY_ID = "88433";

export type EbayConfig = {
  env: EbayEnv;
  clientId: string;
  clientSecret: string;
  /** eBay's RuName; it is the OAuth redirect_uri value, not a URL. */
  ruName: string;
  deletionVerificationToken: string;
  appUrl: string;
  defaultCategoryId: string;
  hosts: { auth: string; api: string; web: string };
};

export function parseEbayEnv(raw: string | undefined): EbayEnv {
  return raw?.trim().toLowerCase() === "production" ? "production" : "sandbox";
}

/** Public base URL of this deployment, used for redirects and the account-deletion endpoint URL. */
export function appUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return "http://localhost:3000";
}

export function readEbayConfig(env: NodeJS.ProcessEnv = process.env): EbayConfig {
  const e = parseEbayEnv(env.EBAY_ENV);
  return {
    env: e,
    clientId: env.EBAY_CLIENT_ID?.trim() ?? "",
    clientSecret: env.EBAY_CLIENT_SECRET?.trim() ?? "",
    ruName: env.EBAY_RU_NAME?.trim() ?? "",
    deletionVerificationToken: env.EBAY_DELETION_VERIFICATION_TOKEN?.trim() ?? "",
    appUrl: appUrl(env),
    defaultCategoryId: env.EBAY_DEFAULT_CATEGORY_ID?.trim() || EBAY_FALLBACK_CATEGORY_ID,
    hosts: EBAY_HOSTS[e],
  };
}

/** Env var names the owner must set before "Connect eBay" appears. */
export const EBAY_REQUIRED_ENV = ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RU_NAME", "TOKEN_ENCRYPTION_KEY"] as const;

export function missingEbayEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  const c = readEbayConfig(env);
  if (!c.clientId) missing.push("EBAY_CLIENT_ID");
  if (!c.clientSecret) missing.push("EBAY_CLIENT_SECRET");
  if (!c.ruName) missing.push("EBAY_RU_NAME");
  if (!isEncryptionConfigured(env.TOKEN_ENCRYPTION_KEY)) missing.push("TOKEN_ENCRYPTION_KEY");
  return missing;
}

export function isEbayConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return missingEbayEnv(env).length === 0;
}

/** Public URL of a listing: https://www.ebay.com/itm/<id> (sandbox: https://sandbox.ebay.com/itm/<id>). */
export function ebayListingUrl(listingId: string, env: EbayEnv): string {
  return `${EBAY_HOSTS[env].web}/itm/${encodeURIComponent(listingId)}`;
}

import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client (bypasses row-level security). Server only, and only for jobs that have no user
 * session: today that is the eBay offer poll (app/api/ebay/sync), which must read connections across
 * households. Returns null when SUPABASE_SERVICE_ROLE_KEY is not set so callers can degrade (503).
 * Never import this from a page, component, or anything a browser bundle could reach.
 */
export function createServiceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

/** Anonymous (publishable key) client with no cookies/session, for public webhooks such as the eBay
 *  account-deletion endpoint, which only needs to call a SECURITY DEFINER function granted to anon. */
export function createAnonClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

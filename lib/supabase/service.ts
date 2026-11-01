import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client (bypasses row-level security). Server only, and only for jobs that have no user
 * session: the eBay offer poll (app/api/ebay/sync), which must read connections across households, and
 * the eBay account-deletion endpoint (app/api/ebay/account-deletion), whose SECURITY DEFINER function is
 * executable by the service role only, and photos the household's assistant sends (lib/assistant/photos.ts),
 * which are written to Storage only after the assistant key, household and photo limit were checked in SQL. Returns null when SUPABASE_SERVICE_ROLE_KEY is not set so
 * callers can degrade (503). Never import this from a page, component, or anything a browser bundle could reach.
 */
export function createServiceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

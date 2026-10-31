import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mapDbError, type ApiFailure } from "./protocol";

// Database access for /api/assistant. There is no user session: the assistant key is the credential, and
// it is checked INSIDE the SQL functions (public.assistant_* in supabase/migrations/20261031000000_...).
// So this client uses the publishable key (role anon), which can call those functions and nothing else of
// consequence. No service-role key is needed for the assistant to work.

export class AssistantApiError extends Error {
  constructor(public readonly failure: ApiFailure) {
    super(failure.error);
  }
}

let cached: SupabaseClient | null = null;

export function assistantDb(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new AssistantApiError({ status: 503, code: "misconfigured", error: "Supabase is not configured on the server." });
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return cached;
}

/** Calls one of the assistant_* SQL functions; database errors become AssistantApiError with an HTTP status. */
export async function callAssistantFunction<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await assistantDb().rpc(fn, args);
  if (error) throw new AssistantApiError(mapDbError(error));
  return data as T;
}

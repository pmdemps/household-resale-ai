import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Household, Membership } from "@/lib/types";

export function isSupabaseConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  );
}

export type AppContext = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  email: string | null;
  household: Household | null;
  role: Membership["role"] | null;
};

/** Signed-in user plus their (first) household. Redirects to /login when signed out. */
export async function getContext(): Promise<AppContext> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: membership } = await supabase
    .from("household_members")
    .select("household_id, role")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  let household: Household | null = null;
  if (membership) {
    const { data } = await supabase.from("households").select("*").eq("id", membership.household_id).single();
    household = data as Household | null;
  }

  return { supabase, userId: user.id, email: user.email ?? null, household, role: (membership?.role as Membership["role"]) ?? null };
}

/** Same as getContext but guarantees a household (redirects to setup otherwise). */
export async function requireHousehold() {
  const ctx = await getContext();
  if (!ctx.household) redirect("/setup");
  return ctx as AppContext & { household: Household; role: Membership["role"] };
}

"use server";

import { revalidatePath } from "next/cache";
import { requireHousehold } from "@/lib/household";
import { generateAssistantKey } from "@/lib/assistant/keys";

// Settings → "Your AI sidekick": keys a member hands to their personal assistant (Muse, ChatGPT, ...).
// The plaintext key exists only in the response to createAssistantKey; the database keeps the SHA-256.

export type NewKeyState = { token?: string; label?: string; prefix?: string; error?: string } | null;

export async function createAssistantKey(_prev: NewKeyState, form: FormData): Promise<NewKeyState> {
  const ctx = await requireHousehold();
  const label = String(form.get("label") ?? "").trim().slice(0, 40) || "assistant";
  const key = generateAssistantKey();
  const { data, error } = await ctx.supabase
    .from("assistant_keys")
    .insert({ household_id: ctx.household.id, user_id: ctx.userId, label, key_hash: key.hash, key_prefix: key.prefix })
    .select("id")
    .single();
  if (error) return { error: error.message };
  await ctx.supabase.from("activity_log").insert({
    household_id: ctx.household.id,
    actor_user: ctx.userId,
    action: "assistant_key_created",
    entity_type: "assistant_key",
    entity_id: data?.id ?? null,
    detail: { label, prefix: key.prefix },
  });
  revalidatePath("/settings");
  return { token: key.token, label, prefix: key.prefix };
}

export async function revokeAssistantKey(form: FormData): Promise<void> {
  const ctx = await requireHousehold();
  const id = String(form.get("id") ?? "").trim().slice(0, 64);
  if (!id) return;
  const { data, error } = await ctx.supabase
    .from("assistant_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("household_id", ctx.household.id)
    .is("revoked_at", null)
    .select("label, key_prefix")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) {
    await ctx.supabase.from("activity_log").insert({
      household_id: ctx.household.id,
      actor_user: ctx.userId,
      action: "assistant_key_revoked",
      entity_type: "assistant_key",
      entity_id: id,
      detail: { label: data.label, prefix: data.key_prefix },
    });
  }
  revalidatePath("/settings");
}

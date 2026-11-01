"use server";

import { revalidatePath } from "next/cache";
import webpush from "web-push";
import { requireHousehold } from "@/lib/household";
import { appUrl } from "@/lib/ebay/config";
import { cleanOrigin, isAllowedPushEndpoint, normalizeKey, pushErrorMessage, validSubscriptionKeys } from "@/lib/push/notify";

// Settings → "Phone buzzes" (components/push-toggle.tsx). The SQL side is
// supabase/migrations/20261031010000_push_notifications.sql; the activity log entries are written there.

export type PushResult = { ok: true; publicKey?: string; devices?: number } | { ok: false; error: string };

/** The household's VAPID public key, made (and kept) on first use. */
export async function preparePush(): Promise<PushResult> {
  const ctx = await requireHousehold();
  const keys = webpush.generateVAPIDKeys();
  const { data, error } = await ctx.supabase.rpc("push_prepare", {
    p_household_id: ctx.household.id,
    p_vapid_public_key: keys.publicKey,
    p_vapid_private_key: keys.privateKey,
  });
  if (error || typeof data !== "string") return { ok: false, error: pushErrorMessage(error) };
  return { ok: true, publicKey: data };
}

export async function savePushSubscription(input: { endpoint: string; p256dh: string; auth: string; device: string }): Promise<PushResult> {
  const ctx = await requireHousehold();
  const endpoint = String(input?.endpoint ?? "").trim();
  const p256dh = normalizeKey(input?.p256dh);
  const auth = normalizeKey(input?.auth);
  if (!isAllowedPushEndpoint(endpoint) || !validSubscriptionKeys(p256dh, auth)) {
    return { ok: false, error: "This browser handed us a push address we don't recognize." };
  }
  // Where the database should send dispatch requests: the production address on Vercel (previews sit
  // behind Vercel's login, which the database can't get through), APP_URL or localhost elsewhere.
  const origin = cleanOrigin(appUrl());
  const { error } = await ctx.supabase.rpc("push_subscribe", {
    p_household_id: ctx.household.id,
    p_endpoint: endpoint,
    p_p256dh: p256dh,
    p_auth: auth,
    p_device_label: String(input?.device ?? "").trim().slice(0, 40) || "Phone",
    p_origin: origin,
  });
  if (error) return { ok: false, error: pushErrorMessage(error) };
  revalidatePath("/settings");
  return { ok: true };
}

export async function removePushSubscription(endpoint: string): Promise<PushResult> {
  const ctx = await requireHousehold();
  const value = String(endpoint ?? "").trim().slice(0, 1024);
  if (!value) return { ok: true };
  const { error } = await ctx.supabase.rpc("push_unsubscribe", { p_endpoint: value });
  if (error) return { ok: false, error: pushErrorMessage(error) };
  revalidatePath("/settings");
  return { ok: true };
}

/** Queues a test buzz for the caller's own devices; it goes out through the real path (database → dispatch). */
export async function sendTestPush(): Promise<PushResult> {
  const ctx = await requireHousehold();
  const { data, error } = await ctx.supabase.rpc("push_send_test", { p_household_id: ctx.household.id });
  if (error) return { ok: false, error: pushErrorMessage(error) };
  return { ok: true, devices: Number(data ?? 0) };
}

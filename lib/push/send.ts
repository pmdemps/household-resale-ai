import "server-only";
import webpush from "web-push";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { composeNotifications, vapidSubject, type PushClaim } from "./notify";

// Sending side of phone notifications, used by app/api/push/dispatch. There is no user session: the database
// sends the household's dispatch token, and the push_claim / push_report SQL functions check it. So this
// client uses the publishable key (role anon), like the assistant API. No service-role key, no env secrets.

export class PushDispatchError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

let cached: SupabaseClient | null = null;

export function pushDb(): SupabaseClient | null {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return cached;
}

export type DispatchSummary = { notifications: number; sent: number; failed: number; removed: number };

/** How long a push service keeps trying to reach a phone that is off: a day, then the to-do is still in the app. */
const TTL_SECONDS = 24 * 60 * 60;

export async function dispatchPush(db: SupabaseClient, householdId: string, token: string, fallbackOrigin: string): Promise<DispatchSummary> {
  const { data, error } = await db.rpc("push_claim", { p_household_id: householdId, p_token: token });
  if (error) {
    if (error.code === "28000") throw new PushDispatchError("Invalid dispatch token", 401);
    throw new PushDispatchError(`push_claim failed (${error.code ?? "unknown"})`, 500);
  }
  const claim = data as PushClaim;
  const plan = composeNotifications(claim.items ?? [], claim.pending_count ?? 0);
  const summary: DispatchSummary = { notifications: plan.length, sent: 0, failed: 0, removed: 0 };
  if (plan.length === 0 || !claim.subscriptions?.length) return summary;

  const vapidDetails = {
    subject: vapidSubject(claim.origin ?? fallbackOrigin),
    publicKey: claim.vapid_public_key,
    privateKey: claim.vapid_private_key,
  };
  const gone = new Set<string>();
  const delivered = new Set<string>();

  for (const n of plan) {
    const targets = claim.subscriptions.filter(
      s => (n.targetUser === null || s.user_id === n.targetUser) && (!n.exceptUser || s.user_id !== n.exceptUser),
    );
    const results = await Promise.allSettled(
      targets.map(s =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(n.payload),
          { vapidDetails, TTL: TTL_SECONDS, urgency: "high", timeout: 10_000 },
        ),
      ),
    );
    results.forEach((r, i) => {
      const endpoint = targets[i].endpoint;
      if (r.status === "fulfilled") {
        summary.sent++;
        delivered.add(endpoint);
        return;
      }
      summary.failed++;
      const status = (r.reason as { statusCode?: number } | undefined)?.statusCode;
      // 404/410: the phone dropped the subscription (app deleted, notifications turned off). Forget it.
      if (status === 404 || status === 410) gone.add(endpoint);
      // Status and push-service reason only: endpoints identify a person's device, so they stay out of logs.
      else console.error("push send failed", status ?? "no status", String((r.reason as { body?: string })?.body ?? "").slice(0, 120));
    });
  }

  for (const endpoint of gone) delivered.delete(endpoint);
  if (gone.size || delivered.size) {
    const { data: report, error: reportError } = await db.rpc("push_report", {
      p_household_id: householdId,
      p_token: token,
      p_gone: [...gone].slice(0, 100),
      p_ok: [...delivered].slice(0, 100),
    });
    if (reportError) console.error("push_report failed", reportError.code ?? "unknown");
    else summary.removed = Number((report as { removed?: number } | null)?.removed ?? 0);
  }
  return summary;
}

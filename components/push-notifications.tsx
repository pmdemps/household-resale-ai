import { Bell } from "lucide-react";
import { PushToggle } from "@/components/push-toggle";
import type { AppContext } from "@/lib/household";
import type { MemberNames } from "@/lib/queries";
import type { Household, Membership } from "@/lib/types";
import { timeAgo } from "@/lib/types";

type Props = { ctx: AppContext & { household: Household; role: Membership["role"] }; names: MemberNames };

type DeviceRow = { id: string; user_id: string; device_label: string; created_at: string; last_success_at: string | null };

/**
 * Settings → "Phone buzzes". Shows which of our phones get notifications; the switch for the phone you're
 * holding is the client half (components/push-toggle.tsx). How the buzz gets sent:
 * supabase/migrations/20261031010000_push_notifications.sql and app/api/push/dispatch.
 */
export async function PushNotifications({ ctx, names }: Props) {
  const { data, error } = await ctx.supabase
    .from("push_subscriptions")
    .select("id, user_id, device_label, created_at, last_success_at")
    .eq("household_id", ctx.household.id)
    .order("created_at", { ascending: true });
  const devices = (data ?? []) as DeviceRow[];

  return (
    <section className="surface p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold text-white"><Bell size={18} /> Phone buzzes</h2>
      <p className="mt-1 text-sm leading-6 text-slate-400">
        Get a buzz the second some shit happens: somebody makes an offer, something sells, a buyer messages us. Each of us
        turns it on on our own phone. The app icon also shows how many things are waiting on us.
      </p>

      {error ? (
        <p className="mt-3 rounded-xl border border-warn/30 bg-warn/10 p-3 text-sm leading-6 text-slate-200">
          The database part isn&apos;t set up yet. Run <code className="text-link">20261031010000_push_notifications.sql</code> in
          Supabase → SQL Editor, then come back here.
        </p>
      ) : (
        <>
          {devices.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-2">
              {devices.map(d => (
                <li key={d.id} className="rounded-full border border-line px-3 py-1 text-xs text-slate-300">
                  {d.user_id === ctx.userId ? "Your" : `${names[d.user_id] ?? "A member"}'s`} {d.device_label}
                  <span className="text-slate-500">
                    {" · "}{d.last_success_at ? `last buzzed ${timeAgo(d.last_success_at)}` : `turned on ${timeAgo(d.created_at)}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-slate-500">Nobody&apos;s phone is set up yet.</p>
          )}
          <PushToggle />
        </>
      )}
    </section>
  );
}

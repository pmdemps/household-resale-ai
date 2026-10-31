import { Bot, KeyRound, Unplug } from "lucide-react";
import { revokeAssistantKey } from "@/app/assistant-actions";
import { NewAssistantKey } from "@/components/assistant-key-form";
import { appUrl } from "@/lib/ebay/config";
import type { AppContext } from "@/lib/household";
import type { Household, Membership } from "@/lib/types";
import { timeAgo } from "@/lib/types";
import type { MemberNames } from "@/lib/queries";

type Props = { ctx: AppContext & { household: Household; role: Membership["role"] }; names: MemberNames };

type KeyRow = { id: string; user_id: string; label: string; key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null };

export const ASSISTANT_SETUP_DOC = "https://github.com/pmdemps/household-resale-ai/blob/main/docs/agents/assistant-concierge.md";

/**
 * Settings → "Your AI sidekick". Lists the household's assistant keys and lets a member make or revoke one.
 * The new key is shown once by the client half (components/assistant-key-form.tsx).
 */
export async function AssistantAccess({ ctx, names }: Props) {
  const { data } = await ctx.supabase
    .from("assistant_keys")
    .select("id, user_id, label, key_prefix, created_at, last_used_at, revoked_at")
    .eq("household_id", ctx.household.id)
    .order("created_at", { ascending: false });
  const keys = (data ?? []) as KeyRow[];
  const endpoint = `${appUrl()}/api/assistant`;

  return (
    <section className="surface p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold text-white"><Bot size={18} /> Your AI sidekick</h2>
      <p className="mt-1 text-sm leading-6 text-slate-400">
        Got Muse, ChatGPT or some other AI assistant? Give it a key and it can tell you the second an offer shows up, then carry your
        &ldquo;take it&rdquo;, &ldquo;counter at 35&rdquo; or &ldquo;fuck no&rdquo; back here. It can only do what we could do in this app ourselves, and it
        can&apos;t go under our floor price unless you tell it to in so many words.
      </p>

      {keys.length > 0 && (
        <ul className="mt-4 divide-y divide-line">
          {keys.map(k => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm text-white">
                  <KeyRound size={14} className="text-slate-500" />
                  <span className="font-medium">{k.label}</span>
                  <code className="text-xs text-slate-400">{k.key_prefix}…</code>
                  {k.revoked_at ? (
                    <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">revoked</span>
                  ) : (
                    <span className="rounded bg-good/15 px-1.5 py-0.5 text-[10px] text-good">active</span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {k.user_id === ctx.userId ? "Yours" : `${names[k.user_id] ?? "A member"}'s`} · made {timeAgo(k.created_at)}
                  {k.last_used_at ? ` · last used ${timeAgo(k.last_used_at)}` : " · never used yet"}
                </p>
              </div>
              {!k.revoked_at && (
                <form action={revokeAssistantKey}>
                  <input type="hidden" name="id" value={k.id} />
                  <button className="btn-secondary"><Unplug size={14} /> Cut it off</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      <NewAssistantKey endpoint={endpoint} docUrl={ASSISTANT_SETUP_DOC} />
    </section>
  );
}

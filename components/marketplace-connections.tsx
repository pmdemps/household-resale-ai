import { CheckCircle2, Link2, RefreshCw, Unplug } from "lucide-react";
import { disconnectEbay, saveEbayShipFrom, syncEbayOffersNow } from "@/app/marketplace-actions";
import { isEbayConfigured, missingEbayEnv, readEbayConfig } from "@/lib/ebay/config";
import { loadEbayConnection, loadShipFrom } from "@/lib/ebay/connection";
import { readEbayNotice } from "@/lib/ebay/notice";
import type { AppContext } from "@/lib/household";
import type { Household, Membership } from "@/lib/types";

type Props = { ctx: AppContext & { household: Household; role: Membership["role"] } };

/**
 * Settings → "Connected marketplaces". Self-contained server component: reads its own data and shows
 * the one-shot notice left by the eBay actions/routes. Mount with <MarketplaceConnections ctx={ctx} />.
 */
export async function MarketplaceConnections({ ctx }: Props) {
  const configured = isEbayConfigured();
  const [conn, shipFrom, notice, syncState] = await Promise.all([
    loadEbayConnection(ctx.supabase, ctx.household.id).catch(() => null),
    loadShipFrom(ctx.supabase, ctx.household.id).catch(() => null),
    readEbayNotice(),
    ctx.supabase.from("sync_state").select("value, updated_at").eq("household_id", ctx.household.id).eq("key", "ebay_offers").maybeSingle(),
  ]);
  const active = Boolean(conn && conn.status === "active" && conn.refresh_token_enc);
  const env = conn?.environment ?? readEbayConfig().env;
  const lastPoll = (syncState.data?.value as { last_poll?: string } | null)?.last_poll ?? null;

  return (
    <section className="surface p-5">
      <h2 className="text-base font-semibold text-white">Connected marketplaces</h2>
      <p className="mt-1 text-sm text-slate-400">Sign in once and Resale HQ posts listings and keeps an eye on offers. Nothing gets accepted or declined until one of us says so.</p>

      {notice && (
        <p className={`mt-3 rounded-lg border px-3 py-2 text-sm ${notice.kind === "ok" ? "border-good/30 bg-good/10 text-good" : "border-warn/30 bg-warn/10 text-warn"}`}>{notice.message}</p>
      )}

      <ul className="mt-4 divide-y divide-line">
        {/* eBay */}
        <li className="py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-white">
                eBay
                <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${env === "production" ? "bg-accent/15 text-link" : "bg-warn/15 text-warn"}`}>{env}</span>
              </p>
              {!configured && (
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  Not set up yet — see <code className="text-slate-300">docs/ebay-setup.md</code>. Missing: {missingEbayEnv().join(", ")}.
                </p>
              )}
              {configured && active && conn && (
                <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
                  <CheckCircle2 size={13} className="text-good" />
                  Connected{conn.account_handle ? <> as <span className="text-slate-200">{conn.account_handle}</span></> : ""} · Connected on {new Date(conn.created_at).toLocaleDateString()}
                  {lastPoll && <> · offers checked {new Date(lastPoll).toLocaleString()}</>}
                </p>
              )}
              {configured && conn && !active && (
                <p className="mt-1 text-xs text-warn">
                  {conn.status === "error" ? "eBay needs you to sign in again." : "Disconnected."}
                  {conn.last_error ? ` (${conn.last_error.slice(0, 120)})` : ""}
                </p>
              )}
              {configured && !conn && <p className="mt-1 text-xs text-slate-400">Not connected. You&apos;ll sign in on eBay and come straight back here.</p>}
            </div>

            {configured && (
              <div className="flex flex-wrap gap-2">
                {active ? (
                  <>
                    <form action={syncEbayOffersNow}>
                      <input type="hidden" name="back_to" value="/settings" />
                      <button className="btn-secondary"><RefreshCw size={14} /> Sync offers now</button>
                    </form>
                    <form action={disconnectEbay}>
                      <button className="btn-secondary"><Unplug size={14} /> Disconnect</button>
                    </form>
                  </>
                ) : (
                  <a href="/api/ebay/connect" className="btn-primary"><Link2 size={15} /> {conn ? "Reconnect eBay" : "Connect eBay"}</a>
                )}
              </div>
            )}
          </div>

          {configured && (
            <details className="mt-3 text-sm" open={active && !shipFrom}>
              <summary className="cursor-pointer text-xs text-link">Ship-from location {shipFrom ? `· ${shipFrom.city}, ${shipFrom.stateOrProvince} ${shipFrom.postalCode}` : "· needed before your first eBay listing"}</summary>
              <form action={saveEbayShipFrom} className="mt-2 flex flex-wrap gap-2">
                <input name="city" required maxLength={80} defaultValue={shipFrom?.city ?? ""} className="field min-w-[10rem] flex-1" placeholder="City" />
                <input name="state" required maxLength={2} defaultValue={shipFrom?.stateOrProvince ?? ""} className="field w-20 uppercase" placeholder="ST" />
                <input name="postal_code" required inputMode="numeric" pattern="\d{5}(-\d{4})?" defaultValue={shipFrom?.postalCode ?? ""} className="field w-28" placeholder="ZIP" />
                <button className="btn-secondary">Save</button>
              </form>
              <p className="mt-1 text-[11px] text-slate-500">Buyers see only the city and state. eBay uses it for shipping estimates.</p>
            </details>
          )}
        </li>

        {/* Etsy */}
        <li className="py-4">
          <p className="text-sm font-medium text-white">Etsy</p>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            Not connected. Etsy must approve the app first (allow a few weeks) — see <code className="text-slate-300">docs/etsy-setup.md</code>. Vintage (20+ years), handmade and craft supplies only.
          </p>
        </li>
      </ul>
    </section>
  );
}

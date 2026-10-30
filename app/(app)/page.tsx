import Link from "next/link";
import { ArrowRight, Boxes, CircleDollarSign, Download, HandCoins, MessageSquareText, PackagePlus, Plus, Tags, TrendingDown, TrendingUp } from "lucide-react";
import { resolveTask } from "@/app/actions";
import { OfferCard } from "@/components/offer-card";
import { requireHousehold } from "@/lib/household";
import { platformName } from "@/lib/platforms";
import { loadMemberNames, loadNotes, loadOverview, loadPendingOffers } from "@/lib/queries";
import { NoteComposer, NotesList } from "@/components/notes";
import { money, timeAgo } from "@/lib/types";
import { MoneyText, ProfitBadge, toneOf, verdict } from "@/components/money";

export default async function OverviewPage() {
  const ctx = await requireHousehold();
  const [overview, offers, notes, names] = await Promise.all([loadOverview(ctx), loadPendingOffers(ctx), loadNotes(ctx, { limit: 4 }), loadMemberNames(ctx)]);
  const empty = overview.counts.unsold === 0 && overview.counts.sold === 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs text-slate-500">{ctx.household.name}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white sm:text-3xl">Overview</h1>
        </div>
        <div className="flex gap-2">
          <a href="/api/export?type=items" className="btn-secondary hidden sm:inline-flex"><Download size={16} /> Export CSV</a>
          <Link href="/inventory/new" className="btn-primary"><Plus size={17} /> Add item</Link>
        </div>
      </header>

      {empty && (
        <section className="surface p-6">
          <h2 className="text-lg font-semibold text-white">Start with one room</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-400">
            Walk through a closet or the kids&apos; room and add each thing you want gone: what it is, size, condition, where it&apos;s stored, and
            the lowest price you&apos;d take. Use &quot;Save &amp; add another&quot; to move fast.
          </p>
          <Link href="/inventory/new" className="btn-primary mt-4"><Plus size={16} /> Add your first item</Link>
        </section>
      )}

      <MoneyHero profit={overview.profit} sold={overview.counts.sold} payout={overview.payout} />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat icon={Boxes} tile="tile-violet" label="To sell" value={String(overview.counts.unsold)} sub={`${overview.counts.needsListing} not listed yet`} href="/inventory?status=open" />
        <Stat icon={Tags} tile="tile-pink" label="Live listings" value={String(overview.counts.activeListings)} sub={`${money(overview.activeValue)} listed`} href="/inventory?status=listed" />
        <Stat icon={CircleDollarSign} tile="tile-sky" label="Paid out" value={money(overview.payout)} sub={`${overview.counts.sold} sold · ${money(overview.revenue)} gross`} className="col-span-2 lg:col-span-1" />
      </section>

      {offers.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><HandCoins size={18} className="text-accent" /> Offers waiting on you</h2>
            {offers.length > 2 && <Link href="/offers" className="text-sm text-accent hover:underline">All {offers.length}</Link>}
          </div>
          <div className="space-y-3">{offers.slice(0, 2).map(o => <OfferCard key={o.id} offer={o} />)}</div>
        </section>
      )}

      {overview.needsListing.length > 0 && (
        <section className="surface p-5">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold text-white"><PackagePlus size={17} className="text-accent" /> Not listed yet</h2>
            {overview.counts.needsListing > overview.needsListing.length && (
              <Link href="/inventory?status=unlisted" className="text-sm text-accent hover:underline">All {overview.counts.needsListing}</Link>
            )}
          </div>
          <ul className="mt-3 divide-y divide-line">
            {overview.needsListing.map(i => (
              <li key={i.id}>
                <Link href={`/inventory/${i.id}`} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-white">{i.name}</span>
                    <span className="text-xs text-slate-500">added {timeAgo(i.createdAt)}{i.targetPrice > 0 ? ` · asking ${money(i.targetPrice)}` : ""}</span>
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-accent">Add listing <ArrowRight size={12} /></span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {overview.recentSales.length > 0 && (
        <section className="surface p-5">
          <h2 className="text-base font-semibold text-white">Recent sales</h2>
          <ul className="mt-3 divide-y divide-line">
            {overview.recentSales.map(r => (
              <li key={r.id}>
                <Link href={`/inventory/${r.itemId}`} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-white">{r.name}</span>
                    <span className="text-xs text-slate-500">{platformName(r.platform)} · {new Date(r.soldAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                  </span>
                  <ProfitBadge value={r.profit} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}


      {overview.tasks.length > 0 && (
        <section className="surface p-5">
          <h2 className="text-base font-semibold text-white">To do</h2>
          <ul className="mt-3 divide-y divide-line">
            {overview.tasks.map(t => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-white">{t.title}</p>
                  {t.detail && <p className="mt-0.5 text-xs text-slate-400">{t.detail}</p>}
                  <p className="mt-0.5 text-[11px] text-slate-500">from {t.requested_by}</p>
                </div>
                <div className="flex gap-2">
                  {t.item_id && <Link href={`/inventory/${t.item_id}`} className="btn-secondary py-1.5 text-xs">Open</Link>}
                  <form action={resolveTask}>
                    <input type="hidden" name="id" value={t.id} />
                    <input type="hidden" name="status" value="done" />
                    <button className="btn-primary py-1.5 text-xs">Done</button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="surface p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold text-white"><MessageSquareText size={17} className="text-accent" /> Notes</h2>
          <Link href="/notes" className="text-sm text-accent hover:underline">All notes</Link>
        </div>
        <div className="space-y-3">
          <NotesList notes={notes} names={names} currentUser={ctx.userId} isAdmin={ctx.role === "admin"} />
          <NoteComposer />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="surface p-5">
          <h2 className="text-base font-semibold text-white">By platform</h2>
          {overview.byPlatform.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">Nothing listed yet.</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-500"><th className="pb-2 font-normal">Platform</th><th className="pb-2 text-right font-normal">Live</th><th className="pb-2 text-right font-normal">Sold</th><th className="pb-2 text-right font-normal">Paid out</th></tr></thead>
              <tbody className="divide-y divide-line">
                {overview.byPlatform.map(p => (
                  <tr key={p.platform}><td className="py-2 text-slate-200">{platformName(p.platform)}</td><td className="py-2 text-right tabular-nums">{p.active}</td><td className="py-2 text-right tabular-nums">{p.sold}</td><td className="py-2 text-right"><MoneyText value={p.payout} /></td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="surface p-5">
          <h2 className="text-base font-semibold text-white">Recent activity</h2>
          {overview.activity.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No activity yet.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {overview.activity.map(a => (
                <li key={a.id} className="flex justify-between gap-3">
                  <span className="truncate text-slate-300">{a.actor_user && names[a.actor_user] ? <span className="text-slate-500">{a.actor_user === ctx.userId ? "You" : names[a.actor_user]}: </span> : null}{describe(a.action, a.detail as Record<string, unknown>)}{a.actor_agent ? <span className="text-slate-500"> · {a.actor_agent}</span> : null}</span>
                  <time className="shrink-0 text-xs text-slate-500">{new Date(a.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function describe(action: string, d: Record<string, unknown>) {
  switch (action) {
    case "item_created": return `Added ${d.name ?? "an item"}`;
    case "listing_added": return `Listed on ${platformName(String(d.platform))}`;
    case "offer_recorded": return `Offer of ${money(Number(d.amount))} recorded`;
    case "offer_accepted": return `Accepted ${money(Number(d.amount))}`;
    case "offer_declined": return `Declined ${money(Number(d.amount))}`;
    case "offer_countered": return `Countered at ${money(Number(d.counter))}`;
    case "note_added": return "Posted a note";
    case "listing_drafted": return "Drafted listings" + (Array.isArray(d.platforms) ? ` for ${(d.platforms as string[]).map(platformName).join(" and ")}` : "");
    case "comment_added": return "Commented on an item";
    case "member_added": return "Added a household member";
    case "sale_recorded": return `Sold on ${platformName(String(d.platform))} for ${money(Number(d.salePrice))}`;
    default: return action.replace(/_/g, " ");
  }
}

function MoneyHero({ profit, sold, payout }: { profit: number; sold: number; payout: number }) {
  const tone = toneOf(profit);
  const Icon = tone === "bad" ? TrendingDown : TrendingUp;
  return (
    <section className={"tile p-5 sm:p-6 " + (tone === "good" ? "tile-good" : tone === "bad" ? "tile-bad" : "")}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className={"flex items-center gap-2 text-sm font-medium " + (tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-slate-400")}>
            <Icon size={18} aria-hidden /> {sold === 0 ? "No sales yet" : verdict(profit)}
          </p>
          <p className={"mt-1 text-4xl font-bold tracking-tight tabular-nums sm:text-5xl " + (tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-white")}>
            {tone === "bad" ? "−" : ""}{money(Math.abs(profit))}
          </p>
          <p className="mt-1 text-xs text-slate-500">Profit from {sold} sale{sold === 1 ? "" : "s"} after fees, shipping and what you paid · {money(payout)} paid out</p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex gap-2 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-good" /> made money</span>
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-bad" /> lost money</span>
          </div>
          <Link href="/insights" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">What sells best <ArrowRight size={14} /></Link>
        </div>
      </div>
    </section>
  );
}

function Stat({ icon: Icon, label, value, sub, href, tile, className = "" }: { icon: typeof Boxes; label: string; value: string; sub: string; href?: string; tile: string; className?: string }) {
  const body = (
    <div className={`tile ${tile} h-full p-4`}>
      <div className="flex items-center justify-between text-slate-400"><span className="text-xs">{label}</span><Icon size={16} /></div>
      <p className="mt-2 text-xl font-semibold tabular-nums text-white sm:text-2xl">{value}</p>
      <p className="mt-1 flex items-center gap-1 text-[11px] text-slate-500">{sub}{href && <ArrowRight size={11} />}</p>
    </div>
  );
  return href ? <Link href={href} className={className}>{body}</Link> : <div className={className}>{body}</div>;
}

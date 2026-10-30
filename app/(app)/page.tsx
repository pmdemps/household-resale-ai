import Link from "next/link";
import { ArrowRight, Check, HandCoins, ListTodo, MessageSquareText, Minus, PackagePlus, Plus, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import { resolveTask } from "@/app/actions";
import { OfferCard } from "@/components/offer-card";
import { requireHousehold } from "@/lib/household";
import { platformName } from "@/lib/platforms";
import { loadMemberNames, loadNotes, loadOverview, loadPendingOffers } from "@/lib/queries";
import { NoteComposer, NotesList } from "@/components/notes";
import { money, timeAgo } from "@/lib/types";
import { ProfitBadge, toneOf } from "@/components/money";
import { profitSentence, signedMoney, type MonthPoint } from "@/lib/money";

export default async function HomePage() {
  const ctx = await requireHousehold();
  const [overview, offers, notes, names] = await Promise.all([loadOverview(ctx), loadPendingOffers(ctx), loadNotes(ctx, { limit: 3 }), loadMemberNames(ctx)]);
  const empty = overview.counts.unsold === 0 && overview.counts.sold === 0;
  const needsCount = offers.length + overview.tasks.length + overview.counts.needsListing;

  return (
    <div className="space-y-8">
      <header className="flex items-center justify-between gap-3">
        <p className="truncate text-sm text-slate-500">{ctx.household.name}</p>
        <Link href="/inventory/new" className="btn-primary"><Plus size={17} /> Add item</Link>
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

      {/* 1. How are we doing? */}
      <section aria-labelledby="q-doing">
        <h1 id="q-doing" className="question">How are we doing?</h1>
        <div className="mt-3">
          <MonthHero thisMonth={overview.thisMonth} lastMonth={overview.lastMonth} allTime={overview.profit} sold={overview.counts.sold} />
        </div>
      </section>

      {/* 2. What needs us? */}
      <section aria-labelledby="q-needs">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="q-needs" className="question">What needs us?</h2>
          <p className="text-sm text-slate-500">{needsCount === 0 ? "Nothing right now" : `${needsCount} thing${needsCount === 1 ? "" : "s"}`}</p>
        </div>

        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <Link href="/inventory?status=open" className="surface inline-flex items-center gap-2 px-3 py-2 hover:bg-white/[0.03]">
            <span className="font-semibold tabular-nums text-white">{overview.counts.unsold}</span> <span className="text-slate-400">to sell</span>
          </Link>
          <Link href="/inventory?status=listed" className="surface inline-flex items-center gap-2 px-3 py-2 hover:bg-white/[0.03]">
            <span className="font-semibold tabular-nums text-white">{overview.counts.activeListings}</span> <span className="text-slate-400">for sale, {money(overview.activeValue)} asked</span>
          </Link>
        </div>

        <div className="mt-3 space-y-3">
          {offers.length > 0 && (
            <div>
              <OfferCard offer={offers[0]} />
              {offers.length > 1 && (
                <Link href="/offers" className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-link hover:underline">
                  <HandCoins size={15} /> {offers.length - 1} more offer{offers.length - 1 === 1 ? "" : "s"} waiting <ArrowRight size={14} />
                </Link>
              )}
            </div>
          )}

          {overview.tasks.length > 0 && (
            <div className="surface p-4 sm:p-5">
              <h3 className="flex items-center gap-2 text-base font-semibold text-white"><ListTodo size={17} className="text-link" /> To do</h3>
              <ul className="mt-2 divide-y divide-line">
                {overview.tasks.map(t => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-white">{t.title}</p>
                      {t.detail && <p className="mt-0.5 text-xs leading-5 text-slate-400">{t.detail}</p>}
                    </div>
                    <div className="flex gap-2">
                      {t.item_id && <Link href={`/inventory/${t.item_id}`} className="btn-secondary py-1.5 text-xs">Open</Link>}
                      <form action={resolveTask}>
                        <input type="hidden" name="id" value={t.id} />
                        <input type="hidden" name="status" value="done" />
                        <button className="btn-primary py-1.5 text-xs"><Check size={14} /> Done</button>
                      </form>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {overview.needsListing.length > 0 && (
            <div className="surface p-4 sm:p-5">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-base font-semibold text-white"><PackagePlus size={17} className="text-link" /> Not listed yet</h3>
                {overview.counts.needsListing > overview.needsListing.length && (
                  <Link href="/inventory?status=unlisted" className="text-sm text-link hover:underline">All {overview.counts.needsListing}</Link>
                )}
              </div>
              <ul className="mt-2 divide-y divide-line">
                {overview.needsListing.map(i => (
                  <li key={i.id}>
                    <Link href={`/inventory/${i.id}`} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-white">{i.name}</span>
                        <span className="text-xs text-slate-500">added {timeAgo(i.createdAt)}{i.targetPrice > 0 ? `, asking ${money(i.targetPrice)}` : ""}</span>
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/15 px-2.5 py-1 text-xs font-semibold text-link">List it <ArrowRight size={12} /></span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {needsCount === 0 && !empty && (
            <div className="surface flex items-center gap-3 p-4 text-sm text-slate-400">
              <Sparkles size={18} className="shrink-0 text-link" /> All caught up. No offers waiting and everything is listed.
            </div>
          )}
        </div>
      </section>

      {/* 3. What's new? */}
      <section aria-labelledby="q-new">
        <h2 id="q-new" className="question">What&apos;s new?</h2>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="surface p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">Recent sales</h3>
              <Link href="/money" className="text-sm text-link hover:underline">Money</Link>
            </div>
            {overview.recentSales.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">Nothing sold yet. The first sale shows up here.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {overview.recentSales.map(r => (
                  <li key={r.id}>
                    <Link href={`/inventory/${r.itemId}`} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-white">{r.name}</span>
                        <span className="text-xs text-slate-500">{platformName(r.platform)}, {new Date(r.soldAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                      </span>
                      <ProfitBadge value={r.profit} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="surface p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-base font-semibold text-white"><MessageSquareText size={17} className="text-link" /> Notes</h3>
              <Link href="/notes" className="text-sm text-link hover:underline">All notes</Link>
            </div>
            <div className="mt-3 space-y-3">
              <NotesList notes={notes} names={names} currentUser={ctx.userId} isAdmin={ctx.role === "admin"} />
              <NoteComposer />
            </div>
          </div>
        </div>

        {overview.activity.length > 0 && (
          <details className="surface mt-3 p-4 sm:p-5">
            <summary className="cursor-pointer text-sm font-medium text-slate-300">Everything that happened lately</summary>
            <ul className="mt-3 space-y-2 text-sm">
              {overview.activity.map(a => (
                <li key={a.id} className="flex justify-between gap-3">
                  <span className="truncate text-slate-300">
                    {a.actor_user && names[a.actor_user] ? <span className="text-slate-500">{a.actor_user === ctx.userId ? "You" : names[a.actor_user]}: </span> : null}
                    {describe(a.action, a.detail as Record<string, unknown>)}
                    {a.actor_agent ? <span className="text-slate-500"> ({a.actor_agent})</span> : null}
                  </span>
                  <time className="shrink-0 text-xs text-slate-500">{new Date(a.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</time>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
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

/** This month's profit as one big green/red number, with all-time underneath. */
function MonthHero({ thisMonth, lastMonth, allTime, sold }: { thisMonth: MonthPoint; lastMonth: MonthPoint | null; allTime: number; sold: number }) {
  const tone = thisMonth.sold === 0 ? "even" : toneOf(thisMonth.profit);
  const Icon = tone === "good" ? TrendingUp : tone === "bad" ? TrendingDown : Minus;
  const color = tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-slate-400";
  const allTone = toneOf(allTime);
  const monthName = thisMonth.longLabel.split(" ")[0];
  return (
    <section className={"tile p-5 sm:p-6 " + (tone === "good" ? "tile-good" : tone === "bad" ? "tile-bad" : "")}>
      <p className={"flex items-center gap-2 text-base font-semibold " + color}>
        <Icon size={20} aria-hidden /> {profitSentence(thisMonth)}
      </p>
      <p className={"mt-1 text-5xl font-bold tracking-tight tabular-nums sm:text-6xl " + (tone === "even" ? "text-white" : color)}>
        {thisMonth.sold === 0 ? money(0) : signedMoney(thisMonth.profit)}
      </p>
      <p className="mt-2 text-sm text-slate-400">
        {thisMonth.sold === 0
          ? `Nothing sold yet in ${monthName}.`
          : `${thisMonth.sold} sold in ${monthName}, after fees, shipping and what you paid.`}
        {lastMonth && lastMonth.sold > 0 && (
          <> Last month: <span className={"font-semibold " + (toneOf(lastMonth.profit) === "bad" ? "text-bad" : toneOf(lastMonth.profit) === "good" ? "text-good" : "text-slate-300")}>{signedMoney(lastMonth.profit)}</span>.</>
        )}
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line/70 pt-4">
        <p className="text-sm text-slate-400">
          All time{" "}
          <span className={"text-lg font-bold tabular-nums " + (allTone === "good" ? "text-good" : allTone === "bad" ? "text-bad" : "text-white")}>{sold === 0 ? money(0) : signedMoney(allTime)}</span>
          {" "}<span className="text-slate-500">from {sold} sale{sold === 1 ? "" : "s"}</span>
        </p>
        <Link href="/money" className="inline-flex items-center gap-1 text-sm font-semibold text-link hover:underline">Month by month <ArrowRight size={14} /></Link>
      </div>
    </section>
  );
}

import Link from "next/link";
import { Clock, Lightbulb, Trophy } from "lucide-react";
import { ProfitBadge, toneOf } from "@/components/money";
import { requireHousehold } from "@/lib/household";
import { MIN_SALES, byBrand, byCategory, byPlatform, itemProfit, slowMovers, topSales, totals, type GroupStat } from "@/lib/insights";
import { platformName } from "@/lib/platforms";
import { loadInsightItems } from "@/lib/queries";
import { money } from "@/lib/types";

const TABS = [
  { id: "brand", label: "Brands" },
  { id: "category", label: "Categories" },
  { id: "platform", label: "Platforms" },
] as const;

export default async function InsightsPage({ searchParams }: { searchParams: Promise<{ by?: string }> }) {
  const ctx = await requireHousehold();
  const { by = "brand" } = await searchParams;
  const items = await loadInsightItems(ctx);
  const t = totals(items);
  const rows = by === "category" ? byCategory(items) : by === "platform" ? byPlatform(items, platformName) : byBrand(items);
  const best = rows.find(r => r.enoughData && r.totalProfit > 0);
  const slow = slowMovers(items, 30);
  const top = topSales(items, 5);
  const noBrand = by === "brand" ? items.filter(i => !i.brand?.trim()).length : 0;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <Link href="/money" className="text-sm text-link hover:underline">← Money</Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">What sells like fucking hotcakes</h1>
        <p className="mt-1 text-sm text-slate-400">What sells, how fast, and what actually makes money after fees, shipping and what we paid.</p>
      </header>

      <section className="grid grid-cols-3 gap-3">
        <Mini label="Sold" value={String(t.sold)} tile="tile-sun" />
        <Mini label="Typical time to sell" value={t.medianDaysToSell === null ? "—" : `${t.medianDaysToSell} day${t.medianDaysToSell === 1 ? "" : "s"}`} tile="tile-peach" />
        <Mini label="Sold at a loss" value={String(t.losers)} tile={t.losers > 0 ? "tile-bad" : "tile-good"} />
      </section>

      {t.sold < MIN_SALES && (
        <p className="flex gap-2 rounded-xl border border-line bg-white/[0.03] px-4 py-3 text-sm text-slate-300">
          <Lightbulb size={17} className="mt-0.5 shrink-0 text-warn" />
          This won&apos;t mean a fucking thing until we sell a few more. Rankings are guesses until a group has {MIN_SALES}+ sales.
        </p>
      )}

      {best && (
        <p className="flex gap-2 rounded-xl border border-good/30 bg-good/[0.08] px-4 py-3 text-sm text-slate-200">
          <Trophy size={17} className="mt-0.5 shrink-0 text-good" />
          <span><span className="font-semibold text-good">{best.label}</span> is our best {by === "platform" ? "platform" : by === "category" ? "category" : "brand"} so far: {best.sold} sold, {money(best.avgProfit)} profit each on average{best.medianDaysToSell !== null ? `, usually gone in ${best.medianDaysToSell} days` : ""}.</span>
        </p>
      )}

      <nav className="flex gap-1" aria-label="Group by">
        {TABS.map(tab => (
          <Link key={tab.id} href={{ pathname: "/insights", query: tab.id === "brand" ? {} : { by: tab.id } }}
            className={"rounded-full px-3 py-1.5 text-sm " + (by === tab.id || (tab.id === "brand" && !["category", "platform"].includes(by)) ? "bg-accent/20 font-medium text-white" : "text-slate-400 hover:text-white")}>
            {tab.label}
          </Link>
        ))}
      </nav>

      <section className="surface p-5">
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing to compare yet. Add some shit{by === "brand" ? " with a brand" : ""} and list it.</p>
        ) : (
          <GroupBars rows={rows} />
        )}
        {noBrand > 0 && <p className="mt-4 text-xs text-slate-500">{noBrand} item{noBrand === 1 ? " has" : "s have"} no brand and {noBrand === 1 ? "isn't" : "aren't"} counted here. Add one on the item page to include {noBrand === 1 ? "it" : "them"}.</p>}
      </section>

      {top.length > 0 && (
        <section className="surface p-5">
          <h2 className="text-base font-semibold text-white">Best fucking sales</h2>
          <ul className="mt-3 divide-y divide-line">
            {top.map(i => (
              <li key={i.id}>
                <Link href={`/inventory/${i.id}`} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-white">{i.name}</span>
                    <span className="text-xs text-slate-500">{[i.brand, i.sale ? platformName(i.sale.platform) : null].filter(Boolean).join(" · ")}</span>
                  </span>
                  <ProfitBadge value={itemProfit(i)!} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {slow.length > 0 && (
        <section className="surface p-5">
          <h2 className="flex items-center gap-2 text-base font-semibold text-white"><Clock size={17} className="text-warn" /> Shit nobody wants (30+ days listed)</h2>
          <p className="mt-1 text-xs text-slate-500">Try a price drop, a better photo, or another platform. Never below the floor though.</p>
          <ul className="mt-3 divide-y divide-line">
            {slow.slice(0, 10).map(({ item, days }) => (
              <li key={item.id}>
                <Link href={`/inventory/${item.id}`} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-white">{item.name}</span>
                    <span className="text-xs text-slate-500">{item.platforms.map(platformName).join(" · ")}</span>
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-warn">{days} days</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function GroupBars({ rows }: { rows: GroupStat[] }) {
  const max = Math.max(...rows.map(r => Math.abs(r.totalProfit)), 1);
  return (
    <ul className="space-y-4">
      {rows.map((r, idx) => {
        const tone = toneOf(r.totalProfit);
        const width = r.sold ? Math.max(4, (Math.abs(r.totalProfit) / max) * 100) : 0;
        return (
          <li key={r.key}>
            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 truncate text-sm font-medium text-white">
                <span className="mr-2 text-xs text-slate-500">{idx + 1}</span>{r.label}
                {r.sold > 0 && !r.enoughData && <span className="ml-2 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-normal text-slate-400">early</span>}
              </p>
              {r.sold > 0 ? <ProfitBadge value={r.totalProfit} /> : <span className="text-xs text-slate-500">no sales yet</span>}
            </div>
            <div className="mt-1.5 h-2 rounded-full bg-white/[0.06]" aria-hidden>
              <div className={"h-2 rounded-full " + (tone === "bad" ? "bg-bad" : "bg-good")} style={{ width: `${width}%` }} />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {r.listed === 0 ? "Collecting dust" : <>{r.sold} of {r.listed} listed sold ({Math.round(r.sellThrough * 100)}%)</>}
              {r.sold > 0 && <> · {money(r.avgProfit)} each</>}
              {r.medianDaysToSell !== null && <> · ~{r.medianDaysToSell} day{r.medianDaysToSell === 1 ? "" : "s"} to sell</>}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function Mini({ label, value, tile }: { label: string; value: string; tile: string }) {
  return (
    <div className={`tile ${tile} p-3 sm:p-4`}>
      <p className="text-[11px] leading-4 text-slate-400">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-white sm:text-xl">{value}</p>
    </div>
  );
}

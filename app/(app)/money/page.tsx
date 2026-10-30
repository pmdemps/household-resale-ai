import Link from "next/link";
import { ArrowRight, Download, Minus, Trophy, TrendingDown, TrendingUp } from "lucide-react";
import { MoneyText, ProfitBadge, toneOf } from "@/components/money";
import { MonthTable, MonthlyProfitChart } from "@/components/money-chart";
import { requireHousehold } from "@/lib/household";
import { profitSentence, signedMoney } from "@/lib/money";
import { platformName } from "@/lib/platforms";
import { loadMoney } from "@/lib/queries";
import { money } from "@/lib/types";

export default async function MoneyPage() {
  const ctx = await requireHousehold();
  const data = await loadMoney(ctx, { months: 12 });
  const { thisMonth, lastMonth } = data.summary;
  const anySales = data.totals.sold > 0;
  const tone = thisMonth.sold === 0 ? "even" : toneOf(thisMonth.profit);
  const Icon = tone === "good" ? TrendingUp : tone === "bad" ? TrendingDown : Minus;
  const sixMonths = data.months.slice(-6);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Money</h1>
          <p className="mt-1 text-sm text-slate-400">Profit is what&apos;s left after fees, shipping and what you paid for the thing.</p>
        </div>
        <a href="/api/export?type=sales" className="btn-secondary"><Download size={15} /> Sales CSV</a>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Totals">
        <div className={"tile col-span-2 p-4 lg:col-span-1 " + (tone === "good" ? "tile-good" : tone === "bad" ? "tile-bad" : "")}>
          <p className="text-xs text-slate-400">This month</p>
          <p className={"mt-1 text-3xl font-bold tracking-tight tabular-nums " + (tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-white")}>
            {thisMonth.sold === 0 ? money(0) : signedMoney(thisMonth.profit)}
          </p>
          <p className={"mt-1 flex items-center gap-1 text-xs font-medium " + (tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-slate-400")}><Icon size={14} aria-hidden /> {profitSentence(thisMonth)}</p>
        </div>
        <Tile label="Last month" value={lastMonth && lastMonth.sold > 0 ? signedMoney(lastMonth.profit) : "—"} sub={lastMonth ? (lastMonth.sold ? `${lastMonth.sold} sold` : "nothing sold") : ""} tone={lastMonth && lastMonth.sold ? toneOf(lastMonth.profit) : "even"} />
        <Tile label="All time" value={anySales ? signedMoney(data.totals.profit) : money(0)} sub={anySales ? `${money(data.totals.net)} after fees` : "no sales yet"} tone={anySales ? toneOf(data.totals.profit) : "even"} />
        <Tile label="Sold" value={String(data.totals.sold)} sub={anySales ? `${money(data.totals.revenue)} in sales` : "nothing yet"} tone="sun" />
      </section>

      <section className="surface p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-white">Month by month</h2>
          <p className="flex gap-3 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-good" aria-hidden /> made money</span>
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-bad" aria-hidden /> lost money</span>
          </p>
        </div>
        {anySales ? (
          <>
            <div className="mt-3 sm:hidden"><MonthlyProfitChart points={sixMonths} width={360} height={230} titleId="chart-6" /></div>
            <div className="mt-3 hidden sm:block"><MonthlyProfitChart points={data.months} width={720} height={260} titleId="chart-12" /></div>
            <p className="mt-2 text-xs text-slate-500"><span className="sm:hidden">Last 6 months. </span><span className="hidden sm:inline">Last 12 months. </span>This month is highlighted. Tap or hover a month for the exact amount.</p>
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium text-link">See the numbers</summary>
              <div className="mt-3"><MonthTable points={data.months} /></div>
            </details>
          </>
        ) : (
          <p className="mt-3 text-sm text-slate-500">The chart fills in as things sell. When an item sells, open it and use &quot;Got an offer or a sale?&quot;.</p>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <section className="surface p-4 sm:p-5">
          <h2 className="text-base font-semibold text-white">By platform</h2>
          {data.byPlatform.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">Nothing listed yet.</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-2 font-normal">Listed on</th>
                  <th className="pb-2 text-right font-normal">For sale</th>
                  <th className="pb-2 text-right font-normal">Sold</th>
                  <th className="hidden pb-2 text-right font-normal sm:table-cell">After fees</th>
                  <th className="pb-2 text-right font-normal">Profit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.byPlatform.map(p => (
                  <tr key={p.platform}>
                    <td className="py-2.5 font-medium text-slate-200">{platformName(p.platform)}</td>
                    <td className="py-2.5 text-right tabular-nums text-slate-300">{p.active}</td>
                    <td className="py-2.5 text-right tabular-nums text-slate-300">{p.sold}</td>
                    <td className="hidden py-2.5 text-right sm:table-cell"><MoneyText value={p.net} className="text-slate-300" /></td>
                    <td className="py-2.5 text-right">{p.sold ? <ProfitBadge value={p.profit} /> : <span className="text-slate-500">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <Link href="/insights" className="tile tile-sun flex items-center gap-4 p-5 hover:brightness-[1.02]">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent text-on-accent"><Trophy size={22} /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-semibold text-white">What sells best</span>
            <span className="block text-sm text-slate-400">Brands, categories and platforms that make the most, and what isn&apos;t moving.</span>
          </span>
          <ArrowRight size={18} className="shrink-0 text-link" />
        </Link>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: "good" | "bad" | "even" | "sun" }) {
  const tile = tone === "good" ? "tile-good" : tone === "bad" ? "tile-bad" : tone === "sun" ? "tile-sun" : "";
  const color = tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-white";
  return (
    <div className={`tile p-4 ${tile}`}>
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold tracking-tight tabular-nums ${color}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

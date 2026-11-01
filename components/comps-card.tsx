import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { addComp, deleteComp } from "@/app/comps-actions";
import { CheckEbayPricesButton } from "@/components/check-ebay-prices";
import { COMP_PLATFORMS, deliveredPrice, summarizeComps, VERDICT_LABEL, verdictSentence, type Verdict } from "@/lib/comps";
import { platformName } from "@/lib/platforms";
import { money, num, type ItemComp } from "@/lib/types";

const VERDICT_TONE: Record<Verdict, string> = {
  below: "bg-warn/15 text-warn",
  comparable: "bg-good/15 text-good",
  above: "bg-warn/15 text-warn",
};

const compPlatform = (id: string) => (id === "amazon" ? "Amazon" : platformName(id));
const shipText = (s: number | null) => (s === null ? "+ shipping" : s === 0 ? "free shipping" : `+ ${money(s)} ship`);

/**
 * Item page → "What others sell this for". Server component.
 * Shows the lowest price on the market now, the typical (median) price, and whether our asking price is
 * below, comparable to, or above it. Comps come from the Check eBay prices button and from people or agents
 * recording ones they found elsewhere.
 */
export function CompsCard({ itemId, comps, askingPrice, ebayAvailable }: { itemId: string; comps: ItemComp[]; askingPrice: number; ebayAvailable: boolean }) {
  const rows = comps.map(c => ({ ...c, price: num(c.price), shipping: c.shipping === null ? null : num(c.shipping) }));
  const summary = summarizeComps(rows, askingPrice > 0 ? askingPrice : null);
  const sentence = verdictSentence(summary, askingPrice, money);
  const lowest = summary.lowest;
  const newest = rows.reduce<string | null>((d, c) => (!d || c.captured_at > d ? c.captured_at : d), null);
  const sorted = [...rows].sort((a, b) => a.price - b.price || deliveredPrice(a) - deliveredPrice(b));

  return (
    <section className="surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-white">What others sell this for</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {summary.count === 0 ? "No comparable listings yet." : `${summary.count} comparable listing${summary.count === 1 ? "" : "s"}${newest ? ` · checked ${new Date(newest).toLocaleDateString()}` : ""}`}
          </p>
        </div>
        {summary.verdict && <span className={"rounded-full px-2.5 py-1 text-xs font-medium " + VERDICT_TONE[summary.verdict]}>{VERDICT_LABEL[summary.verdict]}</span>}
      </div>

      {lowest && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-line p-3">
            <p className="text-xs text-slate-500">Lowest on the market now</p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-white">
              {money(lowest.price)} <span className="text-xs font-normal text-slate-400">{shipText(lowest.shipping)}</span>
            </p>
            <p className="mt-0.5 truncate text-xs text-slate-400">
              on {compPlatform(lowest.platform)}
              {lowest.url && (
                <>
                  {" · "}
                  <a href={lowest.url} target="_blank" rel="noreferrer noopener" className="text-link hover:underline">see it</a>
                </>
              )}
            </p>
          </div>
          <div className="rounded-xl border border-line p-3">
            <p className="text-xs text-slate-500">Typical price</p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-white">{summary.typical !== null ? money(summary.typical) : "—"}</p>
            <p className="mt-0.5 text-xs text-slate-400">{summary.low !== null && summary.high !== null && summary.low !== summary.high ? `range ${money(summary.low)} to ${money(summary.high)}` : "item price, before shipping"}</p>
          </div>
        </div>
      )}

      {sentence && <p className="mt-3 text-sm text-slate-300">{sentence}</p>}

      {sorted.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-xs text-link">See all {sorted.length}</summary>
          <ul className="mt-2 divide-y divide-line">
            {sorted.map(c => (
              <li key={c.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-slate-200">{c.title}</p>
                  <p className="text-xs text-slate-500">
                    {compPlatform(c.platform)}{c.kind === "sold" ? " · sold" : ""}{c.condition ? ` · ${c.condition}` : ""}{c.note ? ` · ${c.note}` : ""}
                    {c.url && (
                      <>
                        {" · "}
                        <a href={c.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 text-link hover:underline">open <ExternalLink size={11} /></a>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-start gap-2">
                  <p className="text-right tabular-nums">
                    <span className="text-white">{money(c.price)}</span>
                    <span className="block text-[11px] text-slate-500">{shipText(c.shipping)}</span>
                  </p>
                  {c.source === "manual" && (
                    <form action={deleteComp}>
                      <input type="hidden" name="id" value={c.id} />
                      <button className="rounded p-1 text-slate-500 hover:text-bad" aria-label={`Remove ${c.title}`}><Trash2 size={14} /></button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {ebayAvailable ? <CheckEbayPricesButton itemId={itemId} /> : <p className="text-xs text-slate-500">Live eBay price checks turn on once eBay app keys are set (Settings).</p>}
      </div>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-xs text-link">Add one you found</summary>
        <form action={addComp} className="mt-3 grid gap-2 sm:grid-cols-[1fr_6.5rem_6.5rem]">
          <input type="hidden" name="item_id" value={itemId} />
          <input name="title" required maxLength={300} className="field sm:col-span-3" placeholder="What it is (e.g. helmet hook with key hook)" />
          <select name="platform" className="field" defaultValue="ebay" aria-label="Where">
            {COMP_PLATFORMS.map(p => <option key={p} value={p}>{compPlatform(p)}</option>)}
          </select>
          <input name="price" type="number" min="0.01" step="0.01" required className="field" placeholder="Price" inputMode="decimal" />
          <input name="shipping" type="number" min="0" step="0.01" className="field" placeholder="Ship $" inputMode="decimal" />
          <input name="url" type="url" className="field sm:col-span-2" placeholder="Link (https://…)" />
          <select name="kind" className="field" defaultValue="active" aria-label="Listed or sold">
            <option value="active">For sale</option><option value="sold">Sold</option>
          </select>
          <button className="btn-secondary sm:col-span-3"><Plus size={15} /> Add comparable</button>
        </form>
      </details>
    </section>
  );
}

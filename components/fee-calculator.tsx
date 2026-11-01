"use client";

import { useState } from "react";
import { estimateFees } from "@/lib/fees";
import { PLATFORMS } from "@/lib/platforms";
import { money } from "@/lib/types";

/** Compare what you'd actually receive on each platform at a given price. */
export function FeeCalculator({ defaultPrice, itemCost, category }: { defaultPrice: number; itemCost: number; category?: string }) {
  const [price, setPrice] = useState(defaultPrice > 0 ? defaultPrice.toFixed(2) : "");
  const [label, setLabel] = useState("");
  const p = Number(price) || 0;
  const ship = Number(label) || 0;
  const rows = PLATFORMS.filter(x => x.id !== "other" && !x.consignment)
    .map(pl => ({ pl, e: estimateFees(pl.id, p, { itemCost, sellerShippingCost: pl.id === "vinted" || pl.id === "poshmark" ? 0 : ship, includeListingFee: true }) }))
    .sort((a, b) => b.e.payout - a.e.payout);

  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-slate-300">
          Sale price ($)
          <input className="field mt-1.5" type="number" min="0" step="0.01" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} />
        </label>
        <label className="text-xs text-slate-300">
          Label we&apos;d pay ($)
          <input className="field mt-1.5" type="number" min="0" step="0.01" inputMode="decimal" value={label} onChange={e => setLabel(e.target.value)} placeholder="0 if buyer pays" />
        </label>
      </div>
      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="pb-2 font-normal">Platform</th>
            <th className="pb-2 text-right font-normal">Fees</th>
            <th className="pb-2 text-right font-normal">We get</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map(({ pl, e }) => {
            const warn = pl.id === "etsy" && category !== "Collectibles";
            return (
              <tr key={pl.id} className={warn ? "opacity-50" : ""}>
                <td className="py-2">
                  <span className="text-slate-200">{pl.name}</span>
                  {pl.hasAccount && <span className="ml-1.5 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-link">your account</span>}
                  {warn && <span className="block text-[11px] text-slate-500">Vintage/handmade only</span>}
                  {(pl.id === "vinted" || pl.id === "poshmark") && <span className="block text-[11px] text-slate-500">Buyer pays label</span>}
                </td>
                <td className="py-2 text-right tabular-nums text-slate-400">{money(e.totalFees)}</td>
                <td className={"py-2 text-right font-medium tabular-nums " + (e.profit < 0 ? "text-bad" : "text-good")}>{money(e.payout)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] leading-4 text-slate-500">Estimates from fee rules last checked Oct 29, 2026. eBay also charges on sales tax, so it runs slightly higher.</p>
    </div>
  );
}

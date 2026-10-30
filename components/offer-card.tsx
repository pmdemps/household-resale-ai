import Link from "next/link";
import { AlertTriangle, Check, Repeat, X } from "lucide-react";
import { decideOffer } from "@/app/actions";
import { FeeBreakdown } from "@/components/fee-breakdown";
import { ProfitBadge } from "@/components/money";
import { estimateFees } from "@/lib/fees";
import { platformName } from "@/lib/platforms";
import { money, num } from "@/lib/types";

export type OfferWithContext = {
  id: string;
  amount: number;
  buyer_handle: string | null;
  received_at: string;
  note: string | null;
  listing: { id: string; platform: string; list_price: number; listing_url: string | null };
  item: { id: string; name: string; purchase_cost: number; floor_price: number | null };
};

export function OfferCard({ offer }: { offer: OfferWithContext }) {
  const amount = num(offer.amount);
  const listPrice = num(offer.listing.list_price);
  const cost = num(offer.item.purchase_cost);
  const floor = offer.item.floor_price === null ? null : num(offer.item.floor_price);
  const atOffer = estimateFees(offer.listing.platform, amount, { itemCost: cost, includeListingFee: false });
  const atList = estimateFees(offer.listing.platform, listPrice, { itemCost: cost, includeListingFee: false });
  const belowFloor = floor !== null && amount < floor;
  const pctOff = listPrice > 0 ? Math.round((1 - amount / listPrice) * 100) : 0;

  return (
    <article className="surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">{platformName(offer.listing.platform)} offer</p>
          <Link href={`/inventory/${offer.item.id}`} className="mt-1 block truncate text-base font-semibold text-white hover:underline">
            {offer.item.name}
          </Link>
          <p className="mt-1 text-sm text-slate-400">
            Listed at {money(listPrice)} · offer {money(amount)}
            {pctOff > 0 && <span className="text-slate-500"> ({pctOff}% off)</span>}
            {offer.buyer_handle && <span className="text-slate-500"> · from {offer.buyer_handle}</span>}
          </p>
        </div>
        <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:flex-col sm:items-end sm:gap-1">
          <p className="text-2xl font-semibold tabular-nums text-white">{money(amount)}</p>
          <div><ProfitBadge value={atOffer.profit} label={atOffer.profit < 0 ? "you'd lose" : "you'd make"} size="md" /></div>
        </div>
      </div>

      {belowFloor && (
        <p className="mt-3 flex items-center gap-2 rounded-lg border border-warn/20 bg-warn/[0.07] px-3 py-2 text-xs text-warn">
          <AlertTriangle size={14} /> Below your floor price of {money(floor!)}.
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1.5 text-xs text-slate-400">If you accept {money(amount)}</p>
          <FeeBreakdown estimate={atOffer} itemCost={cost} compact />
        </div>
        <div className="hidden sm:block">
          <p className="mb-1.5 text-xs text-slate-400">At your list price {money(listPrice)}</p>
          <FeeBreakdown estimate={atList} itemCost={cost} compact />
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500 sm:hidden">
        At your list price you&apos;d receive {money(atList.payout)} ({money(atList.payout - atOffer.payout)} more).
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <form action={decideOffer}>
          <input type="hidden" name="offer_id" value={offer.id} />
          <input type="hidden" name="decision" value="accepted" />
          <button className="btn-primary"><Check size={16} /> Accept</button>
        </form>
        <form action={decideOffer} className="flex gap-2">
          <input type="hidden" name="offer_id" value={offer.id} />
          <input type="hidden" name="decision" value="countered" />
          <input
            name="counter_amount"
            type="number"
            min="0"
            step="0.01"
            required
            defaultValue={Math.max(floor ?? 0, Math.round(((amount + listPrice) / 2) * 100) / 100).toFixed(2)}
            className="field w-24"
            aria-label="Counter amount"
          />
          <button className="btn-secondary"><Repeat size={15} /> Counter</button>
        </form>
        <form action={decideOffer}>
          <input type="hidden" name="offer_id" value={offer.id} />
          <input type="hidden" name="decision" value="declined" />
          <button className="btn-secondary"><X size={15} /> Decline</button>
        </form>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        This records your decision here. Until the {platformName(offer.listing.platform)} integration is live, also tap the same button in the
        {" "}{platformName(offer.listing.platform)} app{offer.listing.listing_url ? <> (<a className="text-accent hover:underline" href={offer.listing.listing_url} target="_blank" rel="noreferrer">open listing</a>)</> : ""}.
      </p>
    </article>
  );
}

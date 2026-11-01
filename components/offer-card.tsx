import Link from "next/link";
import { AlertTriangle, Check, Repeat, Send, X } from "lucide-react";
import { decideOffer, handOffOffer } from "@/app/actions";
import { FeeBreakdown } from "@/components/fee-breakdown";
import { ProfitBadge } from "@/components/money";
import { estimateFees } from "@/lib/fees";
import { platformName } from "@/lib/platforms";
import { money, num, timeAgo } from "@/lib/types";

/** A household member as the offer card needs them; name is null until they set one in Settings. */
export type CardMember = { id: string; name: string | null };

const OTHER_HALF = "your other half";
const possessive = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type OfferWithContext = {
  id: string;
  amount: number;
  buyer_handle: string | null;
  received_at: string;
  note: string | null;
  /** Marketplace id of the offer (eBay BestOfferID) when it was pulled in through an API; null for offers typed in by hand. */
  external_id?: string | null;
  listing: { id: string; platform: string; list_price: number; listing_url: string | null };
  item: { id: string; name: string; purchase_cost: number; floor_price: number | null; owner_user?: string | null };
  /** Set when someone handed this offer to a member ("that's Lauren's, go ask her"). */
  asked?: { user: string; at: string } | null;
};

/**
 * `members` and `currentUser` turn on the "whose shit" bits: the owner tag, "Asked Lauren", and an
 * "Ask Lauren" button per other member that buzzes only their phone.
 */
export function OfferCard({ offer, members = [], currentUser }: { offer: OfferWithContext; members?: CardMember[]; currentUser?: string }) {
  const nameOf = (id: string) => members.find(m => m.id === id)?.name ?? null;
  const owner = offer.item.owner_user ?? null;
  const ownerTag = !owner ? null : owner === currentUser ? "Your shit" : `${possessive(nameOf(owner) ?? capitalize(OTHER_HALF))} shit`;
  const asked = offer.asked ?? null;
  const askedName = asked ? (asked.user === currentUser ? "you" : nameOf(asked.user) ?? OTHER_HALF) : null;
  const others = currentUser ? members.filter(m => m.id !== currentUser) : [];
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
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-slate-500">
            <span>Offer on {platformName(offer.listing.platform)}</span>
            {ownerTag && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-link">{ownerTag}</span>}
            {askedName && <span className="text-slate-400">Asked {askedName}{asked?.at ? ` ${timeAgo(asked.at)}` : ""}</span>}
          </p>
          <Link href={`/inventory/${offer.item.id}`} className="mt-1 block truncate text-base font-semibold text-white hover:underline">
            {offer.item.name}
          </Link>
          <p className="mt-1 text-sm text-slate-400">
            Asking {money(listPrice)}, offered {money(amount)}
            {pctOff > 0 && <span className="text-slate-500"> ({pctOff}% off)</span>}
            {offer.buyer_handle && <span className="text-slate-500"> · from {offer.buyer_handle}</span>}
          </p>
        </div>
        <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:flex-col sm:items-end sm:gap-1">
          <p className="text-2xl font-semibold tabular-nums text-white">{money(amount)}</p>
          <div><ProfitBadge value={atOffer.profit} label={atOffer.profit < 0 ? "we'd lose" : "we'd make"} size="md" /></div>
        </div>
      </div>

      {belowFloor && (
        <p className="mt-3 flex items-center gap-2 rounded-lg border border-warn/20 bg-warn/[0.07] px-3 py-2 text-xs text-warn">
          <AlertTriangle size={14} /> Lowball alert. That&apos;s under our floor of {money(floor!)}. Fuck that.
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1.5 text-xs text-slate-400">If we take {money(amount)}</p>
          <FeeBreakdown estimate={atOffer} itemCost={cost} compact />
        </div>
        <div className="hidden sm:block">
          <p className="mb-1.5 text-xs text-slate-400">At full asking price {money(listPrice)}</p>
          <FeeBreakdown estimate={atList} itemCost={cost} compact />
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500 sm:hidden">
        At full price we&apos;d pocket {money(atList.payout)} after fees ({money(atList.payout - atOffer.payout)} more).
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <form action={decideOffer}>
          <input type="hidden" name="offer_id" value={offer.id} />
          <input type="hidden" name="decision" value="accepted" />
          <button className="btn-primary"><Check size={16} /> Take it</button>
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
          <button className="btn-secondary"><X size={15} /> Fuck no</button>
        </form>
        {others.map(m => {
          const label = m.name ?? OTHER_HALF;
          return (
            <form key={m.id} action={handOffOffer}>
              <input type="hidden" name="offer_id" value={offer.id} />
              <input type="hidden" name="to_user" value={m.id} />
              <button className="btn-secondary" title={`Their shit? Buzzes only ${possessive(label)} phone to ask how badly they wanna sell it`}>
                <Send size={15} /> {asked?.user === m.id ? `Ask ${label} again` : `Ask ${label}`}
              </button>
            </form>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        {offer.listing.platform === "ebay" && offer.external_id ? (
          <>This one came from eBay, so your answer goes straight to eBay. The buyer just sees a normal accept, counter or decline. If it shits the bed, a to-do shows up telling you to do it in the eBay app.</>
        ) : (
          <>
            This only saves it here. You still have to go tap the same damn button in the
            {" "}{platformName(offer.listing.platform)} app{offer.listing.listing_url ? <> (<a className="text-link hover:underline" href={offer.listing.listing_url} target="_blank" rel="noreferrer">open listing</a>)</> : ""}.
          </>
        )}
      </p>
    </article>
  );
}

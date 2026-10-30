import Link from "next/link";
import { ExternalLink, Send, Square, Tag } from "lucide-react";
import { endEbayListing, postItemToEbay, updateEbayPrice } from "@/app/marketplace-actions";
import { isEbayConfigured, readEbayConfig } from "@/lib/ebay/config";
import { readEbayNotice } from "@/lib/ebay/notice";
import { estimateFees } from "@/lib/fees";
import { money, num, type InventoryItem, type Listing } from "@/lib/types";

type Props = {
  item: InventoryItem;
  listings: Listing[];
  /** Household has an active eBay connection (Settings → Marketplaces). */
  hasEbayConnection: boolean;
  /** Number of photos on the item (eBay needs at least one). */
  photoCount: number;
};

/**
 * Item page → "eBay" card. Server component. Mount with
 * <PostToEbay item={item} listings={listings} hasEbayConnection={...} photoCount={photos.length} />.
 */
export async function PostToEbay({ item, listings, hasEbayConnection, photoCount }: Props) {
  const configured = isEbayConfigured();
  if (!configured) return null; // nothing to show until the owner sets EBAY_* env (Settings explains)
  const notice = await readEbayNotice();
  const env = readEbayConfig().env;
  const live = listings.find(l => l.platform === "ebay" && ["active", "paused"].includes(l.status));
  const ebayDraft = listings.find(l => l.platform === "ebay" && l.status === "draft");
  const price = live ? num(live.list_price) : ebayDraft ? num(ebayDraft.list_price) : num(item.target_price);
  const floor = item.floor_price === null ? null : num(item.floor_price);
  const cost = num(item.purchase_cost);
  const est = estimateFees("ebay", price, { itemCost: cost, includeListingFee: false });
  const isSold = item.status === "sold";

  return (
    <section className="surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-white">eBay</h2>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${env === "production" ? "bg-accent/15 text-link" : "bg-warn/15 text-warn"}`}>{env}</span>
      </div>

      {notice && (
        <p className={`mt-3 rounded-lg border px-3 py-2 text-sm ${notice.kind === "ok" ? "border-good/30 bg-good/10 text-good" : "border-warn/30 bg-warn/10 text-warn"}`}>{notice.message}</p>
      )}

      {!hasEbayConnection && (
        <p className="mt-2 text-sm text-slate-400">
          eBay isn&apos;t connected yet. <Link href="/settings" className="text-link hover:underline">Connect it in Settings</Link> and you can post from here with one tap.
        </p>
      )}

      {hasEbayConnection && live && (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-slate-300">
            <span className="font-medium text-white">{live.status === "active" ? "Live" : "Paused"}</span> at {money(num(live.list_price))}
            {live.listing_url && (
              <a href={live.listing_url} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 text-xs text-link hover:underline">Open on eBay <ExternalLink size={12} /></a>
            )}
          </p>
          <p className="text-xs text-slate-500">You&apos;d keep about {money(est.payout)} after eBay fees{floor !== null ? ` · offers under ${money(floor)} are auto-declined` : ""}.</p>
          {live.external_offer_id ? (
            <div className="flex flex-wrap items-end gap-2">
              <form action={updateEbayPrice} className="flex items-end gap-2">
                <input type="hidden" name="listing_id" value={live.id} />
                <input type="hidden" name="item_id" value={item.id} />
                <label className="flex flex-col text-xs text-slate-400">New price
                  <input name="list_price" type="number" min={floor ?? 0} step="0.01" defaultValue={num(live.list_price).toFixed(2)} className="field mt-1 w-28" inputMode="decimal" />
                </label>
                <button className="btn-secondary"><Tag size={14} /> Update price</button>
              </form>
              <form action={endEbayListing}>
                <input type="hidden" name="listing_id" value={live.id} />
                <input type="hidden" name="item_id" value={item.id} />
                <button className="btn-secondary"><Square size={14} /> End listing</button>
              </form>
            </div>
          ) : (
            <p className="text-xs text-slate-500">This listing was added by hand, so price and ending are managed in the eBay app.</p>
          )}
        </div>
      )}

      {hasEbayConnection && !live && !isSold && (
        <form action={postItemToEbay} className="mt-3 space-y-3">
          <input type="hidden" name="item_id" value={item.id} />
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col text-xs text-slate-400">Price
              <input name="list_price" type="number" min={floor ?? 0.01} step="0.01" required defaultValue={price > 0 ? price.toFixed(2) : ""} className="field mt-1 w-28" inputMode="decimal" />
            </label>
            <button className="btn-primary" disabled={photoCount === 0}><Send size={15} /> Post to eBay{price > 0 ? ` at ${money(price)}` : ""}</button>
          </div>
          <ul className="space-y-1 text-[11px] leading-4 text-slate-500">
            <li>Best Offer on{floor !== null ? <>; offers under <span className="text-slate-300">{money(floor)}</span> (your floor) are declined automatically</> : ". Set a floor price to auto-decline lowballs"}.</li>
            <li>You&apos;d keep about <span className="text-slate-300">{money(est.payout)}</span> at {money(price)} (fees ≈ {money(est.totalFees)}{cost > 0 ? `, profit ≈ ${money(est.profit)}` : ""}).</li>
            <li>{photoCount === 0 ? <span className="text-warn">Add at least one photo first — eBay won&apos;t publish without a picture.</span> : `${photoCount} photo${photoCount === 1 ? "" : "s"} will be sent (HEIC skipped).`}</li>
            <li>Fixed price, Good &apos;Til Cancelled, ships from your saved location. Your notes and comments are never sent.</li>
          </ul>
        </form>
      )}
    </section>
  );
}

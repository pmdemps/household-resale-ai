import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, MapPin, Plus } from "lucide-react";
import { addListing, recordOffer, recordSale, setItemOwner, updateItem, updateListing } from "@/app/actions";
import { FeeBreakdown } from "@/components/fee-breakdown";
import { FeeCalculator } from "@/components/fee-calculator";
import { ItemForm } from "@/components/item-form";
import { ItemPhotos } from "@/components/item-photos";
import { OfferCard } from "@/components/offer-card";
import { ProfitBadge } from "@/components/money";
import { estimateFees } from "@/lib/fees";
import { requireHousehold } from "@/lib/household";
import { loadPhotos } from "@/lib/photos";
import { PostToEbay } from "@/components/post-to-ebay";
import { isUsableConnection, loadEbayConnection } from "@/lib/ebay/connection";
import { PLATFORMS, platformById, platformName } from "@/lib/platforms";
import { loadMemberNames, loadMembers, loadNotes, loadPendingOffers } from "@/lib/queries";
import { NoteComposer, NotesList } from "@/components/notes";
import { itemStatusLabel, listingStatusLabel, money, num, offerStatusLabel, type InventoryItem, type Listing, type Offer, type Sale } from "@/lib/types";

export default async function ItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const [{ id }, { saved }] = await Promise.all([params, searchParams]);
  const ctx = await requireHousehold();
  const hid = ctx.household.id;

  const [itemRes, listingsRes, offersRes, saleRes, pending, comments, names, photos, members] = await Promise.all([
    ctx.supabase.from("inventory_items").select("*").eq("household_id", hid).eq("id", id).maybeSingle(),
    ctx.supabase.from("listings").select("*").eq("household_id", hid).eq("item_id", id).order("created_at"),
    ctx.supabase.from("offers").select("*, listings!inner(item_id, platform)").eq("household_id", hid).eq("listings.item_id", id).neq("status", "pending").order("received_at", { ascending: false }),
    ctx.supabase.from("sales").select("*").eq("household_id", hid).eq("item_id", id).maybeSingle(),
    loadPendingOffers(ctx, id),
    loadNotes(ctx, { itemId: id }),
    loadMemberNames(ctx),
    loadPhotos(ctx, id),
    loadMembers(ctx),
  ]);
  const ebayConn = await loadEbayConnection(ctx.supabase, hid).catch(() => null);
  if (!itemRes.data) notFound();
  const item = itemRes.data as InventoryItem;
  const listings = (listingsRes.data ?? []) as Listing[];
  const pastOffers = (offersRes.data ?? []) as (Offer & { listings: { platform: string } })[];
  const sale = saleRes.data as Sale | null;
  const live = listings.filter(l => ["draft", "active", "paused"].includes(l.status));
  const livePlatforms = new Set(live.map(l => l.platform));
  const cost = num(item.purchase_cost);
  const isSold = item.status === "sold";
  const saleProfit = sale ? num(sale.sale_price) + num(sale.shipping_charged) - num(sale.platform_fees) - num(sale.shipping_cost) - num(sale.other_costs) - cost : 0;

  return (
    <div className="space-y-6">
      <header>
        <Link href="/inventory" className="text-sm text-link hover:underline">← My Shit</Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-white">{item.name}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-slate-400">
              <span className={"rounded-full px-2 py-0.5 text-xs font-medium " + (isSold ? "bg-good/15 text-good" : item.status === "listed" ? "bg-accent/20 text-link" : item.status === "pending_sale" ? "bg-warn/15 text-warn" : "bg-white/[0.06] text-slate-300")}>{itemStatusLabel(item.status)}</span>
              <span>{item.category}</span>
              {item.brand && <span>· {item.brand}</span>}
              {item.size && <span>· {item.size}</span>}
              {item.condition && <span>· {item.condition}</span>}
              {item.storage_location && <span className="inline-flex items-center gap-1">· <MapPin size={13} />{item.storage_location}</span>}
            </p>
          </div>
          <div className="text-sm sm:text-right">
            <p className="text-slate-400">Asking <span className="font-semibold text-white">{money(num(item.target_price))}</span></p>
            {item.floor_price !== null && <p className="text-slate-500">Rock bottom {money(num(item.floor_price))}</p>}
          </div>
        </div>
        {members.length > 1 && (
          <form action={setItemOwner} className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <input type="hidden" name="item_id" value={item.id} />
            <label htmlFor="owner_user" className="text-slate-400">Whose shit is it?</label>
            <select id="owner_user" name="owner_user" defaultValue={item.owner_user ?? ""} className="field w-auto">
              <option value="">Ours</option>
              {members.map(m => (
                <option key={m.id} value={m.id}>{m.id === ctx.userId ? "Mine" : m.name ? `${m.name}${/s$/i.test(m.name) ? "'" : "'s"}` : "My other half's"}</option>
              ))}
            </select>
            <button className="btn-secondary">Save</button>
          </form>
        )}
      </header>

      <ItemPhotos householdId={hid} itemId={item.id} itemName={item.name} photos={photos} justCreated={saved === "1"} />

      {sale && (
        <section className="surface p-5">
          <h2 className="text-base font-semibold text-white">Sold on {platformName(sale.platform)}{saleProfit < 0 ? ". At least it's fucking gone." : ", fuck yeah"}</h2>
          <p className="mt-1 text-xs text-slate-500">{new Date(sale.sold_at).toLocaleDateString()}</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Metric label="Sale price" value={money(num(sale.sale_price))} />
            <Metric label="Fees" value={money(num(sale.platform_fees))} />
            <Metric label="Shipping we paid" value={money(num(sale.shipping_cost))} />
            <div>
              <dt className="text-xs text-slate-500">Profit after what we paid</dt>
              <dd className="mt-1"><ProfitBadge size="md" value={saleProfit} /></dd>
            </div>
          </dl>
        </section>
      )}

      {pending.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-white">Somebody wants this shit</h2>
          {pending.map(o => <OfferCard key={o.id} offer={o} members={members} currentUser={ctx.userId} />)}
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <PostToEbay item={item} listings={listings} hasEbayConnection={isUsableConnection(ebayConn)} photoCount={photos.length} />

          <section className="surface p-5">
            <h2 className="text-base font-semibold text-white">Listed on</h2>
            {listings.length === 0 && <p className="mt-2 text-sm text-slate-500">Not listed anywhere yet. It&apos;s just sitting there like an asshole.</p>}
            <ul className="mt-3 space-y-3">
              {listings.map(l => (
                <li key={l.id} className="rounded-xl border border-line p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-white">
                      {platformName(l.platform)} <span className="ml-1 text-xs font-normal text-slate-400">{listingStatusLabel(l.status)}</span>
                    </p>
                    {l.listing_url && (
                      <a href={l.listing_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-link hover:underline">Open <ExternalLink size={12} /></a>
                    )}
                  </div>
                  {["draft", "active", "paused"].includes(l.status) && (
                    <>
                      <form action={updateListing} className="mt-3 flex flex-wrap items-end gap-2">
                        <input type="hidden" name="id" value={l.id} />
                        <input type="hidden" name="item_id" value={item.id} />
                        <label className="flex flex-col text-xs text-slate-400">Price
                          <input name="list_price" type="number" min="0" step="0.01" defaultValue={num(l.list_price).toFixed(2)} className="field mt-1 w-28" />
                        </label>
                        <label className="flex min-w-[10rem] flex-1 flex-col text-xs text-slate-400">Listing link
                          <input name="listing_url" type="url" defaultValue={l.listing_url ?? ""} className="field mt-1" placeholder="https://" />
                        </label>
                        <select name="status" defaultValue={l.status} className="field w-28" aria-label="Listing status">
                          <option value="draft">Draft</option><option value="active">Live</option><option value="paused">Paused</option><option value="ended">Ended</option>
                        </select>
                        <button className="btn-secondary">Save</button>
                      </form>
                      <details className="mt-3 text-sm">
                        <summary className="cursor-pointer text-xs text-link">Got an offer or a sale?</summary>
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <form action={recordOffer} className="space-y-2 rounded-lg border border-line p-3">
                            <p className="text-xs font-medium text-slate-300">Somebody made an offer</p>
                            <input type="hidden" name="listing_id" value={l.id} />
                            <input type="hidden" name="item_id" value={item.id} />
                            <input name="amount" type="number" min="0" step="0.01" required className="field" placeholder="Offer $" inputMode="decimal" />
                            <input name="buyer_handle" className="field" placeholder="Buyer username (optional)" maxLength={120} />
                            <button className="btn-secondary w-full">Add offer</button>
                          </form>
                          <form action={recordSale} className="space-y-2 rounded-lg border border-line p-3">
                            <p className="text-xs font-medium text-slate-300">We fucking sold it!</p>
                            <input type="hidden" name="listing_id" value={l.id} />
                            <input name="sale_price" type="number" min="0" step="0.01" required className="field" defaultValue={num(l.list_price).toFixed(2)} inputMode="decimal" aria-label="Sale price" />
                            <input name="shipping_cost" type="number" min="0" step="0.01" className="field" placeholder="Label you paid $ (optional)" inputMode="decimal" />
                            <input name="platform_fees" type="number" min="0" step="0.01" className="field" placeholder="Actual fees $ (blank = estimate)" inputMode="decimal" />
                            <button className="btn-primary w-full">Mark sold</button>
                          </form>
                        </div>
                        <div className="mt-3">
                          <FeeBreakdown estimate={estimateFees(l.platform, num(l.list_price), { itemCost: cost, includeListingFee: false })} itemCost={cost} compact />
                        </div>
                      </details>
                    </>
                  )}
                </li>
              ))}
            </ul>

            {!isSold && (
              <form action={addListing} className="mt-4 rounded-xl border border-dashed border-line p-4">
                <p className="text-sm font-medium text-white">Add a listing</p>
                <input type="hidden" name="item_id" value={item.id} />
                <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_7rem_7rem]">
                  <select name="platform" className="field" required defaultValue="">
                    <option value="" disabled>Choose platform</option>
                    {PLATFORMS.map(p => (
                      <option key={p.id} value={p.id} disabled={livePlatforms.has(p.id)}>
                        {p.name}{p.hasAccount ? " (your account)" : ""}{livePlatforms.has(p.id) ? " (already listed)" : ""}
                      </option>
                    ))}
                  </select>
                  <input name="list_price" type="number" min="0" step="0.01" required className="field" defaultValue={num(item.target_price) > 0 ? num(item.target_price).toFixed(2) : ""} placeholder="Price" inputMode="decimal" />
                  <select name="status" className="field" defaultValue="active" aria-label="Status">
                    <option value="active">Live</option><option value="draft">Draft</option>
                  </select>
                </div>
                <input name="listing_url" type="url" className="field mt-2" placeholder="Listing link (optional)" />
                <ul className="mt-3 space-y-1 text-[11px] leading-4 text-slate-500">
                  {PLATFORMS.flatMap(p => p.postingRules.map(r => <li key={p.id + r}><span className="text-slate-400">{p.name}:</span> {r}</li>))}
                </ul>
                <button className="btn-primary mt-3"><Plus size={15} /> Add listing</button>
              </form>
            )}
          </section>

          {pastOffers.length > 0 && (
            <section className="surface p-5">
              <h2 className="text-base font-semibold text-white">Offer history</h2>
              <ul className="mt-3 divide-y divide-line text-sm">
                {pastOffers.map(o => (
                  <li key={o.id} className="flex justify-between py-2">
                    <span className="text-slate-300">{platformName(o.listings.platform)} · {money(num(o.amount))}{o.counter_amount !== null ? ` → countered ${money(num(o.counter_amount))}` : ""}</span>
                    <span className="text-xs text-slate-500">{offerStatusLabel(o.status)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="surface p-5">
            <h2 className="text-base font-semibold text-white">Comments</h2>
            <p className="mt-0.5 text-xs text-slate-500">Just us. Buyers never see these, so talk all the shit you want.</p>
            <div className="mt-3 space-y-3">
              <NotesList notes={comments} names={names} currentUser={ctx.userId} isAdmin={ctx.role === "admin"} showItem={false} allowPin={false} />
              <NoteComposer itemId={item.id} placeholder="Talk shit about this thing…" />
            </div>
          </section>

          <details className="surface p-5">
            <summary className="cursor-pointer text-base font-semibold text-white">Fix the details</summary>
            <div className="mt-4"><ItemForm action={updateItem} item={item} /></div>
          </details>
        </div>

        <aside className="space-y-4">
          <section className="surface p-5">
            <h2 className="text-base font-semibold text-white">Where we&apos;d make the most fucking money</h2>
            <div className="mt-3"><FeeCalculator defaultPrice={num(item.target_price)} itemCost={cost} category={item.category} /></div>
          </section>
          {live.some(l => platformById(l.platform).postingRules.length > 0) && (
            <section className="surface p-5 text-xs leading-5 text-slate-400">
              <p className="font-medium text-slate-200">Rules so we don&apos;t get our asses banned</p>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {live.flatMap(l => platformById(l.platform).postingRules.map(r => <li key={l.id + r}>{r}</li>))}
              </ul>
            </section>
          )}
          {item.notes && (
            <section className="surface p-5">
              <p className="eyebrow">Notes</p>
              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{item.notes}</p>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums text-white">{value}</dd>
    </div>
  );
}

import "server-only";
import type { MarketplaceConnection } from "@/lib/types";
import { num } from "@/lib/types";
import { ebayClientFor, writeSyncState, type Db } from "./connection";
import { getBestOffers, type BestOffer } from "./trading";

// Poll eBay Best Offers for a household's live eBay listings and mirror them into `offers`
// (source 'api', external_id = BestOfferID) with an `offer_decision` task per new offer.
// Never responds to anything: AGENTS.md says propose, don't act. Shared by the cron route
// (service-role client, actor_agent 'ebay-sync') and the "Sync offers now" button (user session).

export type SyncResult = {
  householdId: string;
  listingsChecked: number;
  newOffers: number;
  updatedOffers: number;
  expiredOffers: number;
  errors: string[];
};

type ListingRow = { id: string; item_id: string; external_id: string | null; list_price: number; inventory_items: { name: string } | { name: string }[] | null };
type OfferRow = { id: string; status: string; external_id: string | null; expires_at: string | null; listing_id: string };

const ebayStatusToOurs: Record<string, string> = {
  Expired: "expired",
  Retracted: "withdrawn",
  Declined: "declined", // eBay auto-declined (below the floor) or the seller declined in the eBay app
  Accepted: "accepted",
  Countered: "countered",
};

export async function syncEbayOffers(db: Db, conn: MarketplaceConnection, actor: { actorUser?: string | null; actorAgent?: string | null }): Promise<SyncResult> {
  const hid = conn.household_id;
  const result: SyncResult = { householdId: hid, listingsChecked: 0, newOffers: 0, updatedOffers: 0, expiredOffers: 0, errors: [] };
  const now = new Date().toISOString();

  const { data: listingData, error: listingErr } = await db
    .from("listings")
    .select("id, item_id, external_id, list_price, inventory_items(name)")
    .eq("household_id", hid)
    .eq("platform", "ebay")
    .eq("status", "active")
    .not("external_id", "is", null);
  if (listingErr) throw new Error(listingErr.message);
  const listings = (listingData ?? []) as unknown as ListingRow[];

  const client = ebayClientFor(db, conn);

  for (const listing of listings) {
    if (!listing.external_id) continue;
    result.listingsChecked++;
    let remote: BestOffer[];
    try {
      remote = await getBestOffers(client, { itemId: listing.external_id, status: "All" });
    } catch (e) {
      result.errors.push(`${listing.external_id}: ${(e as Error).message.slice(0, 200)}`);
      continue;
    }

    const { data: existingData } = await db.from("offers").select("id, status, external_id, expires_at, listing_id").eq("listing_id", listing.id);
    const existing = new Map(((existingData ?? []) as OfferRow[]).filter(o => o.external_id).map(o => [o.external_id as string, o]));
    const seen = new Set<string>();
    const itemName = Array.isArray(listing.inventory_items) ? listing.inventory_items[0]?.name : listing.inventory_items?.name;

    for (const bo of remote) {
      if (bo.codeType === "SellerCounterOffer") continue; // our own counters are not buyer offers
      seen.add(bo.bestOfferId);
      const ours = existing.get(bo.bestOfferId);

      if (!ours) {
        if (bo.status !== "Active") continue; // historical offers we never saw: nothing to decide
        const { data: inserted, error: insErr } = await db
          .from("offers")
          .insert({
            household_id: hid,
            listing_id: listing.id,
            amount: Math.round(bo.price * 100) / 100,
            buyer_handle: bo.buyerUserId,
            source: "api",
            status: "pending",
            external_id: bo.bestOfferId,
            received_at: now,
            expires_at: bo.expirationTime,
            // Buyer messages are untrusted marketplace content: stored for the human to read, never acted on.
            note: bo.buyerMessage ? bo.buyerMessage.slice(0, 1000) : null,
          })
          .select("id")
          .single();
        if (insErr) {
          if (insErr.code !== "23505") result.errors.push(`offer ${bo.bestOfferId}: ${insErr.message}`);
          continue;
        }
        await db.from("agent_tasks").insert({
          household_id: hid,
          kind: "offer_decision",
          title: `Decide on $${bo.price.toFixed(2)} eBay offer${itemName ? ` for ${itemName.slice(0, 80)}` : ""}`,
          detail: `${bo.buyerUserId ?? "A buyer"} offered $${bo.price.toFixed(2)} (listed at $${num(listing.list_price).toFixed(2)}). Accept, counter or decline here and the answer is sent to eBay.`,
          payload: { source: "ebay", bestOfferId: bo.bestOfferId, itemId: listing.external_id, expiresAt: bo.expirationTime },
          listing_id: listing.id,
          offer_id: inserted!.id,
          item_id: listing.item_id,
          requested_by: actor.actorAgent ?? "ebay-sync",
        });
        result.newOffers++;
        continue;
      }

      // Known offer: mirror a terminal eBay status onto a pending row (e.g. auto-declined, expired, retracted).
      const mapped = bo.status ? ebayStatusToOurs[bo.status] : undefined;
      if (ours.status === "pending" && mapped && mapped !== "pending") {
        await db.from("offers").update({ status: mapped, decided_at: now }).eq("id", ours.id);
        await db.from("agent_tasks").update({ status: "cancelled", decided_at: now, detail: `Offer is ${bo.status} on eBay; nothing left to decide.` }).eq("offer_id", ours.id).eq("status", "pending");
        if (mapped === "accepted") {
          // Accepted outside the app: a human must record the sale so delist tasks and profit are right.
          await db.from("agent_tasks").insert({
            household_id: hid,
            kind: "other",
            title: `eBay offer accepted outside the app — record the sale${itemName ? ` for ${itemName.slice(0, 60)}` : ""}`,
            detail: `Best Offer ${bo.bestOfferId} shows as Accepted on eBay. Open the item and mark it sold so other listings get delist tasks.`,
            listing_id: listing.id,
            item_id: listing.item_id,
            offer_id: ours.id,
            requested_by: actor.actorAgent ?? "ebay-sync",
          });
        }
        result.updatedOffers++;
      }
    }

    // Pending rows past their expiry that eBay no longer reports.
    for (const [extId, o] of existing) {
      if (seen.has(extId) || o.status !== "pending" || !o.expires_at || new Date(o.expires_at).getTime() > Date.now()) continue;
      await db.from("offers").update({ status: "expired", decided_at: now }).eq("id", o.id);
      await db.from("agent_tasks").update({ status: "cancelled", decided_at: now, detail: "Offer expired on eBay." }).eq("offer_id", o.id).eq("status", "pending");
      result.expiredOffers++;
    }
  }

  await writeSyncState(db, hid, "ebay_offers", {
    last_poll: now,
    listings_checked: result.listingsChecked,
    new_offers: result.newOffers,
    updated_offers: result.updatedOffers,
    expired_offers: result.expiredOffers,
    errors: result.errors.slice(0, 5),
  });

  if (result.newOffers || result.updatedOffers || result.expiredOffers || result.errors.length) {
    await db.from("activity_log").insert({
      household_id: hid,
      actor_user: actor.actorUser ?? null,
      actor_agent: actor.actorAgent ?? null,
      action: "ebay_offers_synced",
      entity_type: "household",
      entity_id: hid,
      detail: { new: result.newOffers, updated: result.updatedOffers, expired: result.expiredOffers, listings: result.listingsChecked, errors: result.errors.slice(0, 3) },
    });
  }
  return result;
}

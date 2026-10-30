import "server-only";
import { ebayClientFor, isUsableConnection, loadEbayConnection, type Db } from "./connection";
import { isEbayConfigured } from "./config";
import { respondToBestOffer, type RespondAction } from "./trading";

// Carries a human's accept / counter / decline decision on an eBay Best Offer to eBay.
// Called from decideOffer after the decision is recorded locally. Never throws: the household's
// record stands even when eBay is unreachable; the failure is logged and noted on the task.

export type RespondOutcome = { ok: true } | { ok: false; error: string };

const ACTIONS: Record<string, RespondAction> = { accepted: "Accept", declined: "Decline", countered: "Counter" };

export async function respondToEbayOfferDecision(
  db: Db,
  args: { householdId: string; actorUser: string; offerId: string; bestOfferId: string; ebayItemId: string | null; decision: string; counterAmount: number | null },
): Promise<RespondOutcome> {
  const action = ACTIONS[args.decision];
  const outcome = await attempt(db, args, action);
  await db.from("activity_log").insert({
    household_id: args.householdId,
    actor_user: args.actorUser,
    action: outcome.ok ? "ebay_offer_responded" : "ebay_offer_response_failed",
    entity_type: "offer",
    entity_id: args.offerId,
    detail: { action, bestOfferId: args.bestOfferId, counter: args.counterAmount, ...(outcome.ok ? {} : { error: outcome.error.slice(0, 500) }) },
  });
  if (!outcome.ok) {
    await db
      .from("agent_tasks")
      .update({ detail: `Decision recorded here, but eBay was NOT updated: ${outcome.error.slice(0, 300)}. Please ${action.toLowerCase()} the offer in the eBay app too.` })
      .eq("offer_id", args.offerId);
  }
  return outcome;
}

async function attempt(db: Db, args: Parameters<typeof respondToEbayOfferDecision>[1], action: RespondAction | undefined): Promise<RespondOutcome> {
  try {
    if (!action) return { ok: false, error: `Unknown decision ${args.decision}` };
    if (!isEbayConfigured()) return { ok: false, error: "eBay integration is not configured (EBAY_* env vars)." };
    if (!args.ebayItemId) return { ok: false, error: "Listing has no eBay item id." };
    const conn = await loadEbayConnection(db, args.householdId);
    if (!isUsableConnection(conn)) return { ok: false, error: "No active eBay connection for this household." };
    if (action === "Counter" && !(args.counterAmount && args.counterAmount > 0)) return { ok: false, error: "Counter amount missing." };
    const client = ebayClientFor(db, conn);
    await respondToBestOffer(client, {
      itemId: args.ebayItemId,
      bestOfferId: args.bestOfferId,
      action,
      counterOfferPrice: action === "Counter" ? (args.counterAmount as number) : undefined,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message || "Unknown error" };
  }
}

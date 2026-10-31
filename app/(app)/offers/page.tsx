import Link from "next/link";
import { OfferCard } from "@/components/offer-card";
import { requireHousehold } from "@/lib/household";
import { loadPendingOffers } from "@/lib/queries";

export default async function OffersPage() {
  const ctx = await requireHousehold();
  const offers = await loadPendingOffers(ctx);
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Offers</h1>
        <p className="mt-1 text-sm text-slate-400">Who wants our shit, and what we&apos;d actually pocket after fees.</p>
      </header>
      {offers.length === 0 ? (
        <div className="surface p-8 text-center text-sm text-slate-400">
          No offers. Nobody&apos;s fucking biting yet. When one comes in, open the item and hit <span className="text-slate-200">Got an offer or a sale?</span>
          {" "}or <Link href="/inventory?status=listed" className="text-link hover:underline">see what&apos;s for sale</Link>.
        </div>
      ) : (
        <div className="space-y-3">{offers.map(o => <OfferCard key={o.id} offer={o} />)}</div>
      )}
    </div>
  );
}

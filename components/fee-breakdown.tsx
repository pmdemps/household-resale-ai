import type { FeeEstimate } from "@/lib/fees";
import { platformName } from "@/lib/platforms";
import { money } from "@/lib/types";

export function FeeBreakdown({ estimate, itemCost, compact = false }: { estimate: FeeEstimate; itemCost?: number; compact?: boolean }) {
  const unverified = estimate.rule.verifiedOn === "UNVERIFIED";
  return (
    <div className={"rounded-xl border border-line bg-ink/60 " + (compact ? "p-3" : "p-4")}>
      <dl className="space-y-1.5 text-sm">
        <Row label={`Sale on ${platformName(estimate.platform)}`} value={money(estimate.salePrice)} />
        {estimate.lines.map(l => <Row key={l.label} label={l.label} value={"− " + money(l.amount)} muted />)}
        {estimate.sellerShippingCost > 0 && <Row label="Shipping label you pay" value={"− " + money(estimate.sellerShippingCost)} muted />}
        <div className="my-2 border-t border-line" />
        <Row label="You get after fees" value={money(estimate.payout)} strong tone={estimate.payout < 0 ? "bad" : itemCost ? undefined : estimate.payout > 0 ? "good" : undefined} />
        {itemCost !== undefined && itemCost > 0 && (
          <>
            <Row label="What you paid for it" value={"− " + money(itemCost)} muted />
            <Row label="Profit" value={money(estimate.profit)} strong tone={estimate.profit >= 0 ? "good" : "bad"} />
          </>
        )}
      </dl>
      <p className="mt-3 text-[11px] leading-4 text-slate-500">
        Estimate. {unverified ? "Fee rule not yet verified. " : estimate.rule.verifiedOn.includes("third-party") ? `Fees from third-party sources (${estimate.rule.verifiedOn.slice(0, 10)}). ` : `Fees checked ${estimate.rule.verifiedOn}. `}
        Check the platform&apos;s payout screen before you accept.
      </p>
    </div>
  );
}

function Row({ label, value, muted, strong, tone }: { label: string; value: string; muted?: boolean; strong?: boolean; tone?: "good" | "bad" }) {
  const color = tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : strong ? "text-white" : muted ? "text-slate-400" : "text-slate-200";
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={muted ? "text-slate-400" : "text-slate-300"}>{label}</dt>
      <dd className={"tabular-nums " + color + (strong ? " font-semibold" : "")}>{value}</dd>
    </div>
  );
}

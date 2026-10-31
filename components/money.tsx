import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { money } from "@/lib/types";

export type MoneyTone = "good" | "bad" | "even";

export const toneOf = (value: number): MoneyTone => (value > 0.004 ? "good" : value < -0.004 ? "bad" : "even");

const TONE_TEXT: Record<MoneyTone, string> = { good: "text-good", bad: "text-bad", even: "text-slate-400" };
const TONE_PILL: Record<MoneyTone, string> = {
  good: "bg-good/15 text-good ring-1 ring-inset ring-good/30",
  bad: "bg-bad/15 text-bad ring-1 ring-inset ring-bad/30",
  even: "bg-white/[0.06] text-slate-300 ring-1 ring-inset ring-line",
};
const ICON = { good: TrendingUp, bad: TrendingDown, even: Minus };

/** Signed amount in green (made money) or red (lost money), with an arrow so it reads without color too. */
export function ProfitBadge({ value, label, size = "sm" }: { value: number; label?: string; size?: "sm" | "md" | "lg" }) {
  const tone = toneOf(value);
  const Icon = ICON[tone];
  const sign = tone === "good" ? "+" : tone === "bad" ? "−" : "";
  const sizes = {
    sm: "gap-1 px-2 py-0.5 text-xs",
    md: "gap-1.5 px-2.5 py-1 text-sm",
    lg: "gap-2 px-3 py-1.5 text-base",
  }[size];
  return (
    <span className={`inline-flex items-center rounded-full font-semibold tabular-nums ${sizes} ${TONE_PILL[tone]}`}>
      <Icon size={size === "lg" ? 18 : size === "md" ? 15 : 13} aria-hidden />
      {label && <span className="font-medium">{label}</span>}
      {sign}{money(Math.abs(value))}
    </span>
  );
}

/** Plain colored amount for tables. */
export function MoneyText({ value, className = "" }: { value: number; className?: string }) {
  return <span className={`tabular-nums ${TONE_TEXT[toneOf(value)]} ${className}`}>{money(value)}</span>;
}

export function verdict(value: number): string {
  const t = toneOf(value);
  return t === "good" ? "We're making bank" : t === "bad" ? "We're losing money, dammit" : "Breaking even. Meh.";
}

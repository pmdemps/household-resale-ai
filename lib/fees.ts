// Seller fee estimates per marketplace (US, standard seller, no promoted listings).
//
// Fees change often. Every rule carries `verifiedOn` and `sourceUrl`; re-verify before trusting
// a number older than ~90 days. Estimates only: the platform's payout screen is the source of truth.
// Pure module (no server imports) so it runs in the browser calculator, server actions, and tests.

export type FeeRule = {
  /** Percentage selling fee, e.g. 0.136 for 13.6%. */
  percent: number;
  /** What the percentage fee is charged on. */
  percentBase: "item" | "item_plus_shipping";
  /** Fixed per-order fee; tiers checked in order, first `maxPrice` that fits wins. */
  fixedTiers?: { maxPrice: number; fixed: number }[];
  /** Flat fee replacing the percentage below a threshold (e.g. Poshmark). */
  flatBelow?: { threshold: number; flat: number };
  /** Minimum selling fee. */
  minimumFee?: number;
  /** Payment processing charged to the seller. */
  processingPercent?: number;
  processingFixed?: number;
  /** Per-listing fee (charged even if it doesn't sell). */
  listingFee?: number;
  /** Who normally pays the shipping label. */
  shippingPaidBy: "buyer" | "seller" | "either";
  verifiedOn: string;
  sourceUrl: string;
  notes: string;
};

export const FEE_RULES: Record<string, FeeRule> = {
  ebay: {
    percent: 0.136,
    percentBase: "item_plus_shipping",
    fixedTiers: [
      { maxPrice: 10, fixed: 0.3 },
      { maxPrice: Infinity, fixed: 0.4 },
    ],
    shippingPaidBy: "either",
    verifiedOn: "2026-10-29",
    sourceUrl: "https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees?id=4822",
    notes: "Most categories (13.6% up to $7,500). Charged on item + shipping + sales tax, so real fees run slightly higher than shown. Athletic shoes $150+: 8%, no per-order fee. 250 free listings/month.",
  },
  vinted: {
    percent: 0,
    percentBase: "item",
    shippingPaidBy: "buyer",
    verifiedOn: "2026-10-29",
    sourceUrl: "https://www.vinted.com/pricelist",
    notes: "Seller pays nothing. Buyer pays $0.70 + 5% protection fee and the shipping label.",
  },
  etsy: {
    percent: 0.065,
    percentBase: "item_plus_shipping",
    processingPercent: 0.03,
    processingFixed: 0.25,
    listingFee: 0.2,
    shippingPaidBy: "either",
    verifiedOn: "2026-10-29",
    sourceUrl: "https://www.etsy.com/legal/fees/",
    notes: "6.5% transaction on item + shipping, 3% + $0.25 US processing, $0.20 listing. Used non-vintage goods are not allowed on Etsy.",
  },
  poshmark: {
    percent: 0.2,
    percentBase: "item",
    flatBelow: { threshold: 15, flat: 2.95 },
    shippingPaidBy: "buyer",
    verifiedOn: "2026-10-29 (third-party)",
    sourceUrl: "https://poshmark.com/fees",
    notes: "$2.95 flat under $15, 20% at $15+. Buyer pays the $6.49 label up to 5 lb; seller pays weight upgrades.",
  },
  mercari: {
    percent: 0.1,
    percentBase: "item_plus_shipping",
    shippingPaidBy: "either",
    verifiedOn: "2026-10-29",
    sourceUrl: "https://www.mercari.com/us/help_center/article/169/",
    notes: "10% of item price plus buyer-paid shipping. No processing fee. Buyer pays 3.6% protection.",
  },
  depop: {
    percent: 0,
    percentBase: "item",
    processingPercent: 0.033,
    processingFixed: 0.45,
    shippingPaidBy: "buyer",
    verifiedOn: "2026-10-29",
    sourceUrl: "https://depophelp.zendesk.com/hc/en-gb/articles/360001791127",
    notes: "No selling fee. 3.3% + $0.45 processing on item + shipping (+tax). Boosted sales add 12%.",
  },
  facebook: {
    percent: 0.1,
    percentBase: "item",
    minimumFee: 0.8,
    shippingPaidBy: "either",
    verifiedOn: "2026-10-29 (third-party)",
    sourceUrl: "https://www.valueaddedresource.net/facebook-marketplace-doubling-selling-fees/",
    notes: "Shipped orders: 10%, $0.80 minimum. Local pickup is free. Prepaid labels only for select sellers.",
  },
  other: {
    percent: 0,
    percentBase: "item",
    shippingPaidBy: "either",
    verifiedOn: "n/a",
    sourceUrl: "",
    notes: "No fee model. Enter fees manually.",
  },
};

export type FeeLine = { label: string; amount: number };

export type FeeEstimate = {
  platform: string;
  salePrice: number;
  lines: FeeLine[];
  totalFees: number;
  sellerShippingCost: number;
  /** What lands in your account after platform fees and any label you pay for. */
  payout: number;
  /** payout minus what the item cost you. */
  profit: number;
  rule: FeeRule;
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function estimateFees(
  platform: string,
  salePrice: number,
  opts: { shippingChargedToBuyer?: number; sellerShippingCost?: number; itemCost?: number; includeListingFee?: boolean } = {},
): FeeEstimate {
  const rule = FEE_RULES[platform] ?? FEE_RULES.other;
  const price = Math.max(0, salePrice);
  const shipCharged = Math.max(0, opts.shippingChargedToBuyer ?? 0);
  const sellerShip = Math.max(0, opts.sellerShippingCost ?? 0);
  const lines: FeeLine[] = [];

  if (rule.flatBelow && price < rule.flatBelow.threshold) {
    lines.push({ label: `Flat fee (under $${rule.flatBelow.threshold})`, amount: rule.flatBelow.flat });
  } else if (rule.percent > 0) {
    const base = rule.percentBase === "item_plus_shipping" ? price + shipCharged : price;
    let fee = base * rule.percent;
    if (rule.minimumFee && fee < rule.minimumFee) fee = rule.minimumFee;
    lines.push({ label: `Selling fee (${round2(rule.percent * 100)}%)`, amount: round2(fee) });
  }

  const tier = rule.fixedTiers?.find(t => price <= t.maxPrice);
  if (tier && tier.fixed > 0) lines.push({ label: "Per-order fee", amount: tier.fixed });

  if (rule.processingPercent || rule.processingFixed) {
    const proc = (price + shipCharged) * (rule.processingPercent ?? 0) + (rule.processingFixed ?? 0);
    lines.push({ label: "Payment processing", amount: round2(proc) });
  }

  if (rule.listingFee && opts.includeListingFee !== false) lines.push({ label: "Listing fee", amount: rule.listingFee });

  const totalFees = round2(lines.reduce((s, l) => s + l.amount, 0));
  const payout = round2(price + shipCharged - totalFees - sellerShip);
  const profit = round2(payout - Math.max(0, opts.itemCost ?? 0));
  return { platform, salePrice: price, lines, totalFees, sellerShippingCost: sellerShip, payout, profit, rule };
}

/** Lowest sale price that still nets at least `targetPayout` on a platform (searches in 1¢ steps). */
export function breakEvenPrice(platform: string, targetPayout: number, opts: { sellerShippingCost?: number } = {}): number {
  for (let cents = 0; cents <= 1_000_000; cents++) {
    const p = cents / 100;
    if (estimateFees(platform, p, { ...opts, includeListingFee: false }).payout >= targetPayout) return p;
  }
  return NaN;
}

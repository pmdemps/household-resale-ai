// Ready-to-paste listing text for marketplaces with no API (Poshmark, Mercari, OfferUp, Facebook, Vinted).
// A human pastes this into the platform's own app; Resale HQ never automates those sites (see AGENTS.md).
//
// Everything here leaves the app and is seen by buyers, so it stays clean and professional:
// no cussing, and never anything from the item's private household notes.
// Pure module (no server imports) so the item page and tests can both use it.

export type CopyItem = {
  name: string;
  category: string;
  brand: string | null;
  size: string | null;
  condition: string | null;
  target_price: number | string;
};

export type ListingCopy = {
  title: string;
  description: string;
  /** Suggested asking price on this platform, rounded to whole dollars where buyers expect it. */
  price: number;
  /** Short tips for the person posting (shown in the app, not pasted). */
  tips: string[];
};

/** Title length limits per platform (conservative where the platform doesn't publish one). */
export const TITLE_MAX: Record<string, number> = {
  poshmark: 80,
  mercari: 80,
  offerup: 60,
  facebook: 100,
  vinted: 100,
};

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Cut at a word boundary so titles never end mid-word. */
export function fitTitle(text: string, max: number): string {
  const t = clean(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.5 ? cut.slice(0, space) : t.slice(0, max)).replace(/[\s,.;:-]+$/, "");
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-word, case-insensitive: "L" is not in "Flannel". */
const hasWord = (haystack: string, word: string) => new RegExp(`(^|[^a-z0-9])${escape(word)}($|[^a-z0-9])`, "i").test(haystack);

/** "Nike Air Max 90 Size 10": brand first unless the name already has it, size last. */
export function buildTitle(item: CopyItem, max: number): string {
  const name = clean(item.name);
  const brand = clean(item.brand);
  const size = clean(item.size);
  const parts: string[] = [];
  if (brand && !hasWord(name, brand)) parts.push(brand);
  parts.push(name);
  if (size && !hasWord(name, size)) parts.push(/^size\b/i.test(size) ? size : `Size ${size}`);
  return fitTitle(parts.join(" "), max);
}

const toNum = (v: number | string) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function detailLines(item: CopyItem): string[] {
  const lines: string[] = [];
  if (clean(item.brand)) lines.push(`Brand: ${clean(item.brand)}`);
  if (clean(item.size)) lines.push(`Size: ${clean(item.size)}`);
  if (clean(item.condition)) lines.push(`Condition: ${clean(item.condition)}`);
  if (clean(item.category) && item.category !== "Other") lines.push(`Category: ${clean(item.category)}`);
  return lines;
}

const NEEDS_MEASUREMENTS = new Set(["Clothing", "Kids & baby"]);

/** Listing text for one platform. Returns null for platforms that don't take a written listing (ThredUp). */
export function buildListingCopy(platform: string, item: CopyItem): ListingCopy | null {
  if (platform === "thredup") return null;
  const max = TITLE_MAX[platform] ?? 80;
  const title = buildTitle(item, max);
  const details = detailLines(item);
  const base = toNum(item.target_price);
  const tips: string[] = ["Use the item's photos from Resale HQ (save them from the photo strip first)."];
  if (NEEDS_MEASUREMENTS.has(item.category)) tips.push("Add measurements (pit to pit, length) if we have them. Clothes with measurements sell faster.");

  switch (platform) {
    case "poshmark":
      tips.push("Pick the closest Poshmark category and size so it shows up in filtered searches.");
      return {
        title,
        description: [clean(item.name) + ".", "", ...details, "", "Bundle with other items in my closet to save on shipping. Offers welcome."].join("\n"),
        price: Math.round(base),
        tips,
      };
    case "mercari":
      tips.push("Turn on Smart Pricing only if the floor is at or above our rock bottom price.");
      return {
        title,
        description: [clean(item.name) + ".", "", ...details, "", "Ships carefully packed. Reasonable offers considered."].join("\n"),
        price: Math.round(base),
        tips,
      };
    case "offerup":
      tips.push("Choose local pickup for big or heavy things. Local sales have no OfferUp fee.", "If the website says \"update your app\", post from the OfferUp phone app instead.");
      return {
        title,
        description: [clean(item.name) + ".", ...details, "", "Local pickup. Message me with any questions."].join("\n"),
        price: Math.round(base),
        tips,
      };
    case "facebook":
      tips.push("Post to Marketplace only and turn on Hide from friends.");
      return {
        title,
        description: [clean(item.name) + ".", ...details, "", "Local pickup. Message me if you're interested."].join("\n"),
        price: Math.round(base),
        tips,
      };
    case "vinted":
      tips.push("Post it yourself in the Vinted app. No automation tools on Vinted, ever.");
      return {
        title,
        description: [clean(item.name) + ".", "", ...details].join("\n"),
        price: Math.round(base * 100) / 100,
        tips,
      };
    default:
      return { title, description: [clean(item.name) + ".", "", ...details].join("\n"), price: Math.round(base * 100) / 100, tips };
  }
}

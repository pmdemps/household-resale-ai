// Marketplace metadata and household posting rules.
// Rules here are enforced by the UI and must be followed by every agent (see AGENTS.md).

export type PlatformId = "ebay" | "vinted" | "etsy" | "poshmark" | "mercari" | "offerup" | "thredup" | "depop" | "facebook" | "other";

export type Integration = "official_api" | "email_only" | "manual";

export type PlatformInfo = {
  id: PlatformId;
  name: string;
  /** Household already has a seller account here. */
  hasAccount: boolean;
  integration: Integration;
  integrationNote: string;
  /** Rules every human or agent must follow when posting here. */
  postingRules: string[];
  /** Item categories this platform should not be used for. */
  avoidCategories?: string[];
  /** Where a human starts a new listing on the platform's own site (used by "Post it ourselves"). */
  sellUrl?: string;
  /** Consignment: you ship it off and they price and sell it (ThredUp). No listing price, the payout is the sale. */
  consignment?: boolean;
};

export const PLATFORMS: PlatformInfo[] = [
  {
    id: "ebay",
    name: "eBay",
    hasAccount: true,
    integration: "official_api",
    integrationNote: "Integrated: connect in Settings, post from an item page (Inventory API), buyer offers pulled in (Trading GetBestOffers) and your accept/counter/decline sent back (RespondToBestOffer). Setup: docs/ebay-setup.md.",
    postingRules: ["Enable Best Offer with an auto-decline below the item's floor price."],
  },
  {
    id: "vinted",
    name: "Vinted",
    hasAccount: true,
    integration: "email_only",
    integrationNote: "No public seller API, and Vinted actively detects bots (crosslisters have triggered suspensions). Track offers from notification emails; take actions yourself in the app.",
    sellUrl: "https://www.vinted.com/items/new",
    postingRules: ["Never automate the Vinted website or app. A human taps accept/counter/list."],
    avoidCategories: ["Tools", "Electronics"],
  },
  {
    id: "etsy",
    name: "Etsy",
    hasAccount: true,
    integration: "official_api",
    integrationNote: "Official Open API v3 (needs Etsy app approval). Used non-vintage clothing, shoes, toys and household goods are not allowed.",
    postingRules: ["Only list items that are at least 20 years old (vintage), handmade, or craft supplies."],
  },
  {
    id: "facebook",
    name: "Facebook Marketplace",
    hasAccount: false,
    integration: "manual",
    integrationNote: "No API for individual sellers. Manual, or browser-assisted with your approval.",
    sellUrl: "https://www.facebook.com/marketplace/create/item",
    postingRules: [
      "Post to Marketplace only. Never share to the News Feed, Stories, or groups.",
      "Always turn on \"Hide from friends\" so friends cannot see the listing.",
    ],
  },
  {
    id: "poshmark",
    name: "Poshmark",
    hasAccount: true,
    integration: "email_only",
    integrationNote: "No public API, and its terms ban bots. Resale HQ writes the listing (Post it ourselves on the item page); a human posts it on Poshmark and records it here; offer emails can be tracked. Best for clothes and shoes.",
    postingRules: ["A human posts on Poshmark. No bots or auto-sharing tools, they get closets banned."],
    sellUrl: "https://poshmark.com/create-listing",
    avoidCategories: ["Tools", "Electronics"],
  },
  {
    id: "mercari",
    name: "Mercari",
    hasAccount: true,
    integration: "email_only",
    integrationNote: "No public API, and its terms ban automation. Resale HQ writes the listing; a human posts it on Mercari and records it here; offer emails can be tracked. Good catch-all for clothes, toys and random stuff.",
    postingRules: ["A human posts on Mercari. No bots or crosslisting scripts."],
    sellUrl: "https://www.mercari.com/sell/",
  },
  {
    id: "offerup",
    name: "OfferUp",
    hasAccount: true,
    integration: "manual",
    integrationNote: "No public API. Resale HQ writes the listing; a human posts it in OfferUp and records it here. Best for local pickup of big or heavy stuff (tools, furniture). Local sales have no fee; shipped sales do.",
    postingRules: ["A human posts on OfferUp.", "Local pickup: meet somewhere public and get paid before handing it over."],
    sellUrl: "https://offerup.com/post",
  },
  {
    id: "thredup",
    name: "ThredUp",
    hasAccount: true,
    integration: "manual",
    integrationNote: "Consignment, not a marketplace: order a Clean Out kit, bag up clothes, ship it free, and ThredUp prices and sells it. Record the bag here, then record the payout as the sale when it lands.",
    postingRules: ["Clothes, shoes and accessories only, clean and in good shape. Pick \"donate unsold\" unless we want rejects mailed back ($5.99 each)."],
    sellUrl: "https://www.thredup.com/cleanout",
    consignment: true,
    avoidCategories: ["Toys & games", "Home & kitchen", "Electronics", "Tools", "Books & media", "Collectibles"],
  },
  { id: "depop", name: "Depop", hasAccount: false, integration: "email_only", integrationNote: "Official Partner API exists but is invite-only. Email notifications otherwise.", postingRules: [] },
  { id: "other", name: "Other", hasAccount: false, integration: "manual", integrationNote: "Tracked manually.", postingRules: [] },
];

export const platformById = (id: string): PlatformInfo =>
  PLATFORMS.find(p => p.id === id) ?? PLATFORMS[PLATFORMS.length - 1];

export const platformName = (id: string) => platformById(id).name;

/** Platforms with no API where a human posts the listing Resale HQ writes. */
export const MANUAL_PLATFORMS: PlatformInfo[] = PLATFORMS.filter(p => p.integration !== "official_api" && p.id !== "other" && p.id !== "depop");

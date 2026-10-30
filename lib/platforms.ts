// Marketplace metadata and household posting rules.
// Rules here are enforced by the UI and must be followed by every agent (see AGENTS.md).

export type PlatformId = "ebay" | "vinted" | "etsy" | "poshmark" | "mercari" | "depop" | "facebook" | "other";

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
};

export const PLATFORMS: PlatformInfo[] = [
  {
    id: "ebay",
    name: "eBay",
    hasAccount: true,
    integration: "official_api",
    integrationNote: "Official APIs: Inventory (listings, price), Fulfillment (orders), Trading API GetBestOffers/RespondToBestOffer (buyer offers). Planned first live integration.",
    postingRules: ["Enable Best Offer with an auto-decline below the item's floor price."],
  },
  {
    id: "vinted",
    name: "Vinted",
    hasAccount: true,
    integration: "email_only",
    integrationNote: "No public seller API, and Vinted actively detects bots (crosslisters have triggered suspensions). Track offers from notification emails; take actions yourself in the app.",
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
    postingRules: [
      "Post to Marketplace only. Never share to the News Feed, Stories, or groups.",
      "Always turn on \"Hide from friends\" so friends cannot see the listing.",
    ],
  },
  { id: "poshmark", name: "Poshmark", hasAccount: false, integration: "email_only", integrationNote: "No public API. Email notifications only.", postingRules: [] },
  { id: "mercari", name: "Mercari", hasAccount: false, integration: "email_only", integrationNote: "No public API. Email notifications only.", postingRules: [] },
  { id: "depop", name: "Depop", hasAccount: false, integration: "email_only", integrationNote: "Official Partner API exists but is invite-only. Email notifications otherwise.", postingRules: [] },
  { id: "other", name: "Other", hasAccount: false, integration: "manual", integrationNote: "Tracked manually.", postingRules: [] },
];

export const platformById = (id: string): PlatformInfo =>
  PLATFORMS.find(p => p.id === id) ?? PLATFORMS[PLATFORMS.length - 1];

export const platformName = (id: string) => platformById(id).name;

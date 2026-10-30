// Row types mirroring supabase/migrations. Keep in sync when the schema changes.

export const ITEM_STATUSES = ["researching", "draft", "listed", "pending_sale", "sold", "returned", "donated", "discarded"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const LISTING_STATUSES = ["draft", "active", "paused", "sold", "ended"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const OFFER_STATUSES = ["pending", "accepted", "declined", "countered", "expired", "withdrawn"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const CATEGORIES = ["Clothing", "Shoes", "Toys & games", "Kids & baby", "Home & kitchen", "Electronics", "Tools", "Books & media", "Collectibles", "Other"] as const;

export const CONDITIONS = ["New with tags", "New without tags", "Like new", "Good", "Fair", "For parts"] as const;

export type Household = { id: string; name: string; created_by: string; created_at: string };
export type Membership = { household_id: string; user_id: string; role: "admin" | "member" };

export type InventoryItem = {
  id: string;
  household_id: string;
  created_by: string;
  name: string;
  category: string;
  brand: string | null;
  size: string | null;
  condition: string | null;
  storage_location: string | null;
  weight_oz: number | null;
  source: string;
  purchase_cost: number;
  target_price: number;
  floor_price: number | null;
  status: ItemStatus;
  notes: string | null;
  sold_price: number | null;
  sold_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Listing = {
  id: string;
  household_id: string;
  item_id: string;
  platform: string;
  status: ListingStatus;
  list_price: number;
  listing_url: string | null;
  external_id: string | null;
  listed_at: string | null;
  ended_at: string | null;
  created_at: string;
};

export type Offer = {
  id: string;
  household_id: string;
  listing_id: string;
  amount: number;
  buyer_handle: string | null;
  source: "manual" | "email" | "api" | "agent";
  status: OfferStatus;
  counter_amount: number | null;
  received_at: string;
  expires_at: string | null;
  decided_at: string | null;
  note: string | null;
};

export type Sale = {
  id: string;
  household_id: string;
  item_id: string;
  listing_id: string | null;
  platform: string;
  sale_price: number;
  shipping_charged: number;
  platform_fees: number;
  shipping_cost: number;
  other_costs: number;
  sold_at: string;
};

export type AgentTask = {
  id: string;
  household_id: string;
  kind: string;
  title: string;
  detail: string | null;
  payload: Record<string, unknown>;
  item_id: string | null;
  listing_id: string | null;
  offer_id: string | null;
  requested_by: string;
  status: "pending" | "approved" | "rejected" | "done" | "failed" | "cancelled";
  created_at: string;
};

export type ActivityEntry = {
  id: number;
  household_id: string;
  actor_user: string | null;
  actor_agent: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
};

export const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

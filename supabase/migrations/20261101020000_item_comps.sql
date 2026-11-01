-- Household Resale AI: market comparables ("what others sell this for") per inventory item.
-- Depends on 20261029010000_listings_offers_sales.sql (is_household_member, inventory_items(id, household_id) key).
--
-- One row per comparable listing someone else has up (or sold). Rows come from:
--   source = 'ebay'   the "Check eBay prices" button (Browse API, current Buy It Now listings); each check
--                     replaces the item's previous eBay rows
--   source = 'manual' a person or an agent recording a comp found anywhere (Etsy, Mercari, a web search)
-- The item page summarises them: lowest delivered price, typical (median) price, and whether the asking
-- price is below, comparable to, or above the market (lib/comps.ts).

create table if not exists public.item_comps (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null,
  source text not null default 'manual' check (source in ('ebay', 'manual')),
  -- Where the comparable is listed (ebay, etsy, mercari, poshmark, depop, vinted, facebook, other).
  platform text not null default 'other' check (char_length(platform) between 1 and 40),
  title text not null check (char_length(title) between 1 and 300),
  price numeric(10,2) not null check (price >= 0),
  -- Null = shipping unknown; 0 = free shipping.
  shipping numeric(10,2) check (shipping is null or shipping >= 0),
  url text check (url is null or (char_length(url) <= 1000 and url ~* '^https://')),
  condition text check (condition is null or char_length(condition) <= 80),
  -- 'active' = listed right now, 'sold' = a completed sale.
  kind text not null default 'active' check (kind in ('active', 'sold')),
  note text check (note is null or char_length(note) <= 300),
  external_id text check (external_id is null or char_length(external_id) <= 120),
  -- Who recorded it: a member (created_by) or an agent (added_by_agent, e.g. 'claude').
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  added_by_agent text check (added_by_agent is null or char_length(added_by_agent) <= 60),
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint item_comps_item_fk foreign key (item_id, household_id)
    references public.inventory_items (id, household_id) on delete cascade
);

comment on table public.item_comps is
  'Comparable listings for an inventory item (what others charge). source=ebay rows are refreshed by the Check eBay prices button; manual rows are recorded by members or agents.';

create index if not exists item_comps_item_idx on public.item_comps (item_id, captured_at desc);
create unique index if not exists item_comps_item_ebay_uidx on public.item_comps (item_id, external_id) where source = 'ebay' and external_id is not null;

alter table public.item_comps enable row level security;

drop policy if exists "Members read item comps" on public.item_comps;
create policy "Members read item comps" on public.item_comps for select to authenticated
  using (public.is_household_member(household_id));
drop policy if exists "Members add item comps" on public.item_comps;
create policy "Members add item comps" on public.item_comps for insert to authenticated
  with check (public.is_household_member(household_id) and (created_by is null or created_by = auth.uid()));
drop policy if exists "Members update item comps" on public.item_comps;
create policy "Members update item comps" on public.item_comps for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));
drop policy if exists "Members delete item comps" on public.item_comps;
create policy "Members delete item comps" on public.item_comps for delete to authenticated
  using (public.is_household_member(household_id));

grant select, insert, update, delete on public.item_comps to authenticated;

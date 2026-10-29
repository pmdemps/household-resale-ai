-- Household Resale AI: marketplace listings, offers, sales, approval queue, activity log.
-- Depends on 20261029000000_initial_schema.sql. Apply in order, once, to a fresh project.

-- ---------------------------------------------------------------------------
-- Membership helpers (security definer so policies don't recurse through RLS)
-- ---------------------------------------------------------------------------
create or replace function public.is_household_member(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = auth.uid()
  );
$$;

create or replace function public.is_household_admin(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id and hm.user_id = auth.uid() and hm.role = 'admin'
  );
$$;

revoke all on function public.is_household_member(uuid) from public;
revoke all on function public.is_household_admin(uuid) from public;
grant execute on function public.is_household_member(uuid) to authenticated;
grant execute on function public.is_household_admin(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Inventory details useful for household decluttering
-- ---------------------------------------------------------------------------
alter table public.inventory_items
  add column if not exists brand text,
  add column if not exists size text,
  add column if not exists storage_location text,
  add column if not exists weight_oz numeric(8,2) check (weight_oz is null or weight_oz >= 0),
  add column if not exists floor_price numeric(12,2) check (floor_price is null or floor_price >= 0);

comment on column public.inventory_items.floor_price is
  'Lowest price the household will accept. Agents may never accept or counter below this.';
comment on column public.inventory_items.storage_location is
  'Where the item physically is in the house (e.g. "garage bin 3").';

-- Lets child tables enforce that their household matches the item's household.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_items_id_household_key'
      and conrelid = 'public.inventory_items'::regclass
  ) then
    alter table public.inventory_items
      add constraint inventory_items_id_household_key unique (id, household_id);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Listings: one row per item per marketplace
-- ---------------------------------------------------------------------------
create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null,
  platform text not null
    check (platform in ('ebay', 'poshmark', 'mercari', 'vinted', 'depop', 'facebook', 'etsy', 'other')),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'sold', 'ended')),
  list_price numeric(12,2) not null check (list_price >= 0),
  listing_url text,
  external_id text,
  listed_at timestamptz,
  ended_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint listings_id_household_key unique (id, household_id),
  constraint listings_item_fk foreign key (item_id, household_id)
    references public.inventory_items (id, household_id) on delete cascade
);

-- An item can only have one live (draft/active/paused) listing per platform.
create unique index if not exists listings_one_live_per_platform
  on public.listings (item_id, platform)
  where status in ('draft', 'active', 'paused');
create index if not exists listings_household_status_idx
  on public.listings (household_id, status);

-- ---------------------------------------------------------------------------
-- Offers received on a listing
-- ---------------------------------------------------------------------------
create table if not exists public.offers (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  listing_id uuid not null,
  amount numeric(12,2) not null check (amount >= 0),
  buyer_handle text,
  source text not null default 'manual' check (source in ('manual', 'email', 'api', 'agent')),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'countered', 'expired', 'withdrawn')),
  counter_amount numeric(12,2) check (counter_amount is null or counter_amount >= 0),
  received_at timestamptz not null default now(),
  expires_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offers_listing_fk foreign key (listing_id, household_id)
    references public.listings (id, household_id) on delete cascade
);

create index if not exists offers_household_status_idx
  on public.offers (household_id, status, received_at desc);

-- ---------------------------------------------------------------------------
-- Sales: the realized outcome for an item (one per item)
-- ---------------------------------------------------------------------------
create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null,
  listing_id uuid references public.listings(id) on delete set null,
  platform text not null,
  sale_price numeric(12,2) not null check (sale_price >= 0),
  shipping_charged numeric(12,2) not null default 0 check (shipping_charged >= 0),
  platform_fees numeric(12,2) not null default 0 check (platform_fees >= 0),
  shipping_cost numeric(12,2) not null default 0 check (shipping_cost >= 0),
  other_costs numeric(12,2) not null default 0 check (other_costs >= 0),
  sold_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint sales_one_per_item unique (item_id),
  constraint sales_item_fk foreign key (item_id, household_id)
    references public.inventory_items (id, household_id) on delete cascade
);

create index if not exists sales_household_sold_idx on public.sales (household_id, sold_at desc);

-- ---------------------------------------------------------------------------
-- Approval queue: anything an agent wants to do that affects the outside world
-- ---------------------------------------------------------------------------
create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  kind text not null
    check (kind in ('offer_decision', 'price_change', 'listing_draft', 'relist', 'delist', 'message_reply', 'other')),
  title text not null check (char_length(trim(title)) between 1 and 300),
  detail text,
  payload jsonb not null default '{}'::jsonb,
  item_id uuid references public.inventory_items(id) on delete cascade,
  listing_id uuid references public.listings(id) on delete cascade,
  offer_id uuid references public.offers(id) on delete cascade,
  requested_by text not null default 'human',
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'done', 'failed', 'cancelled')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_tasks_household_status_idx
  on public.agent_tasks (household_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Append-only activity log (humans and agents)
-- ---------------------------------------------------------------------------
create table if not exists public.activity_log (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  actor_user uuid references auth.users(id) on delete set null,
  actor_agent text,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activity_log_household_created_idx
  on public.activity_log (household_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers (set_updated_at defined in initial schema)
-- ---------------------------------------------------------------------------
drop trigger if exists listings_set_updated_at on public.listings;
create trigger listings_set_updated_at before update on public.listings
  for each row execute function public.set_updated_at();
drop trigger if exists offers_set_updated_at on public.offers;
create trigger offers_set_updated_at before update on public.offers
  for each row execute function public.set_updated_at();
drop trigger if exists agent_tasks_set_updated_at on public.agent_tasks;
create trigger agent_tasks_set_updated_at before update on public.agent_tasks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.listings enable row level security;
alter table public.offers enable row level security;
alter table public.sales enable row level security;
alter table public.agent_tasks enable row level security;
alter table public.activity_log enable row level security;

-- listings
drop policy if exists "Members read listings" on public.listings;
create policy "Members read listings" on public.listings for select to authenticated
  using (public.is_household_member(household_id));
drop policy if exists "Members add listings" on public.listings;
create policy "Members add listings" on public.listings for insert to authenticated
  with check (created_by = auth.uid() and public.is_household_member(household_id));
drop policy if exists "Members update listings" on public.listings;
create policy "Members update listings" on public.listings for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));
drop policy if exists "Admins delete listings" on public.listings;
create policy "Admins delete listings" on public.listings for delete to authenticated
  using (public.is_household_admin(household_id));

-- offers
drop policy if exists "Members read offers" on public.offers;
create policy "Members read offers" on public.offers for select to authenticated
  using (public.is_household_member(household_id));
drop policy if exists "Members add offers" on public.offers;
create policy "Members add offers" on public.offers for insert to authenticated
  with check (public.is_household_member(household_id));
drop policy if exists "Members update offers" on public.offers;
create policy "Members update offers" on public.offers for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));
drop policy if exists "Admins delete offers" on public.offers;
create policy "Admins delete offers" on public.offers for delete to authenticated
  using (public.is_household_admin(household_id));

-- sales
drop policy if exists "Members read sales" on public.sales;
create policy "Members read sales" on public.sales for select to authenticated
  using (public.is_household_member(household_id));
drop policy if exists "Members add sales" on public.sales;
create policy "Members add sales" on public.sales for insert to authenticated
  with check (created_by = auth.uid() and public.is_household_member(household_id));
drop policy if exists "Members update sales" on public.sales;
create policy "Members update sales" on public.sales for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));
drop policy if exists "Admins delete sales" on public.sales;
create policy "Admins delete sales" on public.sales for delete to authenticated
  using (public.is_household_admin(household_id));

-- agent_tasks
drop policy if exists "Members read agent tasks" on public.agent_tasks;
create policy "Members read agent tasks" on public.agent_tasks for select to authenticated
  using (public.is_household_member(household_id));
drop policy if exists "Members add agent tasks" on public.agent_tasks;
create policy "Members add agent tasks" on public.agent_tasks for insert to authenticated
  with check (public.is_household_member(household_id));
drop policy if exists "Members update agent tasks" on public.agent_tasks;
create policy "Members update agent tasks" on public.agent_tasks for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

-- activity_log: insert + read only; no updates or deletes from clients
drop policy if exists "Members read activity" on public.activity_log;
create policy "Members read activity" on public.activity_log for select to authenticated
  using (public.is_household_member(household_id));
drop policy if exists "Members write activity" on public.activity_log;
create policy "Members write activity" on public.activity_log for insert to authenticated
  with check (
    public.is_household_member(household_id)
    and (actor_user is null or actor_user = auth.uid())
  );

grant select, insert, update, delete on public.listings, public.offers, public.sales to authenticated;
grant select, insert, update on public.agent_tasks to authenticated;
grant select, insert on public.activity_log to authenticated;

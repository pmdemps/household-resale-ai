-- Household Resale AI: initial private inventory schema
-- Apply through Supabase SQL Editor or Supabase CLI migrations.
create extension if not exists pgcrypto;

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 200),
  category text not null default 'Other',
  source text not null default '',
  source_url text,
  purchase_date date,
  purchase_cost numeric(12,2) not null default 0 check (purchase_cost >= 0),
  target_price numeric(12,2) not null default 0 check (target_price >= 0),
  status text not null default 'draft'
    check (status in ('researching', 'draft', 'listed', 'pending_sale', 'sold', 'returned', 'donated', 'discarded')),
  condition text,
  notes text,
  sold_price numeric(12,2) check (sold_price is null or sold_price >= 0),
  sold_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists inventory_items_user_created_idx
  on public.inventory_items (user_id, created_at desc);
create index if not exists inventory_items_user_status_idx
  on public.inventory_items (user_id, status);

alter table public.inventory_items enable row level security;

drop policy if exists "Users can view their own inventory" on public.inventory_items;
create policy "Users can view their own inventory"
  on public.inventory_items for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can add their own inventory" on public.inventory_items;
create policy "Users can add their own inventory"
  on public.inventory_items for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own inventory" on public.inventory_items;
create policy "Users can update their own inventory"
  on public.inventory_items for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own inventory" on public.inventory_items;
create policy "Users can delete their own inventory"
  on public.inventory_items for delete to authenticated
  using (auth.uid() = user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists inventory_items_set_updated_at on public.inventory_items;
create trigger inventory_items_set_updated_at
  before update on public.inventory_items
  for each row execute function public.set_updated_at();

-- Keep API exposure limited to authenticated users and rely on RLS for row ownership.
grant select, insert, update, delete on public.inventory_items to authenticated;

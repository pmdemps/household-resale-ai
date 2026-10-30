-- Household Resale AI: shared household inventory schema
-- Apply through Supabase SQL Editor or Supabase CLI migrations.
create extension if not exists pgcrypto;

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 120),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create index if not exists household_members_user_idx
  on public.household_members (user_id, household_id);

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
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

create index if not exists inventory_items_household_created_idx
  on public.inventory_items (household_id, created_at desc);
create index if not exists inventory_items_household_status_idx
  on public.inventory_items (household_id, status);

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.inventory_items enable row level security;

drop policy if exists "Household members can view their households" on public.households;
create policy "Household members can view their households"
  on public.households for select to authenticated
  using (
    exists (
      select 1 from public.household_members hm
      where hm.household_id = households.id and hm.user_id = auth.uid()
    )
  );

drop policy if exists "Users can view their own memberships" on public.household_members;
create policy "Users can view their own memberships"
  on public.household_members for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "Household members can view inventory" on public.inventory_items;
create policy "Household members can view inventory"
  on public.inventory_items for select to authenticated
  using (
    exists (
      select 1 from public.household_members hm
      where hm.household_id = inventory_items.household_id
        and hm.user_id = auth.uid()
    )
  );

drop policy if exists "Household members can add inventory" on public.inventory_items;
create policy "Household members can add inventory"
  on public.inventory_items for insert to authenticated
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.household_members hm
      where hm.household_id = inventory_items.household_id
        and hm.user_id = auth.uid()
    )
  );

drop policy if exists "Household members can update inventory" on public.inventory_items;
create policy "Household members can update inventory"
  on public.inventory_items for update to authenticated
  using (
    exists (
      select 1 from public.household_members hm
      where hm.household_id = inventory_items.household_id
        and hm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.household_members hm
      where hm.household_id = inventory_items.household_id
        and hm.user_id = auth.uid()
    )
  );

drop policy if exists "Household admins can delete inventory" on public.inventory_items;
create policy "Household admins can delete inventory"
  on public.inventory_items for delete to authenticated
  using (
    exists (
      select 1 from public.household_members hm
      where hm.household_id = inventory_items.household_id
        and hm.user_id = auth.uid()
        and hm.role = 'admin'
    )
  );

create or replace function public.create_household(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_household_id uuid;
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'You must be signed in to create a household';
  end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 120 then
    raise exception 'Household name must be between 1 and 120 characters';
  end if;

  insert into public.households (name, created_by)
  values (trim(p_name), current_user_id)
  returning id into new_household_id;

  insert into public.household_members (household_id, user_id, role)
  values (new_household_id, current_user_id, 'admin');

  return new_household_id;
end;
$$;

create or replace function public.add_household_member(
  p_household_id uuid,
  p_user_id uuid,
  p_role text default 'member'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to add a household member';
  end if;
  if p_role not in ('admin', 'member') then
    raise exception 'Role must be admin or member';
  end if;
  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id
      and hm.user_id = auth.uid()
      and hm.role = 'admin'
  ) then
    raise exception 'Only household admins can add members';
  end if;

  insert into public.household_members (household_id, user_id, role)
  values (p_household_id, p_user_id, p_role)
  on conflict (household_id, user_id) do update set role = excluded.role;
end;
$$;

revoke all on function public.create_household(text) from public;
revoke all on function public.add_household_member(uuid, uuid, text) from public;
grant execute on function public.create_household(text) to authenticated;
grant execute on function public.add_household_member(uuid, uuid, text) to authenticated;

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

grant select on public.households, public.household_members to authenticated;
grant select, insert, update, delete on public.inventory_items to authenticated;

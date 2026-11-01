-- Platform toggles: which marketplaces we WANT each item on, separate from where it actually is.
--
-- A member flips a switch on the item page. The app then closes the gap:
--   eBay (connected)   posts or ends the listing right away (human-triggered, so no to-do)
--   everything else    writes an agent_tasks to-do: 'listing_draft' ("Post it on Mercari") when switched on
--                      with nothing live, 'delist' ("Pull it off Poshmark") when switched off with a live listing.
-- Agents reconcile the same way: read item_platform_gaps, never touch the sites themselves (AGENTS.md).

create table if not exists public.item_platform_wants (
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null,
  platform text not null check (char_length(platform) between 1 and 40),
  wanted boolean not null default true,
  set_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (item_id, platform),
  constraint item_platform_wants_item_fk foreign key (item_id, household_id)
    references public.inventory_items (id, household_id) on delete cascade
);

comment on table public.item_platform_wants is
  'Per item, per marketplace: do we want it listed there (wanted=true) or not. Compare with listings to find the gaps.';

alter table public.item_platform_wants enable row level security;

drop policy if exists "Members read platform wants" on public.item_platform_wants;
create policy "Members read platform wants" on public.item_platform_wants for select to authenticated
  using (public.is_household_member(household_id));
drop policy if exists "Members set platform wants" on public.item_platform_wants;
create policy "Members set platform wants" on public.item_platform_wants for insert to authenticated
  with check (public.is_household_member(household_id));
drop policy if exists "Members change platform wants" on public.item_platform_wants;
create policy "Members change platform wants" on public.item_platform_wants for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));
drop policy if exists "Members clear platform wants" on public.item_platform_wants;
create policy "Members clear platform wants" on public.item_platform_wants for delete to authenticated
  using (public.is_household_member(household_id));

grant select, insert, update, delete on public.item_platform_wants to authenticated;

-- The gaps: wanted but not live, or live but not wanted. Runs with the caller's RLS (security_invoker),
-- so members and agents each see their own household only. Items already sold are not gaps.
create or replace view public.item_platform_gaps
with (security_invoker = true)
as
select w.household_id,
       w.item_id,
       i.name as item_name,
       w.platform,
       w.wanted,
       l.id as listing_id,
       l.status as listing_status,
       case when w.wanted then 'needs_listing' else 'needs_delisting' end as gap
  from public.item_platform_wants w
  join public.inventory_items i on i.id = w.item_id
  left join public.listings l
         on l.item_id = w.item_id and l.platform = w.platform and l.status in ('draft', 'active', 'paused')
 where i.status <> 'sold'
   and ((w.wanted and l.id is null) or (not w.wanted and l.id is not null));

grant select on public.item_platform_gaps to authenticated;

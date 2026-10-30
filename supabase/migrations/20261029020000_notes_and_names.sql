-- Household Resale AI: shared notes/comments and member display names.
-- Depends on 20261029010000_listings_offers_sales.sql.

-- ---------------------------------------------------------------------------
-- Display names (shown on notes, activity). Each member can set only their own.
-- ---------------------------------------------------------------------------
alter table public.household_members
  add column if not exists display_name text
    check (display_name is null or char_length(trim(display_name)) between 1 and 40);

drop policy if exists "Members update own display name" on public.household_members;
create policy "Members update own display name"
  on public.household_members for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Column-level grant: members can change display_name only, never role or household.
revoke update on public.household_members from authenticated;
grant update (display_name) on public.household_members to authenticated;

-- ---------------------------------------------------------------------------
-- Notes: a shared household board, optionally attached to an item (= item comments).
-- Private to the household. Never synced to any marketplace.
-- ---------------------------------------------------------------------------
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid,
  author uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 4000),
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notes_item_fk foreign key (item_id, household_id)
    references public.inventory_items (id, household_id) on delete cascade
);

create index if not exists notes_household_created_idx on public.notes (household_id, pinned desc, created_at desc);
create index if not exists notes_item_idx on public.notes (item_id, created_at) where item_id is not null;

drop trigger if exists notes_set_updated_at on public.notes;
create trigger notes_set_updated_at before update on public.notes
  for each row execute function public.set_updated_at();

alter table public.notes enable row level security;

drop policy if exists "Members read notes" on public.notes;
create policy "Members read notes" on public.notes for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "Members add notes" on public.notes;
create policy "Members add notes" on public.notes for insert to authenticated
  with check (author = auth.uid() and public.is_household_member(household_id));

-- Any member can pin/unpin; only the author can change the text (enforced by trigger below).
drop policy if exists "Members update notes" on public.notes;
create policy "Members update notes" on public.notes for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

drop policy if exists "Authors or admins delete notes" on public.notes;
create policy "Authors or admins delete notes" on public.notes for delete to authenticated
  using (author = auth.uid() or public.is_household_admin(household_id));

create or replace function public.notes_guard_update()
returns trigger
language plpgsql
as $$
begin
  if new.author is distinct from old.author
     or new.household_id is distinct from old.household_id
     or new.item_id is distinct from old.item_id then
    raise exception 'Notes cannot be moved or reassigned';
  end if;
  if new.body is distinct from old.body and old.author is distinct from auth.uid() then
    raise exception 'Only the author can edit a note';
  end if;
  return new;
end;
$$;

drop trigger if exists notes_guard_update on public.notes;
create trigger notes_guard_update before update on public.notes
  for each row execute function public.notes_guard_update();

grant select, insert, update, delete on public.notes to authenticated;

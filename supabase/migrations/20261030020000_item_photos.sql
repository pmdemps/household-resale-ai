-- Household Resale AI: photos attached to inventory items.
-- Depends on 20261029010000_listings_offers_sales.sql (is_household_member, inventory_items(id, household_id) key).
--
-- Files live in the Supabase Storage bucket `item-photos`. The bucket is PUBLIC on purpose:
-- marketplaces (eBay, Etsy) fetch listing images by plain HTTPS URL, so every photo has to be
-- publicly readable. Object paths are unguessable: <household_id>/<item_id>/<random uuid>.<ext>.
-- Writing to the bucket, and listing what is in it, is limited to members of the household named by
-- the first path segment. The browser uploads straight into the bucket with the member's JWT
-- (components/photo-uploader.tsx) and then records the row via a server action.

-- ---------------------------------------------------------------------------
-- Table: one row per photo, ordered by position (0 = cover photo)
-- ---------------------------------------------------------------------------
create table if not exists public.item_photos (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null,
  storage_path text not null unique check (char_length(storage_path) between 1 and 1000),
  position int not null default 0 check (position >= 0),
  width int check (width is null or width > 0),
  height int check (height is null or height > 0),
  bytes int check (bytes is null or bytes >= 0),
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint item_photos_item_fk foreign key (item_id, household_id)
    references public.inventory_items (id, household_id) on delete cascade
);

comment on table public.item_photos is
  'Photos of an inventory item. storage_path is the object key in the public item-photos bucket; position 0 is the cover photo.';

create index if not exists item_photos_item_position_idx on public.item_photos (item_id, position, created_at);
create index if not exists item_photos_household_cover_idx on public.item_photos (household_id, item_id) where position = 0;

alter table public.item_photos enable row level security;

drop policy if exists "Members read item photos" on public.item_photos;
create policy "Members read item photos" on public.item_photos for select to authenticated
  using (public.is_household_member(household_id));
drop policy if exists "Members add item photos" on public.item_photos;
create policy "Members add item photos" on public.item_photos for insert to authenticated
  with check (created_by = auth.uid() and public.is_household_member(household_id));
drop policy if exists "Members update item photos" on public.item_photos;
create policy "Members update item photos" on public.item_photos for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));
drop policy if exists "Members delete item photos" on public.item_photos;
create policy "Members delete item photos" on public.item_photos for delete to authenticated
  using (public.is_household_member(household_id));

grant select, insert, update, delete on public.item_photos to authenticated;

-- ---------------------------------------------------------------------------
-- Storage bucket (public read) and object policies
-- ---------------------------------------------------------------------------
-- No HEIC: the browser converts it to JPEG before uploading (lib/photo-client.ts); marketplaces can't show HEIC anyway.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-photos', 'item-photos', true, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- True when the current user belongs to the household named by the first folder of an object path.
-- Non-UUID first segments are simply "no", never a cast error.
create or replace function public.is_item_photo_path_member(p_name text)
returns boolean
language sql
stable
set search_path = public
as $$
  select case
    when (storage.foldername(p_name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.is_household_member(((storage.foldername(p_name))[1])::uuid)
    else false
  end;
$$;

revoke all on function public.is_item_photo_path_member(text) from public;
grant execute on function public.is_item_photo_path_member(text) to authenticated;

-- Reading the FILES needs no policy: the bucket is public, so /storage/v1/object/public/... serves them
-- without consulting storage.objects RLS. A select policy only governs the list/metadata API, and a
-- select policy open to anon would let anyone holding the publishable key enumerate every household's
-- object paths. So listing is for signed-in members of the household in the first path segment only.
drop policy if exists "Anyone can view item photos" on storage.objects;
drop policy if exists "Members view item photos" on storage.objects;
create policy "Members view item photos" on storage.objects for select to authenticated
  using (bucket_id = 'item-photos' and public.is_item_photo_path_member(name));
drop policy if exists "Members upload item photos" on storage.objects;
create policy "Members upload item photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'item-photos' and public.is_item_photo_path_member(name));
drop policy if exists "Members update item photos" on storage.objects;
create policy "Members update item photos" on storage.objects for update to authenticated
  using (bucket_id = 'item-photos' and public.is_item_photo_path_member(name))
  with check (bucket_id = 'item-photos' and public.is_item_photo_path_member(name));
drop policy if exists "Members delete item photos" on storage.objects;
create policy "Members delete item photos" on storage.objects for delete to authenticated
  using (bucket_id = 'item-photos' and public.is_item_photo_path_member(name));

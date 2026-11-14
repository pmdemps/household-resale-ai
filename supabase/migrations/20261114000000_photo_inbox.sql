-- Photo inbox: lets an agent that can only run SQL (Claude through the Supabase connector) attach photos a
-- member sent it in chat. Such an agent can't reach Storage or the app over HTTP, so it puts the photo's bytes
-- (base64) in photo_inbox with photo_inbox_add; the insert pokes /api/photos/inbox through pg_net, the same
-- way push_poke pokes /api/push/dispatch. The route claims the rows with the household's dispatch token,
-- re-encodes each photo exactly like assistant photos (upright, max 2000 px, JPEG, no metadata), uploads it
-- with the service role under <household_id>/<item_id>/<uuid>.jpg, and photo_inbox_done writes the
-- item_photos row and removes the inbox row.
--
-- Nobody reaches photo_inbox through the API: no policies, no grants. photo_inbox_add is for the database
-- owner and the service role only. The claim/done functions check the dispatch token like push_claim does.

create table if not exists public.photo_inbox (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id) on delete cascade,
  added_by uuid not null references auth.users(id) on delete cascade,
  added_by_agent text not null check (char_length(added_by_agent) between 1 and 40),
  photo_base64 text not null check (char_length(photo_base64) between 16 and 14000000),  -- about 10 MB of bytes
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  attempts integer not null default 0,
  last_error text
);
create index if not exists photo_inbox_household_idx on public.photo_inbox (household_id, created_at);

alter table public.photo_inbox enable row level security;
revoke all on table public.photo_inbox from public, anon, authenticated;

-- Queue one photo for an item. p_added_by must be a member of the item's household (the member who sent it).
create or replace function public.photo_inbox_add(p_item_id uuid, p_photo_base64 text, p_added_by uuid, p_agent text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid;
  v_waiting integer;
  v_photos integer;
  v_id uuid;
  v_b64 text := regexp_replace(coalesce(p_photo_base64, ''), '\s', '', 'g');
begin
  select i.household_id into v_household from public.inventory_items i where i.id = p_item_id;
  if v_household is null then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.household_members hm where hm.household_id = v_household and hm.user_id = p_added_by) then
    raise exception 'That person isn''t in this item''s household' using errcode = '42501';
  end if;
  if v_b64 !~ '^[A-Za-z0-9+/]+={0,2}$' then
    raise exception 'The photo must be plain base64 (no data: prefix)' using errcode = '22023';
  end if;
  select count(*) into v_photos from public.item_photos where item_id = p_item_id;
  select count(*) into v_waiting from public.photo_inbox where item_id = p_item_id;
  if v_photos + v_waiting >= 12 then
    raise exception 'That item already has 12 photos, the most it can have.' using errcode = '22023';
  end if;

  insert into public.photo_inbox (household_id, item_id, added_by, added_by_agent, photo_base64)
  values (v_household, p_item_id, p_added_by, left(trim(coalesce(nullif(p_agent, ''), 'agent')), 40), v_b64)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.photo_inbox_add(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.photo_inbox_add(uuid, text, uuid, text) to service_role;

-- Poke the app after an insert.
create or replace function public.photo_inbox_poke()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_origin text;
  v_token text;
begin
  -- One request per photo. Extra requests are harmless: rows are claimed with skip locked, so each photo is
  -- handled once.
  select c.app_origin, c.dispatch_token into v_origin, v_token
    from public.push_config c
   where c.household_id = new.household_id;
  if v_origin is null then
    return null;
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    return null;
  end if;

  begin
    perform net.http_post(
      url := v_origin || '/api/photos/inbox',
      body := jsonb_build_object('household_id', new.household_id, 'token', v_token),
      headers := jsonb_build_object('Content-Type', 'application/json'),
      timeout_milliseconds := 30000
    );
  exception when others then
    raise warning 'photo_inbox_poke: could not queue the request: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function public.photo_inbox_poke() from public, anon, authenticated;

drop trigger if exists photo_inbox_poke on public.photo_inbox;
create trigger photo_inbox_poke after insert on public.photo_inbox
  for each row execute function public.photo_inbox_poke();

-- Claim up to 6 waiting photos (and ones claimed over 5 minutes ago that never finished, at most 3 tries).
create or replace function public.photo_inbox_claim(p_household_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_items jsonb;
begin
  perform public.push_check_token(p_household_id, p_token);

  with picked as (
    select p.id from public.photo_inbox p
     where p.household_id = p_household_id
       and p.attempts < 3
       and (p.claimed_at is null or p.claimed_at < now() - interval '5 minutes')
     order by p.created_at, p.id
     limit 6
     for update skip locked
  ), claimed as (
    update public.photo_inbox p
       set claimed_at = now(), attempts = p.attempts + 1
      from picked
     where p.id = picked.id
    returning p.id, p.item_id, p.photo_base64, p.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('inbox_id', id, 'item_id', item_id, 'photo_base64', photo_base64) order by created_at, id), '[]'::jsonb)
    into v_items
    from claimed;

  return jsonb_build_object('items', v_items);
end;
$$;
revoke all on function public.photo_inbox_claim(uuid, text) from public;
grant execute on function public.photo_inbox_claim(uuid, text) to anon, authenticated;

-- Finish one claimed photo: with a storage path, record it on the item and drop the inbox row; with an error,
-- keep the row (it is retried until 3 tries) and remember why.
create or replace function public.photo_inbox_done(
  p_household_id uuid,
  p_token text,
  p_inbox_id uuid,
  p_storage_path text default null,
  p_width integer default null,
  p_height integer default null,
  p_bytes integer default null,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.photo_inbox;
  v_pos integer;
  v_count integer;
  v_id uuid;
begin
  perform public.push_check_token(p_household_id, p_token);
  select * into r from public.photo_inbox where id = p_inbox_id and household_id = p_household_id for update;
  if not found or r.claimed_at is null then
    raise exception 'Inbox photo not found' using errcode = 'P0002';
  end if;

  if p_storage_path is null then
    update public.photo_inbox set last_error = left(coalesce(p_error, 'unknown error'), 500) where id = r.id;
    return jsonb_build_object('ok', false);
  end if;

  if p_storage_path !~ ('^' || r.household_id::text || '/' || r.item_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$') then
    raise exception 'That photo path doesn''t belong to this item.' using errcode = '22023';
  end if;

  perform 1 from public.inventory_items where id = r.item_id for update;
  select count(*), coalesce(max(position) + 1, 0) into v_count, v_pos from public.item_photos where item_id = r.item_id;
  if v_count >= 12 then
    raise exception 'That item already has 12 photos, the most it can have.' using errcode = '22023';
  end if;

  insert into public.item_photos (household_id, item_id, storage_path, position, width, height, bytes, created_by)
  values (r.household_id, r.item_id, p_storage_path, v_pos,
          case when p_width > 0 then p_width end, case when p_height > 0 then p_height end,
          case when p_bytes >= 0 then p_bytes end, r.added_by)
  returning id into v_id;

  insert into public.activity_log (household_id, actor_user, actor_agent, action, entity_type, entity_id, detail)
  values (r.household_id, r.added_by, r.added_by_agent, 'photo_added', 'item', r.item_id,
          jsonb_build_object('count', 1, 'photo_id', v_id, 'bytes', p_bytes, 'width', p_width, 'height', p_height, 'via', 'photo_inbox'));

  delete from public.photo_inbox where id = r.id;
  return jsonb_build_object('ok', true, 'photo_id', v_id, 'item_id', r.item_id, 'position', v_pos);
end;
$$;
revoke all on function public.photo_inbox_done(uuid, text, uuid, text, integer, integer, integer, text) from public;
grant execute on function public.photo_inbox_done(uuid, text, uuid, text, integer, integer, integer, text) to anon, authenticated;

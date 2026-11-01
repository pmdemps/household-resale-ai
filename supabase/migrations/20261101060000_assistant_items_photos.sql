-- Assistant (Muse, ChatGPT) can add an item and attach photos to it, so a member can text their assistant
-- photos and a description instead of opening the app.
--
-- Photos: the server (app/api/assistant) downloads the image from the assistant's temporary link (or takes
-- the uploaded file), checks the bytes, and uploads it to the item-photos bucket with the service role
-- under <household_id>/<item_id>/<uuid>.<ext>. These functions do the key check, the household and limit
-- checks, and the item_photos row; the server never decides which household a photo belongs to.
-- Same model as 20261031000000_assistant_access.sql. All VOLATILE: the key check writes last_used_at
-- (see 20261101050000_assistant_lookups_volatile.sql).

-- Add an item for the member. The same name added by the same assistant within 10 minutes returns the
-- existing item (duplicate = true) instead of a second copy, so a retried request is harmless.
create or replace function public.assistant_add_item(
  p_key text,
  p_name text,
  p_category text default 'Other',
  p_brand text default null,
  p_size text default null,
  p_condition text default null,
  p_asking numeric default 0,
  p_floor numeric default null,
  p_cost numeric default 0,
  p_notes text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  k record;
  v_name text := left(trim(coalesce(p_name, '')), 200);
  v_id uuid;
begin
  select * into k from public.assistant_resolve_key(p_key);
  if char_length(v_name) = 0 then
    raise exception 'An item needs a name.' using errcode = '22023';
  end if;
  if coalesce(p_asking, 0) < 0 or coalesce(p_cost, 0) < 0 or coalesce(p_floor, 0) < 0 then
    raise exception 'Prices can''t be negative.' using errcode = '22023';
  end if;
  if p_floor is not null and coalesce(p_asking, 0) > 0 and p_floor > p_asking then
    raise exception 'The floor price is above the asking price.' using errcode = '22023';
  end if;

  select a.entity_id into v_id
    from public.activity_log a
    join public.inventory_items i on i.id = a.entity_id
   where a.household_id = k.household_id and a.action = 'item_added' and a.actor_agent = k.label
     and a.created_at > now() - interval '10 minutes' and lower(i.name) = lower(v_name)
   order by a.created_at desc
   limit 1;
  if v_id is not null then
    return jsonb_build_object('item_id', v_id, 'name', v_name, 'duplicate', true);
  end if;

  insert into public.inventory_items (household_id, created_by, name, category, brand, size, condition, target_price, floor_price, purchase_cost, notes, status, source)
  values (k.household_id, k.user_id, v_name, left(coalesce(nullif(trim(p_category), ''), 'Other'), 60),
          nullif(left(trim(coalesce(p_brand, '')), 120), ''), nullif(left(trim(coalesce(p_size, '')), 60), ''),
          nullif(left(trim(coalesce(p_condition, '')), 60), ''), coalesce(p_asking, 0), p_floor, coalesce(p_cost, 0),
          nullif(left(trim(coalesce(p_notes, '')), 4000), ''), 'draft', 'assistant')
  returning id into v_id;

  insert into public.activity_log (household_id, actor_user, actor_agent, action, entity_type, entity_id, detail)
  values (k.household_id, k.user_id, k.label, 'item_added', 'item', v_id, jsonb_build_object('via', 'assistant'));

  return jsonb_build_object('item_id', v_id, 'name', v_name, 'duplicate', false);
end;
$$;
revoke all on function public.assistant_add_item(text, text, text, text, text, text, numeric, numeric, numeric, text) from public;
grant execute on function public.assistant_add_item(text, text, text, text, text, text, numeric, numeric, numeric, text) to anon, authenticated;

-- Before uploading: is the key good, is the item theirs, is there room for another photo? Returns the
-- household id the server must put the file under.
create or replace function public.assistant_photo_slot(p_key text, p_item_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  k record;
  v_count integer;
begin
  select * into k from public.assistant_resolve_key(p_key);
  if not exists (select 1 from public.inventory_items i where i.id = p_item_id and i.household_id = k.household_id) then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;
  select count(*) into v_count from public.item_photos where item_id = p_item_id;
  if v_count >= 12 then
    raise exception 'That item already has 12 photos, the most it can have.' using errcode = '22023';
  end if;
  return jsonb_build_object('household_id', k.household_id, 'item_id', p_item_id, 'count', v_count);
end;
$$;
revoke all on function public.assistant_photo_slot(text, uuid) from public;
grant execute on function public.assistant_photo_slot(text, uuid) to anon, authenticated;

-- After uploading: record the photo row. The path must be exactly this household's folder for this item.
create or replace function public.assistant_record_photo(
  p_key text,
  p_item_id uuid,
  p_storage_path text,
  p_width integer default null,
  p_height integer default null,
  p_bytes integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  k record;
  v_pos integer;
  v_count integer;
  v_id uuid;
begin
  select * into k from public.assistant_resolve_key(p_key);
  if not exists (select 1 from public.inventory_items i where i.id = p_item_id and i.household_id = k.household_id) then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;
  if p_storage_path is null
     or p_storage_path !~ ('^' || k.household_id::text || '/' || p_item_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$') then
    raise exception 'That photo path doesn''t belong to this item.' using errcode = '22023';
  end if;

  perform 1 from public.inventory_items where id = p_item_id for update;  -- one photo at a time per item
  select count(*), coalesce(max(position) + 1, 0) into v_count, v_pos from public.item_photos where item_id = p_item_id;
  if v_count >= 12 then
    raise exception 'That item already has 12 photos, the most it can have.' using errcode = '22023';
  end if;

  insert into public.item_photos (household_id, item_id, storage_path, position, width, height, bytes, created_by)
  values (k.household_id, p_item_id, p_storage_path, v_pos,
          case when p_width > 0 then p_width end, case when p_height > 0 then p_height end,
          case when p_bytes >= 0 then p_bytes end, k.user_id)
  returning id into v_id;

  insert into public.activity_log (household_id, actor_user, actor_agent, action, entity_type, entity_id, detail)
  values (k.household_id, k.user_id, k.label, 'photo_added', 'item', p_item_id,
          jsonb_build_object('count', 1, 'photo_id', v_id, 'bytes', p_bytes, 'width', p_width, 'height', p_height));

  return jsonb_build_object('photo_id', v_id, 'item_id', p_item_id, 'position', v_pos, 'photo_count', v_count + 1, 'storage_path', p_storage_path);
end;
$$;
revoke all on function public.assistant_record_photo(text, uuid, text, integer, integer, integer) from public;
grant execute on function public.assistant_record_photo(text, uuid, text, integer, integer, integer) to anon, authenticated;

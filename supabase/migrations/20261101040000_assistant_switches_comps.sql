-- Assistant (Muse, ChatGPT) access to today's item features: find an item, see one item in full
-- (switches, live listings, comps, photos), flip a platform switch, and record a comp it found.
-- Same model as 20261031000000_assistant_access.sql: the key is checked inside each function, every
-- write is attributed to the member who owns the key with actor_agent = the key's label.
-- Depends on 20261101020000_item_comps.sql and 20261101030000_platform_wants.sql.
--
-- An assistant flipping a switch never posts or ends anything itself: it records the wish and writes the
-- same "Post it on X" / "Pull it off X" to-do the app writes for platforms without an API. For eBay the
-- to-do says to tap the switch or Post to eBay in the app, which does it through the official API.

-- Find items by name (for "take the Nikes off Poshmark" when the item isn't listed anywhere yet).
create or replace function public.assistant_find_items(p_key text, p_query text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  k record;
  v_q text := nullif(left(trim(coalesce(p_query, '')), 100), '');
begin
  select * into k from public.assistant_resolve_key(p_key);
  return coalesce((
    select jsonb_agg(x order by x->>'updated_at' desc)
      from (
        select jsonb_build_object(
                 'item_id', i.id,
                 'name', i.name,
                 'status', i.status,
                 'category', i.category,
                 'brand', i.brand,
                 'size', i.size,
                 'asking', i.target_price,
                 'owner', (select coalesce(m.display_name, null) from public.household_members m where m.household_id = i.household_id and m.user_id = i.owner_user),
                 'updated_at', i.updated_at
               ) as x
          from public.inventory_items i
         where i.household_id = k.household_id
           and i.status not in ('sold', 'donated', 'discarded')
           and (v_q is null
                or i.name ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%'
                or coalesce(i.brand, '') ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%')
         order by i.updated_at desc
         limit 15
      ) s
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.assistant_find_items(text, text) from public;
grant execute on function public.assistant_find_items(text, text) to anon, authenticated;

-- Everything about one item: details, switches, live listings, pending post/pull to-dos, comps, photos.
create or replace function public.assistant_item(p_key text, p_item_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  k record;
  i record;
begin
  select * into k from public.assistant_resolve_key(p_key);
  select * into i from public.inventory_items where id = p_item_id and household_id = k.household_id;
  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'item', jsonb_build_object(
      'item_id', i.id, 'name', i.name, 'status', i.status, 'category', i.category, 'brand', i.brand,
      'size', i.size, 'condition', i.condition, 'asking', i.target_price, 'floor_price', i.floor_price,
      'purchase_cost', i.purchase_cost,
      'owner', (select m.display_name from public.household_members m where m.household_id = i.household_id and m.user_id = i.owner_user)
    ),
    'switches', coalesce((select jsonb_object_agg(w.platform, w.wanted) from public.item_platform_wants w where w.item_id = i.id), '{}'::jsonb),
    'listings', coalesce((
      select jsonb_agg(jsonb_build_object('listing_id', l.id, 'platform', l.platform, 'status', l.status, 'list_price', l.list_price, 'url', l.listing_url) order by l.created_at)
        from public.listings l where l.item_id = i.id and l.status in ('draft', 'active', 'paused')
    ), '[]'::jsonb),
    'pending_platform_todos', coalesce((
      select jsonb_agg(jsonb_build_object('task_id', t.id, 'kind', t.kind, 'platform', t.payload->>'platform', 'title', t.title))
        from public.agent_tasks t
       where t.item_id = i.id and t.status = 'pending' and t.kind in ('listing_draft', 'delist')
    ), '[]'::jsonb),
    'comps', coalesce((
      select jsonb_agg(jsonb_build_object('platform', c.platform, 'title', c.title, 'price', c.price, 'shipping', c.shipping,
                                          'url', c.url, 'condition', c.condition, 'kind', c.kind, 'source', c.source, 'captured_at', c.captured_at) order by c.price)
        from (select * from public.item_comps c where c.item_id = i.id order by c.price limit 50) c
    ), '[]'::jsonb),
    'photo_paths', coalesce((
      select jsonb_agg(p.storage_path order by p.position) from public.item_photos p where p.item_id = i.id
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.assistant_item(text, uuid) from public;
grant execute on function public.assistant_item(text, uuid) to anon, authenticated;

-- Flip a platform switch for the member. Mirrors setPlatformWant in app/platform-actions.ts for the
-- no-API path: records the wish, cancels the opposite to-do, and writes a post or pull to-do (never twice).
create or replace function public.assistant_set_platform(p_key text, p_item_id uuid, p_platform text, p_wanted boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  k record;
  i record;
  l record;
  v_name text;
  v_now timestamptz := now();
  v_task uuid;
  v_title text;
  v_outcome text;
begin
  select * into k from public.assistant_resolve_key(p_key);
  if p_platform is null or p_platform not in ('ebay', 'vinted', 'etsy', 'facebook', 'poshmark', 'mercari', 'offerup', 'thredup', 'depop') then
    raise exception 'Unknown platform. Use ebay, vinted, etsy, facebook, poshmark, mercari, offerup, thredup or depop.' using errcode = '22023';
  end if;
  if p_wanted is null then
    raise exception 'Say on (true) or off (false).' using errcode = '22023';
  end if;
  select * into i from public.inventory_items where id = p_item_id and household_id = k.household_id for update;
  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;
  if i.status = 'sold' then
    raise exception 'That item already sold.' using errcode = 'P0003';
  end if;
  v_name := public.platform_display_name(p_platform);

  insert into public.item_platform_wants (household_id, item_id, platform, wanted, set_by, updated_at)
  values (k.household_id, i.id, p_platform, p_wanted, k.user_id, v_now)
  on conflict (item_id, platform) do update set wanted = excluded.wanted, set_by = excluded.set_by, updated_at = excluded.updated_at;

  select * into l from public.listings
   where item_id = i.id and platform = p_platform and status in ('draft', 'active', 'paused')
   limit 1;

  if p_wanted then
    update public.agent_tasks set status = 'cancelled', decided_by = k.user_id, decided_at = v_now, detail = 'Switched ' || v_name || ' back on.'
     where item_id = i.id and kind = 'delist' and status = 'pending' and payload->>'platform' = p_platform;
    if l.id is not null then
      v_outcome := 'already_live';
    else
      select id into v_task from public.agent_tasks
       where item_id = i.id and kind = 'listing_draft' and status = 'pending' and payload->>'platform' = p_platform limit 1;
      v_title := 'Post "' || left(i.name, 200) || '" on ' || v_name;
      if v_task is null then
        insert into public.agent_tasks (household_id, kind, title, detail, payload, item_id, requested_by)
        values (k.household_id, 'listing_draft', v_title,
                case when p_platform = 'ebay'
                     then 'Switched on by ' || k.label || '. Open the item and tap Post to eBay (or flip the eBay switch) and the app posts it.'
                     else 'Switched on by ' || k.label || '. The listing text is ready under "Post it ourselves" on the item page. Paste it in, then tap "We posted it".' end,
                jsonb_build_object('platform', p_platform, 'reason', 'switched_on', 'by', k.label), i.id, k.label)
        returning id into v_task;
      end if;
      v_outcome := 'todo_post';
    end if;
  else
    update public.agent_tasks set status = 'cancelled', decided_by = k.user_id, decided_at = v_now, detail = 'Switched ' || v_name || ' off.'
     where item_id = i.id and kind = 'listing_draft' and status = 'pending' and payload->>'platform' = p_platform;
    if l.id is null then
      v_outcome := 'already_off';
    elsif l.status = 'draft' then
      update public.listings set status = 'ended', ended_at = v_now where id = l.id;
      v_outcome := 'dropped_draft';
    else
      select id into v_task from public.agent_tasks
       where item_id = i.id and kind = 'delist' and status = 'pending' and listing_id = l.id limit 1;
      v_title := 'Pull "' || left(i.name, 200) || '" off ' || v_name || ', we turned it off';
      if v_task is null then
        insert into public.agent_tasks (household_id, kind, title, detail, payload, item_id, listing_id, requested_by)
        values (k.household_id, 'delist', v_title,
                case when p_platform = 'ebay'
                     then 'Switched off by ' || k.label || '. Open the item and flip the eBay switch off (or tap End listing) and the app ends it.'
                     else 'Switched off by ' || k.label || '. End the listing in the ' || v_name || ' app, then mark this done.' end,
                jsonb_build_object('platform', p_platform, 'reason', 'switched_off', 'by', k.label), i.id, l.id, k.label)
        returning id into v_task;
      end if;
      v_outcome := 'todo_pull';
    end if;
  end if;

  insert into public.activity_log (household_id, actor_user, actor_agent, action, entity_type, entity_id, detail)
  values (k.household_id, k.user_id, k.label, case when p_wanted then 'platform_on' else 'platform_off' end, 'item', i.id,
          jsonb_build_object('platform', p_platform, 'outcome', v_outcome));

  return jsonb_build_object('item_id', i.id, 'item', i.name, 'platform', p_platform, 'platform_name', v_name,
                            'wanted', p_wanted, 'outcome', v_outcome, 'task_id', v_task, 'task_title', v_title);
end;
$$;
revoke all on function public.assistant_set_platform(text, uuid, text, boolean) from public;
grant execute on function public.assistant_set_platform(text, uuid, text, boolean) to anon, authenticated;

-- Record a comparable listing the assistant found (a web search, a link the member sent). Https links only.
create or replace function public.assistant_add_comp(
  p_key text,
  p_item_id uuid,
  p_platform text,
  p_title text,
  p_price numeric,
  p_shipping numeric default null,
  p_url text default null,
  p_kind text default 'active',
  p_condition text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  k record;
  v_id uuid;
  v_title text := left(trim(coalesce(p_title, '')), 300);
  v_url text := nullif(trim(coalesce(p_url, '')), '');
begin
  select * into k from public.assistant_resolve_key(p_key);
  if not exists (select 1 from public.inventory_items i where i.id = p_item_id and i.household_id = k.household_id) then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;
  if char_length(v_title) = 0 then
    raise exception 'A comp needs a title.' using errcode = '22023';
  end if;
  if p_price is null or p_price < 0 then
    raise exception 'A comp needs a price of zero or more.' using errcode = '22023';
  end if;
  if v_url is not null and v_url !~* '^https://' then
    raise exception 'Links must start with https://' using errcode = '22023';
  end if;

  -- Same link on the same item: update it instead of adding a duplicate.
  if v_url is not null then
    select id into v_id from public.item_comps where item_id = p_item_id and url = v_url limit 1;
  end if;
  if v_id is not null then
    update public.item_comps
       set price = p_price, shipping = p_shipping, title = v_title, kind = case when p_kind = 'sold' then 'sold' else 'active' end, captured_at = now()
     where id = v_id;
  else
    insert into public.item_comps (household_id, item_id, source, platform, title, price, shipping, url, condition, kind, note, created_by, added_by_agent)
    values (k.household_id, p_item_id, 'manual', left(coalesce(nullif(lower(trim(p_platform)), ''), 'other'), 40), v_title, p_price, p_shipping, v_url,
            left(p_condition, 80), case when p_kind = 'sold' then 'sold' else 'active' end, left(p_note, 300), k.user_id, k.label)
    returning id into v_id;
  end if;

  insert into public.activity_log (household_id, actor_user, actor_agent, action, entity_type, entity_id, detail)
  values (k.household_id, k.user_id, k.label, 'comp_added', 'item', p_item_id, jsonb_build_object('comp_id', v_id, 'price', p_price));

  return jsonb_build_object('comp_id', v_id, 'item_id', p_item_id);
end;
$$;
revoke all on function public.assistant_add_comp(text, uuid, text, text, numeric, numeric, text, text, text, text) from public;
grant execute on function public.assistant_add_comp(text, uuid, text, text, numeric, numeric, text, text, text, text) to anon, authenticated;

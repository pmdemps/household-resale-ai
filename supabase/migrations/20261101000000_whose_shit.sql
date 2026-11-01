-- Household Resale AI: "whose shit is it" and "that's Lauren's, go ask her".
-- Depends on 20261031000000_assistant_access.sql and 20261031010000_push_notifications.sql. Idempotent.
--
--   1. inventory_items.owner_user: which household member a thing belongs to (null = ours, shared).
--      Offers on someone's thing still buzz every phone, but say whose it is: "Somebody wants your shit" on the
--      owner's phone, "Somebody wants Lauren's shit" on everyone else's.
--   2. A hand-off: one member (in the app, or through their assistant, or Claude) says "that's Lauren's, go ask
--      her". apply_handoff marks the thing as hers, notes on the offer's to-do who was asked, and buzzes ONLY her
--      phone: "Patrick says this is your shit. How badly do you wanna sell it?" Anyone can still answer the offer.
--   3. The assistant inbox lists the household's members and whose each thing is, so an assistant can say
--      "new offer on Lauren's helmet mount" and hand it to her by name.

-- ---------------------------------------------------------------------------
-- Whose it is
-- ---------------------------------------------------------------------------
alter table public.inventory_items
  add column if not exists owner_user uuid references auth.users(id) on delete set null;

comment on column public.inventory_items.owner_user is
  'The household member this belongs to, or null when it is shared ("ours"). Set from the item page or by a hand-off.';

-- An owner has to be someone in the item's household.
create or replace function public.inventory_items_owner_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.owner_user is not null and not exists (
    select 1 from public.household_members hm
     where hm.household_id = new.household_id and hm.user_id = new.owner_user
  ) then
    raise exception 'That person is not in this household' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.inventory_items_owner_guard() from public, anon, authenticated;

drop trigger if exists inventory_items_owner_guard on public.inventory_items;
create trigger inventory_items_owner_guard before insert or update of owner_user, household_id on public.inventory_items
  for each row execute function public.inventory_items_owner_guard();

-- ---------------------------------------------------------------------------
-- Hand-offs in the push queue: addressed to one member, from another, about one item.
-- ---------------------------------------------------------------------------
alter table public.push_queue add column if not exists item_id uuid references public.inventory_items(id) on delete cascade;
alter table public.push_queue add column if not exists from_user uuid references auth.users(id) on delete set null;
alter table public.push_queue drop constraint if exists push_queue_kind_check;
alter table public.push_queue add constraint push_queue_kind_check check (kind in ('task', 'test', 'handoff'));

-- Same as before, plus: who a hand-off is from and which item it is about, and whose item each to-do is on.
-- Display names come back as null when a member has not set one; the app words around that.
create or replace function public.push_claim(p_household_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.push_config;
  v_items jsonb;
begin
  select * into c from public.push_check_token(p_household_id, p_token);

  -- Housekeeping: the queue only needs to remember the last week.
  delete from public.push_queue where household_id = p_household_id and created_at < now() - interval '7 days';

  with claimed as (
    update public.push_queue q
       set claimed_at = now()
     where q.household_id = p_household_id
       and q.claimed_at is null
       and q.created_at > now() - interval '1 day'
    returning q.id, q.kind, q.task_id, q.target_user, q.item_id, q.from_user
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'queue_id', cl.id,
           'kind', cl.kind,
           'target_user', cl.target_user,
           'from_user', cl.from_user,
           'from_name', (select nullif(trim(hm.display_name), '') from public.household_members hm
                          where hm.household_id = p_household_id and hm.user_id = cl.from_user),
           'item', (select jsonb_build_object('id', i.id, 'name', i.name) from public.inventory_items i
                     where i.id = coalesce(cl.item_id, t.item_id) and i.household_id = p_household_id),
           'task', case when t.id is null then null else jsonb_build_object(
             'id', t.id, 'kind', t.kind, 'status', t.status, 'title', t.title, 'detail', t.detail,
             'item_id', t.item_id, 'offer_id', t.offer_id,
             'owner_id', ti.owner_user,
             'owner_name', (select nullif(trim(hm.display_name), '') from public.household_members hm
                             where hm.household_id = p_household_id and hm.user_id = ti.owner_user)) end
         ) order by cl.id), '[]'::jsonb)
    into v_items
    from claimed cl
    left join public.agent_tasks t on t.id = cl.task_id
    left join public.inventory_items ti on ti.id = t.item_id;

  return jsonb_build_object(
    'items', v_items,
    'pending_count', (select count(*) from public.agent_tasks t where t.household_id = p_household_id and t.status = 'pending'),
    'origin', c.app_origin,
    'vapid_public_key', c.vapid_public_key,
    'vapid_private_key', c.vapid_private_key,
    -- Only devices of people who are still members of the household.
    'subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth, 'user_id', s.user_id) order by s.created_at)
        from public.push_subscriptions s
       where s.household_id = p_household_id
         and exists (select 1 from public.household_members hm where hm.household_id = s.household_id and hm.user_id = s.user_id)
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.push_claim(uuid, text) from public;
grant execute on function public.push_claim(uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Core: hand an item (and optionally one of its pending offers) to another member.
-- Internal: called by handoff_item (the app), assistant_handoff (an assistant) and Claude with the service role.
-- ---------------------------------------------------------------------------
create or replace function public.apply_handoff(
  p_household_id uuid,
  p_actor uuid,
  p_actor_agent text,
  p_to uuid,
  p_offer_id uuid,
  p_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item uuid := p_item_id;
  v_item_name text;
  v_offer_item uuid;
  v_offer_status text;
  v_amount numeric;
  v_platform text;
  v_task uuid;
  v_devices integer;
begin
  if p_household_id is null or p_to is null or not exists (
    select 1 from public.household_members hm where hm.household_id = p_household_id and hm.user_id = p_to
  ) then
    raise exception 'That person is not in this household' using errcode = 'P0002';
  end if;
  if p_actor is not distinct from p_to then
    raise exception 'That''s you. Hand it to the other person instead' using errcode = '22023';
  end if;

  if p_offer_id is not null then
    select l.item_id, o.status, o.amount, l.platform
      into v_offer_item, v_offer_status, v_amount, v_platform
      from public.offers o
      join public.listings l on l.id = o.listing_id
     where o.id = p_offer_id and o.household_id = p_household_id;
    if not found then
      raise exception 'Offer not found' using errcode = 'P0002';
    end if;
    if v_offer_status <> 'pending' then
      raise exception 'That offer was already answered' using errcode = 'P0003';
    end if;
    if v_item is not null and v_item <> v_offer_item then
      raise exception 'That offer is on a different item' using errcode = '22023';
    end if;
    v_item := v_offer_item;
  elsif v_item is null then
    raise exception 'Say which offer or item to hand off' using errcode = '22023';
  end if;

  select i.name into v_item_name from public.inventory_items i where i.id = v_item and i.household_id = p_household_id;
  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;

  -- Remember whose it is, so the next offer on it says so.
  update public.inventory_items set owner_user = p_to where id = v_item and owner_user is distinct from p_to;

  -- Note on the offer's to-do who was asked (the app shows "Asked Lauren"). Anyone can still decide it.
  if p_offer_id is not null then
    select t.id into v_task
      from public.agent_tasks t
     where t.household_id = p_household_id and t.offer_id = p_offer_id
       and t.kind = 'offer_decision' and t.status = 'pending'
     order by t.created_at desc
     limit 1;
    if v_task is not null then
      update public.agent_tasks
         set payload = coalesce(payload, '{}'::jsonb)
                       || jsonb_build_object('asked_user', p_to, 'asked_by', p_actor, 'asked_at', now())
       where id = v_task;
    end if;
  end if;

  -- Buzz only that member's phones (the push_poke trigger asks the app to send it).
  begin
    insert into public.push_queue (household_id, kind, task_id, item_id, target_user, from_user)
    values (p_household_id, 'handoff', v_task, v_item, p_to, p_actor);
  exception when others then
    -- The hand-off itself (owner, "asked") stands even if the buzz cannot be queued.
    raise warning 'apply_handoff: could not queue the notification: %', sqlerrm;
  end;

  select count(*) into v_devices
    from public.push_subscriptions s
   where s.household_id = p_household_id and s.user_id = p_to;

  insert into public.activity_log (household_id, actor_user, actor_agent, action, entity_type, entity_id, detail)
  values (p_household_id, p_actor, p_actor_agent, 'handed_off', 'item', v_item,
          jsonb_build_object('to', p_to, 'offer_id', p_offer_id, 'task_id', v_task));

  return jsonb_build_object(
    'item', jsonb_build_object('id', v_item, 'name', v_item_name),
    'to', jsonb_build_object('id', p_to, 'name', (select nullif(trim(hm.display_name), '') from public.household_members hm
                                                   where hm.household_id = p_household_id and hm.user_id = p_to)),
    'from', jsonb_build_object('id', p_actor, 'name', (select nullif(trim(hm.display_name), '') from public.household_members hm
                                                        where hm.household_id = p_household_id and hm.user_id = p_actor)),
    'offer', case when p_offer_id is null then null else jsonb_build_object(
      'id', p_offer_id, 'amount', v_amount, 'platform', v_platform, 'platform_name', public.platform_display_name(v_platform)) end,
    'task_id', v_task,
    'devices', v_devices
  );
end;
$$;
revoke all on function public.apply_handoff(uuid, uuid, text, uuid, uuid, uuid) from public, anon, authenticated;

-- The app: the signed-in member hands something to another member.
create or replace function public.handoff_item(p_household_id uuid, p_to uuid, p_offer_id uuid default null, p_item_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'You must be signed in' using errcode = '28000';
  end if;
  if p_household_id is null or not public.is_household_member(p_household_id) then
    raise exception 'Household not found' using errcode = 'P0002';
  end if;
  return public.apply_handoff(p_household_id, auth.uid(), null, p_to, p_offer_id, p_item_id);
end;
$$;
revoke all on function public.handoff_item(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.handoff_item(uuid, uuid, uuid, uuid) to authenticated;

-- An assistant: "that's Lauren's, go ask her". p_to is a member's name (case-insensitive; the first name is
-- enough). Left blank, it means the only other member. A name that matches nobody also means the only other
-- member when that member has not set a display name yet (so "Lauren" works before Lauren names herself).
create or replace function public.assistant_handoff(p_key text, p_to text default null, p_offer_id uuid default null, p_item_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  k record;
  v_name text := lower(nullif(trim(coalesce(p_to, '')), ''));
  v_ids uuid[];
  v_to uuid;
begin
  select * into k from public.assistant_resolve_key(p_key);
  if v_name is not null and char_length(v_name) > 40 then
    raise exception 'That name is too long' using errcode = '22023';
  end if;

  if v_name is not null then
    select array_agg(hm.user_id) into v_ids
      from public.household_members hm
     where hm.household_id = k.household_id
       and (lower(trim(hm.display_name)) = v_name or lower(split_part(trim(hm.display_name), ' ', 1)) = v_name);
    if coalesce(cardinality(v_ids), 0) > 1 then
      raise exception 'More than one person here is called %. Use their full name', p_to using errcode = '22023';
    end if;
    v_to := v_ids[1];
  end if;

  if v_to is null then
    select array_agg(hm.user_id) into v_ids
      from public.household_members hm
     where hm.household_id = k.household_id and hm.user_id <> k.user_id
       and (v_name is null or nullif(trim(hm.display_name), '') is null);
    if coalesce(cardinality(v_ids), 0) <> 1 then
      if v_name is null then
        raise exception 'Say who to ask (a household member''s name)' using errcode = '22023';
      end if;
      raise exception 'Nobody called % in this household', p_to using errcode = 'P0002';
    end if;
    v_to := v_ids[1];
  end if;

  return public.apply_handoff(k.household_id, k.user_id, k.label, v_to, p_offer_id, p_item_id);
end;
$$;
revoke all on function public.assistant_handoff(text, text, uuid, uuid) from public;
grant execute on function public.assistant_handoff(text, text, uuid, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Assistant inbox: same as before, plus the household's members, whose each thing is, and who was asked.
-- ---------------------------------------------------------------------------
create or replace function public.assistant_inbox(p_key text, p_mark_seen boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  k record;
  v_now timestamptz := now();
  v_seen timestamptz;
  v_state_key text;
  result jsonb;
begin
  select * into k from public.assistant_resolve_key(p_key);
  v_state_key := 'assistant_seen:' || k.key_id::text;

  select (value->>'last_seen_at')::timestamptz into v_seen
    from public.sync_state
   where household_id = k.household_id and key = v_state_key;
  -- First check ever: anything from the last week counts as new.
  v_seen := coalesce(v_seen, v_now - interval '7 days');

  result := jsonb_build_object(
    'household', (select jsonb_build_object('id', h.id, 'name', h.name) from public.households h where h.id = k.household_id),
    'member', (select jsonb_build_object('id', hm.user_id, 'name', coalesce(nullif(trim(hm.display_name), ''), 'Household member'))
                 from public.household_members hm where hm.household_id = k.household_id and hm.user_id = k.user_id),
    -- Everyone in the household; name is null for someone who has not set one in Settings yet.
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('id', hm.user_id, 'name', nullif(trim(hm.display_name), ''), 'is_you', hm.user_id = k.user_id)
                       order by hm.created_at)
        from public.household_members hm where hm.household_id = k.household_id), '[]'::jsonb),
    'assistant', k.label,
    'checked_at', v_now,
    'new_since', v_seen,
    -- True when the app can carry eBay decisions to eBay itself (an active eBay connection exists).
    'ebay_connected', exists (
      select 1 from public.marketplace_connections mc
       where mc.household_id = k.household_id and mc.platform = 'ebay' and mc.status = 'active' and mc.refresh_token_enc is not null),
    'pending_offers', coalesce((
      select jsonb_agg(jsonb_build_object(
          'offer_id', o.id,
          'amount', o.amount,
          'buyer', o.buyer_handle,
          'received_at', o.received_at,
          'expires_at', o.expires_at,
          'source', o.source,
          'note', o.note,
          'is_new', o.created_at > v_seen,
          'via_api', o.external_id is not null,
          'listing', jsonb_build_object('id', l.id, 'platform', l.platform, 'list_price', l.list_price, 'url', l.listing_url),
          'item', jsonb_build_object('id', i.id, 'name', i.name, 'floor_price', i.floor_price, 'purchase_cost', i.purchase_cost,
                    'owner', case when i.owner_user is null then null else jsonb_build_object(
                      'id', i.owner_user,
                      'name', (select nullif(trim(hm.display_name), '') from public.household_members hm
                                where hm.household_id = k.household_id and hm.user_id = i.owner_user),
                      'is_you', i.owner_user = k.user_id) end),
          'asked', (select jsonb_build_object(
                      'id', t.payload->>'asked_user',
                      'name', (select nullif(trim(hm.display_name), '') from public.household_members hm
                                where hm.household_id = k.household_id and hm.user_id::text = t.payload->>'asked_user'),
                      'at', t.payload->>'asked_at')
                      from public.agent_tasks t
                     where t.household_id = k.household_id and t.offer_id = o.id and t.status = 'pending' and t.payload ? 'asked_user'
                     order by t.created_at desc limit 1)
        ) order by o.received_at desc)
        from public.offers o
        join public.listings l on l.id = o.listing_id
        join public.inventory_items i on i.id = l.item_id
       where o.household_id = k.household_id and o.status = 'pending'), '[]'::jsonb),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
          'task_id', t.id,
          'kind', t.kind,
          'title', t.title,
          'detail', t.detail,
          'created_at', t.created_at,
          'is_new', t.created_at > v_seen,
          'item_id', t.item_id,
          'listing_id', t.listing_id,
          'requested_by', t.requested_by
        ) order by t.created_at desc)
        from public.agent_tasks t
       where t.household_id = k.household_id and t.status = 'pending' and t.kind <> 'offer_decision'), '[]'::jsonb),
    'listings', coalesce((
      select jsonb_agg(jsonb_build_object(
          'listing_id', l.id,
          'item_id', i.id,
          'item', i.name,
          'owner', (select nullif(trim(hm.display_name), '') from public.household_members hm
                     where hm.household_id = k.household_id and hm.user_id = i.owner_user),
          'owner_id', i.owner_user,
          'platform', l.platform,
          'status', l.status,
          'list_price', l.list_price,
          'floor_price', i.floor_price,
          'url', l.listing_url
        ) order by i.name, l.platform)
        from public.listings l
        join public.inventory_items i on i.id = l.item_id
       where l.household_id = k.household_id
         and l.status in ('draft', 'active', 'paused')
         and i.status not in ('sold', 'donated', 'discarded', 'returned')), '[]'::jsonb)
  );

  if coalesce(p_mark_seen, true) then
    insert into public.sync_state (household_id, key, value)
    values (k.household_id, v_state_key, jsonb_build_object('last_seen_at', v_now))
    on conflict (household_id, key) do update set value = excluded.value;
  end if;

  return result;
end;
$$;
revoke all on function public.assistant_inbox(text, boolean) from public;
grant execute on function public.assistant_inbox(text, boolean) to anon, authenticated;

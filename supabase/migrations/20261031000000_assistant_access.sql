-- Household Resale AI: personal-assistant access (Muse, ChatGPT, ...) and a shared SQL core for
-- offer decisions and sales.
-- Depends on 20261030010000_marketplace_connections.sql (sync_state, sha256_hex). Idempotent.
--
-- A household member creates a key in Settings. An assistant holding that key can read what needs a
-- decision ("inbox") and carry the MEMBER's answer back: accept / counter / decline an offer, record an
-- offer it saw in an email, record a sale, leave a note, close a to-do. Everything it does is attributed to
-- the member who owns the key (decided_by / created_by / actor_user) with actor_agent = the key's label,
-- so the activity feed reads "Patrick: Took $30 (muse)". A key never grants more than that member could
-- do in the app, and it cannot go below the floor price unless the member explicitly overrides.
--
-- The HTTP side (app/api/assistant) calls the assistant_* functions with the PUBLISHABLE key, i.e. as
-- anon. They are SECURITY DEFINER: the row-level policies (which need a signed-in user) are replaced by
-- the key check at the top of every function. Rules for this file: static SQL only, every text input
-- capped, every function pinned to search_path = public, internal helpers revoked from anon/authenticated.
--
-- The same core (apply_offer_decision / apply_sale) is used by the app's server actions through the
-- member wrappers (decide_offer / record_sale), so a decision made in the app and one relayed by an
-- assistant do exactly the same thing. Fee amounts are computed by the app (lib/fees.ts) and passed in.

-- ---------------------------------------------------------------------------
-- assistant_keys: one row per key. Only the SHA-256 of the key is stored.
-- ---------------------------------------------------------------------------
create table if not exists public.assistant_keys (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  -- The member this key acts for. A member can only create keys for themself.
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null check (char_length(trim(label)) between 1 and 40),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  -- First characters of the key, so the Settings page can say which key is which.
  key_prefix text not null check (char_length(key_prefix) between 4 and 16),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

comment on table public.assistant_keys is
  'Keys for personal AI assistants (Muse, ChatGPT, ...). Only the SHA-256 hex of the key is stored; the plaintext is shown once at creation.';

create index if not exists assistant_keys_household_idx on public.assistant_keys (household_id, created_at desc);

create or replace function public.assistant_keys_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.household_id is distinct from old.household_id
     or new.user_id is distinct from old.user_id
     or new.key_hash is distinct from old.key_hash
     or new.key_prefix is distinct from old.key_prefix then
    raise exception 'Assistant keys cannot be reassigned';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'A revoked assistant key stays revoked';
  end if;
  return new;
end;
$$;

drop trigger if exists assistant_keys_guard_update on public.assistant_keys;
create trigger assistant_keys_guard_update before update on public.assistant_keys
  for each row execute function public.assistant_keys_guard_update();

alter table public.assistant_keys enable row level security;

drop policy if exists "Members read assistant keys" on public.assistant_keys;
create policy "Members read assistant keys" on public.assistant_keys for select to authenticated
  using (public.is_household_member(household_id));
drop policy if exists "Members create their own assistant keys" on public.assistant_keys;
create policy "Members create their own assistant keys" on public.assistant_keys for insert to authenticated
  with check (user_id = auth.uid() and public.is_household_member(household_id));
-- Any member can revoke any key in the household (shared data, shared responsibility).
drop policy if exists "Members revoke assistant keys" on public.assistant_keys;
create policy "Members revoke assistant keys" on public.assistant_keys for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));
drop policy if exists "Admins delete assistant keys" on public.assistant_keys;
create policy "Admins delete assistant keys" on public.assistant_keys for delete to authenticated
  using (public.is_household_admin(household_id));

-- Column-level grants: the hash is never readable from a client, and only label / revoked_at are writable.
revoke all on public.assistant_keys from public, anon, authenticated;
grant select (id, household_id, user_id, label, key_prefix, created_at, last_used_at, revoked_at) on public.assistant_keys to authenticated;
grant insert (household_id, user_id, label, key_hash, key_prefix) on public.assistant_keys to authenticated;
grant update (label, revoked_at) on public.assistant_keys to authenticated;
grant delete on public.assistant_keys to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers (internal: not executable by anon/authenticated)
-- ---------------------------------------------------------------------------

-- Display name per platform. Keep in sync with lib/platforms.ts.
create or replace function public.platform_display_name(p_platform text)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select case p_platform
    when 'ebay' then 'eBay'
    when 'facebook' then 'Facebook Marketplace'
    when 'other' then 'Other'
    else initcap(p_platform)
  end;
$$;
revoke all on function public.platform_display_name(text) from public, anon, authenticated;

-- Resolve a plaintext key to (key id, household, member, label). Raises 28000 for a bad or revoked key.
create or replace function public.assistant_resolve_key(p_key text)
returns table (key_id uuid, household_id uuid, user_id uuid, label text)
language plpgsql
security definer
set search_path = public
as $$
declare
  k record;
begin
  if p_key is null or char_length(p_key) not between 20 and 200 then
    raise exception 'Invalid assistant key' using errcode = '28000';
  end if;
  select ak.id, ak.household_id, ak.user_id, ak.label
    into k
    from public.assistant_keys ak
   where ak.key_hash = public.sha256_hex(p_key)
     and ak.revoked_at is null;
  if not found then
    raise exception 'Invalid assistant key' using errcode = '28000';
  end if;
  update public.assistant_keys set last_used_at = now() where id = k.id;
  return query select k.id, k.household_id, k.user_id, k.label;
end;
$$;
revoke all on function public.assistant_resolve_key(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Core: record a sale on a listing. Marks the listing and item sold, declines other pending offers on
-- the listing (and cancels their decision tasks), and queues a "delist" task for every other live listing
-- of the item so it cannot be sold twice. Fees are passed in (computed by lib/fees.ts).
-- ---------------------------------------------------------------------------
create or replace function public.apply_sale(
  p_household_id uuid,
  p_actor_user uuid,
  p_actor_agent text,
  p_listing_id uuid,
  p_sale_price numeric,
  p_platform_fees numeric,
  p_shipping_cost numeric,
  p_offer_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_now timestamptz := now();
  v_sale_id uuid;
  v_delist integer := 0;
  v_price numeric := round(coalesce(p_sale_price, -1), 2);
  v_fees numeric := round(greatest(coalesce(p_platform_fees, 0), 0), 2);
  v_ship numeric := round(greatest(coalesce(p_shipping_cost, 0), 0), 2);
begin
  if p_actor_user is null then
    raise exception 'A sale needs a household member to record it' using errcode = '22023';
  end if;
  if v_price < 0 then
    raise exception 'Sale price must be a non-negative number' using errcode = '22023';
  end if;

  select l.id, l.item_id, l.platform, l.status, l.listing_url, l.external_id, i.name as item_name
    into r
    from public.listings l
    join public.inventory_items i on i.id = l.item_id
   where l.id = p_listing_id and l.household_id = p_household_id
   for update of l;
  if not found then
    raise exception 'Listing not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.sales s where s.item_id = r.item_id) then
    raise exception 'This item is already recorded as sold.' using errcode = 'P0003';
  end if;

  insert into public.sales (household_id, item_id, listing_id, platform, sale_price, platform_fees, shipping_cost, sold_at, created_by)
  values (p_household_id, r.item_id, r.id, r.platform, v_price, v_fees, v_ship, v_now, p_actor_user)
  returning id into v_sale_id;

  update public.listings set status = 'sold', ended_at = v_now where id = r.id;
  update public.inventory_items set status = 'sold', sold_price = v_price, sold_at = v_now where id = r.item_id;

  -- Every other pending offer on this item (any listing) is moot now.
  update public.agent_tasks t
     set status = 'cancelled', decided_at = v_now, detail = 'Item sold; this offer was declined automatically.'
   where t.kind = 'offer_decision' and t.status = 'pending'
     and t.offer_id in (select o.id from public.offers o join public.listings l on l.id = o.listing_id where l.item_id = r.item_id)
     and (p_offer_id is null or t.offer_id is distinct from p_offer_id);
  update public.offers o
     set status = 'declined', decided_at = v_now, decided_by = p_actor_user
   where o.status = 'pending'
     and o.listing_id in (select l.id from public.listings l where l.item_id = r.item_id)
     and (p_offer_id is null or o.id <> p_offer_id);

  -- One item, one sale: every other live listing must come down.
  insert into public.agent_tasks (household_id, kind, title, listing_id, item_id, requested_by, detail)
  select p_household_id, 'delist',
         'Pull it off ' || public.platform_display_name(l.platform) || ', it already fucking sold',
         l.id, r.item_id, 'system',
         'Sold somewhere else. End this listing now so we don''t sell the same shit twice.'
    from public.listings l
   where l.item_id = r.item_id and l.id <> r.id and l.status in ('draft', 'active', 'paused');
  get diagnostics v_delist = row_count;

  insert into public.activity_log (household_id, actor_user, actor_agent, action, entity_type, entity_id, detail)
  values (p_household_id, p_actor_user, p_actor_agent, 'sale_recorded', 'sale', r.item_id,
          jsonb_build_object('platform', r.platform, 'salePrice', v_price, 'listingId', r.id, 'saleId', v_sale_id, 'offerId', p_offer_id));

  return jsonb_build_object(
    'sale_id', v_sale_id,
    'item_id', r.item_id,
    'item_name', r.item_name,
    'listing_id', r.id,
    'platform', r.platform,
    'listing_url', r.listing_url,
    'sale_price', v_price,
    'platform_fees', v_fees,
    'shipping_cost', v_ship,
    'payout', round(v_price - v_fees - v_ship, 2),
    'delist_tasks', v_delist
  );
end;
$$;
revoke all on function public.apply_sale(uuid, uuid, text, uuid, numeric, numeric, numeric, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Core: accept / decline / counter a pending offer. Accepting records the sale through apply_sale.
-- The floor price is enforced unless p_override_floor is true (the app passes true because a member is
-- looking at the lowball warning; assistants pass false unless the member explicitly overrides).
-- ---------------------------------------------------------------------------
create or replace function public.apply_offer_decision(
  p_household_id uuid,
  p_actor_user uuid,
  p_actor_agent text,
  p_offer_id uuid,
  p_decision text,
  p_counter_amount numeric,
  p_platform_fees numeric,
  p_shipping_cost numeric,
  p_override_floor boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  v_now timestamptz := now();
  v_counter numeric;
  v_sale jsonb := null;
  v_tasks integer := 0;
begin
  if p_decision not in ('accepted', 'declined', 'countered') then
    raise exception 'Invalid decision: %', coalesce(p_decision, '(none)') using errcode = '22023';
  end if;

  select o.id, o.status, o.amount, o.listing_id, o.external_id, o.buyer_handle,
         l.item_id, l.platform, l.external_id as listing_external_id, l.listing_url, l.list_price,
         i.name as item_name, i.floor_price
    into rec
    from public.offers o
    join public.listings l on l.id = o.listing_id
    join public.inventory_items i on i.id = l.item_id
   where o.id = p_offer_id and o.household_id = p_household_id
   for update of o;
  if not found then
    raise exception 'Offer not found' using errcode = 'P0002';
  end if;
  if rec.status <> 'pending' then
    raise exception 'This offer has already been decided (%).', rec.status using errcode = 'P0003';
  end if;

  if p_decision = 'countered' then
    v_counter := round(coalesce(p_counter_amount, -1), 2);
    if v_counter <= 0 then
      raise exception 'A counter needs an amount above zero' using errcode = '22023';
    end if;
  end if;

  if rec.floor_price is not null and not coalesce(p_override_floor, false) then
    if p_decision = 'accepted' and rec.amount < rec.floor_price then
      raise exception 'Offer of % is below the floor price of %', rec.amount, rec.floor_price using errcode = 'P0004';
    end if;
    if p_decision = 'countered' and v_counter < rec.floor_price then
      raise exception 'Counter of % is below the floor price of %', v_counter, rec.floor_price using errcode = 'P0004';
    end if;
  end if;

  update public.offers
     set status = p_decision,
         decided_at = v_now,
         decided_by = p_actor_user,
         counter_amount = case when p_decision = 'countered' then v_counter else counter_amount end
   where id = rec.id;

  if p_decision = 'accepted' then
    v_sale := public.apply_sale(p_household_id, p_actor_user, p_actor_agent, rec.listing_id, rec.amount, p_platform_fees, p_shipping_cost, rec.id);
  end if;

  update public.agent_tasks
     set status = 'done', decided_by = p_actor_user, decided_at = v_now
   where offer_id = rec.id and status = 'pending';
  get diagnostics v_tasks = row_count;

  insert into public.activity_log (household_id, actor_user, actor_agent, action, entity_type, entity_id, detail)
  values (p_household_id, p_actor_user, p_actor_agent, 'offer_' || p_decision, 'offer', rec.id,
          jsonb_build_object('amount', rec.amount, 'counter', v_counter, 'platform', rec.platform, 'itemId', rec.item_id));

  return jsonb_build_object(
    'offer_id', rec.id,
    'decision', p_decision,
    'amount', rec.amount,
    'counter_amount', v_counter,
    'buyer', rec.buyer_handle,
    'offer_external_id', rec.external_id,
    'item', jsonb_build_object('id', rec.item_id, 'name', rec.item_name, 'floor_price', rec.floor_price),
    'listing', jsonb_build_object('id', rec.listing_id, 'platform', rec.platform, 'list_price', rec.list_price, 'external_id', rec.listing_external_id, 'url', rec.listing_url),
    'sale', v_sale,
    'tasks_closed', v_tasks
  );
end;
$$;
revoke all on function public.apply_offer_decision(uuid, uuid, text, uuid, text, numeric, numeric, numeric, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Member wrappers: what the app's server actions call (signed-in user, RLS-style membership check).
-- ---------------------------------------------------------------------------
create or replace function public.decide_offer(
  p_offer_id uuid,
  p_decision text,
  p_counter_amount numeric default null,
  p_platform_fees numeric default 0,
  p_shipping_cost numeric default 0,
  p_override_floor boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in' using errcode = '28000';
  end if;
  select household_id into v_household from public.offers where id = p_offer_id;
  if v_household is null or not public.is_household_member(v_household) then
    raise exception 'Offer not found' using errcode = 'P0002';
  end if;
  return public.apply_offer_decision(v_household, auth.uid(), null, p_offer_id, p_decision, p_counter_amount, p_platform_fees, p_shipping_cost, p_override_floor);
end;
$$;
revoke all on function public.decide_offer(uuid, text, numeric, numeric, numeric, boolean) from public, anon;
grant execute on function public.decide_offer(uuid, text, numeric, numeric, numeric, boolean) to authenticated;

create or replace function public.record_sale(
  p_listing_id uuid,
  p_sale_price numeric,
  p_platform_fees numeric default 0,
  p_shipping_cost numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in' using errcode = '28000';
  end if;
  select household_id into v_household from public.listings where id = p_listing_id;
  if v_household is null or not public.is_household_member(v_household) then
    raise exception 'Listing not found' using errcode = 'P0002';
  end if;
  return public.apply_sale(v_household, auth.uid(), null, p_listing_id, p_sale_price, p_platform_fees, p_shipping_cost, null);
end;
$$;
revoke all on function public.record_sale(uuid, numeric, numeric, numeric) from public, anon;
grant execute on function public.record_sale(uuid, numeric, numeric, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- Assistant functions (callable with the publishable key; the assistant key is the credential)
-- ---------------------------------------------------------------------------

-- Everything waiting on the household, plus the live listings so an assistant can match an email to one.
-- Items created after the key's previous check are flagged is_new; p_mark_seen=false peeks without
-- moving that watermark.
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
          'item', jsonb_build_object('id', i.id, 'name', i.name, 'floor_price', i.floor_price, 'purchase_cost', i.purchase_cost)
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

-- Carry the member's accept / counter / decline to the offer.
create or replace function public.assistant_decide_offer(
  p_key text,
  p_offer_id uuid,
  p_decision text,
  p_counter_amount numeric default null,
  p_platform_fees numeric default 0,
  p_shipping_cost numeric default 0,
  p_override_floor boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  k record;
begin
  select * into k from public.assistant_resolve_key(p_key);
  return public.apply_offer_decision(k.household_id, k.user_id, k.label, p_offer_id, p_decision, p_counter_amount, p_platform_fees, p_shipping_cost, p_override_floor);
end;
$$;
revoke all on function public.assistant_decide_offer(text, uuid, text, numeric, numeric, numeric, boolean) from public;
grant execute on function public.assistant_decide_offer(text, uuid, text, numeric, numeric, numeric, boolean) to anon, authenticated;

-- Record a buyer offer the assistant saw (e.g. in a notification email). Same amount on the same listing
-- within two days is treated as the same offer (matches the Gmail watcher's rule) and returned instead.
create or replace function public.assistant_record_offer(
  p_key text,
  p_listing_id uuid,
  p_amount numeric,
  p_buyer_handle text default null,
  p_note text default null,
  p_source text default 'agent'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  k record;
  rec record;
  v_amount numeric := round(coalesce(p_amount, -1), 2);
  v_existing uuid;
  v_offer uuid;
  v_source text := coalesce(nullif(trim(p_source), ''), 'agent');
begin
  select * into k from public.assistant_resolve_key(p_key);
  if v_amount < 0 then
    raise exception 'Offer amount must be a non-negative number' using errcode = '22023';
  end if;
  if v_source not in ('email', 'agent', 'manual') then
    raise exception 'Offer source must be email, agent or manual' using errcode = '22023';
  end if;

  select l.id, l.item_id, l.platform, l.status, l.list_price, i.name as item_name, i.floor_price
    into rec
    from public.listings l
    join public.inventory_items i on i.id = l.item_id
   where l.id = p_listing_id and l.household_id = k.household_id
   for update of l;
  if not found then
    raise exception 'Listing not found' using errcode = 'P0002';
  end if;
  if rec.status not in ('draft', 'active', 'paused') then
    raise exception 'That listing is % and cannot take offers.', rec.status using errcode = 'P0003';
  end if;

  select o.id into v_existing
    from public.offers o
   where o.listing_id = rec.id and o.amount = v_amount and o.received_at > now() - interval '2 days'
   order by o.received_at desc limit 1;
  if v_existing is not null then
    return jsonb_build_object('offer_id', v_existing, 'duplicate', true, 'amount', v_amount,
                              'item', jsonb_build_object('id', rec.item_id, 'name', rec.item_name),
                              'listing', jsonb_build_object('id', rec.id, 'platform', rec.platform, 'list_price', rec.list_price));
  end if;

  insert into public.offers (household_id, listing_id, amount, buyer_handle, source, note, received_at)
  values (k.household_id, rec.id, v_amount, nullif(left(trim(coalesce(p_buyer_handle, '')), 120), ''), v_source,
          nullif(left(trim(coalesce(p_note, '')), 1000), ''), now())
  returning id into v_offer;

  insert into public.agent_tasks (household_id, kind, title, detail, item_id, listing_id, offer_id, requested_by)
  values (k.household_id, 'offer_decision',
          left('Offer: $' || to_char(v_amount, 'FM999999990.00') || ' for ' || rec.item_name || ' on ' || public.platform_display_name(rec.platform), 300),
          'Recorded by ' || k.label || '. Accept, counter or decline.',
          rec.item_id, rec.id, v_offer, k.label);

  insert into public.activity_log (household_id, actor_user, actor_agent, action, entity_type, entity_id, detail)
  values (k.household_id, k.user_id, k.label, 'offer_recorded', 'offer', v_offer,
          jsonb_build_object('amount', v_amount, 'platform', rec.platform, 'source', v_source));

  return jsonb_build_object('offer_id', v_offer, 'duplicate', false, 'amount', v_amount,
                            'item', jsonb_build_object('id', rec.item_id, 'name', rec.item_name, 'floor_price', rec.floor_price),
                            'listing', jsonb_build_object('id', rec.id, 'platform', rec.platform, 'list_price', rec.list_price));
end;
$$;
revoke all on function public.assistant_record_offer(text, uuid, numeric, text, text, text) from public;
grant execute on function public.assistant_record_offer(text, uuid, numeric, text, text, text) to anon, authenticated;

-- Record a sale the member confirmed (e.g. "yes, it sold on Vinted for $12").
create or replace function public.assistant_record_sale(
  p_key text,
  p_listing_id uuid,
  p_sale_price numeric,
  p_platform_fees numeric default 0,
  p_shipping_cost numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  k record;
begin
  select * into k from public.assistant_resolve_key(p_key);
  return public.apply_sale(k.household_id, k.user_id, k.label, p_listing_id, p_sale_price, p_platform_fees, p_shipping_cost, null);
end;
$$;
revoke all on function public.assistant_record_sale(text, uuid, numeric, numeric, numeric) from public;
grant execute on function public.assistant_record_sale(text, uuid, numeric, numeric, numeric) to anon, authenticated;

-- Leave a household note (optionally on an item). Household-only; never sent to a marketplace.
create or replace function public.assistant_add_note(p_key text, p_body text, p_item_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  k record;
  v_body text := left(trim(coalesce(p_body, '')), 4000);
  v_note uuid;
begin
  select * into k from public.assistant_resolve_key(p_key);
  if char_length(v_body) = 0 then
    raise exception 'A note needs some text' using errcode = '22023';
  end if;
  if p_item_id is not null and not exists (select 1 from public.inventory_items i where i.id = p_item_id and i.household_id = k.household_id) then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;

  insert into public.notes (household_id, item_id, author, body)
  values (k.household_id, p_item_id, k.user_id, v_body)
  returning id into v_note;

  insert into public.activity_log (household_id, actor_user, actor_agent, action, entity_type, entity_id, detail)
  values (k.household_id, k.user_id, k.label, case when p_item_id is null then 'note_added' else 'comment_added' end, 'note', v_note,
          jsonb_build_object('item_id', p_item_id));

  return jsonb_build_object('note_id', v_note, 'item_id', p_item_id);
end;
$$;
revoke all on function public.assistant_add_note(text, text, uuid) from public;
grant execute on function public.assistant_add_note(text, text, uuid) to anon, authenticated;

-- Close a to-do on the member's behalf (approved / rejected / done / cancelled). Offer decisions go
-- through assistant_decide_offer instead. Marking a delist task done ends that listing.
create or replace function public.assistant_resolve_task(p_key text, p_task_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  k record;
  t record;
  v_now timestamptz := now();
begin
  select * into k from public.assistant_resolve_key(p_key);
  if p_status not in ('approved', 'rejected', 'done', 'cancelled') then
    raise exception 'Status must be approved, rejected, done or cancelled' using errcode = '22023';
  end if;

  select id, kind, status, listing_id, title into t
    from public.agent_tasks
   where id = p_task_id and household_id = k.household_id
   for update;
  if not found then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;
  if t.kind = 'offer_decision' then
    raise exception 'Decide the offer itself (action "decide") instead of closing its task.' using errcode = '22023';
  end if;
  if t.status not in ('pending', 'approved') then
    raise exception 'This task is already %.', t.status using errcode = 'P0003';
  end if;

  update public.agent_tasks set status = p_status, decided_by = k.user_id, decided_at = v_now where id = t.id;
  if t.kind = 'delist' and p_status = 'done' and t.listing_id is not null then
    update public.listings set status = 'ended', ended_at = v_now where id = t.listing_id and status <> 'sold';
  end if;

  insert into public.activity_log (household_id, actor_user, actor_agent, action, entity_type, entity_id, detail)
  values (k.household_id, k.user_id, k.label, 'task_' || p_status, 'agent_task', t.id, jsonb_build_object('kind', t.kind, 'title', t.title));

  return jsonb_build_object('task_id', t.id, 'kind', t.kind, 'status', p_status);
end;
$$;
revoke all on function public.assistant_resolve_task(text, uuid, text) from public;
grant execute on function public.assistant_resolve_task(text, uuid, text) to anon, authenticated;

-- Put something on the household's to-do list (a buyer message to answer, a price change to consider,
-- anything the member asked the assistant to flag). Same title within three days is returned, not repeated.
create or replace function public.assistant_propose_task(
  p_key text,
  p_kind text,
  p_title text,
  p_detail text default null,
  p_item_id uuid default null,
  p_listing_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  k record;
  v_title text := left(trim(coalesce(p_title, '')), 300);
  v_detail text := nullif(left(trim(coalesce(p_detail, '')), 2000), '');
  v_existing uuid;
  v_task uuid;
begin
  select * into k from public.assistant_resolve_key(p_key);
  if p_kind not in ('price_change', 'listing_draft', 'relist', 'message_reply', 'other') then
    raise exception 'Kind must be price_change, listing_draft, relist, message_reply or other' using errcode = '22023';
  end if;
  if char_length(v_title) = 0 then
    raise exception 'A task needs a title' using errcode = '22023';
  end if;
  if p_item_id is not null and not exists (select 1 from public.inventory_items i where i.id = p_item_id and i.household_id = k.household_id) then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;
  if p_listing_id is not null and not exists (select 1 from public.listings l where l.id = p_listing_id and l.household_id = k.household_id) then
    raise exception 'Listing not found' using errcode = 'P0002';
  end if;

  select id into v_existing from public.agent_tasks
   where household_id = k.household_id and title = v_title and created_at > now() - interval '3 days'
   order by created_at desc limit 1;
  if v_existing is not null then
    return jsonb_build_object('task_id', v_existing, 'duplicate', true, 'title', v_title);
  end if;

  insert into public.agent_tasks (household_id, kind, title, detail, item_id, listing_id, requested_by)
  values (k.household_id, p_kind, v_title, v_detail, p_item_id, p_listing_id, k.label)
  returning id into v_task;

  insert into public.activity_log (household_id, actor_user, actor_agent, action, entity_type, entity_id, detail)
  values (k.household_id, k.user_id, k.label, 'task_proposed', 'agent_task', v_task, jsonb_build_object('kind', p_kind, 'title', v_title));

  return jsonb_build_object('task_id', v_task, 'duplicate', false, 'title', v_title);
end;
$$;
revoke all on function public.assistant_propose_task(text, text, text, text, uuid, uuid) from public;
grant execute on function public.assistant_propose_task(text, text, text, text, uuid, uuid) to anon, authenticated;

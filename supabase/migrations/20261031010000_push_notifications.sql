-- Household Resale AI: phone notifications (web push) for new to-dos.
-- Depends on 20261030010000_marketplace_connections.sql (sha256_hex). Idempotent.
--
-- How it works:
--   1. A member taps "Turn on notifications" in Settings on their phone (on iPhone: the home-screen app).
--      The first time, the app makes the household's VAPID key pair (push_prepare). The phone subscribes
--      with the public key and push_subscribe stores its push endpoint.
--   2. Every new pending agent_task (an offer to decide, a sale to confirm, a buyer message, a delist ...)
--      is queued in push_queue by a trigger, whoever wrote it: the app, the assistant API, the eBay sync or
--      the Gmail watcher's plain SQL.
--   3. A trigger on push_queue asks pg_net to POST {household_id, token} to <app>/api/push/dispatch once the
--      transaction commits. The route trades the token for the waiting rows, the household's devices and the
--      VAPID key (push_claim), sends the notifications, and reports dead devices back (push_report).
--
-- No environment variables are involved: the key pair, the dispatch token and the app's address live in
-- push_config, which no client role can read. Where pg_net is not installed (the local test database) the
-- queue rows simply wait. Nothing here can block the write that created a to-do.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- push_config: one row per household. Server-side secrets; no client role can read or write it.
-- ---------------------------------------------------------------------------
create table if not exists public.push_config (
  household_id uuid primary key references public.households(id) on delete cascade,
  -- VAPID key pair (base64url, P-256): 65-byte public key, 32-byte private key.
  vapid_public_key text not null check (vapid_public_key ~ '^[A-Za-z0-9_-]{80,100}$'),
  vapid_private_key text not null check (vapid_private_key ~ '^[A-Za-z0-9_-]{40,50}$'),
  -- Sent by the database to /api/push/dispatch and checked by push_claim / push_report.
  dispatch_token text not null
    default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
    check (dispatch_token ~ '^[0-9a-f]{64}$'),
  -- Where the app runs (scheme + host), so the database knows where to send the dispatch request.
  app_origin text check (app_origin ~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.push_config is
  'Per-household web push settings: VAPID key pair, dispatch token, app address. Only the push_* SECURITY DEFINER functions use it.';

alter table public.push_config enable row level security;
revoke all on public.push_config from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- push_subscriptions: one row per phone/browser that turned notifications on.
-- ---------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://' and char_length(endpoint) between 12 and 1024),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}={0,2}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,30}={0,2}$'),
  device_label text not null default 'Phone' check (char_length(trim(device_label)) between 1 and 40),
  created_at timestamptz not null default now(),
  last_success_at timestamptz
);

create index if not exists push_subscriptions_household_idx on public.push_subscriptions (household_id, created_at);

alter table public.push_subscriptions enable row level security;

drop policy if exists "Members see the household's notification devices" on public.push_subscriptions;
create policy "Members see the household's notification devices" on public.push_subscriptions for select to authenticated
  using (public.is_household_member(household_id));

-- Members may see which phones have notifications on, never the endpoint or its keys. All writes go through
-- push_subscribe / push_unsubscribe below.
revoke all on public.push_subscriptions from public, anon, authenticated;
grant select (id, household_id, user_id, device_label, created_at, last_success_at) on public.push_subscriptions to authenticated;

-- ---------------------------------------------------------------------------
-- push_queue: what still has to buzz. Written by triggers and push_send_test, read by push_claim.
-- ---------------------------------------------------------------------------
create table if not exists public.push_queue (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  kind text not null check (kind in ('task', 'test')),
  task_id uuid references public.agent_tasks(id) on delete cascade,
  -- null = every member's devices; set = only that member's devices (tests).
  target_user uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);

create index if not exists push_queue_waiting_idx on public.push_queue (household_id, id) where claimed_at is null;

alter table public.push_queue enable row level security;
revoke all on public.push_queue from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Triggers: queue new to-dos, then ask the app to send them.
-- ---------------------------------------------------------------------------
create or replace function public.push_enqueue_task()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'pending'
     and exists (select 1 from public.push_subscriptions s where s.household_id = new.household_id) then
    begin
      insert into public.push_queue (household_id, kind, task_id) values (new.household_id, 'task', new.id);
    exception when others then
      -- A notification is never worth losing the to-do over.
      raise warning 'push_enqueue_task: %', sqlerrm;
    end;
  end if;
  return null;
end;
$$;
revoke all on function public.push_enqueue_task() from public, anon, authenticated;

drop trigger if exists push_enqueue_task on public.agent_tasks;
create trigger push_enqueue_task after insert on public.agent_tasks
  for each row execute function public.push_enqueue_task();

create or replace function public.push_poke()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_origin text;
  v_token text;
begin
  -- One request per household per transaction is enough: the dispatcher claims every waiting row.
  if exists (
    select 1 from public.push_queue q
     where q.household_id = new.household_id and q.claimed_at is null
       and q.id < new.id and q.created_at = new.created_at
  ) then
    return null;
  end if;

  select c.app_origin, c.dispatch_token into v_origin, v_token
    from public.push_config c
   where c.household_id = new.household_id;
  if v_origin is null then
    return null;
  end if;

  -- pg_net is missing where it cannot be installed (the local test database): the row just waits.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    return null;
  end if;

  begin
    -- pg_net sends this after the transaction commits, so the dispatcher sees the new rows.
    perform net.http_post(
      url := v_origin || '/api/push/dispatch',
      body := jsonb_build_object('household_id', new.household_id, 'token', v_token),
      headers := jsonb_build_object('Content-Type', 'application/json'),
      timeout_milliseconds := 15000
    );
  exception when others then
    -- Never block the write; the row stays queued and goes out with the next request.
    raise warning 'push_poke: could not queue the dispatch request: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function public.push_poke() from public, anon, authenticated;

drop trigger if exists push_poke on public.push_queue;
create trigger push_poke after insert on public.push_queue
  for each row execute function public.push_poke();

-- ---------------------------------------------------------------------------
-- Dispatcher functions (called by /api/push/dispatch with the publishable key; the token is the credential)
-- ---------------------------------------------------------------------------

-- Internal: the household's push_config row if p_token is its dispatch token. Raises 28000 otherwise.
create or replace function public.push_check_token(p_household_id uuid, p_token text)
returns public.push_config
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c public.push_config;
begin
  if p_household_id is null or p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid dispatch token' using errcode = '28000';
  end if;
  select * into c from public.push_config where household_id = p_household_id;
  -- Compare hashes so the comparison time says nothing about the token.
  if not found or public.sha256_hex(c.dispatch_token) <> public.sha256_hex(p_token) then
    raise exception 'Invalid dispatch token' using errcode = '28000';
  end if;
  return c;
end;
$$;
revoke all on function public.push_check_token(uuid, text) from public, anon, authenticated;

-- Claim everything waiting for the household (at most one day old) plus what is needed to send it.
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
    returning q.id, q.kind, q.task_id, q.target_user
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'queue_id', cl.id,
           'kind', cl.kind,
           'target_user', cl.target_user,
           'task', case when t.id is null then null else jsonb_build_object(
             'id', t.id, 'kind', t.kind, 'status', t.status, 'title', t.title, 'detail', t.detail,
             'item_id', t.item_id, 'offer_id', t.offer_id) end
         ) order by cl.id), '[]'::jsonb)
    into v_items
    from claimed cl
    left join public.agent_tasks t on t.id = cl.task_id;

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

-- After sending: forget devices the push service says are gone (404/410), mark the ones that got it.
create or replace function public.push_report(p_household_id uuid, p_token text, p_gone text[] default '{}', p_ok text[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.push_config;
  v_removed integer := 0;
  v_delivered integer := 0;
begin
  select * into c from public.push_check_token(p_household_id, p_token);
  if coalesce(cardinality(p_gone), 0) > 100 or coalesce(cardinality(p_ok), 0) > 100 then
    raise exception 'Too many devices in one report' using errcode = '22023';
  end if;

  delete from public.push_subscriptions s
   where s.household_id = p_household_id and s.endpoint = any(coalesce(p_gone, '{}'::text[]));
  get diagnostics v_removed = row_count;

  update public.push_subscriptions s
     set last_success_at = now()
   where s.household_id = p_household_id and s.endpoint = any(coalesce(p_ok, '{}'::text[]));
  get diagnostics v_delivered = row_count;

  return jsonb_build_object('removed', v_removed, 'delivered', v_delivered);
end;
$$;
revoke all on function public.push_report(uuid, text, text[], text[]) from public;
grant execute on function public.push_report(uuid, text, text[], text[]) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Member functions (the app's server actions, signed-in user)
-- ---------------------------------------------------------------------------

-- Returns the household's VAPID public key, storing the given key pair first if the household has none.
-- The app generates a fresh pair on every call; it is only kept the first time.
create or replace function public.push_prepare(p_household_id uuid, p_vapid_public_key text, p_vapid_private_key text)
returns text
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
  insert into public.push_config (household_id, vapid_public_key, vapid_private_key)
  values (p_household_id, p_vapid_public_key, p_vapid_private_key)
  on conflict (household_id) do nothing;
  return (select c.vapid_public_key from public.push_config c where c.household_id = p_household_id);
end;
$$;
revoke all on function public.push_prepare(uuid, text, text) from public, anon;
grant execute on function public.push_prepare(uuid, text, text) to authenticated;

-- Save (or move to this member) a device's push subscription, and remember where the app runs.
create or replace function public.push_subscribe(
  p_household_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_device_label text default null,
  p_origin text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_new boolean;
  v_label text := coalesce(nullif(left(trim(coalesce(p_device_label, '')), 40), ''), 'Phone');
begin
  if auth.uid() is null then
    raise exception 'You must be signed in' using errcode = '28000';
  end if;
  if p_household_id is null or not public.is_household_member(p_household_id) then
    raise exception 'Household not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.push_config c where c.household_id = p_household_id) then
    raise exception 'Notifications are not set up for this household yet' using errcode = 'P0003';
  end if;

  insert into public.push_subscriptions (household_id, user_id, endpoint, p256dh, auth, device_label)
  values (p_household_id, auth.uid(), p_endpoint, p_p256dh, p_auth, v_label)
  on conflict (endpoint) do update
     set household_id = excluded.household_id,
         user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         device_label = excluded.device_label
  -- xmax = 0 only for a freshly inserted row: the app re-saves a phone's subscription quietly on every visit
  -- to Settings, and only the first save is worth an activity entry.
  returning id, (xmax = 0) into v_id, v_new;

  if p_origin is not null then
    update public.push_config set app_origin = p_origin, updated_at = now() where household_id = p_household_id;
  end if;

  if v_new then
    insert into public.activity_log (household_id, actor_user, action, entity_type, entity_id, detail)
    values (p_household_id, auth.uid(), 'push_enabled', 'push_subscription', v_id, jsonb_build_object('device', v_label));
  end if;

  return v_id;
end;
$$;
revoke all on function public.push_subscribe(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.push_subscribe(uuid, text, text, text, text, text) to authenticated;

-- Turn notifications off for one of the caller's own devices. Returns false if it was not theirs.
create or replace function public.push_unsubscribe(p_endpoint text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_household uuid;
  v_label text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in' using errcode = '28000';
  end if;
  delete from public.push_subscriptions s
   where s.endpoint = p_endpoint and s.user_id = auth.uid()
  returning s.id, s.household_id, s.device_label into v_id, v_household, v_label;
  if v_id is null then
    return false;
  end if;
  insert into public.activity_log (household_id, actor_user, action, entity_type, entity_id, detail)
  values (v_household, auth.uid(), 'push_disabled', 'push_subscription', v_id, jsonb_build_object('device', v_label));
  return true;
end;
$$;
revoke all on function public.push_unsubscribe(text) from public, anon;
grant execute on function public.push_unsubscribe(text) to authenticated;

-- Queue a test notification for the caller's own devices. Returns how many devices it will go to.
create or replace function public.push_send_test(p_household_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_devices integer;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in' using errcode = '28000';
  end if;
  if p_household_id is null or not public.is_household_member(p_household_id) then
    raise exception 'Household not found' using errcode = 'P0002';
  end if;
  select count(*) into v_devices
    from public.push_subscriptions s
   where s.household_id = p_household_id and s.user_id = auth.uid();
  if v_devices > 0 then
    insert into public.push_queue (household_id, kind, target_user) values (p_household_id, 'test', auth.uid());
  end if;
  return v_devices;
end;
$$;
revoke all on function public.push_send_test(uuid) from public, anon;
grant execute on function public.push_send_test(uuid) to authenticated;

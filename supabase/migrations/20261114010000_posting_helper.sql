-- Posting helper (browser extension in extension/): fills in the sell form on Mercari, Poshmark and Facebook
-- Marketplace in the member's own logged-in browser. The member reviews it and taps the site's own Post
-- button; the extension never submits. It talks to /api/assistant with an assistant key like Muse does.
--
--   assistant_post_queue    the "Post it on <platform>" to-dos waiting for the helper (switches flipped on)
--   assistant_record_listing  after the member posted: record the live listing, switch on, to-do done
--
-- Vinted is never handled here (they suspend automated accounts). Same key model and VOLATILE rule as the
-- other assistant_* functions (see 20261101050000_assistant_lookups_volatile.sql).

create or replace function public.assistant_post_queue(p_key text, p_platforms text[] default array['mercari', 'poshmark', 'facebook'])
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  k record;
begin
  select * into k from public.assistant_resolve_key(p_key);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'task_id', t.id,
        'item_id', t.item_id,
        'platform', t.payload->>'platform',
        'title', t.title,
        'item_name', i.name,
        'created_at', t.created_at
      ) order by t.created_at)
      from public.agent_tasks t
      join public.inventory_items i on i.id = t.item_id
     where t.household_id = k.household_id
       and t.kind = 'listing_draft' and t.status = 'pending'
       and t.payload->>'platform' = any(p_platforms)
       and t.payload->>'platform' <> 'vinted'
       and i.status not in ('sold', 'donated', 'discarded', 'pending_sale')
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.assistant_post_queue(text, text[]) from public;
grant execute on function public.assistant_post_queue(text, text[]) to anon, authenticated;

create or replace function public.assistant_record_listing(
  p_key text,
  p_item_id uuid,
  p_platform text,
  p_url text,
  p_price numeric,
  p_external_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  k record;
  v_item record;
  v_listing uuid;
  v_existing uuid;
  v_tasks integer;
begin
  select * into k from public.assistant_resolve_key(p_key);
  if p_platform not in ('mercari', 'poshmark', 'facebook', 'offerup', 'depop') then
    raise exception 'The posting helper only records Mercari, Poshmark, Facebook, OfferUp or Depop listings.' using errcode = '22023';
  end if;
  if p_url is not null and p_url !~ '^https://' then
    raise exception 'url must start with https://' using errcode = '22023';
  end if;
  if p_price is null or p_price < 0 then
    raise exception 'Price can''t be negative.' using errcode = '22023';
  end if;

  select i.id, i.name, i.status into v_item from public.inventory_items i where i.id = p_item_id and i.household_id = k.household_id for update;
  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;

  -- A retried report for the same listing is harmless.
  select l.id into v_existing from public.listings l
   where l.item_id = p_item_id and l.platform = p_platform and l.status in ('active', 'paused')
     and (p_url is null or l.listing_url is null or l.listing_url = left(p_url, 1000))
   order by l.created_at desc limit 1;
  if v_existing is not null then
    return jsonb_build_object('listing_id', v_existing, 'item', v_item.name, 'platform', p_platform, 'duplicate', true);
  end if;

  insert into public.listings (household_id, item_id, platform, status, list_price, listing_url, external_id, listed_at, created_by)
  values (k.household_id, p_item_id, p_platform, 'active', p_price, left(p_url, 1000), left(p_external_id, 200), now(), k.user_id)
  returning id into v_listing;

  insert into public.item_platform_wants (household_id, item_id, platform, wanted, set_by)
  values (k.household_id, p_item_id, p_platform, true, k.user_id)
  on conflict (item_id, platform) do update set wanted = true, set_by = excluded.set_by, updated_at = now();

  update public.agent_tasks
     set status = 'done', decided_by = k.user_id, decided_at = now()
   where household_id = k.household_id and item_id = p_item_id and kind = 'listing_draft' and status = 'pending'
     and payload->>'platform' = p_platform;
  get diagnostics v_tasks = row_count;

  if v_item.status in ('researching', 'draft') then
    update public.inventory_items set status = 'listed', updated_at = now() where id = p_item_id;
  end if;

  insert into public.activity_log (household_id, actor_user, actor_agent, action, entity_type, entity_id, detail)
  values (k.household_id, k.user_id, k.label, 'listing_recorded', 'item', p_item_id,
          jsonb_build_object('platform', p_platform, 'listing_id', v_listing, 'via', 'posting_helper'));

  return jsonb_build_object('listing_id', v_listing, 'item', v_item.name, 'platform', p_platform, 'duplicate', false, 'todos_done', v_tasks);
end;
$$;
revoke all on function public.assistant_record_listing(text, uuid, text, text, numeric, text) from public;
grant execute on function public.assistant_record_listing(text, uuid, text, text, numeric, text) to anon, authenticated;

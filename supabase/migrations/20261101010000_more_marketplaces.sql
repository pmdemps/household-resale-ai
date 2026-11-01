-- More marketplaces: OfferUp (local) and ThredUp (consignment) as listing platforms,
-- and proper display names for them in to-do titles ("Pull it off OfferUp, ...").
-- Poshmark and Mercari were already allowed. None of these have APIs: a human posts,
-- the app records the listing, and apply_sale's delist tasks keep it one item, one sale.

do $$
declare
  c record;
begin
  -- Drop whatever check constraint currently limits listings.platform (its name was auto-generated).
  for c in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'public.listings'::regclass
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%platform%'
  loop
    execute format('alter table public.listings drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.listings
  add constraint listings_platform_check
  check (platform in ('ebay', 'poshmark', 'mercari', 'vinted', 'depop', 'facebook', 'etsy', 'offerup', 'thredup', 'other'));

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
    when 'offerup' then 'OfferUp'
    when 'thredup' then 'ThredUp'
    when 'other' then 'Other'
    else initcap(p_platform)
  end;
$$;
revoke all on function public.platform_display_name(text) from public, anon, authenticated;

-- Household Resale AI: marketplace OAuth connections (eBay, Etsy), external ids for
-- listings/offers, a small key-value sync_state table, and eBay account-deletion compliance.
-- Depends on 20261029010000_listings_offers_sales.sql. Append-only and idempotent.
--
-- Tokens are stored ENCRYPTED by the app (AES-256-GCM, lib/crypto.ts, key in TOKEN_ENCRYPTION_KEY).
-- A household member reading the ciphertext columns is acceptable; the key never reaches the database.

-- ---------------------------------------------------------------------------
-- marketplace_connections: one OAuth connection per household per platform
-- ---------------------------------------------------------------------------
create table if not exists public.marketplace_connections (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  platform text not null check (platform in ('ebay', 'etsy')),
  environment text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  account_handle text,
  external_user_id text,
  access_token_enc text,
  refresh_token_enc text,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  scopes text,
  status text not null default 'active' check (status in ('active', 'revoked', 'error')),
  last_error text,
  connected_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketplace_connections_one_per_platform unique (household_id, platform)
);

create index if not exists marketplace_connections_external_user_idx
  on public.marketplace_connections (platform, external_user_id)
  where external_user_id is not null;

drop trigger if exists marketplace_connections_set_updated_at on public.marketplace_connections;
create trigger marketplace_connections_set_updated_at before update on public.marketplace_connections
  for each row execute function public.set_updated_at();

alter table public.marketplace_connections enable row level security;

drop policy if exists "Members read connections" on public.marketplace_connections;
create policy "Members read connections" on public.marketplace_connections for select to authenticated
  using (public.is_household_member(household_id));
drop policy if exists "Members add connections" on public.marketplace_connections;
create policy "Members add connections" on public.marketplace_connections for insert to authenticated
  with check (public.is_household_member(household_id));
drop policy if exists "Members update connections" on public.marketplace_connections;
create policy "Members update connections" on public.marketplace_connections for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));
drop policy if exists "Admins delete connections" on public.marketplace_connections;
create policy "Admins delete connections" on public.marketplace_connections for delete to authenticated
  using (public.is_household_admin(household_id));

grant select, insert, update, delete on public.marketplace_connections to authenticated;

-- ---------------------------------------------------------------------------
-- External ids on listings and offers
-- ---------------------------------------------------------------------------
alter table public.listings
  add column if not exists external_offer_id text,
  add column if not exists sku text;

comment on column public.listings.external_id is 'Marketplace listing id (eBay: listingId / ItemID).';
comment on column public.listings.external_offer_id is 'eBay Inventory API offerId (the unpublished/published "offer" object, not a buyer offer).';
comment on column public.listings.sku is 'SKU sent to the marketplace. eBay: the inventory item id.';

alter table public.offers
  add column if not exists external_id text;

comment on column public.offers.external_id is 'Marketplace id for a buyer offer (eBay: BestOfferID). Used to dedupe polled offers.';

-- Dedupe polled buyer offers: one row per marketplace offer id per listing.
create unique index if not exists offers_listing_external_id_key
  on public.offers (listing_id, external_id)
  where external_id is not null;

-- ---------------------------------------------------------------------------
-- sync_state: small per-household key/value store (poll watermarks, ship-from location, ...)
-- ---------------------------------------------------------------------------
create table if not exists public.sync_state (
  household_id uuid not null references public.households(id) on delete cascade,
  key text not null check (char_length(key) between 1 and 120),
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (household_id, key)
);

drop trigger if exists sync_state_set_updated_at on public.sync_state;
create trigger sync_state_set_updated_at before update on public.sync_state
  for each row execute function public.set_updated_at();

alter table public.sync_state enable row level security;

drop policy if exists "Members read sync state" on public.sync_state;
create policy "Members read sync state" on public.sync_state for select to authenticated
  using (public.is_household_member(household_id));
drop policy if exists "Members add sync state" on public.sync_state;
create policy "Members add sync state" on public.sync_state for insert to authenticated
  with check (public.is_household_member(household_id));
drop policy if exists "Members update sync state" on public.sync_state;
create policy "Members update sync state" on public.sync_state for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));
drop policy if exists "Admins delete sync state" on public.sync_state;
create policy "Admins delete sync state" on public.sync_state for delete to authenticated
  using (public.is_household_admin(household_id));

grant select, insert, update, delete on public.sync_state to authenticated;

-- ---------------------------------------------------------------------------
-- eBay Marketplace Account Deletion compliance
-- The HTTP endpoint (app/api/ebay/account-deletion) verifies the notification, then calls
-- record_ebay_account_deletion with the SERVICE ROLE (SUPABASE_SERVICE_ROLE_KEY). The function is
-- SECURITY DEFINER, so anon/authenticated must NOT be able to execute it: anyone holding the
-- publishable key could otherwise revoke connections and fill the log. The log has RLS on and
-- NO policies: only the service role / owner can read it.
--
-- eBay expects the user's data to be deleted, so the log keeps only SHA-256 hashes of the username
-- and user id (enough to prove a notice was handled), never the plaintext, and the raw payload is
-- stored without its notification.data block.
-- ---------------------------------------------------------------------------
create table if not exists public.ebay_account_deletion_log (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  username_hash text,
  user_id_hash text,
  raw jsonb not null default '{}'::jsonb
);

comment on table public.ebay_account_deletion_log is
  'eBay MARKETPLACE_ACCOUNT_DELETION notices. username_hash / user_id_hash are hex SHA-256 of the values eBay sent; plaintext is never stored.';

alter table public.ebay_account_deletion_log enable row level security;
revoke all on public.ebay_account_deletion_log from public, anon, authenticated;

-- Hex SHA-256 of a text value (null stays null). Uses the built-in sha256(bytea) so it does not
-- depend on which schema pgcrypto's digest() was installed in.
create or replace function public.sha256_hex(p_value text)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select encode(sha256(convert_to(p_value, 'UTF8')), 'hex');
$$;

revoke all on function public.sha256_hex(text) from public;

create or replace function public.record_ebay_account_deletion(
  p_username text,
  p_user_id text,
  p_raw jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_raw jsonb := coalesce(p_raw, '{}'::jsonb);
begin
  -- Input caps: this runs as the table owner, so nothing oversized may reach the log.
  if char_length(coalesce(p_username, '')) > 200 then
    raise exception 'record_ebay_account_deletion: p_username longer than 200 characters' using errcode = 'string_data_right_truncation';
  end if;
  if char_length(coalesce(p_user_id, '')) > 200 then
    raise exception 'record_ebay_account_deletion: p_user_id longer than 200 characters' using errcode = 'string_data_right_truncation';
  end if;
  if pg_column_size(v_raw) > 16384 then
    raise exception 'record_ebay_account_deletion: p_raw larger than 16 KB' using errcode = 'program_limit_exceeded';
  end if;

  -- Never keep the user's identifiers in plaintext (the endpoint also omits them; this is the backstop).
  v_raw := v_raw #- '{notification,data}';

  insert into public.ebay_account_deletion_log (username_hash, user_id_hash, raw)
  values (public.sha256_hex(nullif(p_username, '')), public.sha256_hex(nullif(p_user_id, '')), v_raw);

  if p_user_id is not null and char_length(p_user_id) > 0 then
    update public.marketplace_connections
      set status = 'revoked',
          access_token_enc = null,
          refresh_token_enc = null,
          access_expires_at = null,
          refresh_expires_at = null,
          account_handle = null,
          external_user_id = null,
          last_error = 'eBay account deletion notice received'
      where platform = 'ebay' and external_user_id = p_user_id;
  end if;
end;
$$;

-- Service role only. NOT anon/authenticated: the function is SECURITY DEFINER.
revoke all on function public.record_ebay_account_deletion(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_ebay_account_deletion(text, text, jsonb) to service_role;

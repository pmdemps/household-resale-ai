// Applies all Supabase migrations to an in-memory Postgres (PGlite) with a stubbed
// auth schema, then checks row-level security and integrity rules. Run: npm run test:db
import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? new URL("../supabase/migrations", import.meta.url).pathname;
const db = new PGlite();
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

await db.exec(`
  create role authenticated nologin;
  create role anon nologin;
  create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
  grant usage on schema public to authenticated, anon, service_role;
  insert into auth.users values ('${A}', 'a@example.com'), ('${B}', 'b@example.com');

  -- Minimal stand-in for Supabase Storage (same column names, RLS on objects) so the
  -- item-photos bucket and its object policies can be applied and tested here.
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean not null default false,
    file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
    name text, owner uuid, metadata jsonb, created_at timestamptz default now());
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
    declare _parts text[];
    begin select string_to_array(name, '/') into _parts; return _parts[1:array_length(_parts, 1) - 1]; end $$;
  -- Supabase grants these table privileges to anon as well; RLS policies are what actually protect objects.
  grant usage on schema storage to authenticated, anon;
  grant select on storage.buckets to authenticated, anon;
  grant select, insert, update, delete on storage.objects to authenticated, anon;
`);

for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
  await db.exec(fs.readFileSync(path.join(dir, f), "utf8").replace(/create extension if not exists pgcrypto;/g, ""));
  console.log("applied", f);
}
// Re-apply to confirm idempotence of drop/create statements.
for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
  await db.exec(fs.readFileSync(path.join(dir, f), "utf8").replace(/create extension if not exists pgcrypto;/g, ""));
}
console.log("re-applied OK");

async function as(user, sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false); set role authenticated;`);
  try { return await db.query(sql, params); } finally { await db.exec("reset role;"); }
}
/** Holder of the publishable key with no session (what a stranger on the internet gets). */
async function asAnon(sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); set role anon;`);
  try { return await db.query(sql, params); } finally { await db.exec("reset role;"); }
}
let failures = 0;
const check = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) failures++; };
/** Pass `like` to also require the error message to match (so a check cannot pass because of an unrelated error). */
async function expectError(fn, msg, like) {
  try { await fn(); check(false, msg); }
  catch (e) {
    const text = String(e?.message ?? e);
    if (like && !like.test(text)) check(false, `${msg} (error was: ${text.slice(0, 160)})`);
    else check(true, msg);
  }
}

const hA = (await as(A, "select public.create_household('A house') as id")).rows[0].id;
const hB = (await as(B, "select public.create_household('B house') as id")).rows[0].id;
const item = (await as(A, `insert into public.inventory_items (household_id, created_by, name, floor_price, storage_location)
  values ($1, $2, 'Kids sneakers', 3, 'garage') returning id`, [hA, A])).rows[0].id;
const listing = (await as(A, `insert into public.listings (household_id, item_id, platform, status, list_price, created_by)
  values ($1, $2, 'vinted', 'active', 5.99, $3) returning id`, [hA, item, A])).rows[0].id;
await as(A, `insert into public.offers (household_id, listing_id, amount) values ($1, $2, 3.99)`, [hA, listing]);
await as(A, `insert into public.agent_tasks (household_id, kind, title, listing_id, requested_by) values ($1, 'offer_decision', 'Accept $3.99?', $2, 'claude')`, [hA, listing]);
await as(A, `insert into public.activity_log (household_id, actor_user, action, entity_type, entity_id) values ($1, $2, 'created', 'item', $3)`, [hA, A, item]);

check((await as(A, "select * from public.offers")).rows.length === 1, "member sees own offer");
check((await as(B, "select * from public.offers")).rows.length === 0, "non-member sees no offers");
check((await as(B, "select * from public.listings")).rows.length === 0, "non-member sees no listings");
check((await as(B, "select * from public.agent_tasks")).rows.length === 0, "non-member sees no agent tasks");
check((await as(B, "select * from public.activity_log")).rows.length === 0, "non-member sees no activity");

await expectError(() => as(B, `insert into public.listings (household_id, item_id, platform, list_price, created_by) values ($1, $2, 'ebay', 1, $3)`, [hA, item, B]),
  "non-member cannot list into another household");
await expectError(() => as(B, `insert into public.listings (household_id, item_id, platform, list_price, created_by) values ($1, $2, 'ebay', 1, $3)`, [hB, item, B]),
  "cannot attach another household's item via own household id (composite FK)");
await expectError(() => as(A, `insert into public.listings (household_id, item_id, platform, list_price, created_by) values ($1, $2, 'vinted', 4, $3)`, [hA, item, A]),
  "only one live listing per platform per item");
await as(A, `insert into public.listings (household_id, item_id, platform, list_price, created_by) values ($1, $2, 'ebay', 6.5, $3)`, [hA, item, A]);
check(true, "same item can be live on a second platform");
await expectError(() => as(A, `update public.activity_log set action = 'x'`), "activity log is not updatable by clients");
await expectError(() => as(A, `insert into public.activity_log (household_id, actor_user, action, entity_type) values ($1, $2, 'spoof', 'item')`, [hA, B]),
  "cannot write activity as another user");
const upd = await as(B, `update public.offers set status='accepted' returning id`);
check(upd.rows.length === 0, "non-member cannot update offers");

await as(A, `insert into public.sales (household_id, item_id, listing_id, platform, sale_price, platform_fees, created_by) values ($1,$2,$3,'vinted',3.99,0,$4)`, [hA, item, listing, A]);
await expectError(() => as(A, `insert into public.sales (household_id, item_id, platform, sale_price, created_by) values ($1,$2,'vinted',3.99,$3)`, [hA, item, A]),
  "only one sale per item");

// --- item photos (B is still a non-member of A's household here) ---
const bucket = (await db.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'item-photos'")).rows[0];
check(bucket?.public === true && Number(bucket.file_size_limit) === 10485760 && bucket.allowed_mime_types.includes("image/jpeg"), "item-photos bucket is public with a 10 MB limit");
const photoPath = `${hA}/${item}/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f.jpg`;
const photo = (await as(A, `insert into public.item_photos (household_id, item_id, storage_path, width, height, bytes) values ($1, $2, $3, 1200, 1600, 345678) returning id, position, created_by`, [hA, item, photoPath])).rows[0];
check(photo.position === 0 && photo.created_by === A, "first photo is the cover (position 0) and created_by defaults to the uploader");
check((await as(A, "select * from public.item_photos where item_id = $1", [item])).rows.length === 1, "member sees item photos");
check((await as(B, "select * from public.item_photos")).rows.length === 0, "non-member sees no item photos");
await expectError(() => as(B, `insert into public.item_photos (household_id, item_id, storage_path) values ($1, $2, 'x/y/z.jpg')`, [hA, item]),
  "non-member cannot add photos to another household's item");
await expectError(() => as(B, `insert into public.item_photos (household_id, item_id, storage_path) values ($1, $2, 'x/y/z2.jpg')`, [hB, item]),
  "cannot attach another household's item via own household id (composite FK)");
await expectError(() => as(A, `insert into public.item_photos (household_id, item_id, storage_path, created_by) values ($1, $2, 'x/y/z3.jpg', $3)`, [hA, item, B]),
  "cannot record a photo as another user");
await expectError(() => as(A, `insert into public.item_photos (household_id, item_id, storage_path) values ($1, $2, $3)`, [hA, item, photoPath]),
  "storage_path is unique");
check((await as(B, "update public.item_photos set position = 5 returning id")).rows.length === 0, "non-member cannot reorder photos");
check((await as(B, "delete from public.item_photos returning id")).rows.length === 0, "non-member cannot delete photos");
check((await as(A, "update public.item_photos set position = 3 where id = $1 returning id", [photo.id])).rows.length === 1, "member reorders photos");
// storage.objects: write access AND listing follow the household id in the first path segment. The files
// themselves are served by the public-bucket URL, which does not consult these policies.
await as(A, "insert into storage.objects (bucket_id, name, owner) values ('item-photos', $1, $2)", [photoPath, A]);
check(true, "member uploads into own household folder");
check((await as(A, "insert into storage.objects (bucket_id, name, owner) values ('item-photos', $1, $2) returning id", [`${hA}/${item}/second.jpg`, A])).rows.length === 1,
  "upload with RETURNING works for a member (the select policy admits the uploader's own folder)");
await as(A, "delete from storage.objects where name = $1", [`${hA}/${item}/second.jpg`]);
await expectError(() => as(B, "insert into storage.objects (bucket_id, name, owner) values ('item-photos', $1, $2)", [`${hA}/${item}/intruder.jpg`, B]),
  "non-member cannot upload into another household's folder");
await expectError(() => as(B, "insert into storage.objects (bucket_id, name, owner) values ('item-photos', $1, $2)", ["not-a-uuid/x.jpg", B]),
  "upload path must start with a household id");
await db.query("insert into storage.buckets (id, name) values ('other-bucket', 'other-bucket')");
await expectError(() => as(A, "insert into storage.objects (bucket_id, name, owner) values ('other-bucket', $1, $2)", [`${hA}/x.jpg`, A]),
  "no write access to other buckets");
await as(B, "insert into storage.objects (bucket_id, name, owner) values ('item-photos', $1, $2)", [`${hB}/some-item/own.jpg`, B]);
check((await as(B, "select name from storage.objects where bucket_id = 'item-photos'")).rows.map(r => r.name).join() === `${hB}/some-item/own.jpg`,
  "a member lists only their own household's object paths");
check((await asAnon("select name from storage.objects where bucket_id = 'item-photos'")).rows.length === 0,
  "anon cannot list any object paths (no select policy for anon; files are still served by the public URL)");
await expectError(() => asAnon("insert into storage.objects (bucket_id, name, owner) values ('item-photos', $1, null)", [`${hA}/${item}/anon.jpg`]),
  "anon cannot upload");
check((await as(B, "delete from storage.objects where name = $1 returning id", [photoPath])).rows.length === 0, "non-member cannot delete another household's photo file");
check((await as(A, "delete from storage.objects where name = $1 returning id", [photoPath])).rows.length === 1, "member deletes own household's photo file");
await as(A, "delete from public.item_photos where id = $1", [photo.id]);

// --- item comps (market comparables), B is not yet a member of A's household ---
const comp = (await as(A, `insert into public.item_comps (household_id, item_id, platform, title, price, shipping, url)
  values ($1, $2, 'ebay', 'Similar sneakers', 12.5, 4.25, 'https://www.ebay.com/itm/1') returning id, created_by, source, kind`, [hA, item])).rows[0];
check(comp.created_by === A && comp.source === "manual" && comp.kind === "active", "member records a comp (defaults: manual, active, created_by = self)");
check((await as(A, `insert into public.item_comps (household_id, item_id, source, platform, title, price, external_id, created_by, added_by_agent)
  values ($1, $2, 'ebay', 'ebay', 'Live listing', 9.99, 'v1|1|0', null, null) returning id`, [hA, item])).rows.length === 1, "member stores eBay search results");
await expectError(() => as(A, `insert into public.item_comps (household_id, item_id, source, platform, title, price, external_id)
  values ($1, $2, 'ebay', 'ebay', 'Same listing again', 9.99, 'v1|1|0')`, [hA, item]), "the same eBay listing is stored once per item");
check((await as(B, "select * from public.item_comps")).rows.length === 0, "non-member sees no comps");
check((await asAnon("select * from public.item_comps").catch(() => ({ rows: [] }))).rows.length === 0, "anon sees no comps");
await expectError(() => as(B, `insert into public.item_comps (household_id, item_id, title, price) values ($1, $2, 'x', 1)`, [hA, item]), "non-member cannot add comps to another household");
await expectError(() => as(B, `insert into public.item_comps (household_id, item_id, title, price) values ($1, $2, 'x', 1)`, [hB, item]), "comp cannot point at another household's item");
await expectError(() => as(A, `insert into public.item_comps (household_id, item_id, title, price, created_by) values ($1, $2, 'x', 1, $3)`, [hA, item, B]), "member cannot record a comp as someone else");
await expectError(() => as(A, `insert into public.item_comps (household_id, item_id, title, price, url) values ($1, $2, 'x', 1, 'javascript:alert(1)')`, [hA, item]), "comp links must be https");
await expectError(() => as(A, `insert into public.item_comps (household_id, item_id, title, price) values ($1, $2, 'x', -1)`, [hA, item]), "comp price cannot be negative");
check((await as(B, "update public.item_comps set price = 0 returning id")).rows.length === 0, "non-member cannot edit comps");
check((await as(B, "delete from public.item_comps returning id")).rows.length === 0, "non-member cannot delete comps");
check((await as(A, "delete from public.item_comps where id = $1 returning id", [comp.id])).rows.length === 1, "member deletes a comp");

await expectError(() => as(B, "select public.add_household_member_by_email($1, 'b@example.com')", [hA]), "non-admin cannot add members");
check((await as(A, "select public.add_household_member_by_email($1, 'nobody@example.com') as ok", [hA])).rows[0].ok === false, "unknown email returns false");
check((await as(A, "select public.add_household_member_by_email($1, 'B@Example.com') as ok", [hA])).rows[0].ok === true, "admin adds member by email (case-insensitive)");
check((await as(B, "select * from public.offers")).rows.length === 1, "new member now sees household offers");
check((await as(B, "select * from public.household_members where household_id = $1", [hA])).rows.length === 2, "members see co-members");
await expectError(() => as(B, "delete from public.listings where household_id = $1 returning id", [hA]).then(r => { if (r.rows.length === 0) throw new Error("blocked"); }), "member (non-admin) cannot delete listings");

// --- notes & display names (B is now a member of A's household) ---
await as(A, "update public.household_members set display_name = 'Alex' where user_id = $1", [A]);
await as(B, "update public.household_members set display_name = 'Sam' where user_id = $1", [B]);
check((await as(A, "select display_name from public.household_members where household_id = $1 order by display_name", [hA])).rows.map(r => r.display_name).join(",") === "Alex,Sam", "members set own display names");
const renamed = await as(B, "update public.household_members set display_name = 'Hacked' where user_id = $1 returning user_id", [A]);
check(renamed.rows.length === 0, "cannot rename another member");
await expectError(() => as(B, "update public.household_members set role = 'admin' where user_id = $1", [B]), "member cannot promote self to admin");

const note = (await as(B, "insert into public.notes (household_id, body) values ($1, 'Grandma wants the blue sweater') returning id, author", [hA])).rows[0];
check(note.author === B, "note author defaults to current user");
await as(A, "insert into public.notes (household_id, item_id, body) values ($1, $2, 'Scuff on left toe')", [hA, item]);
check((await as(B, "select * from public.notes where item_id = $1", [item])).rows.length === 1, "item comment visible to co-member");
await expectError(() => as(B, "insert into public.notes (household_id, body, author) values ($1, 'spoof', $2)", [hA, A]), "cannot post as someone else");
await expectError(() => as(A, "update public.notes set body = 'edited' where id = $1", [note.id]), "cannot edit someone else's note text");
check((await as(A, "update public.notes set pinned = true where id = $1 returning id", [note.id])).rows.length === 1, "any member can pin");
await expectError(() => as(A, "update public.notes set item_id = $2 where id = $1", [note.id, item]), "notes cannot be moved to another item");
const otherHouseNote = await as(B, "insert into public.notes (household_id, body) values ($1, 'B house only') returning id", [hB]);
check(otherHouseNote.rows.length === 1, "B writes in own household");
check((await as(A, "select * from public.notes where household_id = $1", [hB])).rows.length === 0, "notes don't leak across households");
await expectError(() => as(A, "insert into public.notes (household_id, item_id, body) values ($1, $2, 'x')", [hB, item]), "cannot attach note to another household's item");
check((await as(B, "delete from public.notes where id = $1 returning id", [note.id])).rows.length === 1, "author deletes own note");

// --- marketplace connections, external ids, sync_state, eBay account deletion ---
// C is a fresh user with no household membership at all.
const C = "33333333-3333-3333-3333-333333333333";
await db.exec(`insert into auth.users values ('${C}', 'c@example.com')`);

const conn = (await as(A, `insert into public.marketplace_connections
  (household_id, platform, environment, account_handle, external_user_id, access_token_enc, refresh_token_enc, scopes, connected_by)
  values ($1, 'ebay', 'sandbox', 'testuser_a', 'EBAY-USER-1', 'v1:ciphertext', 'v1:ciphertext', 'sell.inventory', $2) returning id, status`, [hA, A])).rows[0];
check(conn.status === "active", "connection defaults to active");
check((await as(B, "select * from public.marketplace_connections")).rows.length === 1, "co-member sees the household connection");
check((await as(C, "select * from public.marketplace_connections")).rows.length === 0, "non-member cannot read connections");
await expectError(() => as(C, `insert into public.marketplace_connections (household_id, platform, connected_by) values ($1, 'etsy', $2)`, [hA, C]),
  "non-member cannot add a connection to another household");
await expectError(() => as(A, `insert into public.marketplace_connections (household_id, platform, connected_by) values ($1, 'ebay', $2)`, [hA, A]),
  "only one connection per platform per household");
await expectError(() => as(A, `insert into public.marketplace_connections (household_id, platform, connected_by) values ($1, 'vinted', $2)`, [hA, A]),
  "connections are limited to platforms with an official API");
check((await as(B, "update public.marketplace_connections set status = 'error', last_error = 'expired' where id = $1 returning id", [conn.id])).rows.length === 1, "member can update a connection");
check((await as(B, "delete from public.marketplace_connections where id = $1 returning id", [conn.id])).rows.length === 0, "member (non-admin) cannot delete a connection");
check((await as(C, "update public.marketplace_connections set status = 'revoked' returning id")).rows.length === 0, "non-member cannot update connections");
const connTs = (await as(A, "select created_at, updated_at from public.marketplace_connections where id = $1", [conn.id])).rows[0];
check(new Date(connTs.updated_at) >= new Date(connTs.created_at), "connection updated_at trigger runs");

const ebayListing = (await as(A, `select id from public.listings where item_id = $1 and platform = 'ebay'`, [item])).rows[0].id;
await as(A, `update public.listings set external_id = '110000001', external_offer_id = 'OFFER-1', sku = $2 where id = $1`, [ebayListing, item]);
check((await as(B, "select sku, external_offer_id from public.listings where id = $1", [ebayListing])).rows[0].external_offer_id === "OFFER-1", "listing external ids are stored");
await as(A, `insert into public.offers (household_id, listing_id, amount, source, external_id, buyer_handle) values ($1, $2, 4.5, 'api', 'BO-1', 'buyer1')`, [hA, ebayListing]);
await expectError(() => as(A, `insert into public.offers (household_id, listing_id, amount, source, external_id) values ($1, $2, 4.5, 'api', 'BO-1')`, [hA, ebayListing]),
  "same eBay BestOfferID cannot be recorded twice on a listing");
await as(A, `insert into public.offers (household_id, listing_id, amount, source) values ($1, $2, 4.0, 'manual')`, [hA, ebayListing]);
await as(A, `insert into public.offers (household_id, listing_id, amount, source) values ($1, $2, 4.25, 'manual')`, [hA, ebayListing]);
check(true, "offers without an external id are not deduped");

await as(A, `insert into public.sync_state (household_id, key, value) values ($1, 'ebay_offers', '{"last_poll":"2026-10-30T00:00:00Z"}')
  on conflict (household_id, key) do update set value = excluded.value`, [hA]);
check((await as(B, "select value from public.sync_state where household_id = $1 and key = 'ebay_offers'", [hA])).rows.length === 1, "co-member reads sync state");
check((await as(C, "select * from public.sync_state")).rows.length === 0, "non-member cannot read sync state");
await expectError(() => as(C, `insert into public.sync_state (household_id, key) values ($1, 'x')`, [hA]), "non-member cannot write sync state");

await expectError(() => as(A, "select * from public.ebay_account_deletion_log"), "member cannot read the account deletion log");
await expectError(() => asAnon("select * from public.ebay_account_deletion_log"), "anon cannot read the account deletion log");
await expectError(() => asAnon("select * from public.marketplace_connections"), "anon cannot read connections");

// record_ebay_account_deletion is SECURITY DEFINER: only the service role (the endpoint uses
// SUPABASE_SERVICE_ROLE_KEY) may execute it. The publishable key (anon) and signed-in users may not.
async function asService(sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); set role service_role;`);
  try { return await db.query(sql, params); } finally { await db.exec("reset role;"); }
}
const notice = JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { notificationId: "n-1", data: { username: "testuser_a", userId: "EBAY-USER-1" } } });
await expectError(() => asAnon("select public.record_ebay_account_deletion($1, $2, $3::jsonb)", ["testuser_a", "EBAY-USER-1", notice]),
  "anon CANNOT call record_ebay_account_deletion");
await expectError(() => as(C, "select public.record_ebay_account_deletion($1, $2, $3::jsonb)", ["testuser_a", "EBAY-USER-1", notice]),
  "authenticated user CANNOT call record_ebay_account_deletion");
check((await as(A, "select status, external_user_id from public.marketplace_connections where id = $1", [conn.id])).rows[0].external_user_id === "EBAY-USER-1",
  "rejected calls change nothing");
await expectError(() => asService("select public.record_ebay_account_deletion($1, $2, $3::jsonb)", ["x".repeat(201), "EBAY-USER-1", "{}"]),
  "oversized username is rejected");
await expectError(() => asService("select public.record_ebay_account_deletion($1, $2, $3::jsonb)", ["testuser_a", "y".repeat(201), "{}"]),
  "oversized user id is rejected");
await expectError(() => asService("select public.record_ebay_account_deletion($1, $2, $3::jsonb)", ["testuser_a", "EBAY-USER-1", JSON.stringify({ pad: "z".repeat(17000) })]),
  "oversized raw payload (> 16 KB) is rejected");
await db.exec("reset role;");
check((await db.query("select count(*)::int as n from public.ebay_account_deletion_log")).rows[0].n === 0, "rejected calls are not logged");
await asService("select public.record_ebay_account_deletion($1, $2, $3::jsonb)", ["testuser_a", "EBAY-USER-1", notice]);
check(true, "service role can call record_ebay_account_deletion");
const revoked = (await as(A, "select status, access_token_enc, refresh_token_enc, account_handle, external_user_id from public.marketplace_connections where id = $1", [conn.id])).rows[0];
check(revoked.status === "revoked" && revoked.access_token_enc === null && revoked.refresh_token_enc === null, "deletion notice revokes the connection and clears tokens");
check(revoked.account_handle === null && revoked.external_user_id === null, "deletion notice removes the eBay username and user id from the connection");
await db.exec("reset role;");
const logged = (await db.query("select username_hash, user_id_hash, raw::text as raw from public.ebay_account_deletion_log")).rows;
check(logged.length === 1, "deletion notice is logged (owner view)");
check(logged[0]?.user_id_hash === createHash("sha256").update("EBAY-USER-1").digest("hex") && logged[0]?.username_hash === createHash("sha256").update("testuser_a").digest("hex"),
  "log keeps SHA-256 hashes of the username and user id");
check(!/EBAY-USER-1|testuser_a/.test(logged[0]?.raw ?? "") && /n-1/.test(logged[0]?.raw ?? ""), "log never stores the plaintext identifiers (notification.data is stripped from raw)");
await asService("select public.record_ebay_account_deletion($1, $2, $3::jsonb)", ["someone_else", "UNKNOWN-USER", "{}"]);
check((await db.query("select count(*)::int as n from public.ebay_account_deletion_log")).rows[0].n === 2, "unknown users are still logged, nothing else changes");
await asService("select public.record_ebay_account_deletion($1, $2, $3::jsonb)", [null, null, "{}"]);
check((await db.query("select username_hash, user_id_hash from public.ebay_account_deletion_log order by received_at desc limit 1")).rows[0].user_id_hash === null, "missing identifiers are logged as null, not hashed");

// --- assistant access: keys, inbox, decisions relayed by a personal assistant (A and B are members of hA, C is not) ---
const token = "rhq_" + "t".repeat(43); // what the app would hand to Muse; only its hash is stored
const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
check((await db.query("select public.sha256_hex($1) as h", [token])).rows[0].h === tokenHash, "assistant key hash in SQL matches node:crypto");
const key = (await as(A, `insert into public.assistant_keys (household_id, user_id, label, key_hash, key_prefix) values ($1, $2, 'muse', $3, $4) returning id, key_prefix`, [hA, A, tokenHash, token.slice(0, 12)])).rows[0];
check(key.key_prefix === "rhq_tttttttt", "member creates an assistant key for themself");
check((await as(B, "select id, label, key_prefix, revoked_at from public.assistant_keys")).rows.length === 1, "co-member sees the household's keys (without the hash)");
check((await as(C, "select id from public.assistant_keys")).rows.length === 0, "non-member sees no keys");
await expectError(() => as(A, "select key_hash from public.assistant_keys"), "key hash column is not readable by clients", /permission denied/);
await expectError(() => asAnon("select id from public.assistant_keys"), "anon cannot read keys", /permission denied/);
await expectError(() => as(A, `insert into public.assistant_keys (household_id, user_id, label, key_hash, key_prefix) values ($1, $2, 'x', $3, 'rhq_x')`, [hA, B, "a".repeat(64)]),
  "cannot create a key that acts for another member", /row-level security/);
await expectError(() => as(C, `insert into public.assistant_keys (household_id, user_id, label, key_hash, key_prefix) values ($1, $2, 'x', $3, 'rhq_x')`, [hA, C, "b".repeat(64)]),
  "non-member cannot create a key for another household", /row-level security/);
await expectError(() => as(A, `insert into public.assistant_keys (household_id, user_id, label, key_hash, key_prefix) values ($1, $2, 'x', 'nothex', 'rhq_x')`, [hA, A]),
  "key hash must be 64 hex characters", /check constraint/);

// A second item with three listings, a floor of $10 and offers above and below it.
const item2 = (await as(A, `insert into public.inventory_items (household_id, created_by, name, floor_price, purchase_cost) values ($1, $2, 'Toddler rain boots', 10, 4) returning id`, [hA, A])).rows[0].id;
const vinted2 = (await as(A, `insert into public.listings (household_id, item_id, platform, status, list_price, created_by) values ($1, $2, 'vinted', 'active', 20, $3) returning id`, [hA, item2, A])).rows[0].id;
const ebay2 = (await as(A, `insert into public.listings (household_id, item_id, platform, status, list_price, external_id, created_by) values ($1, $2, 'ebay', 'active', 25, '110000002', $3) returning id`, [hA, item2, A])).rows[0].id;
const etsy2 = (await as(A, `insert into public.listings (household_id, item_id, platform, status, list_price, created_by) values ($1, $2, 'etsy', 'draft', 18, $3) returning id`, [hA, item2, A])).rows[0].id;
async function offerWithTask(listingId, amount, extra = {}) {
  const id = (await as(A, `insert into public.offers (household_id, listing_id, amount, source, external_id) values ($1, $2, $3, $4, $5) returning id`, [hA, listingId, amount, extra.source ?? "email", extra.externalId ?? null])).rows[0].id;
  await as(A, `insert into public.agent_tasks (household_id, kind, title, listing_id, item_id, offer_id, requested_by) values ($1, 'offer_decision', $2, $3, $4, $5, 'gmail-watcher')`, [hA, `Offer: $${amount} on test`, listingId, item2, id]);
  return id;
}
const low = await offerWithTask(vinted2, 8);
const mid = await offerWithTask(vinted2, 12);
const good = await offerWithTask(vinted2, 15);
const ebayOffer = await offerWithTask(ebay2, 22, { source: "api", externalId: "BO-9" });

await expectError(() => asAnon("select public.assistant_inbox($1)", ["rhq_" + "x".repeat(43)]), "unknown assistant key is rejected", /Invalid assistant key/);
await expectError(() => asAnon("select public.assistant_inbox($1)", ["short"]), "malformed assistant key is rejected", /Invalid assistant key/);
const inbox1 = (await asAnon("select public.assistant_inbox($1) as v", [token])).rows[0].v;
check(inbox1.household?.id === hA && inbox1.assistant === "muse" && inbox1.member?.name === "Alex", "inbox identifies the household, the member and the assistant");
const inboxOffer = inbox1.pending_offers.find(o => o.offer_id === good);
check(Boolean(inboxOffer) && Number(inboxOffer.amount) === 15 && inboxOffer.item.name === "Toddler rain boots" && Number(inboxOffer.item.floor_price) === 10 && inboxOffer.listing.platform === "vinted" && inboxOffer.is_new === true,
  "inbox lists pending offers with item, floor and platform, flagged new on first check");
check(inbox1.listings.some(l => l.listing_id === etsy2 && l.status === "draft") && !inbox1.tasks.some(t => t.kind === "offer_decision"), "inbox lists live listings for matching and keeps offer tasks out of the to-do list");
const inbox2 = (await asAnon("select public.assistant_inbox($1) as v", [token])).rows[0].v;
check(inbox2.pending_offers.find(o => o.offer_id === good)?.is_new === false, "second check no longer flags the same offer as new");
check((await as(A, "select last_used_at from public.assistant_keys where id = $1", [key.id])).rows[0].last_used_at !== null, "key use is recorded");

await expectError(() => asAnon("select public.apply_offer_decision($1, $2, 'x', $3, 'accepted', null, 0, 0, true)", [hA, A, good]), "anon cannot call the decision core directly", /permission denied/);
await expectError(() => asAnon("select public.apply_sale($1, $2, 'x', $3, 1, 0, 0, null)", [hA, A, vinted2]), "anon cannot call the sale core directly", /permission denied/);
await expectError(() => asAnon("select * from public.assistant_resolve_key($1)", [token]), "anon cannot resolve keys directly", /permission denied/);
await expectError(() => asAnon("select public.assistant_decide_offer($1, $2, 'accepted')", [token, low]), "assistant cannot accept an offer below the floor price", /below the floor price/);
await expectError(() => asAnon("select public.assistant_decide_offer($1, $2, 'countered', 9)", [token, mid]), "assistant cannot counter below the floor price", /below the floor price/);
await expectError(() => asAnon("select public.assistant_decide_offer($1, $2, 'countered')", [token, mid]), "a counter needs an amount", /counter needs an amount/);
await expectError(() => asAnon("select public.assistant_decide_offer($1, $2, 'maybe')", [token, mid]), "decision must be accepted, declined or countered", /Invalid decision/);
const declined = (await asAnon("select public.assistant_decide_offer($1, $2, 'declined') as v", [token, low])).rows[0].v;
check(declined.decision === "declined" && declined.tasks_closed === 1 && declined.item.name === "Toddler rain boots", "assistant declines an offer and its task is closed");
const countered = (await asAnon("select public.assistant_decide_offer($1, $2, 'countered', 14) as v", [token, mid])).rows[0].v;
check(countered.decision === "countered" && Number(countered.counter_amount) === 14, "assistant counters at or above the floor");
check((await as(A, "select status, counter_amount, decided_by from public.offers where id = $1", [mid])).rows[0].decided_by === A, "relayed decisions are attributed to the key's member");
await expectError(() => asAnon("select public.assistant_decide_offer($1, $2, 'accepted')", [token, mid]), "an offer cannot be decided twice", /already been decided/);

const accepted = (await asAnon("select public.assistant_decide_offer($1, $2, 'accepted', null, 0, 0) as v", [token, good])).rows[0].v;
check(accepted.decision === "accepted" && accepted.sale && Number(accepted.sale.sale_price) === 15 && accepted.sale.delist_tasks === 2, "accepting records the sale and queues delist tasks for the two other listings");
const soldItem = (await as(A, "select status, sold_price from public.inventory_items where id = $1", [item2])).rows[0];
check(soldItem.status === "sold" && Number(soldItem.sold_price) === 15, "accepting marks the item sold");
check((await as(A, "select status from public.listings where id = $1", [vinted2])).rows[0].status === "sold", "accepting marks the listing sold");
check((await as(A, "select status from public.offers where id = $1", [ebayOffer])).rows[0].status === "declined", "pending offers on the item's other listings are declined");
check((await as(A, "select status from public.agent_tasks where offer_id = $1", [ebayOffer])).rows[0].status === "cancelled", "and their decision tasks are cancelled");
const delistTasks = (await as(A, "select id, listing_id, title from public.agent_tasks where item_id = $1 and kind = 'delist' order by title", [item2])).rows;
check(delistTasks.length === 2 && delistTasks.some(t => t.title === "Pull it off eBay, it already fucking sold") && delistTasks.some(t => t.title === "Pull it off Etsy, it already fucking sold"), "delist tasks name the platform like the app does");
const acceptLog = (await as(A, "select actor_user, actor_agent, action, detail from public.activity_log where entity_id = $1 and action = 'offer_accepted'", [good])).rows[0];
check(acceptLog?.actor_user === A && acceptLog?.actor_agent === "muse" && Number(acceptLog.detail.amount) === 15, "activity log shows the member and the assistant");
check((await as(A, "select count(*)::int as n from public.activity_log where household_id = $1 and action = 'sale_recorded' and actor_agent = 'muse'", [hA])).rows[0].n === 1, "the sale itself is logged too");
await expectError(() => asAnon("select public.assistant_record_sale($1, $2, 9)", [token, ebay2]), "an item cannot be sold twice", /already recorded as sold/);

// Floor override is explicit.
const item4 = (await as(A, `insert into public.inventory_items (household_id, created_by, name, floor_price) values ($1, $2, 'Wooden puzzle', 10) returning id`, [hA, A])).rows[0].id;
const vinted4 = (await as(A, `insert into public.listings (household_id, item_id, platform, status, list_price, created_by) values ($1, $2, 'vinted', 'active', 14, $3) returning id`, [hA, item4, A])).rows[0].id;
const low4 = (await as(A, `insert into public.offers (household_id, listing_id, amount) values ($1, $2, 8) returning id`, [hA, vinted4])).rows[0].id;
await expectError(() => asAnon("select public.assistant_decide_offer($1, $2, 'accepted')", [token, low4]), "below-floor accept is refused without an override", /below the floor price/);
check((await asAnon("select public.assistant_decide_offer($1, $2, 'accepted', null, 0, 0, true) as v", [token, low4])).rows[0].v.decision === "accepted", "below-floor accept goes through with an explicit override");

// Recording offers and sales the assistant saw in email.
const item3 = (await as(A, `insert into public.inventory_items (household_id, created_by, name, floor_price) values ($1, $2, 'Kids bike helmet', 5) returning id`, [hA, A])).rows[0].id;
const vinted3 = (await as(A, `insert into public.listings (household_id, item_id, platform, status, list_price, created_by) values ($1, $2, 'vinted', 'draft', 9, $3) returning id`, [hA, item3, A])).rows[0].id;
const rec1 = (await asAnon("select public.assistant_record_offer($1, $2, 7, 'buyer_42', 'From Gmail: New offer', 'email') as v", [token, vinted3])).rows[0].v;
check(rec1.duplicate === false && rec1.item.name === "Kids bike helmet", "assistant records an offer it saw in an email");
const recTask = (await as(A, "select title, requested_by, status from public.agent_tasks where offer_id = $1", [rec1.offer_id])).rows[0];
check(recTask?.title === "Offer: $7.00 for Kids bike helmet on Vinted" && recTask.requested_by === "muse", "a decision task is created with the watcher's title format");
const rec2 = (await asAnon("select public.assistant_record_offer($1, $2, 7) as v", [token, vinted3])).rows[0].v;
check(rec2.duplicate === true && rec2.offer_id === rec1.offer_id, "the same amount within two days is the same offer");
await expectError(() => asAnon("select public.assistant_record_offer($1, $2, 7)", [token, vinted2]), "cannot record an offer on a sold listing", /cannot take offers/);
const hBListing = (await as(B, `insert into public.inventory_items (household_id, created_by, name) values ($1, $2, 'B thing') returning id`, [hB, B])).rows[0].id;
const hBVinted = (await as(B, `insert into public.listings (household_id, item_id, platform, status, list_price, created_by) values ($1, $2, 'vinted', 'active', 3, $3) returning id`, [hB, hBListing, B])).rows[0].id;
await expectError(() => asAnon("select public.assistant_record_offer($1, $2, 2)", [token, hBVinted]), "a key cannot touch another household's listing", /Listing not found/);
const sale3 = (await asAnon("select public.assistant_record_sale($1, $2, 9, 0, 0) as v", [token, vinted3])).rows[0].v;
check(Number(sale3.sale_price) === 9 && sale3.delist_tasks === 0, "assistant records a confirmed sale");
check((await as(A, "select status from public.offers where id = $1", [rec1.offer_id])).rows[0].status === "declined", "recording a sale declines the listing's pending offers");

// Notes, to-dos.
const note3 = (await asAnon("select public.assistant_add_note($1, 'Patrick says the box is in the garage', $2) as v", [token, item3])).rows[0].v;
check((await as(A, "select author, body from public.notes where id = $1", [note3.note_id])).rows[0].author === A, "assistant notes are authored by the member");
await expectError(() => asAnon("select public.assistant_add_note($1, 'x', $2)", [token, hBListing]), "cannot comment on another household's item", /Item not found/);
await expectError(() => asAnon("select public.assistant_add_note($1, '   ')", [token]), "a note needs text", /needs some text/);
const prop = (await asAnon("select public.assistant_propose_task($1, 'message_reply', 'Buyer message on Vinted: is it waterproof?', 'Asked about the boots') as v", [token])).rows[0].v;
check(prop.duplicate === false && (await as(A, "select requested_by, status from public.agent_tasks where id = $1", [prop.task_id])).rows[0].requested_by === "muse", "assistant proposes a to-do");
check((await asAnon("select public.assistant_propose_task($1, 'other', 'Buyer message on Vinted: is it waterproof?') as v", [token])).rows[0].v.duplicate === true, "same title within three days is not repeated");
await expectError(() => asAnon("select public.assistant_propose_task($1, 'delist', 'x')", [token]), "assistant cannot create delist or offer tasks directly", /Kind must be/);
const ebayDelist = delistTasks.find(t => t.listing_id === ebay2);
check((await asAnon("select public.assistant_resolve_task($1, $2, 'done') as v", [token, ebayDelist.id])).rows[0].v.status === "done", "assistant closes a delist task");
check((await as(A, "select status from public.listings where id = $1", [ebay2])).rows[0].status === "ended", "closing a delist task ends the listing");
await expectError(() => asAnon("select public.assistant_resolve_task($1, $2, 'done')", [token, ebayDelist.id]), "a closed task stays closed", /already done/);
const offerTask = (await as(A, "select id from public.agent_tasks where offer_id = $1", [mid])).rows[0];
await expectError(() => asAnon("select public.assistant_resolve_task($1, $2, 'done')", [token, offerTask.id]), "offer tasks are decided through the offer, not closed", /Decide the offer itself/);

// Member wrappers (the app's server actions).
const memberOffer = (await as(A, `select id from public.offers where listing_id = $1 and amount = 3.99`, [listing])).rows[0].id;
await expectError(() => as(C, "select public.decide_offer($1, 'declined')", [memberOffer]), "non-member cannot decide an offer through the wrapper", /Offer not found/);
await expectError(() => asAnon("select public.decide_offer($1, 'declined')", [memberOffer]), "anon cannot call the member wrapper", /permission denied/);
check((await as(A, "select public.decide_offer($1, 'declined') as v", [memberOffer])).rows[0].v.decision === "declined", "member declines through the shared core");
check((await as(A, "select actor_user, actor_agent from public.activity_log where entity_id = $1 and action = 'offer_declined'", [memberOffer])).rows[0].actor_agent === null, "member decisions carry no actor_agent");
await expectError(() => as(A, "select public.record_sale($1, 5)", [listing]), "member cannot record a second sale for an item", /already recorded as sold/);
await expectError(() => as(C, "select public.record_sale($1, 5)", [hBVinted]), "non-member cannot record a sale through the wrapper", /Listing not found/);

// Revocation.
await expectError(() => as(B, "update public.assistant_keys set key_hash = $2 where id = $1", [key.id, "c".repeat(64)]), "key hash cannot be changed by clients", /permission denied/);
check((await as(B, "update public.assistant_keys set revoked_at = now() where id = $1 returning id", [key.id])).rows.length === 1, "a co-member can revoke a key");
await expectError(() => asAnon("select public.assistant_inbox($1)", [token]), "a revoked key no longer works", /Invalid assistant key/);
await expectError(() => as(A, "update public.assistant_keys set revoked_at = null where id = $1", [key.id]), "a revoked key cannot be un-revoked", /stays revoked/);
check((await as(B, "delete from public.assistant_keys where id = $1 returning id", [key.id])).rows.length === 0, "member (non-admin) cannot delete a key");
check((await as(A, "delete from public.assistant_keys where id = $1 returning id", [key.id])).rows.length === 1, "admin deletes a key");

// --- phone notifications (web push). A and B are members of hA, C is not ---
const vapidPub = "B" + "v".repeat(86);
const vapidPriv = "k".repeat(43);
const p256 = "B" + "p".repeat(86);
const authKey = "a".repeat(22);
const endA = "https://web.push.apple.com/QA-phone";
const endB = "https://web.push.apple.com/QB-phone";
const queued = async (where = "true") => (await db.query(`select count(*)::int as n from public.push_queue where ${where}`)).rows[0].n;
const lit = arr => `{${arr.map(e => `"${e}"`).join(",")}}`;

await expectError(() => as(A, "select household_id from public.push_config"), "members cannot read push settings (VAPID private key, dispatch token)", /permission denied/);
await expectError(() => asAnon("select household_id from public.push_config"), "anon cannot read push settings", /permission denied/);
await expectError(() => as(A, "insert into public.push_config (household_id, vapid_public_key, vapid_private_key) values ($1, $2, $3)", [hA, vapidPub, vapidPriv]),
  "clients cannot write push settings directly", /permission denied/);
await expectError(() => asAnon("select public.push_prepare($1, $2, $3)", [hA, vapidPub, vapidPriv]), "anon cannot set up notifications", /permission denied/);
await expectError(() => as(C, "select public.push_prepare($1, $2, $3)", [hA, vapidPub, vapidPriv]), "non-member cannot set up another household's notifications", /Household not found/);
await expectError(() => as(A, "select public.push_subscribe($1, $2, $3, $4, 'iPhone')", [hA, endA, p256, authKey]),
  "a phone cannot subscribe before the household has a key pair", /not set up/);
const pubKey1 = (await as(A, "select public.push_prepare($1, $2, $3) as k", [hA, vapidPub, vapidPriv])).rows[0].k;
const pubKey2 = (await as(B, "select public.push_prepare($1, $2, $3) as k", [hA, "C" + "w".repeat(86), "m".repeat(43)])).rows[0].k;
check(pubKey1 === vapidPub && pubKey2 === vapidPub, "the household keeps its first VAPID key pair");
await expectError(() => as(B, "select public.push_prepare($1, 'not a key', $2)", [hB, vapidPriv]), "a malformed VAPID key is refused", /check constraint/);

await as(A, "insert into public.agent_tasks (household_id, kind, title, requested_by) values ($1, 'other', 'Nobody subscribed yet', 'test')", [hA]);
check(await queued() === 0, "nothing is queued while no phone has notifications on");
await expectError(() => as(A, "insert into public.push_subscriptions (household_id, user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4, $5)", [hA, A, endA, p256, authKey]),
  "clients cannot write subscriptions directly", /permission denied/);
const subA = (await as(A, "select public.push_subscribe($1, $2, $3, $4, 'iPhone', 'https://resale.example.com') as id", [hA, endA, p256, authKey])).rows[0].id;
check(typeof subA === "string", "member turns on notifications for their phone");
await as(A, "select public.push_subscribe($1, $2, $3, $4, 'iPhone', 'https://resale.example.com')", [hA, endA, p256, authKey]);
check((await as(A, "select count(*)::int as n from public.activity_log where action = 'push_enabled' and entity_id = $1", [subA])).rows[0].n === 1,
  "re-saving the same phone does not repeat the activity entry");
await as(B, "select public.push_subscribe($1, $2, $3, $4, 'iPhone', 'https://resale.example.com')", [hA, endB, p256, authKey]);
await expectError(() => as(C, "select public.push_subscribe($1, $2, $3, $4)", [hA, "https://web.push.apple.com/QC-intruder", p256, authKey]),
  "non-member cannot add a phone to another household", /Household not found/);
await expectError(() => asAnon("select public.push_subscribe($1, $2, $3, $4)", [hA, "https://web.push.apple.com/QAnon", p256, authKey]), "anon cannot add a phone", /permission denied/);
await expectError(() => as(A, "select public.push_subscribe($1, 'http://push.example.com/x', $2, $3)", [hA, p256, authKey]), "a push endpoint must be https", /check constraint/);
await expectError(() => as(A, "select public.push_subscribe($1, $2, 'short', $3)", [hA, "https://web.push.apple.com/QBad", authKey]), "push keys must be well formed", /check constraint/);
await expectError(() => as(A, "select public.push_subscribe($1, $2, $3, $4, 'iPad', 'https://x.example.com/path')", [hA, "https://web.push.apple.com/QOrigin", p256, authKey]),
  "the app address must be a bare origin", /check constraint/);
const seenDevices = (await as(B, "select user_id, device_label, last_success_at from public.push_subscriptions where household_id = $1 order by created_at", [hA])).rows;
check(seenDevices.length === 2 && seenDevices.every(d => d.device_label === "iPhone"), "co-members see which phones have notifications on");
await expectError(() => as(B, "select endpoint from public.push_subscriptions"), "push endpoints are not readable by clients", /permission denied/);
await expectError(() => as(B, "select p256dh, auth from public.push_subscriptions"), "push keys are not readable by clients", /permission denied/);
check((await as(C, "select id from public.push_subscriptions")).rows.length === 0, "non-member sees no notification devices");
await expectError(() => asAnon("select id from public.push_subscriptions"), "anon cannot see notification devices", /permission denied/);
await expectError(() => as(A, "select id from public.push_queue"), "clients cannot read the push queue", /permission denied/);
await expectError(() => as(A, "insert into public.push_queue (household_id, kind) values ($1, 'test')", [hA]), "clients cannot write the push queue", /permission denied/);

// Queueing. There is no pg_net in this database, so rows wait for a dispatcher.
await as(A, "insert into public.agent_tasks (household_id, kind, title, requested_by) values ($1, 'message_reply', 'Buyer message on Vinted: still available?', 'gmail-watcher')", [hA]);
check(await queued(`household_id = '${hA}' and kind = 'task' and claimed_at is null`) === 1, "a new pending to-do is queued for the phones");
await as(A, "insert into public.agent_tasks (household_id, kind, title, requested_by, status) values ($1, 'other', 'Already handled', 'test', 'done')", [hA]);
check(await queued(`household_id = '${hA}'`) === 1, "a to-do that is not pending is not queued");
await as(B, "insert into public.agent_tasks (household_id, kind, title, requested_by) values ($1, 'other', 'B house to-do', 'test')", [hB]);
check(await queued(`household_id = '${hB}'`) === 0, "a household with no phones set up queues nothing");

// Dispatch: the database hands the app the household's token; nothing works without it.
const dispatchToken = (await db.query("select dispatch_token from public.push_config where household_id = $1", [hA])).rows[0].dispatch_token;
check(/^[0-9a-f]{64}$/.test(dispatchToken), "each household gets a 64-hex-character dispatch token");
await expectError(() => asAnon("select public.push_claim($1, $2)", [hA, "0".repeat(64)]), "a wrong dispatch token is refused", /Invalid dispatch token/);
await expectError(() => asAnon("select public.push_claim($1, $2)", [hA, "not-a-token"]), "a malformed dispatch token is refused", /Invalid dispatch token/);
await expectError(() => asAnon("select public.push_claim($1, $2)", [hB, dispatchToken]), "a token only works for its own household", /Invalid dispatch token/);
await expectError(() => asAnon("select public.push_check_token($1, $2)", [hA, dispatchToken]), "anon cannot call the token check directly", /permission denied/);
const claim1 = (await asAnon("select public.push_claim($1, $2) as v", [hA, dispatchToken])).rows[0].v;
check(claim1.items.length === 1 && claim1.items[0].kind === "task" && claim1.items[0].task.title === "Buyer message on Vinted: still available?" && claim1.items[0].task.status === "pending",
  "the dispatcher claims the waiting to-do");
check(claim1.subscriptions.length === 2 && claim1.subscriptions.every(s => s.endpoint && s.p256dh && s.auth) && claim1.vapid_private_key === vapidPriv && claim1.origin === "https://resale.example.com",
  "the claim carries the household's phones, key pair and address");
check(Number(claim1.pending_count) > 0, "the claim carries the pending count for the app-icon badge");
check((await asAnon("select public.push_claim($1, $2) as v", [hA, dispatchToken])).rows[0].v.items.length === 0, "a claimed row is never sent twice");

// Test buzz: only to the member who asked.
check((await as(A, "select public.push_send_test($1) as n", [hA])).rows[0].n === 1, "a test is queued for the member's phone");
await expectError(() => as(C, "select public.push_send_test($1)", [hA]), "non-member cannot send a test to another household", /Household not found/);
const claim2 = (await asAnon("select public.push_claim($1, $2) as v", [hA, dispatchToken])).rows[0].v;
check(claim2.items.length === 1 && claim2.items[0].kind === "test" && claim2.items[0].target_user === A, "a test is addressed to the member who asked");

// Reporting back after sending.
await expectError(() => asAnon("select public.push_report($1, $2, $3::text[], $4::text[])", [hA, "f".repeat(64), lit([endA]), lit([])]), "a report needs the dispatch token", /Invalid dispatch token/);
const report = (await asAnon("select public.push_report($1, $2, $3::text[], $4::text[]) as v", [hA, dispatchToken, lit([endB]), lit([endA])])).rows[0].v;
check(report.removed === 1 && report.delivered === 1, "dead phones are forgotten and delivered ones are marked");
check((await as(A, "select last_success_at from public.push_subscriptions where id = $1", [subA])).rows[0].last_success_at !== null, "a delivered phone shows when it last buzzed");
check((await as(A, "select count(*)::int as n from public.push_subscriptions where household_id = $1", [hA])).rows[0].n === 1, "the dead phone is gone");

// The real path: with pg_net present, the trigger asks the app to send (once per transaction) and a failed
// request never blocks the to-do. This stand-in for net.http_post records what pg_net would send.
await db.exec(`
  create schema if not exists net;
  create table if not exists net.sent (id serial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds int);
  create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
      headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 2000)
  returns bigint language plpgsql as $$
  begin
    if url like 'https://down.example.com%' then raise exception 'connection refused'; end if;
    insert into net.sent (url, body, headers, timeout_milliseconds) values (url, body, headers, timeout_milliseconds);
    return lastval();
  end $$;
`);
const sentCount = async () => (await db.query("select count(*)::int as n from net.sent")).rows[0].n;
await as(A, "insert into public.agent_tasks (household_id, kind, title, requested_by) values ($1, 'other', 'Confirm sale: thing on Vinted for $5', 'gmail-watcher')", [hA]);
const pokeReq = (await db.query("select url, body, headers from net.sent order by id desc limit 1")).rows[0];
check(pokeReq?.url === "https://resale.example.com/api/push/dispatch" && pokeReq.body.household_id === hA && pokeReq.body.token === dispatchToken && pokeReq.headers["Content-Type"] === "application/json",
  "a new to-do makes the database POST the household id and token to the app");
const sentBefore = await sentCount();
await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${A}', false); set role authenticated;
  begin;
  insert into public.agent_tasks (household_id, kind, title, requested_by) values ('${hA}', 'delist', 'Pull it off eBay', 'system');
  insert into public.agent_tasks (household_id, kind, title, requested_by) values ('${hA}', 'delist', 'Pull it off Etsy', 'system');
  commit;
  reset role;`);
check(await sentCount() === sentBefore + 1, "two to-dos written together cause one request");
await db.query("update public.push_config set app_origin = 'https://down.example.com' where household_id = $1", [hA]);
const taskWhenDown = (await as(A, "insert into public.agent_tasks (household_id, kind, title, requested_by) values ($1, 'other', 'Written while the app is down', 'test') returning id", [hA])).rows[0];
check(Boolean(taskWhenDown?.id) && await queued(`task_id = '${taskWhenDown.id}' and claimed_at is null`) === 1, "a failed request never blocks the to-do; it waits in the queue");
check((await asAnon("select public.push_claim($1, $2) as v", [hA, dispatchToken])).rows[0].v.items.length === 4, "the next dispatch picks up everything still waiting");
await db.query("update public.push_config set app_origin = 'https://resale.example.com' where household_id = $1", [hA]);

// Turning it off.
check((await as(B, "select public.push_unsubscribe($1) as ok", [endA])).rows[0].ok === false, "a member cannot turn off someone else's phone");
check((await as(A, "select public.push_unsubscribe($1) as ok", [endA])).rows[0].ok === true, "a member turns off their own phone");
const pushLog = (await as(A, "select action from public.activity_log where entity_type = 'push_subscription' order by id")).rows.map(r => r.action);
check(pushLog.filter(a => a === "push_enabled").length === 2 && pushLog.at(-1) === "push_disabled", "turning phones on and off shows in the activity feed");
await as(A, "insert into public.agent_tasks (household_id, kind, title, requested_by) values ($1, 'other', 'After everyone turned it off', 'test')", [hA]);
check(await queued(`household_id = '${hA}' and claimed_at is null`) === 0, "with no phones left, nothing is queued");

// --- whose shit is it, and hand-offs ("that's Sam's, go ask Sam"). A (Alex) and B (Sam) are members of hA, C is not ---
const handItem = (await as(A, "insert into public.inventory_items (household_id, created_by, name) values ($1, $2, 'Helmet mount') returning id", [hA, A])).rows[0].id;
await expectError(() => as(A, "update public.inventory_items set owner_user = $2 where id = $1", [handItem, C]), "an item's owner has to be in the household", /not in this household/);
await expectError(() => as(A, "insert into public.inventory_items (household_id, created_by, name, owner_user) values ($1, $2, 'Not theirs', $3)", [hA, A, C]),
  "a new item cannot belong to an outsider", /not in this household/);
check((await as(B, "update public.inventory_items set owner_user = $2 where id = $1 returning owner_user", [handItem, B])).rows[0].owner_user === B, "a member marks a thing as theirs");
check((await as(A, "update public.inventory_items set owner_user = null where id = $1 returning owner_user", [handItem])).rows[0].owner_user === null, "and back to ours");

await as(A, "select public.push_subscribe($1, $2, $3, $4, 'iPhone', 'https://resale.example.com')", [hA, endA, p256, authKey]);
await as(B, "select public.push_subscribe($1, $2, $3, $4, 'iPhone', 'https://resale.example.com')", [hA, endB, p256, authKey]);
const handListing = (await as(A, "insert into public.listings (household_id, item_id, platform, status, list_price, created_by) values ($1, $2, 'ebay', 'active', 39.99, $3) returning id", [hA, handItem, A])).rows[0].id;
const handOffer = (await as(A, "insert into public.offers (household_id, listing_id, amount) values ($1, $2, 30) returning id", [hA, handListing])).rows[0].id;
const handTask = (await as(A, `insert into public.agent_tasks (household_id, kind, title, item_id, listing_id, offer_id, requested_by)
  values ($1, 'offer_decision', 'Offer: $30 for Helmet mount on eBay', $2, $3, $4, 'gmail-watcher') returning id`, [hA, handItem, handListing, handOffer])).rows[0].id;
const claimPlain = (await asAnon("select public.push_claim($1, $2) as v", [hA, dispatchToken])).rows[0].v;
check(claimPlain.items.length === 1 && claimPlain.items[0].task.owner_id === null && claimPlain.items[0].item.name === "Helmet mount", "an offer on a shared thing carries no owner");
const hBOffer = (await as(B, "insert into public.offers (household_id, listing_id, amount) values ($1, $2, 2) returning id", [hB, hBVinted])).rows[0].id;

await expectError(() => asAnon("select public.handoff_item($1, $2, $3)", [hA, B, handOffer]), "anon cannot hand things off", /permission denied/);
await expectError(() => as(C, "select public.handoff_item($1, $2, $3)", [hA, B, handOffer]), "a non-member cannot hand off another household's offer", /Household not found/);
await expectError(() => as(A, "select public.handoff_item($1, $2, $3)", [hA, C, handOffer]), "cannot hand off to someone outside the household", /not in this household/);
await expectError(() => as(A, "select public.handoff_item($1, $2, $3)", [hA, A, handOffer]), "cannot hand off to yourself", /That's you/);
await expectError(() => as(A, "select public.handoff_item($1, $2)", [hA, B]), "a hand-off needs an offer or an item", /Say which offer or item/);
await expectError(() => as(A, "select public.handoff_item($1, $2, $3)", [hA, B, hBOffer]), "cannot hand off another household's offer", /Offer not found/);
await expectError(() => as(A, "select public.handoff_item($1, $2, $3, $4)", [hA, B, handOffer, item]), "the offer and the item have to match", /different item/);
await expectError(() => asAnon("select public.apply_handoff($1, $2, null, $3, $4, null)", [hA, A, B, handOffer]), "anon cannot call the hand-off core", /permission denied/);
await expectError(() => as(A, "select public.apply_handoff($1, $2, null, $3, $4, null)", [hA, A, B, handOffer]), "members cannot call the hand-off core directly", /permission denied/);

const handed = (await as(A, "select public.handoff_item($1, $2, $3) as v", [hA, B, handOffer])).rows[0].v;
check(handed.to.id === B && handed.to.name === "Sam" && handed.from.name === "Alex" && handed.item.name === "Helmet mount" && Number(handed.offer.amount) === 30
  && handed.offer.platform_name === "eBay" && handed.task_id === handTask && handed.devices === 1, "a hand-off says who was asked, about what, and that their phone will buzz");
check((await as(A, "select owner_user from public.inventory_items where id = $1", [handItem])).rows[0].owner_user === B, "a hand-off remembers whose it is");
check((await as(B, "select payload from public.agent_tasks where id = $1", [handTask])).rows[0].payload.asked_user === B, "the offer's to-do notes who was asked");
const claimH = (await asAnon("select public.push_claim($1, $2) as v", [hA, dispatchToken])).rows[0].v;
const hItem = claimH.items.find(i => i.kind === "handoff");
check(claimH.items.length === 1 && hItem?.target_user === B && hItem.from_user === A && hItem.from_name === "Alex" && hItem.item?.name === "Helmet mount" && hItem.task?.id === handTask,
  "the hand-off buzz goes only to the person asked, from the person asking, about that offer");
check((await as(A, "select count(*)::int as n from public.activity_log where action = 'handed_off' and entity_id = $1", [handItem])).rows[0].n === 1, "hand-offs show in the activity feed");

await as(A, "insert into public.agent_tasks (household_id, kind, title, item_id, requested_by) values ($1, 'offer_decision', 'Offer: $32 for Helmet mount on eBay', $2, 'gmail-watcher')", [hA, handItem]);
const claimO = (await asAnon("select public.push_claim($1, $2) as v", [hA, dispatchToken])).rows[0].v;
check(claimO.items.length === 1 && claimO.items[0].kind === "task" && claimO.items[0].target_user === null && claimO.items[0].task.owner_id === B && claimO.items[0].task.owner_name === "Sam",
  "a new offer on someone's thing still goes to every phone, and says whose it is");

// Through an assistant: by name, by "the other one", and before the other member has set a name.
const token2 = "rhq_" + "h".repeat(43);
await as(A, "insert into public.assistant_keys (household_id, user_id, label, key_hash, key_prefix) values ($1, $2, 'muse', $3, $4)",
  [hA, A, createHash("sha256").update(token2, "utf8").digest("hex"), token2.slice(0, 12)]);
await as(A, "update public.inventory_items set owner_user = null where id = $1", [handItem]);
await expectError(() => asAnon("select public.assistant_handoff($1, 'Sam', $2)", ["rhq_" + "x".repeat(43), handOffer]), "a hand-off needs a valid assistant key", /Invalid assistant key/);
check((await asAnon("select public.assistant_handoff($1, 'sAm', $2) as v", [token2, handOffer])).rows[0].v.to.id === B, "an assistant hands off by name, any case");
const viaBlank = (await asAnon("select public.assistant_handoff($1, null, null, $2) as v", [token2, handItem])).rows[0].v;
check(viaBlank.to.id === B && viaBlank.offer === null && viaBlank.item.name === "Helmet mount", "no name means the only other member; a thing can be handed off without an offer");
await expectError(() => asAnon("select public.assistant_handoff($1, 'Jordan', $2)", [token2, handOffer]), "an unknown name is refused while everyone has one", /Nobody called Jordan/);
await expectError(() => asAnon("select public.assistant_handoff($1, 'Alex', $2)", [token2, handOffer]), "an assistant cannot hand its own member's thing to them", /That's you/);
await as(B, "update public.household_members set display_name = null where user_id = $1", [B]);
const viaUnnamed = (await asAnon("select public.assistant_handoff($1, 'Lauren', $2) as v", [token2, handOffer])).rows[0].v;
check(viaUnnamed.to.id === B && viaUnnamed.to.name === null, "a name reaches the only other member before they have set one");
await as(B, "update public.household_members set display_name = 'Sam' where user_id = $1", [B]);
check((await as(A, "select actor_agent from public.activity_log where action = 'handed_off' order by id desc limit 1")).rows[0].actor_agent === "muse",
  "assistant hand-offs are attributed to the assistant");
const inboxH = (await asAnon("select public.assistant_inbox($1, false) as v", [token2])).rows[0].v;
const offH = inboxH.pending_offers.find(o => o.offer_id === handOffer);
check(inboxH.members.length === 2 && inboxH.members.some(m => m.is_you && m.name === "Alex") && inboxH.members.some(m => !m.is_you && m.name === "Sam"),
  "the assistant inbox lists the household's members");
check(offH?.item.owner?.name === "Sam" && offH.item.owner.is_you === false && offH.asked?.name === "Sam", "the inbox says whose each offer's thing is and who was asked");
check(inboxH.listings.find(l => l.listing_id === handListing)?.owner === "Sam", "listings say whose they are");

await as(A, "select public.decide_offer($1, 'declined')", [handOffer]);
await expectError(() => as(A, "select public.handoff_item($1, $2, $3)", [hA, B, handOffer]), "an answered offer cannot be handed off", /already answered/);
check((await as(B, "select public.handoff_item($1, $2, null, $3) as v", [hA, A, handItem])).rows[0].v.to.name === "Alex", "it works the other way round too");

// --- More marketplaces (20261101010000): OfferUp and ThredUp listings, delist titles use real names.
const itemM = (await as(A, `insert into public.inventory_items (household_id, created_by, name, floor_price) values ($1, $2, 'Cordless drill', 20) returning id`, [hA, A])).rows[0].id;
const offerupL = (await as(A, `insert into public.listings (household_id, item_id, platform, status, list_price, created_by) values ($1, $2, 'offerup', 'active', 40, $3) returning id`, [hA, itemM, A])).rows[0].id;
await as(A, `insert into public.listings (household_id, item_id, platform, status, list_price, created_by) values ($1, $2, 'mercari', 'active', 45, $3)`, [hA, itemM, A]);
await as(A, `insert into public.listings (household_id, item_id, platform, status, list_price, created_by) values ($1, $2, 'thredup', 'active', 0, $3)`, [hA, itemM, A]);
check(true, "OfferUp and ThredUp listings are allowed");
await expectError(() => as(A, `insert into public.listings (household_id, item_id, platform, list_price, created_by) values ($1, $2, 'craigslist', 1, $3)`, [hA, itemM, A]),
  "unknown platforms are still rejected", /check constraint/);
await as(A, "select public.record_sale($1, 40)", [offerupL]);
const delists = (await as(A, "select title from public.agent_tasks where item_id = $1 and kind = 'delist' order by title", [itemM])).rows.map(r => r.title);
check(delists.length === 2 && delists.some(t => t.includes("Mercari")) && delists.some(t => t.includes("ThredUp")),
  "selling on OfferUp queues delist to-dos for Mercari and ThredUp with proper names");
check((await db.query("select public.platform_display_name('offerup') as n")).rows[0].n === "OfferUp", "OfferUp's display name");
// --- Platform toggles (20261101030000): wants are household-scoped; gaps view shows wanted-but-not-live and live-but-not-wanted.
const itemW = (await as(A, `insert into public.inventory_items (household_id, created_by, name, floor_price) values ($1, $2, 'Running shoes', 15) returning id`, [hA, A])).rows[0].id;
await as(A, `insert into public.item_platform_wants (household_id, item_id, platform, wanted, set_by) values ($1, $2, 'mercari', true, $3), ($1, $2, 'poshmark', false, $3)`, [hA, itemW, A]);
await as(A, `insert into public.listings (household_id, item_id, platform, status, list_price, created_by) values ($1, $2, 'poshmark', 'active', 30, $3)`, [hA, itemW, A]);
await expectError(() => as(C, `insert into public.item_platform_wants (household_id, item_id, platform, wanted, set_by) values ($1, $2, 'ebay', true, $3)`, [hA, itemW, C]),
  "non-member cannot set platform wants for another household", /row-level security/);
check((await as(C, "select count(*)::int as n from public.item_platform_wants where item_id = $1", [itemW])).rows[0].n === 0, "non-member cannot read platform wants");
const gaps = (await as(A, "select platform, gap from public.item_platform_gaps where item_id = $1 order by platform", [itemW])).rows;
check(gaps.length === 2 && gaps[0].platform === "mercari" && gaps[0].gap === "needs_listing" && gaps[1].platform === "poshmark" && gaps[1].gap === "needs_delisting",
  "gaps view lists wanted-but-not-live and live-but-not-wanted");
check((await as(C, "select count(*)::int as n from public.item_platform_gaps where item_id = $1", [itemW])).rows[0].n === 0, "gaps view respects RLS (security_invoker)");
await as(A, `insert into public.listings (household_id, item_id, platform, status, list_price, created_by) values ($1, $2, 'mercari', 'active', 32, $3)`, [hA, itemW, A]);
check((await as(A, "select count(*)::int as n from public.item_platform_gaps where item_id = $1 and platform = 'mercari'", [itemW])).rows[0].n === 0, "a live listing closes the needs_listing gap");

// --- Assistant switches and comps (20261101040000) -------------------------------------------------
{
  const itemS = (await as(A, `insert into public.inventory_items (household_id, created_by, name, brand, floor_price, target_price) values ($1, $2, 'Air Max 90 sneakers', 'Nike', 30, 60) returning id`, [hA, A])).rows[0].id;
  const found = (await asAnon("select public.assistant_find_items($1, 'nike') as v", [token2])).rows[0].v;
  check(found.some(i => i.item_id === itemS), "assistant can find an unlisted item by brand");
  const poshL = (await as(A, `insert into public.listings (household_id, item_id, platform, status, list_price, created_by) values ($1, $2, 'poshmark', 'active', 60, $3) returning id`, [hA, itemS, A])).rows[0].id;

  const on = (await asAnon("select public.assistant_set_platform($1, $2, 'mercari', true) as v", [token2, itemS])).rows[0].v;
  check(on.outcome === "todo_post" && on.task_id, "switching Mercari on writes a post to-do");
  const again = (await asAnon("select public.assistant_set_platform($1, $2, 'mercari', true) as v", [token2, itemS])).rows[0].v;
  check(again.task_id === on.task_id, "switching on twice doesn't add a second to-do");
  const off = (await asAnon("select public.assistant_set_platform($1, $2, 'poshmark', false) as v", [token2, itemS])).rows[0].v;
  check(off.outcome === "todo_pull", "switching off a live Poshmark listing writes a pull to-do");
  check((await db.query("select listing_id, requested_by, kind from public.agent_tasks where id = $1", [off.task_id])).rows[0].listing_id === poshL, "pull to-do points at the live listing");
  const back = (await asAnon("select public.assistant_set_platform($1, $2, 'poshmark', true) as v", [token2, itemS])).rows[0].v;
  check(back.outcome === "already_live" && (await db.query("select status from public.agent_tasks where id = $1", [off.task_id])).rows[0].status === "cancelled",
    "switching back on cancels the pull to-do");
  check((await db.query("select actor_agent from public.activity_log where action = 'platform_on' order by id desc limit 1")).rows[0].actor_agent === "muse", "switch flips are attributed to the assistant");
  await expectError(() => asAnon("select public.assistant_set_platform($1, $2, 'craigslist', true)", [token2, itemS]), "unknown platforms are rejected", /Unknown platform/);

  const comp = (await asAnon("select public.assistant_add_comp($1, $2, 'ebay', 'Nike Air Max 90 size 10', 40, 0, 'https://www.ebay.com/itm/123', 'sold') as v", [token2, itemS])).rows[0].v;
  const comp2 = (await asAnon("select public.assistant_add_comp($1, $2, 'ebay', 'Nike Air Max 90 size 10', 38, 0, 'https://www.ebay.com/itm/123', 'sold') as v", [token2, itemS])).rows[0].v;
  check(comp.comp_id === comp2.comp_id, "the same link updates the comp instead of duplicating it");
  await expectError(() => asAnon("select public.assistant_add_comp($1, $2, 'ebay', 'x', 5, null, 'http://insecure.example')", [token2, itemS]), "comp links must be https", /https/);

  const detail = (await asAnon("select public.assistant_item($1, $2) as v", [token2, itemS])).rows[0].v;
  check(detail.switches.mercari === true && detail.switches.poshmark === true && detail.comps.length === 1 && Number(detail.comps[0].price) === 38,
    "assistant_item returns switches and comps");

  // Another household's item is invisible to this key.
  const itemB = (await as(B, `insert into public.inventory_items (household_id, created_by, name) values ($1, $2, 'B only') returning id`, [hB, B])).rows[0].id;
  await expectError(() => asAnon("select public.assistant_item($1, $2)", [token2, itemB]), "assistant cannot read another household's item", /Item not found/);
  await expectError(() => asAnon("select public.assistant_set_platform($1, $2, 'ebay', true)", [token2, itemB]), "assistant cannot flip another household's switches", /Item not found/);
  await expectError(() => asAnon("select public.assistant_add_comp($1, $2, 'ebay', 'x', 5)", [token2, itemB]), "assistant cannot add comps to another household's item", /Item not found/);
  await expectError(() => asAnon("select public.assistant_item($1, $2)", ["rhq_" + "x".repeat(43), itemS]), "a bad key gets nothing", /Invalid assistant key|not valid/);
}

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);

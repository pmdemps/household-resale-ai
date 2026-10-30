// Applies all Supabase migrations to an in-memory Postgres (PGlite) with a stubbed
// auth schema, then checks row-level security and integrity rules. Run: npm run test:db
import { PGlite } from "@electric-sql/pglite";
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
  grant usage on schema public to authenticated, anon;
  insert into auth.users values ('${A}', 'a@example.com'), ('${B}', 'b@example.com');
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
let failures = 0;
const check = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) failures++; };
async function expectError(fn, msg) { try { await fn(); check(false, msg); } catch { check(true, msg); } }

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
async function asAnon(sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); set role anon;`);
  try { return await db.query(sql, params); } finally { await db.exec("reset role;"); }
}

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
await asAnon("select public.record_ebay_account_deletion($1, $2, $3::jsonb)", ["testuser_a", "EBAY-USER-1", JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" } })]);
check(true, "anon can call record_ebay_account_deletion");
const revoked = (await as(A, "select status, access_token_enc, refresh_token_enc from public.marketplace_connections where id = $1", [conn.id])).rows[0];
check(revoked.status === "revoked" && revoked.access_token_enc === null && revoked.refresh_token_enc === null, "deletion notice revokes the connection and clears tokens");
await db.exec("reset role;");
check((await db.query("select count(*)::int as n from public.ebay_account_deletion_log")).rows[0].n === 1, "deletion notice is logged (owner view)");
await asAnon("select public.record_ebay_account_deletion($1, $2, $3::jsonb)", ["someone_else", "UNKNOWN-USER", "{}"]);
check((await db.query("select count(*)::int as n from public.ebay_account_deletion_log")).rows[0].n === 2, "unknown users are still logged, nothing else changes");

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);

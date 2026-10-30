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
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated;
  grant execute on function auth.uid() to authenticated;
  grant usage on schema public to authenticated;
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

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);

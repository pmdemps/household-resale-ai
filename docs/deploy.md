# Put Resale HQ online

Goal: one private link that you and your partner open on any phone or laptop, each signed in with your own account, both seeing the same household.

Time: about 20 minutes. Cost: $0 (Supabase Free + Vercel Hobby, which is fine for personal, non-commercial use).

## 1. Supabase (database + logins)

1. Create a project at supabase.com (or use the existing one).
2. **SQL Editor** → run each file in `supabase/migrations/` **in filename order**, once:
   1. `20261029000000_initial_schema.sql`
   2. `20261029010000_listings_offers_sales.sql`
   3. `20261029020000_notes_and_names.sql`
   4. `20261030000000_function_search_path.sql`
   5. `20261030010000_marketplace_connections.sql`
   6. `20261030020000_item_photos.sql`
   7. `20261031000000_assistant_access.sql` (offer decisions, sales and the assistant API run through its SQL functions, so the app needs it)
   8. `20261031010000_push_notifications.sql` (phone notifications; also switches on Supabase's `pg_net` extension, see step 6)
   - If the editor warns that a file has "destructive operations", that's the `drop policy if exists` / `drop trigger if exists` lines that let a file be re-run safely. Run it. Every file can be run again without harm.
3. **Project Settings → API Keys**: copy the **Project URL** and the **publishable** key. Never use the `service_role`/secret key in the web app.

## 2. Vercel (the website)

1. vercel.com → **Add New → Project** → import `household-resale-ai` from GitHub.
2. Framework is detected as Next.js. Add environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL` = Project URL
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = publishable key
3. Deploy. You get a URL like `https://household-resale-ai.vercel.app`.
   - Vercel deploys `main` to that URL and gives every PR branch its own preview link, so you can try a PR before merging.

## 3. Connect the two

In Supabase → **Authentication → URL Configuration**:
- **Site URL**: your Vercel URL
- **Redirect URLs**: `https://<your-vercel-url>/auth/callback` and `http://localhost:3000/auth/callback`

## 4. Accounts

1. Open the site → **Create account** → confirm the email → you land on **Create your household** (enter your first name too).
2. Your partner opens the same link and creates their own account.
3. You: **Settings → Household → Add member** with their email. They refresh and see everything. They can set their name under **Settings → Your name**.
4. **Lock the door:** Supabase → **Authentication → Sign In / Providers** → turn off **Allow new users to sign up**. Strangers who find the URL couldn't see your data anyway (row-level security), but now they can't even make an account.

## 5. Phone app

On iPhone: open the site in Safari → Share (on iOS 26 it's under the **•••** button) → **Add to Home Screen** → keep **Open as Web App** on → **Add**. On Android: Chrome menu → **Add to Home screen**. It opens full screen like an app, and updates whenever the site does. Sign in once inside it: the home-screen app keeps its own login, separate from Safari.

## 6. Phone notifications

Each person, on their own phone: open the home-screen app → **Settings → Phone buzzes → Turn on notifications** → allow, then **Send a test**. From then on every new to-do buzzes both phones (an offer, a sale to confirm, a buyer message, a "pull it off the other site"), whoever created it: the app, the Gmail watcher, the eBay sync or an assistant. The app icon shows how many things are waiting.

- iPhone only does this from the home-screen app (iOS 16.4 or newer), not from a Safari tab.
- Nothing to configure: no environment variables, no keys to paste. The first phone that turns it on makes the household's push key pair, which stays in the database (`push_config`, unreadable by any client).
- How it travels: a trigger queues the new to-do in `push_queue`, and Supabase's `pg_net` POSTs to `https://<your-site>/api/push/dispatch` right after the write. The app sends the notifications from there (`web-push`). The address is the production URL (`VERCEL_PROJECT_PRODUCTION_URL`, or `APP_URL` if set). Preview deployments sit behind Vercel's login, so notifications only go out from production.
- Not arriving? In Supabase → SQL Editor: `select status_code, error_msg, created from net._http_response order by created desc limit 5;` shows the last dispatch requests (kept 6 hours). 200 is good; 404 means the site doesn't have this code deployed yet.
- To stop: **Settings → Phone buzzes → Turn it off on this phone**, or turn off notifications for Resale HQ in the phone's settings. Phones that delete the app are forgotten automatically.

## Privacy notes

- The GitHub repo is public; your data is not in it. Items, prices, notes and buyers live only in Supabase, protected per household.
- Notes and item comments are household-only. Nothing in them is ever sent to a marketplace.

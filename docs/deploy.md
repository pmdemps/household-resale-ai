# Put Resale HQ online

Goal: one private link that you and your partner open on any phone or laptop, each signed in with your own account, both seeing the same household.

Time: about 20 minutes. Cost: $0 (Supabase Free + Vercel Hobby, which is fine for personal, non-commercial use).

## 1. Supabase (database + logins)

1. Create a project at supabase.com (or use the existing one).
2. **SQL Editor** → run each file in `supabase/migrations/` **in filename order**, once:
   1. `20261029000000_initial_schema.sql`
   2. `20261029010000_listings_offers_sales.sql`
   3. `20261029020000_notes_and_names.sql`
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

## 5. Phone shortcut

On iPhone: open the site in Safari → Share → **Add to Home Screen**. On Android: Chrome menu → **Add to Home screen**. It opens like an app.

## Privacy notes

- The GitHub repo is public; your data is not in it. Items, prices, notes and buyers live only in Supabase, protected per household.
- Notes and item comments are household-only. Nothing in them is ever sent to a marketplace.

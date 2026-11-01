# eBay setup (owner checklist)

What you get: **Connect eBay** in Settings, **Post to eBay** on an item (Best Offer on, lowballs under your floor auto-declined), price changes and ending from the app, buyer offers pulled into the Offers queue, and your accept / counter / decline sent back to eBay. Nothing is ever accepted or declined without a tap from you.

Time: ~45 minutes the first time (eBay's developer portal is slow), then 5 minutes to switch to production.

## 1. Developer account and keys

1. Go to <https://developer.ebay.com> → **Register** (use your normal eBay login; the developer program is free).
2. **Application Keys** (top right under your name → *Application access keys*). You get two keysets: **Sandbox** and **Production**. Each has:
   - **App ID (Client ID)** → `EBAY_CLIENT_ID`
   - **Cert ID (Client Secret)** → `EBAY_CLIENT_SECRET`
3. Start with the **Sandbox** keyset.

## 2. RuName (the OAuth redirect)

eBay does not use your URL directly as `redirect_uri`; it uses a **RuName** that points at your URL.

1. Next to the keyset click **User Tokens** → **Get a Token from eBay via Your Application** → **Add eBay Redirect URL**.
2. Fill in:
   - Display title: `Resale HQ`
   - Privacy policy URL: any page you control (your Vercel URL is fine)
   - **Your auth accepted URL:** `https://household-resale-ai.vercel.app/api/ebay/callback`
   - **Your auth declined URL:** `https://household-resale-ai.vercel.app/settings?ebay=error&reason=denied`
   - OAuth enabled: yes
3. Save. The generated **RuName** (looks like `Pat_Dempsey-PatDemps-Resale-abcdefghi`) → `EBAY_RU_NAME`.

Do this once for Sandbox and once for Production (they get different RuNames).

## 3. Marketplace Account Deletion endpoint (required before Production keys work)

eBay disables production keysets until you either subscribe to account-deletion notices or opt out. We store eBay user tokens, so we subscribe.

1. Developer portal → **Alerts & Notifications** → **Marketplace Account Deletion**.
2. Email: your address. 
3. **Notification endpoint URL:** `https://household-resale-ai.vercel.app/api/ebay/account-deletion`
4. **Verification token:** make one up, 32–80 characters, only letters, numbers, `_` and `-`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
   Put the same value in Vercel as `EBAY_DELETION_VERIFICATION_TOKEN` **and deploy before** you click Save — eBay immediately sends a challenge to the endpoint and expects the hash back.
5. Also set `SUPABASE_SERVICE_ROLE_KEY` (step 5 below) before you go live. The challenge works without it, but recording a real deletion notice does not: the database function behind the endpoint can only be run by the service role (never by the publishable key), so without it the endpoint answers `503` and eBay keeps retrying.
6. Click **Save** → it should show "verified". (Use **Send Test Notification** afterwards; the app records it in `ebay_account_deletion_log` — only SHA-256 hashes of the username and user id, never the plaintext — and revokes any matching connection, clearing its tokens, eBay username and user id.)

## 4. Business policies

Listings need a shipping, payment and return policy. In your eBay seller account (not the developer portal) open <https://www.ebay.com/bp/manage> (Account → **Business Policies**) and opt in; eBay creates defaults from your past listings. The app uses the first policy of each kind.

Sandbox note: sandbox seller accounts often cannot opt in (a known eBay catch-22). The app still publishes without policy ids where eBay allows it, and otherwise shows eBay's error text in the notice on the item page.

## 5. Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Value | Type |
|---|---|---|
| `EBAY_CLIENT_ID` | App ID of the keyset in use | Config |
| `EBAY_CLIENT_SECRET` | Cert ID of that keyset | **Secret** |
| `EBAY_RU_NAME` | RuName for that keyset | Config |
| `EBAY_ENV` | `sandbox` or `production` | Config |
| `EBAY_DELETION_VERIFICATION_TOKEN` | the token from step 3 | **Secret** |
| `TOKEN_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` — encrypts stored eBay tokens (AES-256-GCM). Keep a copy somewhere safe; losing it means everyone reconnects. | **Secret** |
| `CRON_SECRET` | any long random string; the scheduler sends it as `Authorization: Bearer …` to `/api/ebay/sync` | **Secret** |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → `service_role` (secret). **Required** for the account-deletion endpoint (`/api/ebay/account-deletion`, step 3) and the scheduled offer sync (`/api/ebay/sync`); never in the browser. Without it both routes answer 503 (the account-deletion challenge still passes, and the manual "Sync offers now" button still works). | **Secret** |
| `APP_URL` | `https://household-resale-ai.vercel.app` (no trailing slash) | Config |
| `EBAY_DEFAULT_CATEGORY_ID` | optional; leaf category used when suggestions are unavailable (sandbox). Default `88433` (Everything Else). | Config |

Redeploy after adding variables. Set Preview environments to **sandbox** values only.

Also run the new migration in Supabase SQL Editor: `supabase/migrations/20261030010000_marketplace_connections.sql` (safe to run twice).

## 6. Sandbox test plan

1. Developer portal → **Tools & Samples → Sandbox user registration**: create a **seller** and a **buyer** test user (names get a `TESTUSER_` prefix; play money refreshes weekly).
2. App → Settings → **Connect eBay** → sign in as the sandbox *seller* → you land back on Settings showing "Connected as TESTUSER_…".
3. Settings → **Ship-from location**: enter your city/state/ZIP (buyers only see city/state).
4. Open an item with a photo and a floor price → **Post to eBay at $X**. The item page shows the listing link (`sandbox.ebay.com/itm/…`).
5. Log in to <https://sandbox.ebay.com> as the *buyer*, open the listing, **Make Offer** below the floor → eBay auto-declines. Make another offer above the floor.
6. Settings → **Sync offers now** → the offer appears under Offers with "you'd keep". Tap **Counter**/**Accept**/**Decline** → check the buyer's sandbox account sees the response.
7. Change the price and **End listing** from the item page.
8. Scheduler: set up any external cron (cron-job.org, GitHub Actions, your Mac) to `POST https://household-resale-ai.vercel.app/api/ebay/sync` with header `Authorization: Bearer <CRON_SECRET>` every 10–15 minutes. (Vercel Hobby crons run at most daily, so none is bundled.)

## 7. Switch to production

1. Repeat steps 2 and 3 for the **Production** keyset (new RuName; the deletion endpoint URL and token stay the same).
2. In Vercel change `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME` to the production values and `EBAY_ENV=production`; redeploy.
3. Settings → **Connect eBay** again with your real eBay account (sandbox connections are marked and cannot be reused).
4. First real listing: pick something cheap, confirm the fee estimate against eBay's own fee preview, and check the Best Offer auto-decline price on the live listing.

## Limits worth knowing

- Trading API (offers) allows 5,000 calls/day; a 10-minute poll uses ~144 plus one per live listing.
- eBay refresh tokens last ~18 months; the app marks the connection "needs you to sign in again" when a refresh is rejected.
- Buyer messages on offers are shown to you but never acted on automatically.
- `X-EBAY-SIGNATURE` on account-deletion notices is not yet verified (TODO in `app/api/ebay/account-deletion/route.ts`); the endpoint only revokes our copy of one user's tokens.
- **Check eBay prices** (the "What others sell this for" card on each item) only needs `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`, not a connected account. It uses the Browse API with an app token (default limit 5,000 calls/day). Sandbox has almost no listings, so real comps need **production** keys. It shows current Buy It Now listings. Sold prices need Marketplace Insights, which requires eBay's approval.

# Etsy setup (not built yet — apply for access now)

Etsy's Open API v3 needs an **approved app key** before any code can talk to it, and approval takes weeks (reports: ~3 weeks for personal use, months for commercial). Apply first; the integration can be built while you wait. Only vintage (20+ years), handmade and craft supplies may be listed (AGENTS.md / `lib/platforms.ts`).

## 1. Apply

1. <https://www.etsy.com/developers/register> → **Create a New App**.
2. Name: `Resale HQ`. Describe it as **personal use, your own shop only** ("list my own vintage items and read my own shop's orders"). Do **not** tick commercial / multiple shops — that is the slow queue and has cancelled personal keys.
3. Give a support email you actually read (Etsy requires one and suspends keys after 6 months without calls).
4. When approved you get a **Keystring** (client id) and **Shared secret**.

## 2. Redirect URL

In the app's settings add the callback: `https://household-resale-ai.vercel.app/api/etsy/callback` (exact HTTPS match required).

## 3. Environment variables (when the code lands)

| Name | Value |
|---|---|
| `ETSY_KEYSTRING` | app keystring (sent as `x-api-key`) |
| `ETSY_SHARED_SECRET` | shared secret (Vercel **Secret**) |
| `ETSY_REDIRECT_URI` | `https://household-resale-ai.vercel.app/api/etsy/callback` |
| `TOKEN_ENCRYPTION_KEY` | same key as eBay; Etsy tokens are stored encrypted in `marketplace_connections` |

## What the integration will do

- OAuth 2.0 with PKCE (`https://www.etsy.com/oauth/connect`, scopes `listings_r listings_w shops_r transactions_r`); refresh tokens last 90 days, so expect a re-connect every ~3 months.
- **Draft listings only**: `POST /v3/application/shops/{shop_id}/listings` + image upload. Activating (and the $0.20 fee) stays a tap you do on Etsy.
- Hourly poll of paid receipts (Etsy has no webhooks) to mark items sold.
- Required attribution in the app footer: "The term 'Etsy' is a trademark of Etsy, Inc. This Application uses Etsy's API, but is not endorsed or certified by Etsy."
- `when_made` / `who_made` enums change; they will live in `sync_state`, not code.

Reuses `marketplace_connections` (platform `etsy`) from migration `20261030010000`; no new tables expected.

# Roadmap: AI-managed household resale

Goal: list household stuff (clothes, shoes, toys, home goods) across marketplaces, have AI agents watch offers and prices, and only bother a human for decisions — with the real profit after fees shown on every decision.

Accounts today: **eBay, Vinted, Etsy** (nothing listed yet). Facebook Marketplace, Poshmark, Mercari, Depop optional later.

## What the marketplaces actually allow (checked Oct 29, 2026)

| Platform | Seller fee | Official API for us? | What automation is realistic |
|---|---|---|---|
| **eBay** | 13.6% of item + shipping + tax, + $0.30 (≤$10) / $0.40 | **Yes.** Inventory API (list, reprice), Fulfillment (orders), Trading API `GetBestOffers` / `RespondToBestOffer` (buyer offers) + `BestOfferPlaced` notifications. | Full: create listings, change prices, read offers, respond after approval. Needs a developer account and the Marketplace Account Deletion endpoint (or exemption) before production. |
| **Vinted** | **$0** (buyer pays 5% + $0.70) | No. Vinted actively detects bots; crosslisters got users suspended in Oct 2026. | Read offer/sale **emails** only. A human taps accept/counter in the app. |
| **Etsy** | 6.5% + 3% + $0.25 processing + $0.20 listing | Yes (Open API v3, app approval ~30 days). | Technically full, but **used non-vintage goods are banned**. Only for 20+ year-old vintage pieces. |
| Facebook Marketplace | 10% shipped (min $0.80); local pickup free | No (partner-only APIs). | Manual. Rule: Marketplace only, **Hide from friends** on. |
| Poshmark | $2.95 under $15, else 20% | No; terms prohibit automation. | Email tracking + manual. Bad for items under ~$10. |
| Mercari | 10% of item + buyer-paid shipping | No. | Email tracking + manual. |
| Depop | 0% + 3.3% + $0.45 processing | Partner API, invite-only. | Email tracking; request API access later. |

Takeaways:

1. **eBay is the one place agents can genuinely act.** Build that integration first.
2. **Vinted is the best place for cheap kids' clothes and shoes** (seller keeps 100%), but it must stay human-operated. The app's job there is tracking, alerts, and profit math.
3. **Email is the universal feed.** Every platform emails offers and sales; parsing the user's own inbox (Gmail) is allowed and covers all of them.
4. Items under ~$10: Vinted or a bundle. Poshmark's flat $2.95 takes most of a $4 sale.

## Stages

### Stage 1 — Inventory tracker ✅ (this PR)
Dashboard, items with location/size/condition/floor price, listings per platform, offers with fee-aware accept/counter/decline, sales with real profit, automatic "delist everywhere else" tasks after a sale, CSV export, shared household (add a partner by email), activity log, approval queue table.

**To go live:** apply both migrations to Supabase, set env vars, sign up, create the household, add Lauren. ~15 minutes.

### Stage 2 — Offer watcher (email → app)
- Scheduled agent reads Gmail for offer/sale emails from eBay, Vinted, Poshmark, Mercari, Depop.
- Matches each to a listing, creates the `offers` row (`source = 'email'`) and an `offer_decision` task.
- Push notification: "Kids' sneakers · $5.99 on Vinted · offer $3.99 · you'd get $3.99. Accept?"
- Needs: a server-side agent key (service role, never in the browser), real sample emails to build parsers against, dedupe by message ID.

### Stage 3 — Agent API + approval loop
- `/api/agent/*` endpoints with per-agent tokens (scoped to one household, revocable, logged as `actor_agent`).
- Agents can read inventory, propose tasks, and report results; only humans can approve.
- Any AI (Claude, ChatGPT, Gemini) plugs in through the same API or an MCP server wrapping it.

### Stage 4 — eBay integration
- eBay OAuth (user token stored encrypted server-side).
- Publish approved listing drafts, sync status, pull Best Offers, respond to approved decisions, apply approved price drops.
- Account-deletion notification endpoint for eBay compliance.

### Stage 5 — Pricing & listing agents
- Listing drafts from photos (title, description, category, size) → `listing_draft` tasks.
- ✅ Market comps card on each item: **Check eBay prices** (Browse API, live Buy It Now listings) plus comps people/agents record from any site; shows lowest now, typical price, and a below/comparable/above verdict.
- Price suggestions from eBay **sold** comps (Marketplace Insights, needs eBay approval).
- Stale-listing rules: e.g. no views in 14 days → propose a 10% drop, never below floor.

### Stage 6 — Ops
Deployment (Vercel), backups, per-member notification settings, Etsy vintage flow if useful.

## How multiple AIs coordinate

- **On code:** GitHub. Issues labeled `agent:ready` are the work queue; each agent claims one, works on its own `agent/<name>/…` branch, opens a draft PR; a human merges. Rules in `AGENTS.md` (read by Codex, Copilot, Cursor, Gemini CLI; `CLAUDE.md` points to it).
- **On live selling:** the app database. `agent_tasks` is the shared to-do/approval queue and `activity_log` is the shared memory of what happened. Agents read both before acting, so one agent's work is visible to the next.
- **Never mixed:** the repo is public, so household data stays out of GitHub.

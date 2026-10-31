# Household Resale AI

Open-source AI-powered resale management platform for inventory tracking, deal analysis, pricing, profit analytics, listing generation, and multi-agent orchestration across OpenAI/ChatGPT, Anthropic Claude, Google Gemini, and future models.

## Current status

**Stage 1: working inventory tracker.** Supabase auth, a shared household, inventory, listings per marketplace, offers with fee-aware accept/counter/decline, sales with real profit, automatic delist tasks after a sale, and CSV export. eBay integration (OAuth, posting, Best Offers), a scheduled Gmail offer watcher, and an assistant API so your own AI (Muse, ChatGPT) can tell you about offers and relay your answer (`docs/agents/assistant-concierge.md`). See [docs/roadmap.md](docs/roadmap.md) for the staged plan and what each marketplace actually allows, and [AGENTS.md](AGENTS.md) for how AI agents work on this project.

## Product direction

- Responsive dashboard for desktop and mobile
- Inventory, purchase costs, listing status, sales, fees, and realized profit
- Deal analysis with source links, comparable prices, risk notes, and target offer
- AI-assisted listing titles, descriptions, and pricing
- Provider-neutral adapters for OpenAI, Claude, Gemini, and future models
- Background jobs with approval gates before consequential actions
- Individual accounts, roles, audit history, and data export

## Planned architecture

- **Web app:** Next.js, React, TypeScript, Tailwind CSS
- **Database and authentication:** Supabase / PostgreSQL with row-level security
- **AI providers:** server-side adapters; keys never go in browser code
- **Background runner:** separate worker/job system after core persistence and authentication
- **Deployment:** web hosting plus managed database; provider to be selected

These are planned choices, not claims that services are already configured.

## Run locally

Requirements: Node.js 22.18 or later (tests use built-in TypeScript support) and npm.

```bash
npm install
npm run dev
```

Checks: `npm run lint`, `npm run typecheck`, `npm test` (fee and CSV unit tests plus a migration/RLS test against in-memory Postgres), `npm run build`.

Open [http://localhost:3000](http://localhost:3000).

Copy `.env.example` to `.env.local` when integrations are introduced. Never commit real credentials.

eBay is optional: without `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME` and `TOKEN_ENCRYPTION_KEY` the app runs normally and Settings shows "not set up yet". Full owner checklist (keys, RuName, account-deletion endpoint, `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`, sandbox test plan) in [docs/ebay-setup.md](docs/ebay-setup.md).

## Security rules

- Never commit API keys, tokens, passwords, real `.env` files, private financial exports, or transaction records.
- Keep AI provider calls on the server.
- Use authenticated sessions and database row-level security before storing real household data.
- Treat marketplace content and external data as untrusted input.
- Require approval before publishing listings, sending messages, spending money, or performing other external actions.

## Roadmap

1. Dashboard UI and inventory interaction prototype
2. Supabase schema, authentication, and persistent inventory
3. Costs, sales, fees, and profit ledger
4. AI provider settings and provider-neutral agent interface
5. Deal evaluation and listing-draft workflows
6. Background runner, logs, retries, and approval queue
7. Deployment, backups, and household user roles

Contributions are welcome. Do not submit secrets, private personal data, or real account exports.

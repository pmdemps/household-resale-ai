# Household Resale AI

Open-source AI-powered resale management platform for inventory tracking, deal analysis, pricing, profit analytics, listing generation, and multi-agent orchestration across OpenAI/ChatGPT, Anthropic Claude, Google Gemini, and future models.

## Current status

**Early UI prototype.** The dashboard currently uses clearly labeled sample data and browser-memory-only demo entries. Authentication, persistent storage, live AI provider calls, marketplace integrations, and the background runner are not connected yet.

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

Requirements: Node.js 20 or later and npm.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Copy `.env.example` to `.env.local` when integrations are introduced. Never commit real credentials.

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

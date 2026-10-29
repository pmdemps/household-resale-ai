# Supabase setup checklist

The repository contains the initial SQL migration, shared-household schema, and authentication helpers. These steps still require your Supabase project.

1. In Supabase, open **Connect** or **Project Settings → API Keys** and copy the Project URL plus the publishable key. A legacy anon key also works.
2. In local development, copy `.env.example` to `.env.local` and fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Never commit `.env.local`.
3. Apply the files in `supabase/migrations/` **in filename order** (`20261029000000_initial_schema.sql`, then `20261029010000_listings_offers_sales.sql`) in the Supabase SQL Editor, or run `supabase db push` with the CLI. `npm run test:db` checks both against an in-memory Postgres first.
4. In **Authentication → URL Configuration**, set the Site URL to your deployed app URL and add `http://localhost:3000/auth/callback` for local development plus the deployed `/auth/callback` URL.
5. Visit `/login` and create an account to test sign-up/sign-in.
6. Once signed in, `/setup` creates your household. To share it, the other person signs up at `/login`, then you add their email under **Settings → Household**.
7. For deployment, add the same public URL/key as environment variables in the hosting provider. Do not add a secret/service-role key to client-exposed variables.

The schema uses row-level security: inventory is scoped to household membership, so two separate accounts can access the same household inventory without sharing credentials. Household members can read and edit inventory; only household admins can delete inventory or add members.

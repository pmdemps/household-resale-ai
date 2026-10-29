# Supabase setup checklist

The repository contains the initial SQL migration, shared-household schema, and authentication helpers. These steps still require your Supabase project.

1. In Supabase, open **Connect** or **Project Settings → API Keys** and copy the Project URL plus the publishable key. A legacy anon key also works.
2. In local development, copy `.env.example` to `.env.local` and fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Never commit `.env.local`.
3. Apply `supabase/migrations/20261029000000_initial_schema.sql` in the Supabase SQL Editor, or use the Supabase CLI migration workflow. Apply it only once to a fresh project; this initial migration is intended to be finalized before first application.
4. In **Authentication → URL Configuration**, set the Site URL to your deployed app URL and add `http://localhost:3000/auth/callback` for local development plus the deployed `/auth/callback` URL.
5. Visit `/login` and create an account to test sign-up/sign-in.
6. Once signed in, the app's setup flow will create a household by calling `create_household(p_name)`. A household admin can add another registered account through the `add_household_member(p_household_id, p_user_id, p_role)` database function. The member must already have an Auth account; the app still needs a UI for household setup and invitations.
7. For deployment, add the same public URL/key as environment variables in the hosting provider. Do not add a secret/service-role key to client-exposed variables.

The schema uses row-level security: inventory is scoped to household membership, so two separate accounts can access the same household inventory without sharing credentials. Household members can read and edit inventory; only household admins can delete inventory or add members. The dashboard remains a demo until database-backed reads/writes are implemented; do not treat its sample numbers as real.

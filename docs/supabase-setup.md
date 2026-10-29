# Supabase setup checklist

The repository contains the first SQL migration and client helpers. These steps still require your Supabase project.

1. In Supabase, open **Project Settings → API** (or **Connect**) and copy the Project URL plus the publishable key. A legacy anon key also works.
2. In local development, copy `.env.example` to `.env.local` and fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Never commit `.env.local`.
3. Apply `supabase/migrations/20261029000000_initial_schema.sql` in the Supabase SQL Editor, or use the Supabase CLI migration workflow.
4. In **Authentication → URL Configuration**, set the Site URL to your deployed app URL and add `http://localhost:3000/auth/callback` for local development plus the deployed `/auth/callback` URL.
5. Visit `/login` and create an account to test sign-up/sign-in.
6. For deployment, add the same public URL/key as environment variables in the hosting provider. Do not add a service-role key to client-exposed variables.

The migration enables row-level security and restricts inventory rows to the authenticated user who owns each row. The existing dashboard remains a demo until the inventory page is explicitly switched to database reads/writes; do not treat its sample numbers as real.

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

## Photos

Item photos live in a Storage bucket called `item-photos`. The migration `20261030020000_item_photos.sql` creates the bucket itself (`insert into storage.buckets …`) along with the `item_photos` table and the object policies, so there is nothing to click through in **Storage → New bucket**. After applying it, check in the dashboard that:

- **Storage → item-photos** exists and is marked **Public**, with a 10 MB file size limit and allowed types `image/jpeg, image/png, image/webp, image/heic`. Public is deliberate: eBay and Etsy fetch listing images by plain URL, and object paths are unguessable (`<household id>/<item id>/<random uuid>.jpg`).
- **Storage → Policies → item-photos** shows four policies, all for `authenticated` and all limited to the household folder in the first path segment (`public.is_item_photo_path_member`): members view/list, upload, update and delete. There is deliberately **no** policy for `anon`: the files are served by the public-bucket URL, which never consults these policies, while a select policy open to anon would let anyone with the publishable key list every household's object paths.

If the migration is ever applied by a tool that lacks rights on the `storage` schema, create the bucket by hand with those settings and re-run just the `storage.*` statements from the migration in the SQL editor.

Public image URL for a photo: `<NEXT_PUBLIC_SUPABASE_URL>/storage/v1/object/public/item-photos/<storage_path>` (`publicPhotoUrl()` in `lib/photos.ts`).

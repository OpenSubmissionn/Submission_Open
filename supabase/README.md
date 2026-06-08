# Supabase setup — OPEN DevTool analytics

The community dashboard at `/users.html` reads from two real data sources:

| Source | What it gives us |
|---|---|
| **npm Registry API** (public, no auth) | Total CLI downloads, daily breakdown for the last 30 days |
| **Supabase Postgres** (this folder) | Every "transaction profiled" hit on the web debugger, with geo + referrer |

Everything else (top countries, world map dots, live feed, growth chart, platform mix) is **derived** from those two sources at request time in [`web/tracking.ts`](../web/tracking.ts).

## 1. Create the project

1. Sign up at [supabase.com](https://supabase.com) (free tier — 500 MB storage, no credit card)
2. New project → name it `open-devtool` → pick a region close to your users → set a DB password (save it)
3. Wait ~2 minutes for the project to provision

## 2. Run the schema

In the Supabase dashboard:

1. Open **SQL Editor** (left sidebar)
2. New query → paste the contents of [`schema.sql`](./schema.sql)
3. Click **Run**

You should see "Success. No rows returned." That's correct — we just created the table.

## 3. Grab the credentials

Still in the Supabase dashboard:

1. Open **Project Settings → API**
2. Copy three things:
   - **Project URL** (e.g. `https://abcdefgh.supabase.co`)
   - **anon public key** — NOT used by the server, only listed for reference
   - **service_role key** — keep this secret, it bypasses RLS

## 4. Wire it up

### Local development

Copy `.env.example` to `.env` (if you haven't already) and fill in:

```sh
SUPABASE_URL=https://abcdefgh.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...   # the service_role key, NOT the anon key
```

Then run:

```sh
npm run web
```

The dev server will pick up the env vars automatically. Hit `http://localhost:3344/users.html` — if Supabase is reachable, you'll see real (likely empty) data.

### Vercel deployment

In your Vercel project dashboard:

1. **Settings → Environment Variables**
2. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (apply to Production, Preview, Development)
3. Redeploy

Vercel will also auto-inject `x-vercel-ip-country`, `x-vercel-ip-city`, `x-vercel-ip-latitude`, `x-vercel-ip-longitude` headers on every request — that's how `/api/track` gets geo data without any extra service.

## 5. (optional) Seed some sample data

If you want to see the dashboard populated before you have real traffic, you can insert a few rows manually from the SQL editor:

```sql
insert into events (event_type, country, country_code, city, lat, lng, referrer) values
  ('tx_profiled', 'Brazil',         'BR', 'São Paulo',     -23.55, -46.63, 'twitter.com'),
  ('tx_profiled', 'United States',  'US', 'San Francisco',  37.77,-122.42, 'github.com'),
  ('tx_profiled', 'Germany',        'DE', 'Berlin',         52.52,  13.40, 'direct'),
  ('tx_profiled', 'India',          'IN', 'Bangalore',      12.97,  77.59, 'twitter.com');
```

## Privacy notes

- No IP addresses are stored — only country/city/coarse lat-lng from Vercel's edge headers.
- No user identifiers, no cookies, no fingerprinting.
- Referrer is captured as-is from `document.referrer` and normalized to a hostname server-side.
- RLS blocks all access from the `anon` role; only the server (with `service_role`) can read/write.

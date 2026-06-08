-- ─────────────────────────────────────────────────────────────────
-- OPEN DevTool — analytics schema
--
-- Single events table that records every "transaction profiled" hit
-- from the web debugger, with geo (Vercel edge headers) and referrer.
-- Aggregated server-side at request time in web/tracking.ts — no
-- materialized views, no triggers, keep it boring.
-- ─────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

create table if not exists public.events (
  id           uuid primary key default gen_random_uuid(),
  event_type   text not null,
  country      text,
  country_code text,
  city         text,
  region       text,
  lat          double precision,
  lng          double precision,
  referrer     text,
  created_at   timestamptz not null default now()
);

-- Indexes the dashboard hits on every refresh:
--   • created_at desc — recent feed, 30-day growth window
--   • country_code   — top-countries aggregate
--   • event_type     — when we add more event kinds later
create index if not exists events_created_at_idx on public.events (created_at desc);
create index if not exists events_country_code_idx on public.events (country_code);
create index if not exists events_event_type_idx on public.events (event_type);

-- Row Level Security: the public API only ever uses the service_role
-- key (server-side), so we lock down the anon role entirely. Inserts
-- and selects from the anon role are blocked; the API key bypasses RLS.
alter table public.events enable row level security;

drop policy if exists "anon no access" on public.events;
create policy "anon no access" on public.events for all to anon using (false) with check (false);

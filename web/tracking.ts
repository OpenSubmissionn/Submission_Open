/**
 * Community dashboard data layer.
 *
 * Two responsibilities:
 *
 *   1. `trackEvent(...)` — write a single "transaction profiled" row to
 *      Supabase, enriched with the geo headers Vercel attaches at the edge.
 *
 *   2. `getStats()` — return the aggregated payload `/users.html` renders.
 *      Combines:
 *        • npm Registry API (CLI downloads, last 30 days + previous 30 for
 *          a delta, plus an all-time total)
 *        • Supabase events table (web visits, top countries, top cities for
 *          the world map dots, referrers, live feed, daily growth)
 *
 * No mock data, no fallbacks beyond returning empty arrays if a backing
 * service is unreachable — the front-end shows a graceful empty state.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Avoid `NPM_PACKAGE_NAME` — npm itself injects `npm_package_name` for
// scripts, and Windows treats env var names as case-insensitive, so the
// override would always resolve to this monorepo's name.
const NPM_PACKAGE = process.env.OPENDEV_NPM_PACKAGE ?? 'opendevtool';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

// ─────────────────────────────────────────────────────────────
// Supabase client — lazily created so the module loads even when
// env vars are missing (CI / local without `.env`). When unset,
// trackEvent() no-ops and getStats() returns CLI-only data.
// ─────────────────────────────────────────────────────────────
let _supabase: SupabaseClient | null | undefined;

function supabase(): SupabaseClient | null {
  if (_supabase !== undefined) return _supabase;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn(
      '[tracking] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — analytics disabled. See supabase/README.md.'
    );
    _supabase = null;
    return null;
  }
  try {
    _supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    });
    return _supabase;
  } catch (e) {
    console.error('[tracking] Supabase client init failed:', e);
    _supabase = null;
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface GeoHeaders {
  country?: string;       // ISO2, e.g. "BR"
  countryName?: string;   // pretty name, when available
  city?: string;
  region?: string;
  latitude?: string;
  longitude?: string;
}

export interface TrackPayload {
  event_type: 'tx_profiled';
  referrer?: string;
}

interface EventRow {
  event_type: string;
  country: string | null;
  country_code: string | null;
  city: string | null;
  region: string | null;
  lat: number | null;
  lng: number | null;
  referrer: string | null;
  created_at: string;
}

export interface StatsPayload {
  // top-line counters
  totals: {
    webEvents: number;          // all-time tx_profiled count
    webEvents30d: number;       // last 30 days
    webEventsDeltaPct: number;  // (last30 / prev30 - 1) * 100
    cliDownloads: number;       // all-time CLI downloads from npm
    cliDownloads30d: number;    // last 30 days
    cliDownloadsDeltaPct: number;
    uniqueCountries: number;
  };
  // 30-day daily series for the growth chart
  growth: {
    cli: { date: string; count: number }[];
    web: { date: string; count: number }[];
  };
  // Aggregated by city for the world map dots
  cities: {
    city: string;
    country: string;
    countryCode: string | null;
    lat: number;
    lng: number;
    count: number;
  }[];
  // Top countries for the ranking panel
  topCountries: {
    name: string;
    code: string | null;
    count: number;
  }[];
  // Where users come from
  topReferrers: { source: string; count: number; pct: number }[];
  // Live feed seed — most recent events
  recent: {
    country: string | null;
    city: string | null;
    countryCode: string | null;
    referrer: string | null;
    createdAt: string;
  }[];
  // Mix of npm registry vs web — derived, not stored
  platformMix: { label: string; count: number; pct: number; color: string }[];
  // CLI version distribution (npm last-week data — the only granularity npm
  // offers for per-version downloads). Sorted by download count desc.
  cliVersions: { version: string; downloads: number; pct: number }[];
  // What's actually backing the response — useful for the front-end to show a
  // "demo data" banner if Supabase isn't wired up yet
  meta: {
    supabaseConfigured: boolean;
    npmPackage: string;
    generatedAt: string;
    // Publish date of the package (YYYY-MM-DD). The dashboard uses this to
    // render "since launch" labels and to explain why launch-day downloads
    // are excluded from totals.
    npmPublishedAt: string | null;
    // How many downloads npm counted on the publish day (almost entirely
    // mirrors + scanners). We zero this out across all totals; surfacing
    // the number lets the dashboard be transparent about what was excluded.
    npmLaunchDayDownloadsExcluded: number;
  };
}

// ─────────────────────────────────────────────────────────────
// trackEvent — single insert, never throws on the caller
// ─────────────────────────────────────────────────────────────

export async function trackEvent(
  payload: TrackPayload,
  geo: GeoHeaders = {},
  clientIp?: string
): Promise<void> {
  const client = supabase();
  if (!client) return;

  // Vercel edge headers are the gold-standard source for geo — when present,
  // they always win. In local dev (and any environment that strips edge
  // headers) we fall back to an IP geolocation lookup so the dashboard
  // doesn't end up with a wall of nulls.
  const haveEdgeGeo = !!(geo.country || geo.city || geo.latitude);
  if (!haveEdgeGeo) {
    const ipGeo = await lookupIpGeo(clientIp);
    if (ipGeo) {
      geo = { ...geo, ...ipGeo };
    }
  }

  const lat = geo.latitude ? parseFloat(geo.latitude) : null;
  const lng = geo.longitude ? parseFloat(geo.longitude) : null;

  const row = {
    event_type: payload.event_type,
    country_code: geo.country ?? null,
    country: geo.countryName ?? countryFromCode(geo.country) ?? null,
    city: geo.city ? decodeURIComponent(geo.city) : null,
    region: geo.region ?? null,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    referrer: normalizeReferrer(payload.referrer),
  };

  const { error } = await client.from('events').insert(row);
  if (error) console.error('[tracking] insert failed:', error.message);
}

// ─────────────────────────────────────────────────────────────
// IP geolocation fallback (ip-api.com — free, no auth, 45 req/min/IP)
//
// Returns a GeoHeaders-shaped object so callers can spread it onto an
// existing partially-filled object. The cache key is the IP itself; results
// hold for 1 hour because a given IP rarely changes location.
//
// Empty/private/localhost IPs are routed through `/json/` (no IP path) so
// ip-api uses our outbound IP — which is the server's own IP, i.e. exactly
// the location of whoever's running `npm run web` locally.
// ─────────────────────────────────────────────────────────────

const _ipGeoCache = new Map<string, { at: number; geo: GeoHeaders | null }>();
const IP_GEO_TTL_MS = 60 * 60 * 1000;

async function lookupIpGeo(clientIp?: string): Promise<GeoHeaders | null> {
  const normalizedIp = normalizeClientIp(clientIp);
  const cacheKey = normalizedIp ?? '__self__';

  const hit = _ipGeoCache.get(cacheKey);
  if (hit && Date.now() - hit.at < IP_GEO_TTL_MS) return hit.geo;

  try {
    const path = normalizedIp ?? '';
    const url = `http://ip-api.com/json/${path}?fields=status,country,countryCode,city,regionName,lat,lon`;
    const res = await fetch(url);
    if (!res.ok) {
      _ipGeoCache.set(cacheKey, { at: Date.now(), geo: null });
      return null;
    }
    const json: any = await res.json();
    if (json?.status !== 'success') {
      _ipGeoCache.set(cacheKey, { at: Date.now(), geo: null });
      return null;
    }

    const geo: GeoHeaders = {
      country: json.countryCode,
      countryName: json.country,
      city: json.city,
      region: json.regionName,
      latitude: typeof json.lat === 'number' ? String(json.lat) : undefined,
      longitude: typeof json.lon === 'number' ? String(json.lon) : undefined,
    };
    _ipGeoCache.set(cacheKey, { at: Date.now(), geo });
    return geo;
  } catch (e) {
    console.warn('[tracking] ip-api lookup failed:', e);
    _ipGeoCache.set(cacheKey, { at: Date.now(), geo: null });
    return null;
  }
}

// Strip IPv6-mapped IPv4 prefix and reject IPs that ip-api can't geolocate.
// We return undefined for localhost / private ranges so the caller falls
// through to the "no IP" path (uses our outbound IP, which is what dev wants).
function normalizeClientIp(raw?: string): string | undefined {
  if (!raw) return undefined;
  const ip = raw.replace(/^::ffff:/, '').trim();
  if (!ip) return undefined;
  if (ip === '::1' || ip === '127.0.0.1') return undefined;
  // Private IPv4 ranges — RFC 1918
  if (/^10\./.test(ip)) return undefined;
  if (/^192\.168\./.test(ip)) return undefined;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return undefined;
  // Link-local
  if (/^169\.254\./.test(ip)) return undefined;
  // Anything else — let ip-api try
  return ip;
}

// ─────────────────────────────────────────────────────────────
// getStats — one fan-out, returns the full dashboard payload
// ─────────────────────────────────────────────────────────────

// Small in-memory cache so dashboards refreshing on a tight interval don't
// hammer the npm API or Supabase. 60s is short enough to feel live but
// avoids burst load on warm function instances.
let _cache: { at: number; data: StatsPayload } | null = null;
const CACHE_TTL_MS = 60_000;

export async function getStats(): Promise<StatsPayload> {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.data;

  const [npm, web] = await Promise.all([fetchNpmStats(), fetchWebStats()]);

  const totalCliDownloads = npm.allTime;
  const cli30d = sum(npm.last30.map((p) => p.count));
  const cliPrev30 = sum(npm.prev30.map((p) => p.count));
  const cliDelta = cliPrev30 > 0 ? ((cli30d - cliPrev30) / cliPrev30) * 100 : 0;

  const web30 = web.totalLast30d;
  const webPrev30 = web.totalPrev30d;
  const webDelta = webPrev30 > 0 ? ((web30 - webPrev30) / webPrev30) * 100 : 0;

  // Platform mix — CLI vs Web by 30-day activity
  const totalActivity = cli30d + web30 || 1;
  const platformMix = [
    {
      label: 'CLI (npm)',
      count: cli30d,
      pct: Math.round((cli30d / totalActivity) * 100),
      color: 'var(--blue-bright)',
    },
    {
      label: 'Web debugger',
      count: web30,
      pct: Math.round((web30 / totalActivity) * 100),
      color: 'var(--green)',
    },
  ];

  const data: StatsPayload = {
    totals: {
      webEvents: web.total,
      webEvents30d: web30,
      webEventsDeltaPct: round(webDelta, 1),
      cliDownloads: totalCliDownloads,
      cliDownloads30d: cli30d,
      cliDownloadsDeltaPct: round(cliDelta, 1),
      uniqueCountries: web.uniqueCountries,
    },
    growth: {
      cli: npm.last30,
      web: web.dailyLast30d,
    },
    cities: web.cities,
    topCountries: web.topCountries,
    topReferrers: web.topReferrers,
    recent: web.recent,
    platformMix,
    cliVersions: npm.versions,
    meta: {
      supabaseConfigured: !!supabase(),
      npmPackage: NPM_PACKAGE,
      generatedAt: new Date().toISOString(),
      npmPublishedAt: npm.publishedAt,
      npmLaunchDayDownloadsExcluded: npm.launchDayDownloads,
    },
  };

  _cache = { at: Date.now(), data };
  return data;
}

// ─────────────────────────────────────────────────────────────
// npm Registry — free, no auth, public
//
//   • /downloads/range/{start}:{end}/{pkg} returns { downloads: [{day, downloads}] }
//   • /downloads/point/{start}:{end}/{pkg} returns a single total
//
// The range endpoint maxes out at 18 months per call, way more than we need.
// ─────────────────────────────────────────────────────────────

async function fetchNpmStats(): Promise<{
  allTime: number;
  last30: { date: string; count: number }[];
  prev30: { date: string; count: number }[];
  versions: { version: string; downloads: number; pct: number }[];
  publishedAt: string | null;       // ISO date of first version publish, e.g. "2026-05-12"
  launchDayDownloads: number;       // downloads counted ON the publish day (bots/mirrors)
}> {
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const day = 86_400_000;
  const last30Start = new Date(today.getTime() - 30 * day);
  const prev30End = new Date(last30Start.getTime() - day);
  const prev30Start = new Date(prev30End.getTime() - 29 * day);

  try {
    // npm's per-version endpoint only supports `last-day` / `last-week` (not
    // arbitrary date ranges) — `last-week` gives the richest signal without
    // missing recently-published versions, so we use that.
    //
    // The /registry endpoint gives us the publish date so we can strip the
    // launch-day bot spike from totals — npm mirrors, security scanners and
    // download-tracker services all pull every new package immediately, and
    // for a brand-new package that single day can be 80%+ of all downloads.
    const [last30Res, prev30Res, allTimeRes, versionsRes, registryRes] = await Promise.all([
      fetch(`https://api.npmjs.org/downloads/range/${fmt(last30Start)}:${fmt(today)}/${NPM_PACKAGE}`),
      fetch(`https://api.npmjs.org/downloads/range/${fmt(prev30Start)}:${fmt(prev30End)}/${NPM_PACKAGE}`),
      fetch(`https://api.npmjs.org/downloads/point/2015-01-10:${fmt(today)}/${NPM_PACKAGE}`),
      fetch(`https://api.npmjs.org/versions/${NPM_PACKAGE}/last-week`),
      fetch(`https://registry.npmjs.org/${NPM_PACKAGE}`),
    ]);

    const last30Json: any = last30Res.ok ? await last30Res.json() : { downloads: [] };
    const prev30Json: any = prev30Res.ok ? await prev30Res.json() : { downloads: [] };
    const allTimeJson: any = allTimeRes.ok ? await allTimeRes.json() : { downloads: 0 };
    const versionsJson: any = versionsRes.ok ? await versionsRes.json() : { downloads: {} };
    const registryJson: any = registryRes.ok ? await registryRes.json() : null;

    // First published date — for "opendevtool" this is 2026-05-12T00:41:28Z.
    // The `time` object has one timestamp per version + `created` + `modified`;
    // `created` is the most reliable signal of "the day this package first
    // appeared on the registry".
    const publishedAtRaw: string | null = registryJson?.time?.created ?? null;
    const publishedAt: string | null = publishedAtRaw ? publishedAtRaw.slice(0, 10) : null;

    const toSeries = (j: any): { date: string; count: number }[] =>
      Array.isArray(j?.downloads)
        ? j.downloads.map((d: any) => ({ date: d.day, count: d.downloads }))
        : [];

    // Filter out the launch-day count from every series + the all-time total.
    // After 30 days have passed the publish day naturally falls out of the
    // window, so this is a no-op for established packages.
    const last30Raw = toSeries(last30Json);
    const prev30Raw = toSeries(prev30Json);
    const launchDayInLast30 = publishedAt
      ? last30Raw.find((p) => p.date === publishedAt)?.count ?? 0
      : 0;
    const launchDayInPrev30 = publishedAt
      ? prev30Raw.find((p) => p.date === publishedAt)?.count ?? 0
      : 0;

    const last30 = last30Raw.map((p) =>
      p.date === publishedAt ? { ...p, count: 0 } : p
    );
    const prev30 = prev30Raw.map((p) =>
      p.date === publishedAt ? { ...p, count: 0 } : p
    );

    const allTimeRaw = typeof allTimeJson?.downloads === 'number' ? allTimeJson.downloads : 0;
    const allTime = Math.max(0, allTimeRaw - launchDayInLast30 - launchDayInPrev30);

    // Versions endpoint shape: { package: "X", downloads: { "0.5.0": 3, ... } }
    // Returns an array sorted by download count desc, with a pct relative to
    // total downloads across the captured versions.
    const versionsRaw: Record<string, number> =
      versionsJson?.downloads && typeof versionsJson.downloads === 'object'
        ? versionsJson.downloads
        : {};
    const versionsTotal = sum(Object.values(versionsRaw));
    const versions = Object.entries(versionsRaw)
      .map(([version, downloads]) => ({
        version,
        downloads,
        pct: versionsTotal > 0 ? round((downloads / versionsTotal) * 100, 1) : 0,
      }))
      .sort((a, b) => b.downloads - a.downloads);

    return {
      allTime,
      last30,
      prev30,
      versions,
      publishedAt,
      launchDayDownloads: launchDayInLast30 + launchDayInPrev30,
    };
  } catch (e) {
    console.error('[tracking] npm API failed:', e);
    return {
      allTime: 0,
      last30: [],
      prev30: [],
      versions: [],
      publishedAt: null,
      launchDayDownloads: 0,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Supabase aggregation
//
// One bulk read of the last 60 days (for 30d + prev30d windows), one
// count-only query for the all-time total. Everything else is in-memory
// grouping — fine for the volumes we expect (< 100k events).
// ─────────────────────────────────────────────────────────────

async function fetchWebStats(): Promise<{
  total: number;
  totalLast30d: number;
  totalPrev30d: number;
  uniqueCountries: number;
  dailyLast30d: { date: string; count: number }[];
  cities: StatsPayload['cities'];
  topCountries: StatsPayload['topCountries'];
  topReferrers: StatsPayload['topReferrers'];
  recent: StatsPayload['recent'];
}> {
  const empty = {
    total: 0,
    totalLast30d: 0,
    totalPrev30d: 0,
    uniqueCountries: 0,
    dailyLast30d: emptyDailySeries(30),
    cities: [],
    topCountries: [],
    topReferrers: [],
    recent: [],
  };

  const client = supabase();
  if (!client) return empty;

  const today = new Date();
  const day = 86_400_000;
  const start30 = new Date(today.getTime() - 30 * day);
  const start60 = new Date(today.getTime() - 60 * day);

  try {
    const [bulkRes, totalRes] = await Promise.all([
      client
        .from('events')
        .select('event_type,country,country_code,city,lat,lng,referrer,created_at')
        .eq('event_type', 'tx_profiled')
        .gte('created_at', start60.toISOString())
        .order('created_at', { ascending: false })
        .limit(10_000),
      client
        .from('events')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'tx_profiled'),
    ]);

    if (bulkRes.error) {
      console.error('[tracking] bulk read failed:', bulkRes.error.message);
      return empty;
    }

    const rows = (bulkRes.data ?? []) as EventRow[];
    const total = totalRes.count ?? rows.length;

    const last30 = rows.filter((r) => new Date(r.created_at) >= start30);
    const prev30 = rows.filter((r) => new Date(r.created_at) < start30);

    return {
      total,
      totalLast30d: last30.length,
      totalPrev30d: prev30.length,
      uniqueCountries: new Set(rows.map((r) => r.country_code).filter(Boolean)).size,
      dailyLast30d: bucketByDay(last30, 30),
      cities: aggregateCities(last30),
      topCountries: aggregateCountries(last30),
      topReferrers: aggregateReferrers(last30),
      recent: rows.slice(0, 20).map((r) => ({
        country: r.country,
        city: r.city,
        countryCode: r.country_code,
        referrer: r.referrer,
        createdAt: r.created_at,
      })),
    };
  } catch (e) {
    console.error('[tracking] Supabase query failed:', e);
    return empty;
  }
}

// ─────────────────────────────────────────────────────────────
// Aggregation helpers
// ─────────────────────────────────────────────────────────────

function bucketByDay(rows: EventRow[], days: number): { date: string; count: number }[] {
  const buckets = new Map<string, number>();
  const today = new Date();
  // Seed every day in the window so the chart has a flat baseline even on
  // days with zero events.
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const r of rows) {
    const day = r.created_at.slice(0, 10);
    if (buckets.has(day)) buckets.set(day, (buckets.get(day) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([date, count]) => ({ date, count }));
}

function emptyDailySeries(days: number): { date: string; count: number }[] {
  const today = new Date();
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(today.getTime() - (days - 1 - i) * 86_400_000);
    return { date: d.toISOString().slice(0, 10), count: 0 };
  });
}

function aggregateCities(rows: EventRow[]): StatsPayload['cities'] {
  const acc = new Map<
    string,
    { city: string; country: string; countryCode: string | null; lat: number; lng: number; count: number }
  >();
  for (const r of rows) {
    if (!r.city || r.lat == null || r.lng == null) continue;
    const key = `${r.country_code ?? '??'}|${r.city}`;
    const prev = acc.get(key);
    if (prev) {
      prev.count += 1;
    } else {
      acc.set(key, {
        city: r.city,
        country: r.country ?? '',
        countryCode: r.country_code,
        lat: r.lat,
        lng: r.lng,
        count: 1,
      });
    }
  }
  return [...acc.values()].sort((a, b) => b.count - a.count).slice(0, 80);
}

function aggregateCountries(rows: EventRow[]): StatsPayload['topCountries'] {
  const acc = new Map<string, { name: string; code: string | null; count: number }>();
  for (const r of rows) {
    // Skip events that came in without geo data — they're real events but
    // contribute nothing to a "top countries" ranking. They still show up in
    // the webEvents total; this filter just keeps the ranking clean.
    if (!r.country_code && !r.country) continue;
    const name = r.country ?? countryFromCode(r.country_code ?? '') ?? 'Unknown';
    const key = r.country_code ?? name;
    const prev = acc.get(key);
    if (prev) prev.count += 1;
    else acc.set(key, { name, code: r.country_code, count: 1 });
  }
  return [...acc.values()].sort((a, b) => b.count - a.count).slice(0, 10);
}

function aggregateReferrers(rows: EventRow[]): StatsPayload['topReferrers'] {
  const acc = new Map<string, number>();
  for (const r of rows) {
    const src = r.referrer ?? 'direct';
    acc.set(src, (acc.get(src) ?? 0) + 1);
  }
  const total = sum([...acc.values()]) || 1;
  return [...acc.entries()]
    .map(([source, count]) => ({ source, count, pct: round((count / total) * 100, 1) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

// ─────────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────────

function normalizeReferrer(raw: string | undefined): string {
  if (!raw) return 'direct';
  try {
    const u = new URL(raw);
    // Common social/source hostname → display name
    const map: Record<string, string> = {
      'twitter.com': 'twitter.com',
      'x.com': 'twitter.com',
      't.co': 'twitter.com',
      'github.com': 'github.com',
      'www.google.com': 'google',
      'google.com': 'google',
      'www.bing.com': 'bing',
      'duckduckgo.com': 'duckduckgo',
      'news.ycombinator.com': 'hacker news',
      'reddit.com': 'reddit',
      'www.reddit.com': 'reddit',
      'discord.com': 'discord',
      'producthunt.com': 'product hunt',
      'www.producthunt.com': 'product hunt',
    };
    const host = u.hostname.toLowerCase();
    return map[host] ?? host.replace(/^www\./, '');
  } catch {
    return raw.slice(0, 80) || 'direct';
  }
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// Minimal ISO2 → country name lookup — only the ones we expect to see in
// any volume. Falls back to the code when we don't recognise it (better
// than rendering "null" in the UI).
const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States', CA: 'Canada', MX: 'Mexico', BR: 'Brazil', AR: 'Argentina',
  CL: 'Chile', CO: 'Colombia', PE: 'Peru', VE: 'Venezuela',
  GB: 'United Kingdom', IE: 'Ireland', DE: 'Germany', FR: 'France', NL: 'Netherlands',
  ES: 'Spain', PT: 'Portugal', IT: 'Italy', CH: 'Switzerland', AT: 'Austria',
  BE: 'Belgium', SE: 'Sweden', NO: 'Norway', FI: 'Finland', DK: 'Denmark',
  PL: 'Poland', CZ: 'Czechia', RO: 'Romania', GR: 'Greece', TR: 'Turkey',
  UA: 'Ukraine', RU: 'Russia',
  IN: 'India', PK: 'Pakistan', BD: 'Bangladesh', CN: 'China', JP: 'Japan',
  KR: 'South Korea', SG: 'Singapore', HK: 'Hong Kong', TW: 'Taiwan', TH: 'Thailand',
  VN: 'Vietnam', ID: 'Indonesia', MY: 'Malaysia', PH: 'Philippines',
  AE: 'UAE', SA: 'Saudi Arabia', IL: 'Israel', EG: 'Egypt',
  NG: 'Nigeria', KE: 'Kenya', ZA: 'South Africa', MA: 'Morocco',
  AU: 'Australia', NZ: 'New Zealand',
};

function countryFromCode(code?: string | null): string | null {
  if (!code) return null;
  return COUNTRY_NAMES[code.toUpperCase()] ?? code;
}

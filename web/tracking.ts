/**
 * Community dashboard event ingestion.
 *
 * `trackEvent(...)` writes a single "transaction profiled" row to Supabase,
 * enriched with the geo headers Vercel attaches at the edge (or, in local
 * dev, an IP geolocation fallback). The aggregation / read side of this
 * data lives in a separate private repo so the public deployment never
 * exposes a way to read community data back out.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

// ─────────────────────────────────────────────────────────────
// Supabase client — lazily created so the module loads even when
// env vars are missing (CI / local without `.env`). When unset,
// trackEvent() no-ops.
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

function normalizeClientIp(raw?: string): string | undefined {
  if (!raw) return undefined;
  const ip = raw.replace(/^::ffff:/, '').trim();
  if (!ip) return undefined;
  if (ip === '::1' || ip === '127.0.0.1') return undefined;
  if (/^10\./.test(ip)) return undefined;
  if (/^192\.168\./.test(ip)) return undefined;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return undefined;
  if (/^169\.254\./.test(ip)) return undefined;
  return ip;
}

// ─────────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────────

function normalizeReferrer(raw: string | undefined): string {
  if (!raw) return 'direct';
  try {
    const u = new URL(raw);
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

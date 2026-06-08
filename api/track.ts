import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as server from '../web/server.js';

// Same CJS/ESM dance as api/latest-tx.ts — pull the export through a
// namespace import so it works regardless of how the bundler resolves
// the parent module.
const trackEvent = (server as any).trackEvent ?? (server as any).default?.trackEvent;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  try {
    if (typeof trackEvent !== 'function') {
      throw new Error('trackEvent export not found on web/server module');
    }

    const body = req.body ?? {};
    const referrer = typeof body.referrer === 'string' ? body.referrer : undefined;

    // Vercel auto-injects these at the edge. Lower-cased to match Node header
    // conventions; `req.headers` already normalises casing on Vercel.
    const h = (name: string) => {
      const v = req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };

    // Fallback IP for the rare case Vercel's edge geo headers are missing
    // (rate-limited, edge cache, region without geo data). x-forwarded-for
    // is the canonical "real client IP" on Vercel.
    const xff = h('x-forwarded-for');
    const clientIp = xff ? xff.split(',')[0]?.trim() : undefined;

    await trackEvent(
      { event_type: 'tx_profiled', referrer },
      {
        country: h('x-vercel-ip-country'),
        city: h('x-vercel-ip-city'),
        region: h('x-vercel-ip-country-region'),
        latitude: h('x-vercel-ip-latitude'),
        longitude: h('x-vercel-ip-longitude'),
      },
      clientIp
    );

    res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[track] error:', e?.message ?? e);
    // Never fail loud — analytics should never block the user's analyze flow.
    res.status(200).json({ ok: false });
  }
}

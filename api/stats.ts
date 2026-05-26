import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as server from '../web/server.js';

const getStats = (server as any).getStats ?? (server as any).default?.getStats;

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    if (typeof getStats !== 'function') {
      throw new Error('getStats export not found on web/server module');
    }
    const data = await getStats();
    // 30s browser cache, 60s shared (matches the in-memory cache inside
    // getStats()) — keeps the dashboard snappy without missing real-time
    // changes by more than a minute.
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
    res.status(200).json(data);
  } catch (e: any) {
    console.error('[stats] error:', e?.message ?? e);
    res.status(500).json({ error: e?.message ?? String(e) });
  }
}

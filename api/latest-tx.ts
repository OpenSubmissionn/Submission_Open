import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';
import * as server from '../web/server.js';

// `web/server.ts` lives under the root package.json which has no `"type"`
// field, so it's transpiled as CJS. ESM-to-CJS named imports are checked
// statically by Node and fail on esbuild's barrel output, so we go through
// the namespace + `default` fallback instead.
const getLatestTx = (server as any).getLatestTx ?? (server as any).default?.getLatestTx;
const rateLimit = (server as any).rateLimit ?? (server as any).default?.rateLimit;

const LATEST_LIMIT = { windowMs: 60_000, max: 60 } as const;

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (!v) return undefined;
  const s = Array.isArray(v) ? v[0] : v;
  return s?.split(',')[0]?.trim() || undefined;
}

// See api/analyze.ts for the rationale — do NOT trust a spoofable
// `X-Forwarded-For` as the rate-limit identity (HIGH-01).
function readClientIp(req: VercelRequest): string {
  const vercelIp = firstHeader(req.headers['x-vercel-forwarded-for']);
  if (vercelIp) return vercelIp;

  const depth = Number.parseInt(process.env.TRUSTED_PROXY_DEPTH ?? '0', 10);
  if (Number.isFinite(depth) && depth > 0) {
    const xff = req.headers['x-forwarded-for'];
    const list = (Array.isArray(xff) ? xff.join(',') : (xff ?? ''))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length >= depth) return list[list.length - depth] || 'unknown';
  }
  return (req.socket as any)?.remoteAddress ?? 'unknown';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (typeof rateLimit === 'function') {
    const ip = readClientIp(req);
    const decision = rateLimit(`latest-tx:${ip}`, LATEST_LIMIT);
    res.setHeader('X-RateLimit-Limit', String(LATEST_LIMIT.max));
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(decision.resetAt / 1000)));
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSec));
      res.status(429).json({
        error: 'rate limit exceeded',
        retryAfterSec: decision.retryAfterSec,
      });
      return;
    }
  }
  try {
    if (typeof getLatestTx !== 'function') {
      throw new Error('getLatestTx export not found on web/server module');
    }
    const result = await getLatestTx();
    res.status(200).json(result);
  } catch (e: any) {
    // Generic message + correlation id. The previous behaviour leaked the
    // configured Helius RPC URL (and its rate-limit text) through error.message
    // — useful for an attacker pacing cost-amplification attacks.
    const requestId = randomUUID();
    console.error(`[latest-tx] error rid=${requestId}:`, e);
    res.status(500).json({ error: 'latest-tx lookup failed', requestId });
  }
}

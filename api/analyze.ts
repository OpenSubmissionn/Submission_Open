import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';
import * as server from '../web/server.js';

// `web/server.ts` lives under the root package.json which has no `"type"`
// field, so it's transpiled as CJS. ESM-to-CJS named imports are checked
// statically by Node and fail on esbuild's barrel output, so we go through
// the namespace + `default` fallback instead.
const analyze = (server as any).analyze ?? (server as any).default?.analyze;
const rateLimit = (server as any).rateLimit ?? (server as any).default?.rateLimit;
const getAnalyzeCached =
  (server as any).getAnalyzeCached ?? (server as any).default?.getAnalyzeCached;
const setAnalyzeCached =
  (server as any).setAnalyzeCached ?? (server as any).default?.setAnalyzeCached;

// Base58 charset Solana uses for signatures (no 0, O, I, l). Length 87–88
// is the standard ed25519 signature size encoded in base58. Validating the
// charset at the trust boundary prevents log-injection via newlines/control
// characters and rejects obvious garbage before any RPC fan-out.
const SIGNATURE_REGEX = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/;

// Per-process rate-limit budget for /api/analyze. Note: in-memory counter
// is per-instance, so a determined attacker who can spawn cold serverless
// containers can amplify. This is intentional — the in-memory store is the
// stopgap we chose; promote to Upstash/Vercel KV when actual abuse warrants.
const ANALYZE_LIMIT = { windowMs: 60_000, max: 30 } as const;

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (!v) return undefined;
  const s = Array.isArray(v) ? v[0] : v;
  return s?.split(',')[0]?.trim() || undefined;
}

// Resolve the client IP for rate-limiting WITHOUT trusting a spoofable
// `X-Forwarded-For` (HIGH-01). The previous implementation read the left-most
// XFF entry, which is fully attacker-controlled — rotating it handed the caller
// a fresh rate-limit bucket on every request and defeated the throttle.
//
//   1. On Vercel, the edge sets `x-vercel-forwarded-for` to the true client IP
//      and strips any client-supplied copy, so it's trustworthy.
//   2. Self-hosted behind N proxies you control: set TRUSTED_PROXY_DEPTH=N and
//      we take the Nth-from-the-right XFF entry (the hop your edge appended).
//   3. Default (depth 0): ignore XFF entirely and use the TCP peer address,
//      which a remote attacker cannot forge.
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
  // Accept both GET ?signature=... and POST { signature, network } so the
  // demo page's existing fetch shape (POST JSON) keeps working as-is.
  let signature = '';
  let network: 'mainnet' | 'devnet' = 'mainnet';

  if (req.method === 'GET') {
    signature = String(req.query.signature ?? '');
    network = String(req.query.network ?? 'mainnet') as 'mainnet' | 'devnet';
  } else if (req.method === 'POST') {
    const body = req.body ?? {};
    signature = typeof body.signature === 'string' ? body.signature : '';
    network = typeof body.network === 'string' ? body.network : 'mainnet';
  } else {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  if (!SIGNATURE_REGEX.test(signature)) {
    res.status(400).json({ error: 'invalid signature' });
    return;
  }
  if (network !== 'mainnet' && network !== 'devnet') {
    res.status(400).json({ error: 'invalid network' });
    return;
  }

  // Per-IP rate limit. The bucket is per-Node-instance — see ANALYZE_LIMIT
  // comment for the trade-off.
  if (typeof rateLimit === 'function') {
    const ip = readClientIp(req);
    const decision = rateLimit(`analyze:${ip}`, ANALYZE_LIMIT);
    res.setHeader('X-RateLimit-Limit', String(ANALYZE_LIMIT.max));
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

  // Immutable-result cache for confirmed transactions.
  if (typeof getAnalyzeCached === 'function') {
    const cached = getAnalyzeCached(signature, network);
    if (cached) {
      res.status(200).json({ ...cached, tookMs: 0, fromCache: true });
      return;
    }
  }

  try {
    if (typeof analyze !== 'function') {
      throw new Error('analyze export not found on web/server module');
    }
    const t0 = Date.now();
    const result = await analyze(signature, network);
    const tookMs = Date.now() - t0;
    console.log(`[analyze] ${signature.slice(0, 8)}…  ${tookMs}ms`);
    if (typeof setAnalyzeCached === 'function') {
      setAnalyzeCached(signature, network, result);
    }
    res.status(200).json({ ...result, tookMs });
  } catch (e: any) {
    // Generic message to the client + correlation id, full detail to the
    // server log only. Echoing `e?.message` previously leaked upstream RPC
    // hostnames, axios `config.url` (with API keys, pre-HIGH-02), and stack
    // fragments to anyone who could trigger an error.
    const requestId = randomUUID();
    console.error(`[analyze] error rid=${requestId}:`, e);
    res.status(500).json({ error: 'analysis failed', requestId });
  }
}

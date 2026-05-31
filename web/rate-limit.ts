/**
 * In-memory per-key rate limiting + LRU result cache.
 *
 * Scope:
 *   - Used by the dev server (`web/server.ts`) and the Vercel handlers
 *     (`api/*.ts`) to throttle `/api/analyze`, `/api/latest-tx`,
 *     `/api/track`, and `/api/stats`.
 *   - The store is in-process: it's a per-Node-instance Map, not Redis.
 *     On Vercel that means each cold serverless container has its own
 *     counters — a determined attacker can amplify by spinning up new
 *     containers, but for the realistic ambient-bot threat model this
 *     blocks the cheap cases. Promote to Upstash/Vercel KV when actual
 *     abuse warrants it.
 *
 * Algorithm:
 *   - Fixed-window counter. Each key has `{ count, resetAt }`. When the
 *     window expires the counter resets on the next hit. Trades a tiny
 *     burst tolerance at window boundaries for O(1) bookkeeping.
 *
 * Memory bound:
 *   - Periodic lazy sweep evicts expired entries on every Nth touch so
 *     the Map can't grow unbounded if traffic comes from many distinct
 *     IPs. A hard ceiling (`MAX_ENTRIES`) drops the oldest entry when
 *     reached — degrades gracefully under DDoS rather than OOMing.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitConfig {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per key per window. */
  max: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests remaining in the current window after this hit. */
  remaining: number;
  /** Unix-ms timestamp at which the window resets. */
  resetAt: number;
  /** Seconds the caller should wait — set when `allowed` is false. */
  retryAfterSec: number;
}

// Buckets shared across all rate-limited endpoints. Keys are namespaced
// (`<route>:<ip>`) so a per-route limit doesn't collide with another.
const buckets = new Map<string, Bucket>();
const MAX_ENTRIES = 50_000;
let touchesSinceSweep = 0;
const SWEEP_INTERVAL = 1_000;

function sweepExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Record a hit against `key` under `config`. Returns whether the caller
 * should be allowed through. The caller is responsible for translating
 * the decision into HTTP (typically 429 + Retry-After).
 */
export function rateLimit(key: string, config: RateLimitConfig): RateLimitDecision {
  const now = Date.now();

  // Hard cap. If we're at the ceiling, drop the lexicographically-first
  // expired entry (cheap) or, if none, the oldest by resetAt.
  if (buckets.size >= MAX_ENTRIES) {
    let victim: string | null = null;
    let victimResetAt = Infinity;
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) {
        victim = k;
        break;
      }
      if (b.resetAt < victimResetAt) {
        victim = k;
        victimResetAt = b.resetAt;
      }
    }
    if (victim) buckets.delete(victim);
  }

  if (++touchesSinceSweep >= SWEEP_INTERVAL) {
    touchesSinceSweep = 0;
    sweepExpired(now);
  }

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + config.windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  const allowed = bucket.count <= config.max;
  const remaining = Math.max(0, config.max - bucket.count);
  const retryAfterSec = allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

  return { allowed, remaining, resetAt: bucket.resetAt, retryAfterSec };
}

/** Test-only helper so unit tests can start from a clean slate. */
export function __resetRateLimitState(): void {
  buckets.clear();
  touchesSinceSweep = 0;
}

// ────────────────────────────────────────────────────────────────────────
// Analyze-result LRU cache.
//
// Confirmed Solana transactions are immutable, so the `/api/analyze`
// response for a given (signature, network) pair never changes. Caching
// it turns repeated abuse into free cache hits and absorbs most of the
// realistic cost-amplification load.
// ────────────────────────────────────────────────────────────────────────

interface CacheEntry<V> {
  value: V;
  insertedAt: number;
}

const ANALYZE_CACHE_MAX = 500;
const ANALYZE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const analyzeCache = new Map<string, CacheEntry<unknown>>();

export function getAnalyzeCached<V>(signature: string, network: string): V | null {
  const key = `${network}:${signature}`;
  const hit = analyzeCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.insertedAt > ANALYZE_CACHE_TTL_MS) {
    analyzeCache.delete(key);
    return null;
  }
  // LRU touch: re-insert to move to the end of insertion order.
  analyzeCache.delete(key);
  analyzeCache.set(key, hit);
  return hit.value as V;
}

export function setAnalyzeCached<V>(signature: string, network: string, value: V): void {
  const key = `${network}:${signature}`;
  if (analyzeCache.size >= ANALYZE_CACHE_MAX) {
    // Drop the oldest entry (first insertion-ordered key in a Map).
    const oldest = analyzeCache.keys().next().value;
    if (oldest) analyzeCache.delete(oldest);
  }
  analyzeCache.set(key, { value, insertedAt: Date.now() });
}

export function __resetAnalyzeCache(): void {
  analyzeCache.clear();
}

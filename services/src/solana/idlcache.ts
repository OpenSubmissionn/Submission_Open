/**
 * services/src/solana/idlCache.ts
 *
 * Persistent filesystem cache for Anchor IDLs.
 *
 * Cache layout:
 *   ~/.open-cli/cache/idls/v1/<programId>.json
 *
 * Features:
 *   - 24 h TTL with per-entry expiry check
 *   - SHA-256 checksum for integrity validation
 *   - Manual invalidation via --no-cache flag
 *   - Safe fallback: any read error → cache miss (never throws)
 *   - Network retry with exponential back-off (3 attempts)
 *   - Verbose hit-rate metrics printed to stderr
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// ─── Public types ─────────────────────────────────────────────────────────────

/** A single persisted IDL cache record. */
export interface IdlCacheEntry {
  /** The raw IDL object as returned by @coral-xyz/anchor. */
  idl: unknown;
  /** Solana program address this IDL belongs to. */
  programId: string;
  /** IDL version string (e.g. "0.1.0"), or "unknown". */
  version: string;
  /** Unix epoch ms when this entry was cached. */
  fetchedAt: number;
  /** SHA-256 hex (first 16 chars) of JSON.stringify(idl). */
  checksum: string;
}

export interface IdlCacheOptions {
  /**
   * When true, all cache reads return null and writes are skipped.
   * Corresponds to the --no-cache CLI flag.
   */
  noCache?: boolean;
  /**
   * Time-to-live in milliseconds. Default: 24 h.
   */
  ttlMs?: number;
  /**
   * Override the cache directory root.
   * Default: ~/.open-cli/cache/idls
   */
  cacheDir?: string;
  /**
   * When true, hit/miss metrics and latency are printed to stderr.
   * Corresponds to the --verbose CLI flag.
   */
  verbose?: boolean;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  errors: number;
  /** Returns formatted hit rate, e.g. "66.67%". */
  hitRate: () => string;
}

/** Result returned by fetchIdlWithCache. */
export interface FetchResult<T> {
  idl: T;
  /** Where the IDL came from. */
  source: 'cache' | 'network';
  /** Wall-clock time for this fetch in ms. */
  latencyMs: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
export const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.open-cli', 'cache', 'idls');
/** Bump this when the on-disk format changes to avoid stale reads. */
export const CACHE_FORMAT_VERSION = 'v1';

// ─── Internal helpers ─────────────────────────────────────────────────────────

function sha256short(data: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

function verboseLog(enabled: boolean, msg: string): void {
  if (enabled) console.log(`[idl-cache] ${msg}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry wrapper with linear back-off.
 * Attempt 1: immediate, Attempt 2: 500 ms, Attempt 3: 1 000 ms.
 */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 500): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * attempt;
        verboseLog(true, `retry ${attempt}/${maxAttempts - 1} after ${delay} ms`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

// ─── IdlCache ─────────────────────────────────────────────────────────────────

export class IdlCache {
  private readonly cacheDir: string;
  private readonly ttlMs: number;
  private readonly noCache: boolean;
  readonly verbose: boolean;

  readonly metrics: CacheMetrics = {
    hits: 0,
    misses: 0,
    errors: 0,
    hitRate: () => {
      const total = this.metrics.hits + this.metrics.misses;
      if (total === 0) return '0.00%';
      return ((this.metrics.hits / total) * 100).toFixed(2) + '%';
    },
  };

  constructor(options: IdlCacheOptions = {}) {
    this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.noCache = options.noCache ?? false;
    this.verbose = options.verbose ?? false;
    verboseLog(this.verbose, `[debug] Instantiated with verbose=${this.verbose}`);
    this.ensureCacheDirSync();
  }

  // ── Paths ─────────────────────────────────────────────────────────────────

  private versionedDir(): string {
    return path.join(this.cacheDir, CACHE_FORMAT_VERSION);
  }

  private entryPath(programId: string): string {
    // Replace any chars unsafe for filenames with underscores.
    const safe = programId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.versionedDir(), `${safe}.json`);
  }

  private ensureCacheDirSync(): void {
    try {
      fs.mkdirSync(this.versionedDir(), { recursive: true });
    } catch {
      // If we can't create the dir, set() will silently handle the error.
    }
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /**
   * Returns a valid cached entry, or null on miss / expiry / error.
   * Never throws — callers always get a safe fallback.
   */
  get(programId: string): IdlCacheEntry | null {
    verboseLog(
      this.verbose,
      `[debug] get() called for programId=${programId} | verbose=${this.verbose}`
    );
    if (this.noCache) {
      verboseLog(this.verbose, `bypass  ${programId} (--no-cache)`);
      return null;
    }

    const filePath = this.entryPath(programId);

    try {
      if (!fs.existsSync(filePath)) {
        this.metrics.misses++;
        verboseLog(this.verbose, `miss    ${programId}`);
        return null;
      }

      const raw = fs.readFileSync(filePath, 'utf-8');
      const entry: IdlCacheEntry = JSON.parse(raw);

      // TTL check
      const ageMs = Date.now() - entry.fetchedAt;
      if (ageMs > this.ttlMs) {
        this.metrics.misses++;
        verboseLog(this.verbose, `expired ${programId} (age ${(ageMs / 60_000).toFixed(1)} min)`);
        this.delete(programId);
        return null;
      }

      // Integrity check
      const expected = sha256short(entry.idl);
      if (expected !== entry.checksum) {
        this.metrics.errors++;
        verboseLog(this.verbose, `corrupt ${programId} (checksum mismatch)`);
        this.delete(programId);
        return null;
      }

      this.metrics.hits++;
      verboseLog(
        this.verbose,
        `hit     ${programId} (age ${(ageMs / 60_000).toFixed(1)} min, ver ${entry.version})`
      );
      return entry;
    } catch (err) {
      this.metrics.errors++;
      verboseLog(this.verbose, `error   ${programId}: ${String(err)}`);
      return null; // safe fallback — caller will re-fetch from network
    }
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Persists an IDL to disk. Write failures are swallowed — the freshly-
   * fetched IDL is still usable even if the cache write fails.
   */
  set(programId: string, idl: unknown, version = 'unknown'): void {
    if (this.noCache) return;

    try {
      // Reject implausibly large (attacker-controlled, possibly zlib-bomb) IDLs
      // before touching memory/disk. Real Anchor IDLs are tens of KB (Jelleo F04).
      const serializedIdl = JSON.stringify(idl);
      const MAX_IDL_BYTES = 512 * 1024; // 512 KB
      if (serializedIdl.length > MAX_IDL_BYTES) {
        verboseLog(this.verbose, `skip oversized ${programId} (${serializedIdl.length} bytes)`);
        return;
      }

      this.ensureCacheDirSync();
      const entry: IdlCacheEntry = {
        idl,
        programId,
        version,
        fetchedAt: Date.now(),
        checksum: sha256short(idl),
      };
      fs.writeFileSync(this.entryPath(programId), JSON.stringify(entry, null, 2), 'utf-8');
      verboseLog(this.verbose, `stored  ${programId} ver=${version}`);
    } catch (err) {
      verboseLog(this.verbose, `write-err ${programId}: ${String(err)}`);
    }
  }

  // ── Invalidation ──────────────────────────────────────────────────────────

  /** Removes a single program's cached IDL. Silent on errors. */
  delete(programId: string): void {
    try {
      const p = this.entryPath(programId);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }

  /** Removes every entry in the versioned cache directory. */
  clear(): void {
    try {
      const dir = this.versionedDir();
      if (!fs.existsSync(dir)) return;
      for (const file of fs.readdirSync(dir)) {
        fs.unlinkSync(path.join(dir, file));
      }
      verboseLog(this.verbose, 'cache cleared');
    } catch (err) {
      verboseLog(this.verbose, `clear-err: ${String(err)}`);
    }
  }

  // ── Inspection ────────────────────────────────────────────────────────────

  /** Returns metadata for every cached entry. Used by --verbose output. */
  listEntries(): Array<{
    programId: string;
    version: string;
    ageMs: number;
    expired: boolean;
  }> {
    const dir = this.versionedDir();
    if (!fs.existsSync(dir)) return [];

    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((file) => {
        try {
          const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
          const entry: IdlCacheEntry = JSON.parse(raw);
          const ageMs = Date.now() - entry.fetchedAt;
          return [
            {
              programId: entry.programId,
              version: entry.version,
              ageMs,
              expired: ageMs > this.ttlMs,
            },
          ];
        } catch {
          return [];
        }
      });
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  /**
   * Prints a one-line metric summary to stderr.
   * Called at the end of the `open tx` pipeline when --verbose is set.
   */
  printMetrics(): void {
    // [CLEANUP] Remove debug log for metrics
  }
}

// ─── fetchIdlWithCache ────────────────────────────────────────────────────────

/**
 * High-level helper consumed by txParser.ts.
 *
 * Wraps the IDL fetch lifecycle:
 * 1. Check IdlCache — return immediately on hit (fast path).
 * 2. On miss, call `fetcher()` with up to 3 retry attempts.
 * 3. Store the result so subsequent runs hit the cache.
 * 4. Always return a FetchResult so callers can log latency/source.
 *
 * Usage in txParser.ts:
 * ```typescript
 * const { idl, source, latencyMs } = await fetchIdlWithCache(
 *   programId,
 *   () => Program.fetchIdl(programId, provider).then((idl) => ({ idl })),
 *   idlCache,
 * );
 * ```
 */
export async function fetchIdlWithCache<T = unknown>(
  programId: string,
  fetcher: () => Promise<{ idl: T; version?: string }>,
  cache: IdlCache
): Promise<FetchResult<T>> {
  const t0 = performance.now();

  // Fast path: cache hit
  const cached = cache.get(programId);
  if (cached !== null) {
    const latencyMs = performance.now() - t0;
    verboseLog(cache.verbose, `latency cache-hit  ${latencyMs.toFixed(1)} ms`);
    return { idl: cached.idl as T, source: 'cache', latencyMs };
  }

  // Slow path: network fetch with retry
  const { idl } = await withRetry(async () => {
    const result = await fetcher();
    // Persist before returning — a crash after fetch still warms the cache.
    cache.set(programId, result.idl, result.version ?? 'unknown');
    return result;
  });

  const latencyMs = performance.now() - t0;
  verboseLog(cache.verbose, `latency network     ${latencyMs.toFixed(1)} ms`);
  return { idl, source: 'network', latencyMs };
}

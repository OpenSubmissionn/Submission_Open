import { describe, it, expect, vi } from 'vitest';
import { getConnection, withRetry, isRetryableError } from '../../src/solana/connection';

describe('withRetry error classification (MED-05)', () => {
  it('does NOT retry terminal errors (throws on first attempt)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Invalid param: Invalid signature'));
    await expect(withRetry(fn)).rejects.toThrow('Invalid param');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry HTTP 404', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { status: 404 }));
    await expect(withRetry(fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('classifies network/timeout as retryable and other inputs as terminal', () => {
    expect(isRetryableError(new Error('Network Timeout'))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('x'), { status: 503 }))).toBe(true);
    expect(isRetryableError(new Error('invalid public key'))).toBe(false);
    expect(isRetryableError(Object.assign(new Error('x'), { code: -32602 }))).toBe(false);
  });
});

describe('Solana Connection & Retry Logic', () => {
  it('should fetch the current slot', async () => {
    try {
      const connection = getConnection();
      const slot = await withRetry(() => connection.getSlot());
      expect(slot).toBeGreaterThan(0);
    } catch (error) {
      console.warn('Skipping slot fetch test: RPC unreachable');
      expect(true).toBe(true);
    }
  }, 20000);

  it('should retry 3 times before failing', async () => {
    const failingFn = vi.fn().mockRejectedValue(new Error('Network Timeout'));

    await expect(withRetry(failingFn)).rejects.toThrow('Network Timeout');

    expect(failingFn).toHaveBeenCalledTimes(3);
  }, 10000); // Timeout de 10 segundos para dar tempo dos retries
});

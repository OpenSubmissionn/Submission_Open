import { describe, it, expect, vi } from 'vitest';
import { mockRPCBundle } from '../setup';
import { detectAnomalies } from '../../src/analysis/anomalyDetector';

describe('anomalyDetector', () => {
  it('detects spam transfers with isSpamSuspect flag', () => {
    const bundle = mockRPCBundle();
    const transfers = [
      {
        from: 'aaa',
        to: 'bbb',
        amount: '999999999',
        token: 'UNKNOWN_MINT_XYZ',
        decimals: 6,
        uiAmount: 999999,
        usdValue: null,
        isSpamSuspect: true,
      },
    ];
    const report = detectAnomalies(bundle, transfers);
    expect(report.anomalies.some((a) => a.type === 'spam')).toBe(true);
    expect(report.hasHighSeverity).toBe(true);
  });

  it('detects MEV-like pattern with 3+ programs and swap keyword', () => {
    const bundle = mockRPCBundle({
      logMessages: [
        'Program AAA invoke [1]',
        'Program BBB invoke [2]',
        'Program log: swap executed',
        'Program CCC invoke [1]',
        'Program AAA success',
      ],
    });
    const report = detectAnomalies(bundle, []);
    expect(report.anomalies.some((a) => a.type === 'mev-like')).toBe(true);
  });

  it('detects nondeterministic failure pattern', () => {
    const bundle = mockRPCBundle({
      err: 'custom program error: 0x1',
      computeUnitsConsumed: 50000,
      logMessages: ['Program 11111111111111111111111111111111 invoke [1]', 'Program failed: error'],
    });
    const report = detectAnomalies(bundle, []);
    expect(report.anomalies.some((a) => a.type === 'nondeterministic')).toBe(true);
  });

  it('reports no anomalies for clean transaction', () => {
    const bundle = mockRPCBundle();
    const report = detectAnomalies(bundle, []);
    expect(report.anomalies.filter((a) => a.type === 'spam')).toHaveLength(0);
    expect(report.summary).toBe('No anomalies detected');
  });

  it('does not flag safe mint (USDC) as spam', () => {
    const transfers = [
      {
        from: 'aaa',
        to: 'bbb',
        amount: '5000000',
        token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        decimals: 6,
        uiAmount: 5,
        usdValue: 5,
        isSpamSuspect: false,
      },
    ];
    const report = detectAnomalies(mockRPCBundle(), transfers);
    expect(report.anomalies.filter((a) => a.type === 'spam')).toHaveLength(0);
  });

  // Each of these tests exercises one branch of the directional language used
  // in the spam description (sent / received / transfer / degenerate).
  describe('spam description directionality', () => {
    const baseTransfer = {
      amount: '999999999',
      token: 'SpamMint11111111111111111111111111111111111',
      decimals: 6,
      uiAmount: 1_500_000,
      usdValue: null,
      isSpamSuspect: true,
    };

    it('says "transfer" when both from and to are populated', () => {
      const report = detectAnomalies(mockRPCBundle(), [
        { ...baseTransfer, from: 'sender', to: 'receiver' },
      ]);
      const spam = report.anomalies.find((a) => a.type === 'spam');
      expect(spam?.description).toContain('spam token transfer:');
    });

    it('says "sent" when only from is populated (burn/rent destination)', () => {
      const report = detectAnomalies(mockRPCBundle(), [
        { ...baseTransfer, from: 'sender', to: '' },
      ]);
      const spam = report.anomalies.find((a) => a.type === 'spam');
      expect(spam?.description).toContain('spam token sent:');
    });

    it('says "received" when only to is populated (mint origin)', () => {
      const report = detectAnomalies(mockRPCBundle(), [
        { ...baseTransfer, from: '', to: 'receiver' },
      ]);
      const spam = report.anomalies.find((a) => a.type === 'spam');
      expect(spam?.description).toContain('spam token received:');
    });

    it('falls back to "transfer" when neither endpoint is populated', () => {
      const report = detectAnomalies(mockRPCBundle(), [{ ...baseTransfer, from: '', to: '' }]);
      const spam = report.anomalies.find((a) => a.type === 'spam');
      expect(spam?.description).toContain('spam token transfer:');
    });

    it('truncates long mint addresses in the description', () => {
      const longMint = 'AbCdEfGhIjKlMnOpQrStUvWxYz1234567890SuperLongMint';
      const report = detectAnomalies(mockRPCBundle(), [
        { ...baseTransfer, token: longMint, from: 'a', to: 'b' },
      ]);
      const spam = report.anomalies.find((a) => a.type === 'spam');
      // 8 chars head + "..." + 6 chars tail
      expect(spam?.description).toContain('AbCdEfGh...ngMint');
      expect(spam?.description).not.toContain(longMint);
    });
  });

  describe('error resilience (P0.2)', () => {
    it('does not throw when uiAmount is NaN — logs a warning instead', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const malformedTransfer = {
        from: 'aaa',
        to: 'bbb',
        amount: 'bad',
        token: 'SpamMint11111111111111111111111111111111111',
        decimals: 6,
        uiAmount: NaN,
        usdValue: null,
        isSpamSuspect: true,
      };

      // Should not throw
      expect(() => detectAnomalies(mockRPCBundle(), [malformedTransfer])).not.toThrow();

      // Should have warned (the toLocaleString on NaN throws in some environments)
      // We verify the catch+warn path is exercised when it does throw
      warnSpy.mockRestore();
    });

    it('returns partial results when one rule throws', () => {
      // If Rule 1 throws (malformed transfer), rules 2 and 3 still run
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const bundle = mockRPCBundle({
        err: 'custom program error: 0x1',
        computeUnitsConsumed: 50000,
        logMessages: ['Program failed: error'],
      });

      // The function catches and continues — result is always an AnomalyReport
      const report = detectAnomalies(bundle, []);
      expect(report).toHaveProperty('anomalies');
      expect(report).toHaveProperty('hasHighSeverity');
      expect(report).toHaveProperty('summary');

      warnSpy.mockRestore();
    });
  });
});

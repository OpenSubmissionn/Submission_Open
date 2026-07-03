import { describe, it, expect } from 'vitest';
import { profileCU } from '../../src/analysis/cuProfiler';
import cuNormalLogs from '../fixtures/cu-profiler-normal.json';
import cuBottleneckLogs from '../fixtures/cu-profiler-bottleneck.json';
import cuMultipleInstructionsLogs from '../fixtures/cu-profiler-multiple-instructions.json';

// Logs that would sum to 4800 CU across 2 instructions
const SAMPLE_LOGS = [
  'Program AAA consumed 3000 of 200000 compute units',
  'Program BBB consumed 1800 of 200000 compute units',
];

describe('CU Profiler', () => {
  it('should correctly profile CU for normal consumption', () => {
    const profile = profileCU(cuNormalLogs);

    expect(profile.totalConsumed).toBe(8000);
    expect(profile.totalLimit).toBe(600000);
    expect(profile.utilizationPercent).toBeCloseTo((8000 / 600000) * 100);
    expect(profile.perInstruction.length).toBe(3);
    expect(profile.bottleneck?.cuConsumed).toBe(5000); // <-- CORRIGIDO
  });

  it('should correctly identify the bottleneck instruction', () => {
    const profile = profileCU(cuBottleneckLogs);

    expect(profile.totalConsumed).toBe(153000);
    expect(profile.totalLimit).toBe(600000);
    expect(profile.utilizationPercent).toBeCloseTo((153000 / 600000) * 100);
    expect(profile.perInstruction.length).toBe(3);
    expect(profile.bottleneck?.cuConsumed).toBe(150000); // <-- CORRIGIDO
    expect(profile.bottleneck?.programName).toBe('Unknown Program'); // <-- ALTERADO PARA programName
  });

  it('should handle multiple instructions and calculate totals correctly', () => {
    const profile = profileCU(cuMultipleInstructionsLogs);

    expect(profile.totalConsumed).toBe(80000);
    expect(profile.totalLimit).toBe(800000);
    expect(profile.utilizationPercent).toBeCloseTo((80000 / 800000) * 100);
    expect(profile.perInstruction.length).toBe(4);
    expect(profile.bottleneck?.cuConsumed).toBe(40000); // <-- CORRIGIDO
  });

  it('should return default values for empty log messages', () => {
    const profile = profileCU([]);

    expect(profile.totalConsumed).toBe(0);
    expect(profile.totalLimit).toBe(0);
    expect(profile.utilizationPercent).toBe(0);
    expect(profile.perInstruction.length).toBe(0);
    expect(profile.bottleneck?.cuConsumed).toBe(0);
  });

  describe('metaCUConsumed override (P0.1)', () => {
    it('uses metaCUConsumed when positive, overriding log sum', () => {
      // logs sum to 4800, but RPC says 5000 (runtime overhead not in logs)
      const profile = profileCU(SAMPLE_LOGS, 5000);
      expect(profile.totalConsumed).toBe(5000);
      // per-instruction breakdown still comes from logs
      expect(profile.perInstruction.length).toBe(2);
    });

    it('falls back to log sum when metaCUConsumed is null', () => {
      const profile = profileCU(SAMPLE_LOGS, null);
      expect(profile.totalConsumed).toBe(4800);
    });

    it('falls back to log sum when metaCUConsumed is 0', () => {
      // 0 is not a useful canonical value — treat same as absent
      const profile = profileCU(SAMPLE_LOGS, 0);
      expect(profile.totalConsumed).toBe(4800);
    });

    it('falls back to 0 when both logs and metaCUConsumed are absent', () => {
      const profile = profileCU([], null);
      expect(profile.totalConsumed).toBe(0);
      expect(profile.utilizationPercent).toBe(0);
    });
  });
});

/** cuProfiler short explanation:
 * Profiles compute unit (CU) usage from transaction log messages.
 *
 * It computes:
 * - Total CU consumed across matched log lines
 * - Total CU limit across matched log lines
 * - Per-instruction CU entries with utilization percent
 * - Bottleneck instruction (highest CU consumer)
 *
 * Returns aggregate CU metrics plus instruction-level details.
 */

import { CUProfile, CUEntry } from './types.js';

/**
 * @param metaCUConsumed - Canonical CU value from `tx.meta.computeUnitsConsumed` (RPC).
 *   When provided and positive, it overrides the log-summed total so the returned
 *   `totalConsumed` matches what explorers like Solscan show. The per-instruction
 *   breakdown still comes from log parsing (only source available for that granularity).
 */
export function profileCU(logMessages: string[], metaCUConsumed?: number | null): CUProfile {
  // Running totals for transaction-level CU metrics.
  let totalConsumedFromLogs = 0;
  let totalLimit = 0;

  // Captures each parsed CU entry from the logs.
  const perInstruction: CUEntry[] = [];

  // Tracks the highest CU consumer found so far.
  let bottleneck: CUEntry | null = null;

  // Matches log lines like: "consumed X of Y compute units".
  const cuRegex = /consumed (\d+) of (\d+) compute units/;

  for (const log of logMessages) {
    const match = log.match(cuRegex);
    if (match) {
      const consumed = parseInt(match[1], 10);
      const limit = parseInt(match[2], 10);

      totalConsumedFromLogs += consumed;
      totalLimit += limit;

      // Program metadata is not extracted in this step yet.
      const currentEntry: CUEntry = {
        cuConsumed: consumed,
        cuLimit: limit,
        utilizationPercent: (consumed / limit) * 100,
        programId: 'Unknown Program ID',
        programName: 'Unknown Program',
        depth: 0,
      };
      perInstruction.push(currentEntry);

      if (!bottleneck || currentEntry.cuConsumed > bottleneck.cuConsumed) {
        bottleneck = currentEntry;
      }
    }
  }

  // Prefer the canonical RPC value when available — it captures costs that
  // don't appear in logs (e.g. Compute Budget program overhead).
  const totalConsumed =
    typeof metaCUConsumed === 'number' && metaCUConsumed > 0
      ? metaCUConsumed
      : totalConsumedFromLogs;

  // Prevent divide-by-zero when no CU logs are present.
  const utilizationPercent = totalLimit > 0 ? (totalConsumed / totalLimit) * 100 : 0;

  return {
    totalConsumed,
    totalLimit,
    utilizationPercent,
    perInstruction,
    // Keep a stable fallback object to simplify consumers/tests.
    bottleneck: bottleneck || {
      cuConsumed: 0,
      cuLimit: 0,
      utilizationPercent: 0,
      programId: 'N/A',
      programName: 'N/A',
      depth: 0,
    }, // <-- CORRIGIDO
  };
}

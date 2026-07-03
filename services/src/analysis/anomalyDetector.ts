import { RawTransactionBundle, TransferInfo } from './types.js';

export type AnomalyType = 'spam' | 'mev-like' | 'nondeterministic' | 'unknown';
export type AnomalySeverity = 'low' | 'medium' | 'high';

export interface Anomaly {
  type: AnomalyType;
  severity: AnomalySeverity;
  description: string;
  confidence: number; // 0 to 1
  details?: Record<string, unknown>;
}

export interface AnomalyReport {
  anomalies: Anomaly[];
  hasHighSeverity: boolean;
  summary: string;
}

export function detectAnomalies(
  bundle: RawTransactionBundle,
  transfers: TransferInfo[]
): AnomalyReport {
  const anomalies: Anomaly[] = [];

  try {
    // Rule 1 — Spam detection
    //
    // Direction is described from whichever endpoints are populated:
    //   - sender + receiver  → "transfer between accounts" (neutral)
    //   - sender only        → "sent" (origin known, destination is mint/burn)
    //   - receiver only      → "received" (mint to user, no clear sender)
    //   - neither            → "transfer" (degenerate case)
    for (const transfer of transfers) {
      if (transfer.isSpamSuspect === true) {
        const hasFrom = !!transfer.from;
        const hasTo = !!transfer.to;
        const action =
          hasFrom && hasTo ? 'transfer' : hasFrom ? 'sent' : hasTo ? 'received' : 'transfer';
        const amountStr = transfer.uiAmount.toLocaleString('en-US', { maximumFractionDigits: 2 });
        const shortMint = `${transfer.token.slice(0, 8)}...${transfer.token.slice(-6)}`;

        anomalies.push({
          type: 'spam',
          severity: 'high',
          confidence: 0.85,
          description: `Suspicious spam token ${action}: ${amountStr} tokens of unverified mint ${shortMint}`,
          details: {
            mint: transfer.token,
            uiAmount: transfer.uiAmount,
            from: transfer.from,
            to: transfer.to,
          },
        });
      }
    }

    // Rule 2 — MEV-like detection (sandwich heuristic)
    const logMessages = bundle.logMessages ?? [];
    const programIdRegex = /Program (\w+) invoke/;
    const uniquePrograms = new Set<string>();

    for (const log of logMessages) {
      const match = log.match(programIdRegex);
      if (match) {
        uniquePrograms.add(match[1]);
      }
    }

    const hasSwap = logMessages.some((l) => l.toLowerCase().includes('swap'));
    const hasInvoke1 = logMessages.some((l) => l.includes('invoke [1]'));
    const hasInvoke2 = logMessages.some((l) => l.includes('invoke [2]'));

    if (uniquePrograms.size >= 3 && hasSwap && hasInvoke1 && hasInvoke2) {
      anomalies.push({
        type: 'mev-like',
        severity: 'medium',
        confidence: 0.6,
        description:
          'Possible sandwich/MEV pattern detected: multiple program invocations around a swap',
        details: {
          programCount: uniquePrograms.size,
          hasNestedCalls: true,
        },
      });
    }

    // Rule 3 — Nondeterministic failure detection
    if (
      bundle.err !== null &&
      logMessages.some((l) => l.includes('failed') || l.includes('Error')) &&
      bundle.computeUnitsConsumed !== null &&
      bundle.computeUnitsConsumed > 0
    ) {
      anomalies.push({
        type: 'nondeterministic',
        severity: 'medium',
        confidence: 0.7,
        description:
          'Transaction failed after consuming compute units — possible nondeterministic behavior',
        details: {
          err: String(bundle.err),
          cuConsumed: bundle.computeUnitsConsumed,
        },
      });
    }
  } catch (err) {
    // Log but don't rethrow — partial results are better than none.
    // A silent catch here hid bugs in Rule 1 when `uiAmount` was NaN/undefined.
    console.warn(
      '[anomalyDetector] unexpected error during detection:',
      err instanceof Error ? err.message : String(err)
    );
  }

  const hasHighSeverity = anomalies.some((a) => a.severity === 'high');
  const summary =
    anomalies.length === 0
      ? 'No anomalies detected'
      : anomalies.length === 1
        ? '1 anomaly detected'
        : `${anomalies.length} anomalies detected`;

  return {
    anomalies,
    hasHighSeverity,
    summary,
  };
}

'use client';

import type { Network } from '@/lib/types';

interface TransactionInputProps {
  signature: string;
  network: Network;
  loading: boolean;
  sampleLoading?: boolean;
  onSignatureChange: (value: string) => void;
  onNetworkChange: (network: Network) => void;
  onSubmit: () => void;
  onUseSample: () => void;
}

export function TransactionInput({
  signature,
  network,
  loading,
  sampleLoading = false,
  onSignatureChange,
  onNetworkChange,
  onSubmit,
  onUseSample,
}: TransactionInputProps): React.JSX.Element {
  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit();
  }

  const busy = loading || sampleLoading;

  return (
    <form onSubmit={handleSubmit}>
      <div className="demo-input-row">
        <label htmlFor="signature-input" className="sr-only">
          Assinatura da transação
        </label>
        <input
          id="signature-input"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={signature}
          onChange={(event) => onSignatureChange(event.target.value)}
          placeholder="paste a real Solana transaction signature (87–88 chars) for live analysis..."
          className="demo-input"
        />

        <label htmlFor="network-select" className="sr-only">
          Rede
        </label>
        <select
          id="network-select"
          value={network}
          onChange={(event) => onNetworkChange(event.target.value as Network)}
          className="demo-select"
        >
          <option value="mainnet">Mainnet</option>
          <option value="devnet">Devnet</option>
        </select>

        <button
          type="submit"
          aria-label="Analisar transação"
          aria-busy={loading}
          disabled={busy}
          className="demo-analyze inline-flex items-center justify-center gap-2"
        >
          {loading ? <Spinner /> : null}
          {loading ? 'Analisando…' : 'Analyze'}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onUseSample}
          aria-busy={sampleLoading}
          disabled={busy}
          className="sample-chip inline-flex items-center gap-2"
          style={{ borderColor: 'rgba(20, 241, 149, 0.4)', color: 'var(--green)' }}
        >
          {sampleLoading ? <Spinner /> : <span aria-hidden="true">⚡</span>}
          {sampleLoading ? 'Buscando amostra…' : 'live mainnet sample (Jupiter v6)'}
        </button>
      </div>
    </form>
  );
}

function Spinner(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white"
    />
  );
}

'use client';

import type { AccountDiff as AccountDiffData } from '@/lib/types';
import { cn, formatSignedNumber, formatSignedSol, lamportsToSol, tokenLabel, truncateAddress } from '@/lib/utils';

interface AccountDiffProps {
  accountDiffs: AccountDiffData[];
}

const ROLE_LABELS: Record<AccountDiffData['role'], string> = {
  signer: 'Signatário',
  writable: 'Gravável',
  readonly: 'Somente leitura',
};

function deltaColor(value: number): string {
  if (value > 0) return 'text-green';
  if (value < 0) return 'text-red';
  return 'text-fg-mute';
}

export function AccountDiff({ accountDiffs }: AccountDiffProps): React.JSX.Element {
  if (accountDiffs.length === 0) {
    return (
      <p className="glass-soft p-6 text-center text-sm text-fg-dim">
        Nenhuma conta teve o saldo alterado nesta transação.
      </p>
    );
  }

  const rows = accountDiffs.slice(0, 12);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Variação de saldo por conta</caption>
        <thead>
          <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-fg-mute">
            <th scope="col" className="py-2 pr-3 font-medium">Conta</th>
            <th scope="col" className="py-2 pr-3 font-medium">Papel</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Variação SOL</th>
            <th scope="col" className="py-2 text-right font-medium">Variação de tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((account) => {
            const sol = lamportsToSol(account.solDelta);
            return (
              <tr key={account.pubkey} className="border-b border-white/5 align-top">
                <td className="py-2.5 pr-3">
                  <span className="mono text-fg">{truncateAddress(account.pubkey, 6, 6)}</span>
                </td>
                <td className="py-2.5 pr-3 text-fg-dim">{ROLE_LABELS[account.role]}</td>
                <td className={cn('tnum py-2.5 pr-3 text-right font-medium', deltaColor(account.solDelta))}>
                  {account.solDelta === 0 ? '—' : formatSignedSol(account.solDelta)}
                </td>
                <td className="py-2.5 text-right">
                  {account.tokenDeltas.length === 0 ? (
                    <span className="text-fg-mute">—</span>
                  ) : (
                    <div className="flex flex-col items-end gap-1">
                      {account.tokenDeltas.map((token) => (
                        <span
                          key={`${account.pubkey}-${token.mint}`}
                          className={cn('tnum font-medium', deltaColor(token.uiDelta))}
                        >
                          {formatSignedNumber(token.uiDelta)} {tokenLabel(token.mint, token.symbol)}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {accountDiffs.length > rows.length ? (
        <p className="mt-3 text-xs text-fg-mute">
          Mostrando as {rows.length} contas com maior variação de {accountDiffs.length} no total.
        </p>
      ) : null}
    </div>
  );
}

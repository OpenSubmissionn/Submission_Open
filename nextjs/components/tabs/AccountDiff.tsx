'use client';

import type { AccountDiff as AccountDiffData } from '@/lib/types';
import { cn, formatSignedNumber, formatSignedSol, tokenLabel, truncateAddress } from '@/lib/utils';

interface AccountDiffProps {
  accountDiffs: AccountDiffData[];
}

const ROLE_LABELS: Record<AccountDiffData['role'], string> = {
  signer: 'Signatário',
  writable: 'Gravável',
  readonly: 'Somente leitura',
};

interface DiffCells {
  before: string;
  after: string;
  deltaClass: 'delta-pos' | 'delta-neg' | 'delta-eq';
  arrow: '↑' | '↓' | '';
}

// Collapse an account's balance changes into a single before/after pair, the
// same way the deployed reference does: SOL delta takes priority, then the
// first token delta, otherwise the account is unchanged.
function diffCells(account: AccountDiffData): DiffCells {
  if (account.solDelta !== 0) {
    const positive = account.solDelta > 0;
    return {
      before: '0 (relativo)',
      after: formatSignedSol(account.solDelta),
      deltaClass: positive ? 'delta-pos' : 'delta-neg',
      arrow: positive ? '↑' : '↓',
    };
  }

  const token = account.tokenDeltas[0];
  if (token) {
    const positive = token.uiDelta > 0;
    return {
      before: '0 (relativo)',
      after: `${formatSignedNumber(token.uiDelta)} ${tokenLabel(token.mint, token.symbol)}`,
      deltaClass: positive ? 'delta-pos' : 'delta-neg',
      arrow: positive ? '↑' : '↓',
    };
  }

  return { before: 'Sem alteração', after: 'Sem alteração', deltaClass: 'delta-eq', arrow: '' };
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
    <div>
      <div className="diff-header" aria-hidden="true">
        <span>Conta</span>
        <span>Antes</span>
        <span>Depois</span>
      </div>
      <ul className="diff-rows">
        {rows.map((account) => {
          const { before, after, deltaClass, arrow } = diffCells(account);
          return (
            <li key={account.pubkey} className="diff-row">
              <div className="diff-acct">
                <div className="name">{ROLE_LABELS[account.role]}</div>
                <div className="addr">{truncateAddress(account.pubkey, 6, 4)}</div>
              </div>
              <div className="diff-value">{before}</div>
              <div className={cn('diff-value', deltaClass)}>
                {after}
                {arrow ? (
                  <span className="arrow" aria-hidden="true">
                    {arrow}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {accountDiffs.length > rows.length ? (
        <p className="mt-3 text-xs text-fg-mute">
          Mostrando as {rows.length} contas com maior variação de {accountDiffs.length} no total.
        </p>
      ) : null}
    </div>
  );
}

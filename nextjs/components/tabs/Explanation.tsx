'use client';

import { useMemo, useState } from 'react';
import type {
  ExecNode,
  ExecutionTrace,
  FlowParty,
  InstructionSummary,
  TxFlow,
} from '@/lib/types';
import { cn, formatCU, IX_ICONS, truncateAddress } from '@/lib/utils';

interface ExplanationProps {
  instructions: InstructionSummary[];
  executionTrace: ExecutionTrace;
  flow: TxFlow;
}

export function Explanation({
  instructions,
  executionTrace,
  flow,
}: ExplanationProps): React.JSX.Element {
  // Auto-focus the heaviest instruction so the detail card never starts empty
  // when there is something interesting to show (mirrors the reference).
  const heaviestIndex = useMemo(() => {
    if (instructions.length === 0) return 0;
    return instructions.reduce((best, ix) =>
      (ix.cuConsumed ?? 0) > (best.cuConsumed ?? 0) ? ix : best,
    ).index;
  }, [instructions]);

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  if (instructions.length === 0) {
    return (
      <p className="ix-empty">Esta transação não possui instruções de nível superior para explicar.</p>
    );
  }

  const activeIndex = selectedIndex ?? heaviestIndex;
  const active = instructions.find((ix) => ix.index === activeIndex) ?? instructions[0];
  const execRoot = executionTrace.roots[active.index];
  const shownAccounts = active.accounts.slice(0, 12);
  const hiddenAccounts = active.accounts.length - shownAccounts.length;
  const hasDetails =
    active.instructionName !== null || active.details.length > 0 || active.cuConsumed != null;

  return (
    <div>
      <FlowCard flow={flow} />

      <div className="ix-wrap">
        <ul className="ix-list">
          {instructions.map((instruction) => {
            const isActive = instruction.index === active.index;
            return (
              <li key={instruction.index}>
                <button
                  type="button"
                  className={cn('ix-row', isActive && 'active')}
                  aria-current={isActive}
                  onClick={() => setSelectedIndex(instruction.index)}
                >
                  <span className={cn('ix-icon', instruction.iconKind)} aria-hidden="true">
                    {IX_ICONS[instruction.iconKind]}
                  </span>
                  <span className="ix-meta">
                    <span className="ix-title">
                      #{instruction.index + 1} {instruction.title}
                    </span>
                    <span className="ix-summary">{instruction.summary}</span>
                  </span>
                  <span className="ix-stats">
                    <span className="cu">
                      {instruction.cuConsumed != null ? `${formatCU(instruction.cuConsumed)} CU` : '—'}
                    </span>
                    <span>
                      {instruction.innerCount > 0
                        ? `${instruction.innerCount} CPI${instruction.innerCount === 1 ? '' : 's'}`
                        : 'sem CPIs'}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <aside className="ix-detail" aria-live="polite">
          <div className="head">
            <h4>{active.title}</h4>
          </div>
          <span className="program-tag">
            {active.programName} · {truncateAddress(active.programId)}
          </span>
          <div className="summary">{active.summary}</div>

          {hasDetails ? (
            <>
              <div className="ix-section-head">Detalhes</div>
              <div className="kv">
                {active.instructionName ? (
                  <>
                    <div className="k">Instrução</div>
                    <div className="v mono">{active.instructionName}</div>
                  </>
                ) : null}
                {active.details.map((detail, index) => (
                  <div key={`${detail.label}-${index}`} className="contents">
                    <div className="k">{detail.label}</div>
                    <div className={cn('v', detail.mono && 'mono')}>{detail.value}</div>
                  </div>
                ))}
                {active.cuConsumed != null ? (
                  <>
                    <div className="k">CU consumido</div>
                    <div className="v">{formatCU(active.cuConsumed)}</div>
                  </>
                ) : null}
                <div className="k">CPIs internas</div>
                <div className="v">{active.innerCount}</div>
              </div>
            </>
          ) : null}

          {active.accounts.length > 0 ? (
            <>
              <div className="ix-section-head">Contas</div>
              <div className="acct-list">
                {shownAccounts.map((account, index) => (
                  <div key={`${account.pubkey}-${index}`} className="row">
                    <span>{account.role}</span>
                    <span className="pubkey">{truncateAddress(account.pubkey, 6, 4)}</span>
                  </div>
                ))}
                {hiddenAccounts > 0 ? (
                  <div className="row">
                    <span>mais {hiddenAccounts}…</span>
                    <span />
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          {execRoot ? (
            <>
              <div className="ix-section-head">Log de execução</div>
              <ExecLog node={execRoot} />
            </>
          ) : null}

          {active.warnings.map((warning, index) => (
            <div key={`${warning}-${index}`} className="warn">
              {warning}
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}

// ───────── transaction flow card ─────────
function FlowCard({ flow }: { flow: TxFlow }): React.JSX.Element | null {
  if (!flow || !flow.signer) return null;

  const parties = [
    { party: flow.signer, kind: 'signer' as const, role: flow.spread ? 'signatário · spread' : 'signatário' },
    flow.tokenSource && flow.tokenSource.pubkey !== flow.signer.pubkey
      ? { party: flow.tokenSource, kind: 'maker' as const, role: 'custódia / origem de tokens' }
      : null,
    flow.intendedRecipient && flow.intendedRecipient.pubkey !== flow.signer.pubkey
      ? { party: flow.intendedRecipient, kind: 'maker' as const, role: 'destinatário pretendido (maker)' }
      : null,
  ].filter((entry): entry is { party: FlowParty; kind: 'signer' | 'maker'; role: string } => entry !== null);

  const warnings = flow.warnings ?? [];
  // Venues that paid out at least 0.01 SOL on this trade.
  const pools = (flow.losers ?? []).filter((loser) => Math.abs(loser.solDelta) >= 10_000_000);

  return (
    <div className={cn('flow-card', warnings.length > 0 && 'has-warnings')}>
      <div className="flow-narrative">
        <span className="label">Fluxo da transação</span>
        {flow.narrative}
      </div>

      {warnings.length > 0 ? (
        <div className="flow-warnings">
          {warnings.map((warning, index) => (
            <div key={`${warning}-${index}`} className="flow-warning">
              <span className="icon" aria-hidden="true">
                ⚠
              </span>
              <span>{warning}</span>
            </div>
          ))}
        </div>
      ) : null}

      {parties.length > 0 ? (
        <div className="flow-parties">
          {parties.map((entry) => (
            <FlowPartyCard
              key={`${entry.kind}-${entry.party.pubkey}`}
              party={entry.party}
              kind={entry.kind}
              role={entry.role}
              spread={entry.kind === 'signer' && Boolean(flow.spread)}
            />
          ))}
        </div>
      ) : null}

      {pools.length > 0 ? (
        <div className="flow-pools">
          <div className="head">Pools de liquidez / pagadores (SOL perdido)</div>
          {pools.map((loser) => (
            <div key={loser.pubkey} className="flow-pool">
              <span className="pubkey">{truncateAddress(loser.pubkey, 6, 4)}</span>
              <span className="amount">{fmtSol(loser.solDelta)}</span>
            </div>
          ))}
          <div className="flow-pool total">
            <span>Total pago</span>
            <span className="amount">{fmtSol(-flow.totalSolPaidOut)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FlowPartyCard({
  party,
  kind,
  role,
  spread,
}: {
  party: FlowParty;
  kind: 'signer' | 'maker';
  role: string;
  spread: boolean;
}): React.JSX.Element {
  const sol = party.solDelta;
  const solClass = sol > 0 ? 'pos' : sol < 0 ? 'neg' : '';
  return (
    <div className={cn('flow-party', kind, spread && 'spread')}>
      <span className="role">{role}</span>
      <span className="pubkey">{truncateAddress(party.pubkey, 6, 4)}</span>
      {sol !== 0 ? (
        <span className={cn('delta', solClass)}>
          {sol > 0 ? '+' : ''}
          {fmtSol(sol)}
        </span>
      ) : null}
      {party.usdValue != null ? <span className="delta-usd">{fmtUsd(party.usdValue)}</span> : null}
      {party.tokenDeltas.length > 0 ? (
        <span className="tokens">
          {party.tokenDeltas.map((token, index) => {
            const symbol = token.symbol || truncateAddress(token.mint, 4, 0);
            return (
              <span key={`${token.mint}-${index}`} style={{ color: token.uiDelta > 0 ? 'var(--green)' : 'var(--red)' }}>
                {index > 0 ? ', ' : ''}
                {token.uiDelta > 0 ? '+' : ''}
                {token.uiDelta.toLocaleString('en-US')} {symbol}
              </span>
            );
          })}
        </span>
      ) : null}
    </div>
  );
}

function fmtSol(lamports: number): string {
  return `${(lamports / 1_000_000_000).toFixed(4)} SOL`;
}

function fmtUsd(usd: number): string {
  return `$${usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

// ───────── execution log — nested, Solscan-style colored trace ─────────
interface ExecLine {
  key: string;
  indent: number;
  cls: string;
  content: React.ReactNode;
}

function ExecLog({ node }: { node: ExecNode }): React.JSX.Element {
  const lines = buildExecLines(node);
  return (
    <div className="exec-log">
      {lines.map((line) => (
        <span key={line.key} className={cn('row', line.cls)}>
          <Indent depth={line.indent} />
          {line.content}
        </span>
      ))}
    </div>
  );
}

function Indent({ depth }: { depth: number }): React.JSX.Element | null {
  if (depth <= 0) return null;
  return <span className="indent">{`${'│ '.repeat(depth - 1)}└ `}</span>;
}

function buildExecLines(root: ExecNode): ExecLine[] {
  const lines: ExecLine[] = [];
  let counter = 0;

  const walk = (node: ExecNode, depth: number): void => {
    const id = String(counter++);
    lines.push({
      key: `inv-${id}`,
      indent: depth,
      cls: 'invoke',
      content: (
        <>
          {'▶ '}
          <span className="program">{shortLabel(node.programName)}</span>{' '}
          <span className="indent">invoke [{node.depth}]</span>
        </>
      ),
    });

    node.logs.forEach((log, index) => {
      lines.push({ key: `log-${id}-${index}`, indent: depth + 1, cls: 'log', content: `log: ${log}` });
    });

    node.children.forEach((child) => walk(child, depth + 1));

    if (node.cuConsumed != null) {
      lines.push({ key: `cu-${id}`, indent: depth + 1, cls: 'cu', content: `consumiu ${formatCU(node.cuConsumed)} CU` });
    }

    if (node.returnData) {
      const data = node.returnData.length > 64 ? `${node.returnData.slice(0, 64)}…` : node.returnData;
      lines.push({ key: `ret-${id}`, indent: depth + 1, cls: 'return', content: `return: ${data}` });
    }

    if (node.status === 'success') {
      lines.push({ key: `ok-${id}`, indent: depth + 1, cls: 'ok', content: '✓ programa retornou sucesso' });
    } else if (node.status === 'failed') {
      const err = node.errorMessage ? ` — ${node.errorMessage}` : '';
      lines.push({ key: `err-${id}`, indent: depth + 1, cls: 'err', content: `✗ programa falhou${err}` });
    } else {
      lines.push({ key: `tr-${id}`, indent: depth + 1, cls: 'err', content: '⊘ trace truncado' });
    }
  };

  walk(root, 0);
  return lines;
}

function shortLabel(name: string): string {
  if (!name) return 'desconhecido';
  if (name.length > 32) return `${name.slice(0, 14)}…${name.slice(-6)}`;
  return name;
}

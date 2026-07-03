'use client';

import { useState } from 'react';
import type { ExecNode, ExecutionTrace, IconKind, InstructionSummary } from '@/lib/types';
import { cn, formatCU, IX_ICONS, truncateAddress } from '@/lib/utils';

interface ExplanationProps {
  instructions: InstructionSummary[];
  executionTrace: ExecutionTrace;
}

const ICON_COLORS: Record<IconKind, string> = {
  transfer: 'bg-accent/15 text-accent-soft',
  swap: 'bg-purple/15 text-purple-soft',
  mint: 'bg-green/15 text-green',
  burn: 'bg-red/15 text-red',
  create: 'bg-accent/15 text-accent-soft',
  compute: 'bg-white/10 text-fg-dim',
  verify: 'bg-green/15 text-green',
  misc: 'bg-white/10 text-fg-dim',
};

export function Explanation({ instructions, executionTrace }: ExplanationProps): React.JSX.Element {
  const [selected, setSelected] = useState(0);

  if (instructions.length === 0) {
    return (
      <p className="glass-soft p-6 text-center text-sm text-fg-dim">
        Esta transação não possui instruções para explicar.
      </p>
    );
  }

  const active = instructions[Math.min(selected, instructions.length - 1)];
  const execRoot = active ? executionTrace.roots[active.index] : undefined;

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,320px)_1fr]">
      <ul className="flex flex-col gap-1.5">
        {instructions.map((instruction, index) => {
          const isActive = active?.index === instruction.index;
          return (
            <li key={instruction.index}>
              <button
                type="button"
                onClick={() => setSelected(index)}
                aria-current={isActive}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                  isActive
                    ? 'border-accent/40 bg-accent/10'
                    : 'border-white/5 bg-white/[0.02] hover:bg-white/5',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm',
                    ICON_COLORS[instruction.iconKind],
                  )}
                >
                  {IX_ICONS[instruction.iconKind]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">
                    {instruction.title}
                  </span>
                  <span className="block truncate text-xs text-fg-mute">
                    #{instruction.index} · {instruction.programName}
                  </span>
                </span>
                {instruction.cuConsumed != null ? (
                  <span className="tnum shrink-0 text-xs text-fg-dim">
                    {formatCU(instruction.cuConsumed)}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      {active ? (
        <div className="glass-soft p-4">
          <h3 className="text-base font-semibold text-fg">{active.title}</h3>
          <p className="mono mt-1 text-xs text-fg-mute">
            {active.programName} · {truncateAddress(active.programId)}
          </p>
          <p className="mt-3 text-sm leading-relaxed text-fg-dim">{active.summary}</p>

          {active.details.length > 0 ? (
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {active.details.map((detail) => (
                <div key={`${detail.label}-${detail.value}`} className="contents">
                  <dt className="text-fg-mute">{detail.label}</dt>
                  <dd className={cn('truncate text-fg', detail.mono && 'mono')}>{detail.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {active.warnings.length > 0 ? (
            <ul className="mt-4 flex flex-col gap-1.5">
              {active.warnings.map((warning) => (
                <li
                  key={warning}
                  className="rounded-lg border border-orange/25 bg-orange/5 px-3 py-2 text-xs text-orange"
                >
                  {warning}
                </li>
              ))}
            </ul>
          ) : null}

          {execRoot ? <ExecLog node={execRoot} /> : null}

          {active.accounts.length > 0 ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-xs font-medium text-fg-dim">
                {active.accounts.length} contas envolvidas
              </summary>
              <ul className="mt-2 flex flex-col gap-1">
                {active.accounts.slice(0, 12).map((account, index) => (
                  <li
                    key={`${account.pubkey}-${index}`}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="text-fg-mute">{account.role}</span>
                    <span className="mono text-fg-dim">{truncateAddress(account.pubkey, 6, 6)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ExecLog({ node }: { node: ExecNode }): React.JSX.Element | null {
  const lines = collectLogLines(node, 0).slice(0, 24);
  if (lines.length === 0) return null;

  return (
    <div className="mt-4">
      <p className="mb-1.5 text-xs font-medium text-fg-dim">Logs de execução</p>
      <pre className="mono max-h-56 overflow-auto rounded-lg border border-white/5 bg-black/40 p-3 text-xs leading-relaxed text-fg-dim">
        {lines.map((line, index) => (
          <div key={index} style={{ paddingLeft: `${line.depth * 12}px` }}>
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

function collectLogLines(node: ExecNode, depth: number): Array<{ text: string; depth: number }> {
  const own = node.logs.map((text) => ({ text, depth }));
  const children = node.children.flatMap((child) => collectLogLines(child, depth + 1));
  return [...own, ...children];
}

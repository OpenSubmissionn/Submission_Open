'use client';

import type { Bottleneck, ComputeUnits, ProgramCu } from '@/lib/types';
import { cn, colorForProgram, formatCU, formatPercent, truncateAddress } from '@/lib/utils';

interface FlameGraphProps {
  programs: ProgramCu[];
  computeUnits: ComputeUnits;
  bottleneck: Bottleneck | null;
}

export function FlameGraph({ programs, computeUnits, bottleneck }: FlameGraphProps): React.JSX.Element {
  if (programs.length === 0) {
    return (
      <p className="glass-soft p-6 text-center text-sm text-fg-dim">
        Nenhum programa consumiu CU nesta transação.
      </p>
    );
  }

  const rows = programs.slice(0, 8);
  const maxCu = Math.max(...rows.map((program) => program.cuConsumed), 1);
  const totalConsumed = computeUnits.consumed || 1;
  const utilization = computeUnits.limit > 0
    ? Math.min(100, (computeUnits.consumed / computeUnits.limit) * 100)
    : 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="glass-soft p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-xs uppercase tracking-wide text-fg-mute">Compute units</span>
          <span className="tnum text-sm text-fg">
            <span className="font-semibold text-fg">{formatCU(computeUnits.consumed)}</span>
            <span className="text-fg-mute"> / {formatCU(computeUnits.limit)} CU</span>
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/5">
          <div
            className="h-full rounded-full bg-gradient-to-r from-yellow via-orange to-red shadow-[0_0_12px_rgba(245,158,11,0.3)]"
            style={{ width: `${utilization}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-fg-dim">
          {formatPercent(computeUnits.utilizationPercent)} do limite utilizado
        </p>
      </div>

      <ul className="flex flex-col gap-2.5">
        {rows.map((program) => {
          const barWidth = Math.max(2, (program.cuConsumed / maxCu) * 100);
          const share = (program.cuConsumed / totalConsumed) * 100;
          const isBottleneck = bottleneck?.programId === program.programId;
          const color = colorForProgram(program.programName);

          return (
            <li key={program.programId}>
              <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium text-fg">{program.programName}</span>
                  {isBottleneck ? (
                    <span className="shrink-0 rounded-full bg-orange/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange">
                      Gargalo
                    </span>
                  ) : null}
                </span>
                <span className="tnum shrink-0 text-fg-dim">
                  {formatCU(program.cuConsumed)} CU
                  <span className="text-fg-mute"> · {formatPercent(share)}</span>
                </span>
              </div>
              <div
                className="h-6 overflow-hidden rounded-md bg-white/5"
                role="img"
                aria-label={`${program.programName} consumiu ${formatCU(program.cuConsumed)} CU, ${formatPercent(share)} do total`}
              >
                <div
                  className={cn('h-full origin-left rounded-md', isBottleneck && 'ring-1 ring-inset ring-orange/60')}
                  style={{
                    width: `${barWidth}%`,
                    backgroundColor: color,
                    opacity: isBottleneck ? 1 : 0.82,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-fg-mute mono">
                {truncateAddress(program.programId)} · {program.count}× invocado
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

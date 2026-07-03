'use client';

import type { Bottleneck, CpiNode, CpiTree as CpiTreeData, InstructionName } from '@/lib/types';
import { cn, formatCU, truncateAddress } from '@/lib/utils';

interface CpiTreeProps {
  cpiTree: CpiTreeData;
  bottleneck: Bottleneck | null;
  instructionNames: InstructionName[];
}

export function CpiTree({ cpiTree, bottleneck, instructionNames }: CpiTreeProps): React.JSX.Element {
  if (cpiTree.root.length === 0) {
    return (
      <p className="glass-soft p-6 text-center text-sm text-fg-dim">
        Nenhuma invocação de programa foi reconstruída a partir dos logs.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-1">
        {cpiTree.root.map((node, index) => (
          <CpiTreeNode
            key={`${node.programId}-${index}`}
            node={node}
            bottleneckId={bottleneck?.programId ?? null}
            instructionName={instructionNames[index]?.instructionName ?? null}
          />
        ))}
      </ul>
      <p className="text-xs text-fg-mute">
        {cpiTree.nodeCount} invocações de programa · profundidade máxima {cpiTree.totalDepth} ·
        reconstruído a partir dos logs
      </p>
    </div>
  );
}

interface CpiTreeNodeProps {
  node: CpiNode;
  bottleneckId: string | null;
  instructionName?: string | null;
}

function CpiTreeNode({ node, bottleneckId, instructionName }: CpiTreeNodeProps): React.JSX.Element {
  const isBottleneck = bottleneckId === node.programId;
  const failed = node.status === 'failed';

  return (
    <li>
      <div
        className={cn(
          'flex items-center gap-2 rounded-lg border px-3 py-2',
          isBottleneck ? 'border-orange/40 bg-orange/5' : 'border-white/5 bg-white/[0.02]',
        )}
      >
        <span
          aria-hidden="true"
          className={cn('h-2 w-2 shrink-0 rounded-full', failed ? 'bg-red' : 'bg-green')}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
          {node.programName}
          {instructionName ? (
            <span className="mono ml-2 text-xs text-accent-soft">{instructionName}</span>
          ) : null}
        </span>
        {isBottleneck ? (
          <span className="shrink-0 rounded-full bg-orange/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange">
            Gargalo
          </span>
        ) : null}
        <span className="tnum shrink-0 text-xs text-fg-dim">
          {node.cuConsumed != null ? `${formatCU(node.cuConsumed)} CU` : '—'}
        </span>
        <span className="mono hidden shrink-0 text-xs text-fg-mute sm:inline">
          {truncateAddress(node.programId)}
        </span>
      </div>

      {node.children.length > 0 ? (
        <ul className="ml-4 mt-1 flex flex-col gap-1 border-l border-white/10 pl-3">
          {node.children.map((child, index) => (
            <CpiTreeNode
              key={`${child.programId}-${child.depth}-${index}`}
              node={child}
              bottleneckId={bottleneckId}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

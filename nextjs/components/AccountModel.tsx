'use client';

import type { AccountModel as AccountModelData, ModelNode } from '@/lib/types';
import { truncateAddress } from '@/lib/utils';

interface AccountModelProps {
  accountModel: AccountModelData;
}

const NODE_COLORS: Record<ModelNode['type'], { bg: string; border: string; text: string }> = {
  signer: { bg: '#1e3a5f', border: '#3b82f6', text: '#93c5fd' },
  program: { bg: '#1e3a2a', border: '#22c55e', text: '#86efac' },
  pda: { bg: '#3b2a1e', border: '#f97316', text: '#fdba74' },
  account: { bg: '#2a1e3b', border: '#a855f7', text: '#d8b4fe' },
};

const TYPE_LABEL: Record<ModelNode['type'], string> = {
  signer: 'Signer',
  program: 'Program',
  pda: 'PDA',
  account: 'Account',
};

const PADDING = 32;

export function AccountModel({ accountModel }: AccountModelProps): React.JSX.Element {
  const { nodes, edges } = accountModel;

  if (nodes.length === 0) {
    return (
      <p className="glass-soft p-6 text-center text-sm text-fg-dim">
        Nenhum dado de modelo de contas disponível.
      </p>
    );
  }

  // Compute viewport from pre-laid-out coordinates
  const maxX = Math.max(...nodes.map((n) => n.x + n.w), 1);
  const maxY = Math.max(...nodes.map((n) => n.y + n.h), 1);
  const viewW = maxX + PADDING * 2;
  const viewH = maxY + PADDING * 2;

  // Build a map from node id to node for edge rendering
  const nodeMap = new Map<string, ModelNode>(nodes.map((n) => [n.id, n]));

  // Center of a node
  const cx = (n: ModelNode) => PADDING + n.x + n.w / 2;
  const cy = (n: ModelNode) => PADDING + n.y + n.h / 2;

  return (
    <div className="flex flex-col gap-4">
      {/* Legend */}
      <div className="flex flex-wrap gap-3">
        {(Object.keys(NODE_COLORS) as ModelNode['type'][]).map((type) => {
          const c = NODE_COLORS[type];
          return (
            <span
              key={type}
              className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium"
              style={{ background: c.bg, color: c.text, border: `1px solid ${c.border}` }}
            >
              {TYPE_LABEL[type]}
            </span>
          );
        })}
        <span className="ml-auto text-xs text-fg-mute">
          {nodes.length} nós · {edges.length} conexões
        </span>
      </div>

      {/* SVG canvas */}
      <div className="glass-soft overflow-x-auto rounded-lg p-0">
        <svg
          viewBox={`0 0 ${viewW} ${viewH}`}
          width="100%"
          style={{ minWidth: Math.min(viewW, 320), maxHeight: 480 }}
          aria-label="Account model graph"
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#4b5563" />
            </marker>
          </defs>

          {/* Edges */}
          {edges.map((edge, i) => {
            const from = nodeMap.get(edge.from);
            const to = nodeMap.get(edge.to);
            if (!from || !to) return null;
            const x1 = cx(from);
            const y1 = cy(from);
            const x2 = cx(to);
            const y2 = cy(to);
            const midX = (x1 + x2) / 2;
            const midY = (y1 + y2) / 2;
            return (
              <g key={i}>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="#4b5563"
                  strokeWidth={1.5}
                  markerEnd="url(#arrow)"
                />
                {edge.label && (
                  <text
                    x={midX}
                    y={midY - 4}
                    textAnchor="middle"
                    fontSize={9}
                    fill="#9ca3af"
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            );
          })}

          {/* Nodes */}
          {nodes.map((node) => {
            const c = NODE_COLORS[node.type];
            const x = PADDING + node.x;
            const y = PADDING + node.y;
            const r = 6;
            return (
              <g key={node.id}>
                <rect
                  x={x}
                  y={y}
                  width={node.w}
                  height={node.h}
                  rx={r}
                  ry={r}
                  fill={c.bg}
                  stroke={c.border}
                  strokeWidth={1.5}
                />
                {/* Type badge */}
                <text
                  x={x + 8}
                  y={y + 14}
                  fontSize={8}
                  fontWeight="600"
                  fill={c.text}
                  letterSpacing="0.05em"
                >
                  {TYPE_LABEL[node.type].toUpperCase()}
                </text>
                {/* Label */}
                <text
                  x={x + node.w / 2}
                  y={y + node.h / 2 + 1}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={10}
                  fontWeight="500"
                  fill="#f3f4f6"
                >
                  {node.label || truncateAddress(node.address)}
                </text>
                {/* Address */}
                <text
                  x={x + node.w / 2}
                  y={y + node.h - 10}
                  textAnchor="middle"
                  fontSize={8}
                  fill="#6b7280"
                >
                  {truncateAddress(node.address)}
                </text>
                {/* Tooltip via title */}
                <title>
                  {`${node.label || node.address}\nTipo: ${TYPE_LABEL[node.type]}\nOwner: ${node.owner}\n${node.description}`}
                </title>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Node list as accessible fallback */}
      <details className="glass-soft rounded-lg p-3">
        <summary className="cursor-pointer text-xs font-medium text-fg-mute hover:text-fg">
          Lista de contas ({nodes.length})
        </summary>
        <ul className="mt-3 flex flex-col gap-2">
          {nodes.map((node) => {
            const c = NODE_COLORS[node.type];
            return (
              <li key={node.id} className="flex items-start gap-2 text-xs">
                <span
                  className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold"
                  style={{ background: c.bg, color: c.text, border: `1px solid ${c.border}` }}
                >
                  {TYPE_LABEL[node.type]}
                </span>
                <span className="text-fg">{node.label || truncateAddress(node.address)}</span>
                {node.description && (
                  <span className="text-fg-mute">&mdash; {node.description}</span>
                )}
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}

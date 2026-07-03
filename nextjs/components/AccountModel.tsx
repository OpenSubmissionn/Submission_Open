'use client';

import { useState } from 'react';
import type { AccountModel as AccountModelData, ModelEdge, ModelNode } from '@/lib/types';
import { cn } from '@/lib/utils';

interface AccountModelProps {
  accountModel: AccountModelData;
}

const TYPE_LABEL: Record<ModelNode['type'], string> = {
  signer: 'Signer',
  program: 'Program',
  pda: 'PDA',
  account: 'Account',
};

// Legend order mirrors the deployed reference.
const LEGEND: ModelNode['type'][] = ['program', 'pda', 'signer', 'account'];

const MARGIN = 20;

export function AccountModel({ accountModel }: AccountModelProps): React.JSX.Element {
  const { nodes, edges } = accountModel;
  const [selected, setSelected] = useState<string | null>(null);

  if (nodes.length === 0) {
    return (
      <p className="glass-soft p-6 text-center text-sm text-fg-dim">
        Nenhum dado de modelo de contas disponível.
      </p>
    );
  }

  const nodeMap = new Map<string, ModelNode>(nodes.map((node) => [node.id, node]));
  const viewW = Math.max(...nodes.map((node) => node.x + node.w), 1) + MARGIN;
  const viewH = Math.max(...nodes.map((node) => node.y + node.h), 1) + MARGIN;

  const isNeighbor = (id: string, sel: string): boolean =>
    edges.some(
      (edge) => (edge.from === sel && edge.to === id) || (edge.from === id && edge.to === sel),
    );

  const selectedNode = selected ? (nodeMap.get(selected) ?? null) : null;

  return (
    <>
      <div className="model-wrap">
        <div
          className="model-canvas"
          onClick={() => setSelected(null)}
          role="presentation"
        >
          <svg
            className="model-svg"
            viewBox={`0 0 ${viewW} ${viewH}`}
            preserveAspectRatio="xMidYMid meet"
            role="group"
            aria-label={`Grafo do modelo de contas: ${nodes.length} nós, ${edges.length} conexões`}
          >
            <g>
              {edges.map((edge, index) => (
                <Edge
                  key={`${edge.from}->${edge.to}-${index}`}
                  edge={edge}
                  from={nodeMap.get(edge.from)}
                  to={nodeMap.get(edge.to)}
                  selected={selected}
                />
              ))}
            </g>
            <g>
              {nodes.map((node) => {
                const dim = selected !== null && node.id !== selected && !isNeighbor(node.id, selected);
                return (
                  <Node
                    key={node.id}
                    node={node}
                    active={node.id === selected}
                    dim={dim}
                    onSelect={(id) => setSelected(id)}
                    onClear={() => setSelected(null)}
                  />
                );
              })}
            </g>
          </svg>

          <div className="model-legend" aria-hidden="true">
            {LEGEND.map((type) => (
              <span key={type} className="item">
                <span className={cn('swatch', type)} />
                {TYPE_LABEL[type]}
              </span>
            ))}
          </div>
        </div>

        <aside className={cn('model-detail', !selectedNode && 'empty')} aria-live="polite">
          {selectedNode ? (
            <>
              <div className="head">
                <h4>{selectedNode.label}</h4>
              </div>
              <div className="row">
                <span className="k">Tipo</span>
                <span className="v">{TYPE_LABEL[selectedNode.type]}</span>
              </div>
              <div className="row">
                <span className="k">Endereço</span>
                <span className="v">{selectedNode.address}</span>
              </div>
              <div className="row">
                <span className="k">Dono</span>
                <span className="v">{selectedNode.owner}</span>
              </div>
              {selectedNode.description ? <div className="desc">{selectedNode.description}</div> : null}
            </>
          ) : (
            <div className="body">
              Clique em um nó no grafo para inspecionar seu tipo, dono, endereço e papel na transação.
            </div>
          )}
        </aside>
      </div>

      {/* Text alternative for screen readers, since the SVG graph is visual. */}
      <ul className="sr-only">
        {nodes.map((node) => (
          <li key={node.id}>
            {TYPE_LABEL[node.type]}: {node.label} ({node.address}).{' '}
            {node.description}
          </li>
        ))}
      </ul>
    </>
  );
}

function Edge({
  edge,
  from,
  to,
  selected,
}: {
  edge: ModelEdge;
  from: ModelNode | undefined;
  to: ModelNode | undefined;
  selected: string | null;
}): React.JSX.Element | null {
  if (!from || !to) return null;

  const x1 = from.x + from.w;
  const y1 = from.y + from.h / 2;
  const x2 = to.x;
  const y2 = to.y + to.h / 2;
  const midX = (x1 + x2) / 2;

  const incident = edge.from === selected || edge.to === selected;
  const active = selected !== null && incident;
  const dim = selected !== null && !incident;

  return (
    <g>
      <path
        d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
        className={cn('model-edge', active && 'active', dim && 'dim')}
      />
      {edge.label ? (
        <text x={midX} y={(y1 + y2) / 2 - 4} className="model-edge-label">
          {edge.label}
        </text>
      ) : null}
    </g>
  );
}

function Node({
  node,
  active,
  dim,
  onSelect,
  onClear,
}: {
  node: ModelNode;
  active: boolean;
  dim: boolean;
  onSelect: (id: string) => void;
  onClear: () => void;
}): React.JSX.Element {
  const maxChars = Math.max(8, Math.floor((node.w - 16) / 7));
  const label = node.label.length > maxChars ? `${node.label.slice(0, maxChars - 1)}…` : node.label;

  return (
    <g
      className={cn('model-node', node.type, active && 'selected', dim && 'dim')}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={`${TYPE_LABEL[node.type]}: ${node.label}, ${node.address}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.id);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(node.id);
        } else if (event.key === 'Escape') {
          onClear();
        }
      }}
    >
      <title>{node.label}</title>
      <rect x={node.x} y={node.y} width={node.w} height={node.h} rx={14} />
      <text x={node.x + node.w / 2} y={node.y + node.h / 2 + 4}>
        {label}
      </text>
    </g>
  );
}

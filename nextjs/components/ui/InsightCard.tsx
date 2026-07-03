'use client';

import type { InsightSeverity } from '@/lib/types';
import { cn, formatCU } from '@/lib/utils';

interface InsightCardProps {
  severity: InsightSeverity;
  title: string;
  message: string;
  recommendation?: string;
  estimatedCUSavings?: number;
}

const SEVERITY_STYLES: Record<InsightSeverity, { badge: string; ring: string; label: string }> = {
  critical: {
    badge: 'bg-red/15 text-red',
    ring: 'border-red/30',
    label: 'Crítico',
  },
  warning: {
    badge: 'bg-orange/15 text-orange',
    ring: 'border-orange/30',
    label: 'Atenção',
  },
  info: {
    badge: 'bg-accent/15 text-accent-soft',
    ring: 'border-accent/25',
    label: 'Info',
  },
};

export function InsightCard({
  severity,
  title,
  message,
  recommendation,
  estimatedCUSavings,
}: InsightCardProps): React.JSX.Element {
  const style = SEVERITY_STYLES[severity];

  return (
    <article className={cn('glass border p-4', style.ring)}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide',
            style.badge,
          )}
        >
          {style.label}
        </span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-fg-dim">{message}</p>
      {recommendation ? (
        <p className="mt-2 text-sm leading-relaxed text-fg">
          <span className="font-medium text-accent-soft">Recomendação: </span>
          {recommendation}
        </p>
      ) : null}
      {estimatedCUSavings ? (
        <p className="mt-3 text-xs font-medium text-green-soft tnum">
          Economia estimada: {formatCU(estimatedCUSavings)} CU
        </p>
      ) : null}
    </article>
  );
}

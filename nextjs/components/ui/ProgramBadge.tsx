'use client';

import { cn, colorForProgram, truncateAddress } from '@/lib/utils';

interface ProgramBadgeProps {
  programId: string;
  programName: string;
  showAddress?: boolean;
  className?: string;
}

export function ProgramBadge({
  programId,
  programName,
  showAddress = false,
  className,
}: ProgramBadgeProps): React.JSX.Element {
  const color = colorForProgram(programName);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-fg',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="truncate">{programName}</span>
      {showAddress ? (
        <span className="mono text-fg-mute">{truncateAddress(programId)}</span>
      ) : null}
    </span>
  );
}

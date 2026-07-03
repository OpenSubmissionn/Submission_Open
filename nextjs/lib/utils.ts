import type { IconKind } from './types';

const LAMPORTS_PER_SOL = 1_000_000_000;

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function truncateAddress(address: string, head = 4, tail = 4): string {
  if (!address) return '';
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

export function formatSol(sol: number, fractionDigits = 6): string {
  if (!Number.isFinite(sol)) return '0 SOL';
  return `${sol.toLocaleString('en-US', { maximumFractionDigits: fractionDigits })} SOL`;
}

export function formatLamports(lamports: number, fractionDigits = 6): string {
  return formatSol(lamportsToSol(lamports), fractionDigits);
}

export function formatSignedSol(lamports: number, fractionDigits = 6): string {
  const sol = lamportsToSol(lamports);
  const sign = sol > 0 ? '+' : '';
  return `${sign}${sol.toLocaleString('en-US', { maximumFractionDigits: fractionDigits })} SOL`;
}

export function formatCU(cu: number | null | undefined): string {
  if (cu == null || !Number.isFinite(cu)) return '0';
  return Math.round(cu).toLocaleString('en-US');
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${Math.round(value)}`;
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString('en-US');
}

export function formatPercent(value: number, fractionDigits = 0): string {
  if (!Number.isFinite(value)) return '0%';
  return `${value.toFixed(fractionDigits)}%`;
}

export function formatSignedNumber(value: number, fractionDigits = 4): string {
  if (!Number.isFinite(value)) return '0';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toLocaleString('en-US', { maximumFractionDigits: fractionDigits })}`;
}

export function formatTimestamp(blockTime: number | null | undefined): string {
  if (!blockTime) return 'desconhecido';
  return new Date(blockTime * 1000).toLocaleString('pt-BR');
}

export function tokenLabel(mint: string, symbol?: string): string {
  return symbol && symbol.trim().length > 0 ? symbol : truncateAddress(mint);
}

// Non-emoji glyphs keyed by the instruction icon kind emitted by the API.
export const IX_ICONS: Record<IconKind, string> = {
  transfer: '→',
  swap: '⇄',
  mint: '↑',
  burn: '↓',
  create: '+',
  compute: '≡',
  verify: '✓',
  misc: '•',
};

// Deterministic accent color for a program so the same program always reads
// with the same hue across tabs. Known ecosystem programs get a fixed brand
// tone; everything else is hashed to a stable HSL value.
const KNOWN_PROGRAM_HUES: Record<string, number> = {
  'jupiter aggregator v6': 152,
  'orca whirlpool': 190,
  'raydium amm': 265,
  'raydium clmm': 275,
  'token program': 210,
  'token-2022': 205,
  'system program': 220,
  'compute budget': 45,
  'associated token account': 200,
  'metaplex metadata': 300,
  'pump.fun': 25,
};

export function colorForProgram(programName: string): string {
  const key = programName.trim().toLowerCase();
  const known = KNOWN_PROGRAM_HUES[key];
  if (known !== undefined) return `hsl(${known} 70% 60%)`;
  let hash = 0;
  for (let i = 0; i < programName.length; i += 1) {
    hash = (hash * 31 + programName.charCodeAt(i)) % 360;
  }
  return `hsl(${hash} 60% 62%)`;
}

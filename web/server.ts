/**
 * Local dev server that serves the static landing/demo pages and exposes a
 * small JSON API on top of the existing analysis pipeline (services/src).
 *
 * Run with:  npm run web
 *
 * The pipeline used here is the same as cli/src/commands/tx.ts — we just
 * package the result for the browser instead of rendering to a TUI.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  fetchTransaction,
  parseLogsFromBundle,
  profileCU,
  buildCPITree,
  computeAccountDiffs,
  mergeAnalysis,
  analyzeTransaction,
  IdlCache,
  McpInsightProvider,
  type CPITree,
  type CPINode,
  type ParsedLogs,
} from '../services/src/index.js';
import { getProgramNameSync } from '../services/src/solana/programs.js';
import { trackEvent, getStats, type GeoHeaders } from './tracking.js';

// Re-export so api/track.ts and api/stats.ts can pull these through the
// established `web/server.js` barrel (same pattern as analyze / getLatestTx).
export { trackEvent, getStats };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '3344', 10);
const WEB_DIR = __dirname;

// ───────────────────────────────────────────────────────────────────────────
// Program name resolution (mirrors cli/src/renderers/terminal/renderer.ts)
// ───────────────────────────────────────────────────────────────────────────
//
// The CPI tree builder only emits raw program IDs, and the CU profiler labels
// every entry as "Unknown Program". The CLI patches both with the same
// inline lookup + the JSON registry, so the web pipeline mirrors that here.

const INLINE_PROGRAM_NAMES: Record<string, string> = {
  '11111111111111111111111111111111': 'System Program',
  ComputeBudget111111111111111111111111111111: 'Compute Budget',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'Token Program',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token Account',
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: 'Metaplex Metadata',
  whirLbMiicVdio4KfUV7LSu1DbjhokCWAN8DiwKx5hp: 'Orca Whirlpool',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter Aggregator V6',
  CiQPQrmQh6BPhb9k7dFnsEs5gKPgdrvNKFc5xie5xVGd: 'Pump.fun',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
  // AMM-style venues that show up frequently in filler/MEV txs
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'Pump.fun AMM',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
  pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ: 'Pump.fun Fees',
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: 'Meteora Pools',
  jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu: 'Jupiter Limit Order',
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: 'Phoenix DEX',
};

function resolveProgramName(programId: string | undefined | null): string {
  if (!programId) return 'Unknown Program';
  const inline = INLINE_PROGRAM_NAMES[programId];
  if (inline) return inline;
  const fromRegistry = getProgramNameSync(programId);
  if (fromRegistry && fromRegistry !== 'Unknown Program') return fromRegistry;
  return programId; // fall back to the raw id so the UI never shows "Unknown"
}

// ───────────────────────────────────────────────────────────────────────────
// Pipeline helpers (mirrors cli/src/utils/pipeline.ts so we don't depend on it)
// ───────────────────────────────────────────────────────────────────────────

function toCPITree(trace: ReturnType<typeof buildCPITree>): CPITree {
  const toNode = (node: (typeof trace.roots)[number]): CPITree['root'][number] => ({
    programId: node.programId,
    programName: resolveProgramName(node.programId),
    depth: node.depth,
    status: node.status === 'success' ? 'success' : 'failed',
    cuConsumed: node.computeUnitsConsumed,
    children: node.children.map(toNode),
  });

  const metrics = { maxDepth: 0, count: 0 };
  const visit = (node: (typeof trace.roots)[number]) => {
    metrics.maxDepth = Math.max(metrics.maxDepth, node.depth);
    metrics.count += 1;
    for (const child of node.children) visit(child);
  };
  for (const root of trace.roots) visit(root);

  return {
    root: trace.roots.map(toNode),
    totalDepth: metrics.maxDepth,
    nodeCount: metrics.count,
  };
}

function toParsedLogs(
  logMessages: string[],
  parsed: ReturnType<typeof parseLogsFromBundle>
): ParsedLogs {
  return {
    raw: logMessages,
    entries: [],
    byProgram: Object.keys(parsed.byProgram).map((programId) => ({
      programId,
      programName: resolveProgramName(programId),
      entries: [],
      cuConsumed: parsed.byProgram[programId]?.consumed,
    })) as any,
    errors: parsed.errors,
    totalLines: parsed.totalLines,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-program CU aggregation derived from the CPI tree.
//
// `cuProfile.perInstruction` doesn't carry program identifiers — every entry
// is labelled "Unknown Program". The CPI tree, by contrast, tracks the exact
// program for each invocation, so we walk it to produce a flame-graph-friendly
// list of { programId, programName, cuConsumed, count }.
// ───────────────────────────────────────────────────────────────────────────

interface ProgramCU {
  programId: string;
  programName: string;
  cuConsumed: number;
  count: number;
}

function aggregateProgramsFromCpi(cpi: CPITree): ProgramCU[] {
  const acc = new Map<string, ProgramCU>();
  const walk = (nodes: CPINode[]) => {
    for (const n of nodes) {
      const cu = n.cuConsumed ?? 0;
      const prev = acc.get(n.programId);
      if (prev) {
        prev.cuConsumed += cu;
        prev.count += 1;
      } else {
        acc.set(n.programId, {
          programId: n.programId,
          programName: n.programName || resolveProgramName(n.programId),
          cuConsumed: cu,
          count: 1,
        });
      }
      if (n.children?.length) walk(n.children);
    }
  };
  walk(cpi.root);
  return [...acc.values()].sort((a, b) => b.cuConsumed - a.cuConsumed);
}

function findCpiBottleneck(
  cpi: CPITree
): { programId: string; programName: string; cuConsumed: number; depth: number } | null {
  let best: { programId: string; programName: string; cuConsumed: number; depth: number } | null =
    null;
  const walk = (nodes: CPINode[]) => {
    for (const n of nodes) {
      const cu = n.cuConsumed ?? 0;
      // Skip Compute Budget and System ixs — they always show small CU and
      // would never be the meaningful bottleneck.
      const skip =
        n.programId === 'ComputeBudget111111111111111111111111111111' ||
        n.programId === '11111111111111111111111111111111';
      if (!skip && (!best || cu > best.cuConsumed)) {
        best = {
          programId: n.programId,
          programName: n.programName || resolveProgramName(n.programId),
          cuConsumed: cu,
          depth: n.depth,
        };
      }
      if (n.children?.length) walk(n.children);
    }
  };
  walk(cpi.root);
  return best;
}

// ───────────────────────────────────────────────────────────────────────────
// Account model graph (nodes + edges) for the "Account Model" tab.
//
// Layout uses 4 columns so the SVG canvas (760x540) reads as:
//
//   col 0 (x= 80)   signers / fee payer
//   col 1 (x=280)   root programs (depth 1) and the System Program
//   col 2 (x=480)   inner programs (depth >= 2) — Token, AMMs, etc.
//   col 3 (x=660)   accounts/PDAs whose balances actually changed
//
// Edges:
//   signer  → root program        ("invokes")
//   program → inner program       ("CPI")
//   token program → token account ("debits"/"credits") when an SPL transfer
//                                 hits a writable account
// ───────────────────────────────────────────────────────────────────────────

interface ModelNode {
  id: string;
  type: 'signer' | 'program' | 'pda' | 'account';
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  address: string;
  owner: string;
  description: string;
}

interface ModelEdge {
  from: string;
  to: string;
  label?: string;
}

const SHORT = (s: string, head = 4, tail = 4) =>
  !s ? '' : s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

function buildAccountModel(
  cpi: CPITree,
  accountDiffs: ReturnType<typeof computeAccountDiffs>,
  transfers: any[] = []
): { nodes: ModelNode[]; edges: ModelEdge[] } {
  const nodes: ModelNode[] = [];
  const edges: ModelEdge[] = [];
  const seenIds = new Set<string>();

  const NODE_W_PROGRAM = 150;
  const NODE_W_SIGNER = 140;
  const NODE_W_ACCOUNT = 120;
  const NODE_H = 34;
  // Columns sized so col 3 (x=620) + width (120) = 740, well inside the
  // SVG's 760-unit viewBox. The previous layout put accounts at x=660
  // which clipped the right edge in browsers that render the canvas
  // narrower than the viewBox.
  const COL_X = [60, 230, 420, 620];
  const ROW_GAP = 70;

  const pushNode = (n: ModelNode) => {
    if (seenIds.has(n.id)) return;
    seenIds.add(n.id);
    nodes.push(n);
  };

  // Column 0 — signers (and fee payer if different)
  const signers = accountDiffs.filter((a) => a.role === 'signer').slice(0, 3);
  if (signers.length === 0) {
    // No signer? Synthesise a placeholder so the graph still anchors on the
    // left.
    pushNode({
      id: 'wallet',
      type: 'signer',
      x: COL_X[0],
      y: 220,
      w: NODE_W_SIGNER,
      h: NODE_H,
      label: 'Wallet (signer)',
      address: 'unknown',
      owner: 'System Program',
      description: 'Transaction signer.',
    });
  }
  signers.forEach((s, i) => {
    const id = `signer-${i}`;
    pushNode({
      id,
      type: 'signer',
      x: COL_X[0],
      y: 180 + i * (NODE_H + ROW_GAP),
      w: NODE_W_SIGNER,
      h: NODE_H,
      label: i === 0 ? 'Wallet (signer)' : `Signer #${i + 1}`,
      address: SHORT(s.pubkey, 4, 4),
      owner: 'System Program',
      description:
        i === 0
          ? `Signed the transaction. ${s.solDelta < 0 ? `Net SOL change: ${(s.solDelta / 1e9).toFixed(6)}.` : ''}`.trim()
          : 'Co-signer on this transaction.',
    });
  });

  // Column 1 — root programs (depth 1 in the CPI tree). Compute Budget
  // ixs always sit at the front of the program list but never have any
  // logical relationship to accounts — drop them so the canvas stays
  // focused on the programs that actually move state.
  const SYSTEM_NOISE = new Set(['ComputeBudget111111111111111111111111111111']);
  const rootPrograms = cpi.root.filter((p) => !SYSTEM_NOISE.has(p.programId)).slice(0, 5);
  rootPrograms.forEach((p, i) => {
    const id = `root-${p.programId}-${i}`;
    pushNode({
      id,
      type: 'program',
      x: COL_X[1],
      y: 140 + i * (NODE_H + ROW_GAP / 2),
      w: NODE_W_PROGRAM,
      h: NODE_H,
      label: p.programName,
      address: SHORT(p.programId, 4, 4),
      owner: 'BPFLoaderUpgradeable',
      description: `Top-level invocation. Consumed ${(p.cuConsumed ?? 0).toLocaleString()} CU.`,
    });
    // Connect every signer to every root program — most txs only have one
    // signer, so this is the right default visual.
    const signerIds = signers.length > 0 ? signers.map((_, j) => `signer-${j}`) : ['wallet'];
    for (const sid of signerIds) edges.push({ from: sid, to: id, label: 'invokes' });
  });

  // Column 2 — inner programs (children of root nodes)
  const innerSeen = new Set<string>();
  const innerByRoot: Record<string, CPINode[]> = {};
  rootPrograms.forEach((p, i) => {
    const rootId = `root-${p.programId}-${i}`;
    const children = (p.children || []).filter(
      (c) => c.programId !== p.programId // ignore self-recursion noise
    );
    innerByRoot[rootId] = children;
  });
  const innerNodes: { id: string; node: CPINode; rootId: string }[] = [];
  for (const [rootId, children] of Object.entries(innerByRoot)) {
    children.forEach((c, i) => {
      const key = `${c.programId}@${i}`;
      if (innerSeen.has(key)) return;
      innerSeen.add(key);
      innerNodes.push({ id: `inner-${c.programId}-${i}-${rootId}`, node: c, rootId });
    });
  }
  innerNodes.slice(0, 6).forEach((entry, i) => {
    pushNode({
      id: entry.id,
      type: 'program',
      x: COL_X[2],
      y: 80 + i * (NODE_H + ROW_GAP / 2),
      w: NODE_W_PROGRAM,
      h: NODE_H,
      label: entry.node.programName,
      address: SHORT(entry.node.programId, 4, 4),
      owner: 'BPFLoaderUpgradeable',
      description: `Called via CPI from a root program. Consumed ${(entry.node.cuConsumed ?? 0).toLocaleString()} CU.`,
    });
    edges.push({ from: entry.rootId, to: entry.id, label: 'CPI' });
  });

  // Column 3 — accounts whose balances actually changed (writable diffs)
  // Pick the top-N most-changed accounts so the graph doesn't get noisy.
  const changedDiffs = accountDiffs
    .filter((d) => d.role !== 'signer')
    .filter((d) => d.solDelta !== 0 || (d.tokenDeltas && d.tokenDeltas.length > 0))
    .slice(0, 6);
  changedDiffs.forEach((d, i) => {
    const id = `acct-${d.pubkey}`;
    const tokenDelta = d.tokenDeltas?.[0];
    const isToken = !!tokenDelta;
    const label = isToken
      ? `Token Acct (${(tokenDelta as any).symbol || SHORT((tokenDelta as any).mint, 4, 4)})`
      : d.solDelta !== 0
        ? 'SOL Account'
        : 'Account';
    const owner = isToken ? 'Token Program' : 'System Program';
    const summary = isToken
      ? `${tokenDelta.uiDelta > 0 ? '+' : ''}${tokenDelta.uiDelta} ${(tokenDelta as any).symbol || SHORT((tokenDelta as any).mint, 4, 4)}`
      : `${d.solDelta > 0 ? '+' : ''}${(d.solDelta / 1e9).toFixed(6)} SOL`;
    pushNode({
      id,
      type: isToken ? 'account' : 'pda',
      x: COL_X[3],
      y: 60 + i * (NODE_H + ROW_GAP / 2),
      w: NODE_W_ACCOUNT,
      h: 30,
      label,
      address: SHORT(d.pubkey, 4, 4),
      owner,
      description: `${d.role === 'writable' ? 'Writable account.' : 'Read-only account.'} Net change: ${summary}.`,
    });
    // Best-effort edge — connect this account to the Token Program node
    // (if visible) for token accounts, or to the System Program / first
    // root program for native SOL accounts.
    if (isToken) {
      const tokenInner = innerNodes.find((n) => /Token/i.test(n.node.programName));
      if (tokenInner) {
        edges.push({
          from: tokenInner.id,
          to: id,
          label: tokenDelta.uiDelta > 0 ? 'credits' : 'debits',
        });
      }
    } else if (rootPrograms[0]) {
      edges.push({ from: `root-${rootPrograms[0].programId}-0`, to: id, label: 'updates' });
    }
  });

  return { nodes, edges };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-instruction summary ("Explanation" tab).
//
// Wallet support folks looking at Solscan rarely have time to decode raw
// instruction blobs — they want a single sentence per ix in plain English:
// "Sends 0.5 SOL", "Swaps tokens via Jupiter", "Creates an associated token
// account". `summarizeInstruction()` walks the parsed RPC instruction +
// programId/instructionName and returns a small structured payload the
// front-end can render as a clickable list with a side detail card.
// ───────────────────────────────────────────────────────────────────────────

interface InstructionSummary {
  index: number;
  programId: string;
  programName: string;
  instructionName: string | null;
  iconKind: 'transfer' | 'swap' | 'mint' | 'burn' | 'create' | 'compute' | 'verify' | 'misc';
  title: string;
  summary: string;
  details: { label: string; value: string; mono?: boolean }[];
  accounts: { role: string; pubkey: string }[];
  cuConsumed: number | null;
  innerCount: number;
  warnings: string[];
}

function lamportsToSol(n: number | string | undefined | null): string {
  if (n == null) return '0 SOL';
  const v = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(v)) return '0 SOL';
  return `${(v / 1e9).toLocaleString('en-US', { maximumFractionDigits: 9 })} SOL`;
}

// `getParsedTransaction` doesn't pre-decode Compute Budget instructions, so we
// fall back to manual decoding for the four real ones. Returns a synthetic
// `parsed` object in the same shape RPC uses for native programs, which lets
// summarizeInstruction route through the normal switch below.
function decodeComputeBudgetData(dataBase58: string): { type: string; info: any } | null {
  try {
    const bs58Mod = require('bs58');
    const decode = bs58Mod.default?.decode ?? bs58Mod.decode;
    const buf: Buffer = Buffer.from(decode(dataBase58));
    if (buf.length === 0) return null;
    const tag = buf[0];
    if (tag === 2 && buf.length >= 5) {
      // SetComputeUnitLimit { units: u32 }
      return { type: 'setComputeUnitLimit', info: { units: buf.readUInt32LE(1) } };
    }
    if (tag === 3 && buf.length >= 9) {
      // SetComputeUnitPrice { microLamports: u64 }
      const microLamports = buf.readBigUInt64LE(1);
      return { type: 'setComputeUnitPrice', info: { microLamports: microLamports.toString() } };
    }
    if (tag === 0 && buf.length >= 9) {
      // RequestUnits { units: u32, additionalFee: u32 } — deprecated
      return {
        type: 'requestUnits',
        info: { units: buf.readUInt32LE(1), additionalFee: buf.readUInt32LE(5) },
      };
    }
    if (tag === 1 && buf.length >= 5) {
      // RequestHeapFrame { bytes: u32 }
      return { type: 'requestHeapFrame', info: { bytes: buf.readUInt32LE(1) } };
    }
    if (tag === 4 && buf.length >= 5) {
      // SetLoadedAccountsDataSizeLimit { bytes: u32 }
      return {
        type: 'setLoadedAccountsDataSizeLimit',
        info: { bytes: buf.readUInt32LE(1) },
      };
    }
    return null;
  } catch {
    return null;
  }
}

function rawIxToCommonShape(rawIx: any, accountKeys: string[]) {
  // Normalize the two shapes Solana RPC can return:
  //  • parsed:  { programId, program, parsed: { type, info } }
  //  • partial: { programId|programIdIndex, accounts: [..pubkey/index..], data }
  const programId =
    typeof rawIx?.programId === 'string'
      ? rawIx.programId
      : (rawIx?.programId?.toBase58?.() ??
        (typeof rawIx?.programIdIndex === 'number' ? accountKeys[rawIx.programIdIndex] : ''));
  const accounts: string[] = Array.isArray(rawIx?.accounts)
    ? rawIx.accounts.map((a: any) =>
        typeof a === 'number' ? (accountKeys[a] ?? `?${a}`) : (a?.toBase58?.() ?? String(a))
      )
    : [];
  let parsed = rawIx?.parsed && typeof rawIx.parsed === 'object' ? rawIx.parsed : null;
  // Compute Budget is the one common native program RPC doesn't decode for
  // us — manually shim it so the summarizer switch picks it up.
  if (
    !parsed &&
    programId === 'ComputeBudget111111111111111111111111111111' &&
    typeof rawIx?.data === 'string'
  ) {
    parsed = decodeComputeBudgetData(rawIx.data);
  }
  return { programId: programId ?? '', accounts, parsed };
}

function summarizeInstruction(
  rawIx: any,
  accountKeys: string[],
  index: number,
  parsedIx: any | null,
  cuConsumed: number | null,
  innerCount: number
): InstructionSummary {
  const { programId, accounts, parsed } = rawIxToCommonShape(rawIx, accountKeys);
  const programName = resolveProgramName(programId);
  // Prefer the RPC-decoded type for native programs, then the IDL-decoded
  // name for Anchor programs, then null.
  const instructionName: string | null = parsed?.type ?? parsedIx?.instructionName ?? null;

  const base: InstructionSummary = {
    index,
    programId,
    programName,
    instructionName,
    iconKind: 'misc',
    title: instructionName ? `${programName} · ${instructionName}` : programName,
    summary: `Calls ${programName}${
      accounts.length ? ` with ${accounts.length} account${accounts.length === 1 ? '' : 's'}` : ''
    }.`,
    details: [],
    accounts: accounts.map((pubkey, i) => ({ role: `account ${i}`, pubkey })),
    cuConsumed,
    innerCount,
    warnings: [],
  };

  // ── Native program shortcuts (parsed.info is structured by the SDK) ──
  if (parsed) {
    const info = parsed.info ?? {};

    // System Program
    if (programId === '11111111111111111111111111111111') {
      switch (parsed.type) {
        case 'transfer':
          return {
            ...base,
            iconKind: 'transfer',
            title: `Send ${lamportsToSol(info.lamports)}`,
            summary: `Transfers ${lamportsToSol(info.lamports)} from ${SHORT(info.source)} to ${SHORT(info.destination)}.`,
            details: [
              { label: 'Amount', value: lamportsToSol(info.lamports) },
              { label: 'From', value: info.source ?? '—', mono: true },
              { label: 'To', value: info.destination ?? '—', mono: true },
            ],
          };
        case 'createAccount':
          return {
            ...base,
            iconKind: 'create',
            title: 'Create account',
            summary: `Creates a new account owned by ${SHORT(info.owner)} and seeds it with ${lamportsToSol(info.lamports)}.`,
            details: [
              { label: 'New account', value: info.newAccount ?? '—', mono: true },
              { label: 'Owner program', value: info.owner ?? '—', mono: true },
              { label: 'Funded with', value: lamportsToSol(info.lamports) },
              { label: 'Space', value: `${info.space ?? 0} bytes` },
            ],
          };
        case 'allocate':
          return {
            ...base,
            iconKind: 'create',
            title: 'Allocate space',
            summary: `Allocates ${info.space ?? 0} bytes of storage on an existing account.`,
            details: [
              { label: 'Account', value: info.account ?? '—', mono: true },
              { label: 'Space', value: `${info.space ?? 0} bytes` },
            ],
          };
        case 'assign':
          return {
            ...base,
            iconKind: 'misc',
            title: 'Assign owner',
            summary: `Reassigns ${SHORT(info.account)} to be owned by ${SHORT(info.owner)}.`,
            details: [
              { label: 'Account', value: info.account ?? '—', mono: true },
              { label: 'New owner', value: info.owner ?? '—', mono: true },
            ],
          };
      }
    }

    // SPL Token / Token-2022
    if (
      programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ||
      programId === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
    ) {
      const ui = info?.tokenAmount?.uiAmountString ?? info?.amount ?? '?';
      const dec = info?.tokenAmount?.decimals;
      const symbol = info?.mint ? SHORT(info.mint) : 'tokens';
      switch (parsed.type) {
        case 'transfer':
        case 'transferChecked':
          return {
            ...base,
            iconKind: 'transfer',
            title: `Transfer ${ui} ${symbol}`,
            summary: `Moves ${ui} ${symbol} from token account ${SHORT(info.source)} to ${SHORT(info.destination)}.`,
            details: [
              { label: 'Amount', value: `${ui}${dec != null ? ` (decimals ${dec})` : ''}` },
              { label: 'Source ATA', value: info.source ?? '—', mono: true },
              { label: 'Destination ATA', value: info.destination ?? '—', mono: true },
              ...(info.mint ? [{ label: 'Mint', value: info.mint, mono: true }] : []),
              ...(info.authority
                ? [{ label: 'Authority', value: info.authority, mono: true }]
                : []),
            ],
          };
        case 'mintTo':
        case 'mintToChecked':
          return {
            ...base,
            iconKind: 'mint',
            title: `Mint ${ui} ${symbol}`,
            summary: `Mints ${ui} new ${symbol} into ${SHORT(info.account)}.`,
            details: [
              { label: 'Amount', value: `${ui}` },
              { label: 'Mint', value: info.mint ?? '—', mono: true },
              { label: 'Destination', value: info.account ?? '—', mono: true },
            ],
          };
        case 'burn':
        case 'burnChecked':
          return {
            ...base,
            iconKind: 'burn',
            title: `Burn ${ui} ${symbol}`,
            summary: `Permanently destroys ${ui} ${symbol} from ${SHORT(info.account)}.`,
            details: [
              { label: 'Amount', value: `${ui}` },
              { label: 'Mint', value: info.mint ?? '—', mono: true },
              { label: 'From account', value: info.account ?? '—', mono: true },
            ],
          };
        case 'closeAccount':
          return {
            ...base,
            iconKind: 'misc',
            title: 'Close token account',
            summary: `Closes ${SHORT(info.account)} and refunds the rent lamports to ${SHORT(info.destination)}.`,
            details: [
              { label: 'Closed', value: info.account ?? '—', mono: true },
              { label: 'Rent refund to', value: info.destination ?? '—', mono: true },
            ],
          };
        case 'approve':
        case 'approveChecked':
          return {
            ...base,
            iconKind: 'misc',
            title: `Approve delegate`,
            summary: `Authorizes ${SHORT(info.delegate)} to spend up to ${ui} ${symbol} from ${SHORT(info.source)}.`,
            details: [
              { label: 'Delegate', value: info.delegate ?? '—', mono: true },
              { label: 'Allowance', value: `${ui}` },
              { label: 'On account', value: info.source ?? '—', mono: true },
            ],
          };
        case 'initializeAccount':
        case 'initializeAccount2':
        case 'initializeAccount3':
          return {
            ...base,
            iconKind: 'create',
            title: 'Initialize token account',
            summary: `Initializes a new token account for mint ${SHORT(info.mint)}.`,
            details: [
              { label: 'Account', value: info.account ?? '—', mono: true },
              { label: 'Mint', value: info.mint ?? '—', mono: true },
              { label: 'Owner', value: info.owner ?? '—', mono: true },
            ],
          };
      }
    }

    // Associated Token Account
    if (programId === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL') {
      if (parsed.type === 'create' || parsed.type === 'createIdempotent') {
        return {
          ...base,
          iconKind: 'create',
          title: 'Create associated token account',
          summary: `Derives and creates the ATA for ${SHORT(info.wallet)} to hold the token ${SHORT(info.mint)}.`,
          details: [
            { label: 'Wallet', value: info.wallet ?? '—', mono: true },
            { label: 'Mint', value: info.mint ?? '—', mono: true },
            { label: 'Created ATA', value: info.account ?? '—', mono: true },
          ],
          warnings:
            parsed.type === 'createIdempotent'
              ? ['Idempotent — does nothing if the ATA already exists.']
              : [],
        };
      }
    }

    // Compute Budget
    if (programId === 'ComputeBudget111111111111111111111111111111') {
      switch (parsed.type) {
        case 'setComputeUnitLimit':
          return {
            ...base,
            iconKind: 'compute',
            title: 'Set compute unit limit',
            summary: `Caps how much compute the transaction is allowed to use at ${(info.units ?? 0).toLocaleString()} CU.`,
            details: [{ label: 'Limit', value: `${(info.units ?? 0).toLocaleString()} CU` }],
          };
        case 'setComputeUnitPrice':
          return {
            ...base,
            iconKind: 'compute',
            title: 'Set priority fee',
            summary: `Pays ${info.microLamports ?? 0} micro-lamports per CU as a priority bid (helps land in the next block).`,
            details: [{ label: 'Price per CU', value: `${info.microLamports ?? 0} µLamports` }],
          };
        case 'requestUnits':
        case 'requestHeapFrame':
          return {
            ...base,
            iconKind: 'compute',
            title: 'Request compute resources',
            summary: 'Requests additional compute resources for the transaction.',
            details: Object.entries(info).map(([k, v]) => ({ label: k, value: String(v) })),
          };
        case 'setLoadedAccountsDataSizeLimit':
          return {
            ...base,
            iconKind: 'compute',
            title: 'Set loaded accounts data size limit',
            summary: `Caps the total bytes of account data the runtime will load to ${(info.bytes ?? 0).toLocaleString()} bytes (lowers fees on large account lists).`,
            details: [{ label: 'Limit', value: `${(info.bytes ?? 0).toLocaleString()} bytes` }],
          };
      }
    }
  }

  // ── Anchor / known-program shortcuts (driven by instruction name) ──
  // We don't decode arguments here — Anchor does that via the IDL but the
  // result we have today only carries the instruction name. That's still
  // useful: "Jupiter · sharedAccountsRoute" + a 1-liner description is
  // way better than raw hex.
  if (instructionName) {
    const lc = instructionName.toLowerCase();

    if (programId === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') {
      const swapNameTexts: Record<string, string> = {
        route: 'Jupiter computes the best route across DEXes and executes the swap.',
        sharedaccountsroute:
          'Jupiter swaps using shared program accounts to save on transaction size and CU.',
        exactoutroute:
          'Jupiter swaps to deliver an exact output amount, computing the input price-bound from quotes.',
        sharedaccountsexactoutroute:
          'Jupiter exact-output swap using shared accounts (cheapest+smallest route).',
      };
      const desc = swapNameTexts[lc] ?? `Jupiter aggregator instruction \`${instructionName}\`.`;
      return {
        ...base,
        iconKind: 'swap',
        title: `Swap via Jupiter`,
        summary: desc,
      };
    }

    if (programId === 'whirLbMiicVdio4KfUV7LSu1DbjhokCWAN8DiwKx5hp' && lc.includes('swap')) {
      return {
        ...base,
        iconKind: 'swap',
        title: 'Swap on Orca Whirlpool',
        summary:
          'Concentrated-liquidity swap on Orca. Walks tick arrays in the requested direction until the input is consumed.',
      };
    }

    if (programId === 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' && lc.includes('swap')) {
      return {
        ...base,
        iconKind: 'swap',
        title: 'Swap on Raydium CLMM',
        summary: 'Concentrated-liquidity swap on Raydium. Tick-array based, similar to Whirlpool.',
      };
    }

    if (programId === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' && lc.includes('swap')) {
      return {
        ...base,
        iconKind: 'swap',
        title: 'Swap on Raydium AMM',
        summary: 'Constant-product AMM swap on Raydium (legacy v4 pools).',
      };
    }

    if (programId === 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s') {
      if (lc.includes('verify')) {
        return {
          ...base,
          iconKind: 'verify',
          title: 'Verify NFT collection',
          summary: 'Marks this NFT as a verified member of its collection (Metaplex Metadata).',
        };
      }
      if (lc.includes('createmetadata')) {
        return {
          ...base,
          iconKind: 'create',
          title: 'Create NFT metadata',
          summary:
            'Creates the on-chain metadata account that names and links to the off-chain JSON.',
        };
      }
    }

    // Generic Anchor instruction — the name itself carries the meaning.
    return {
      ...base,
      title: `${programName} · ${instructionName}`,
      summary: `Calls the \`${instructionName}\` instruction on ${programName}.`,
    };
  }

  // Final fallback — opaque instruction we couldn't decode at all.
  return base;
}

function buildInstructionSummaries(
  bundle: any,
  parsedInstructions: any[],
  cpiTree: CPITree
): InstructionSummary[] {
  const message = bundle?.transaction?.message;
  const accountKeys: string[] = bundle?.accountKeys ?? [];
  const rawInstructions: any[] = Array.isArray(message?.instructions) ? message.instructions : [];

  if (process.env.DEBUG_IXS === '1') {
    console.log('[ixs] count:', rawInstructions.length);
    rawInstructions.forEach((ix, i) =>
      console.log('  raw[' + i + ']:', JSON.stringify(ix).slice(0, 200))
    );
  }

  // Pair each top-level instruction with its CPI tree root so we can attach
  // the CU value and the inner-instruction count. They're guaranteed to be
  // in the same order — the CPI builder consumes the same log stream.
  return rawInstructions.map((rawIx, i) => {
    const cpiRoot = cpiTree.root[i];
    const parsedIx = parsedInstructions[i];
    const innerCount = cpiRoot?.children?.length ?? 0;
    const cu = cpiRoot?.cuConsumed ?? null;
    return summarizeInstruction(rawIx, accountKeys, i, parsedIx ?? null, cu, innerCount);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Richer execution trace for the "Explanation" tab.
//
// The CPI tree returned by services/src strips per-node log messages so the
// CLI dashboard can stay compact. The Explanation tab wants the opposite —
// it needs to render the full nested log of every invocation, indented like
// Solscan, plus a one-line summary on each node so support agents don't have
// to translate raw program logs in their head.
// ───────────────────────────────────────────────────────────────────────────

interface ExecNode {
  programId: string;
  programName: string;
  depth: number;
  status: 'success' | 'failed' | 'truncated';
  cuConsumed: number | null;
  cuLimit: number | null;
  logs: string[]; // raw "Program log: ..." messages emitted by this program
  returnData: string | null;
  errorMessage: string | null;
  children: ExecNode[];
}

// Pick out the human-readable bits from the executor logs — the ones support
// agents care about. "Program log: Instruction: Transfer" becomes simply
// "Instruction: Transfer"; consumed-CU lines are dropped because we already
// surface that as a number.
function cleanExecLogs(rawLogs: string[]): string[] {
  return rawLogs
    .map((l) => {
      const m1 = l.match(/^Program log:\s*(.*)$/);
      if (m1) return m1[1].trim();
      const m2 = l.match(/^Program data:\s*(.*)$/);
      if (m2) return `data: ${m2[1].slice(0, 80)}${m2[1].length > 80 ? '…' : ''}`;
      return null;
    })
    .filter((l): l is string => !!l)
    .slice(0, 8); // hard cap so the panel doesn't explode on log-heavy programs
}

function pickReturnData(rawLogs: string[]): string | null {
  for (const l of rawLogs) {
    const m = l.match(/^Program return:\s*(\w+)\s+(.*)$/);
    if (m) return m[2];
  }
  return null;
}

function toExecNode(snapshot: any): ExecNode {
  return {
    programId: snapshot.programId,
    programName: resolveProgramName(snapshot.programId),
    depth: snapshot.depth,
    status: snapshot.status,
    cuConsumed: snapshot.computeUnitsConsumed ?? null,
    cuLimit: null, // CPI tree builder doesn't preserve the limit; left null on purpose
    logs: cleanExecLogs(snapshot.logs ?? []),
    returnData: pickReturnData(snapshot.logs ?? []),
    errorMessage: snapshot.error?.rawMessage ?? null,
    children: (snapshot.children ?? []).map(toExecNode),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Knowledge base for the "Learn" tab.
//
// The redesigned Learn tab has 3 sections — programs, accounts/PDAs, and
// fundamental Solana concepts. Each card pairs a short reusable description
// with a transaction-specific clause ("In this tx it was called 4 times").
// Wallet support folks who don't fluently read Solana logs get the same
// context an experienced engineer would write up by hand for them.
// ───────────────────────────────────────────────────────────────────────────

const PROGRAM_LEARN: Record<string, { tagline: string }> = {
  '11111111111111111111111111111111': {
    tagline:
      "Solana's System Program. Creates accounts, transfers SOL, allocates space and assigns ownership. Every native operation that doesn't involve a token routes through here.",
  },
  ComputeBudget111111111111111111111111111111: {
    tagline:
      "A native program that lets the transaction set its own CU ceiling and offer a per-CU priority fee. It doesn't move state — it just configures how the validator schedules execution.",
  },
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: {
    tagline:
      "Solana's native SPL Token Program. Handles transfers, mints, freezes and account initialization for fungible tokens.",
  },
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: {
    tagline:
      'Token-2022 — the next-gen SPL token program with extensions like transfer fees, confidential transfers and metadata pointers.',
  },
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: {
    tagline:
      "The Associated Token Account program. Derives a deterministic ATA pubkey from a wallet+mint pair and creates it on demand so users don't have to manage token-account addresses themselves.",
  },
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: {
    tagline:
      'Metaplex Metadata. Stores on-chain metadata for tokens and NFTs (name, symbol, URI, collection links) so wallets can render them with a recognizable identity.',
  },
  whirLbMiicVdio4KfUV7LSu1DbjhokCWAN8DiwKx5hp: {
    tagline:
      'Orca Whirlpool — a concentrated-liquidity AMM. swap_v2 walks tick arrays in the price direction and stops when the input amount is consumed.',
  },
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': {
    tagline:
      'Raydium AMM v4 — constant-product pools (x*y=k). Cheaper than CLMM but with worse capital efficiency at narrow price bands.',
  },
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: {
    tagline:
      'Raydium CLMM — concentrated-liquidity AMM, similar in shape to Whirlpool. Tick-array based, requires reading liquidity ranges per swap.',
  },
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: {
    tagline:
      'Jupiter v6 — the dominant Solana DEX aggregator. Routes a swap across multiple liquidity sources to find the best price, then executes via CPIs.',
  },
  CiQPQrmQh6BPhb9k7dFnsEs5gKPgdrvNKFc5xie5xVGd: {
    tagline:
      'Pump.fun — bonding-curve token launcher. Buys/sells trade against an on-chain curve until the token graduates to a Raydium pool.',
  },
};

interface LearnCard {
  name: string;
  description: string;
}

interface LearnPayload {
  programs: LearnCard[];
  accounts: LearnCard[];
  concepts: LearnCard[];
}

function buildLearn(
  programs: ProgramCU[],
  accountDiffs: ReturnType<typeof computeAccountDiffs>,
  cpiTree: CPITree,
  computeUnitsConsumed: number,
  computeUnitsLimit: number,
  totalCpiCount: number,
  maxDepth: number,
  txType: string | undefined
): LearnPayload {
  // ── Programs ── one card per program that actually consumed CU. We
  // augment the static tagline with a tx-specific clause ("called Nx, used
  // Y CU"), which is the part that turns a generic glossary into something
  // the agent can actually quote to a user.
  const programCards: LearnCard[] = programs
    .filter((p) => p.cuConsumed > 0)
    .slice(0, 8)
    .map((p) => {
      const tagline =
        PROGRAM_LEARN[p.programId]?.tagline ??
        `An on-chain program at ${p.programId.slice(0, 4)}…${p.programId.slice(-4)}. The local registry doesn\'t recognize it, so its purpose can\'t be summarised here.`;
      const sharePct = computeUnitsConsumed > 0 ? (p.cuConsumed / computeUnitsConsumed) * 100 : 0;
      const txClause = `In this transaction it was invoked ${p.count}× and consumed ${p.cuConsumed.toLocaleString()} CU (${sharePct.toFixed(0)}% of total).`;
      return { name: p.programName, description: `${tagline} ${txClause}` };
    });

  // ── Accounts & PDAs ── build a card for each writable account whose
  // balance actually changed. We classify by owner and present each as a
  // human-readable role rather than just dumping the pubkey.
  const interestingDiffs = accountDiffs
    .filter((d) => d.solDelta !== 0 || (d.tokenDeltas && d.tokenDeltas.length > 0))
    .slice(0, 8);
  const accountCards: LearnCard[] = interestingDiffs.map((d) => {
    const tokenDelta = d.tokenDeltas?.[0];
    const isToken = !!tokenDelta;
    if (isToken) {
      const symbol = (tokenDelta as any).symbol || `${tokenDelta.mint.slice(0, 4)}…`;
      const dir = tokenDelta.uiDelta > 0 ? 'received' : 'sent';
      return {
        name: `Token Account (${symbol})`,
        description: `An Associated Token Account that holds ${symbol}. In this transaction it ${dir} ${Math.abs(tokenDelta.uiDelta).toLocaleString()} ${symbol}. Owned by the SPL Token Program; balances are stored on the account itself, not on the wallet.`,
      };
    }
    if (d.role === 'signer') {
      return {
        name: 'Signer / Fee Payer',
        description: `The wallet that authorised the transaction by signing it. It also paid the network fee, so its SOL balance dropped by ${Math.abs(d.solDelta / 1e9).toFixed(6)} SOL net.`,
      };
    }
    return {
      name: 'Native SOL Account',
      description: `A regular account whose lamport balance changed. Net delta: ${d.solDelta > 0 ? '+' : ''}${(d.solDelta / 1e9).toFixed(6)} SOL.`,
    };
  });

  // ── Constraints & Concepts ── primer cards on Solana primitives, each
  // anchored with a stat from this specific transaction so it doesn\'t feel
  // like a static glossary.
  const conceptCards: LearnCard[] = [
    {
      name: 'Compute Units (CU)',
      description: `The unit Solana uses to meter execution cost. Each transaction has a budget (default 200,000 CU; this one was capped at ${computeUnitsLimit.toLocaleString()}). When exhausted, execution fails. Unlike Ethereum gas, CU is tracked per-instruction — that\'s why you can pinpoint exactly where ${computeUnitsConsumed.toLocaleString()} CU was spent in this tx.`,
    },
    {
      name: 'CPI (Cross-Program Invocation)',
      description: `When one program calls another mid-execution. CPIs are how composability works on Solana — but each level adds runtime overhead. This transaction had ${totalCpiCount} program invocations across ${maxDepth} nested level${maxDepth === 1 ? '' : 's'}.`,
    },
    {
      name: 'PDA (Program Derived Address)',
      description:
        'An address derived deterministically from a program ID and a set of seeds — no private key, no off-chain signer. PDAs are how programs own their own state without holding keys. Re-deriving a PDA on-chain costs CU, so most modern programs let callers pass it in as an input instead.',
    },
    {
      name: 'Priority Fee',
      description:
        'A per-CU bid (priced in micro-lamports) the sender attaches via Compute Budget so the leader prioritises this tx during congestion. The base signature fee is fixed; the priority component scales with CU consumed × bid.',
    },
  ];

  return { programs: programCards, accounts: accountCards, concepts: conceptCards };
}

// ───────────────────────────────────────────────────────────────────────────
// Transaction flow / "money trail" analyzer.
//
// Wallet support agents need to answer "where did the value go?" in seconds.
// `buildTxFlow` walks the per-account net deltas and produces:
//
//   • a one-line narrative of the transaction
//   • the signer's net change (and a flag if the signer is a relayer/filler
//     rather than the token-bearing wallet)
//   • a sorted list of counterparty winners (gained SOL) and losers (paid out)
//   • the largest non-signer SOL gain — the "spread" a third party captured
//   • warnings when the signer's share of incoming SOL is unusually small
//
// This is what catches the LOBSTAR-style limit-order-fill tx: an underpriced
// order where the maker only gets a fraction of the SOL paid out by the
// liquidity pools and a filler/relayer pockets the rest.
// ───────────────────────────────────────────────────────────────────────────

interface FlowParty {
  pubkey: string;
  role: 'signer' | 'writable' | 'readonly';
  solDelta: number; // lamports
  solDeltaSol: number; // formatted SOL
  usdValue: number | null; // priced via SOL price
  tokenDeltas: { mint: string; symbol?: string; uiDelta: number; decimals: number }[];
  isFeePayer: boolean;
  label?: string; // optional tag like "filler / relayer"
}

interface TxFlow {
  signer: FlowParty | null;
  // The wallet that lost the most token value. In a limit-order-fill that's
  // typically the program escrow PDA, not the human user — see
  // `intendedRecipient` for the actual end-user wallet.
  tokenSource: FlowParty | null;
  // The largest non-signer SOL recipient. In a regular swap this equals the
  // signer; in a limit-order fill or a relayed swap, it's the human user
  // who placed the order.
  intendedRecipient: FlowParty | null;
  winners: FlowParty[]; // non-signer accounts with +SOL, sorted by gain desc
  losers: FlowParty[]; // accounts with -SOL (excluding fee-only outflows)
  totalSolPaidOut: number; // lamports lost by losers
  totalSolReceived: number; // lamports gained by winners + signer
  signerShareOfReceived: number; // 0..1
  spread: { taker: string; lamports: number; sol: number; usd: number | null } | null;
  narrative: string;
  warnings: string[];
}

function shortPubkey(p: string): string {
  if (!p) return '';
  return p.length > 10 ? `${p.slice(0, 4)}…${p.slice(-4)}` : p;
}

function buildTxFlow(
  accountDiffs: ReturnType<typeof computeAccountDiffs>,
  bundle: any,
  fee: number,
  solPriceUsd: number | null
): TxFlow {
  if (!accountDiffs?.length) {
    return {
      signer: null,
      tokenSource: null,
      intendedRecipient: null,
      winners: [],
      losers: [],
      totalSolPaidOut: 0,
      totalSolReceived: 0,
      signerShareOfReceived: 0,
      spread: null,
      narrative: 'No accounts moved — this transaction had no balance changes.',
      warnings: [],
    };
  }

  const lamportsToUsd = (n: number) => (solPriceUsd != null ? (n / 1e9) * solPriceUsd : null);

  // Build an ATA → owner-wallet map from the bundle's pre/postTokenBalances.
  // This lets us consolidate "Michael's LOBSTAR ATA" and "Michael's wallet"
  // into the same row when computing flow — otherwise the SOL receipt and
  // the token outflow look like they happened to two unrelated parties.
  const ataOwners = new Map<string, string>();
  const accountKeys: string[] = bundle?.accountKeys ?? [];
  const indexBalances = (list: any[] | undefined): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const idx = entry?.accountIndex;
      const owner = entry?.owner;
      if (typeof idx === 'number' && typeof owner === 'string' && accountKeys[idx]) {
        ataOwners.set(accountKeys[idx], owner);
      }
    }
  };
  indexBalances(bundle?.preTokenBalances);
  indexBalances(bundle?.postTokenBalances);

  // Consolidate accountDiffs by "effective wallet". An ATA's token deltas
  // get folded onto the owner's row so the flow view shows the wallet the
  // user actually cares about — not the program-owned ATA holding the tokens.
  const partyByKey = new Map<string, FlowParty>();
  const ensureParty = (key: string, role: 'signer' | 'writable' | 'readonly'): FlowParty => {
    let p = partyByKey.get(key);
    if (!p) {
      p = {
        pubkey: key,
        role,
        solDelta: 0,
        solDeltaSol: 0,
        usdValue: null,
        tokenDeltas: [],
        isFeePayer: false,
      };
      partyByKey.set(key, p);
    } else if (p.role !== 'signer' && role === 'signer') {
      p.role = 'signer';
    }
    return p;
  };

  let signerIndex = -1;
  accountDiffs.forEach((d, i) => {
    const owner = ataOwners.get(d.pubkey);
    const tokenLoss = (d.tokenDeltas ?? []).some((t) => t.uiDelta < 0);
    const tokenGain = (d.tokenDeltas ?? []).some((t) => t.uiDelta > 0);

    // SOL deltas always belong to the account itself. Token deltas belong to
    // the ATA's owner when present, otherwise to the account.
    const tokenTarget = owner ?? d.pubkey;

    const solParty = ensureParty(d.pubkey, d.role);
    solParty.solDelta += d.solDelta;

    const tokenParty = tokenTarget === d.pubkey ? solParty : ensureParty(tokenTarget, 'writable');
    for (const t of d.tokenDeltas ?? []) {
      // Skip wSOL token deltas when there's an equivalent SOL delta — they
      // double-count the same lamports. wSOL mint is So11...1112.
      if (
        t.mint === 'So11111111111111111111111111111111111111112' &&
        Math.abs(d.solDelta) >= 1_000 &&
        Math.sign(d.solDelta) === Math.sign(t.uiDelta * 1e9)
      ) {
        continue;
      }
      tokenParty.tokenDeltas.push({
        mint: t.mint,
        symbol: (t as any).symbol,
        uiDelta: t.uiDelta,
        decimals: t.decimals,
      });
    }

    if (d.role === 'signer') signerIndex = i;
    void tokenLoss;
    void tokenGain;
  });

  // Finalize derived fields per party.
  const parties: FlowParty[] = [...partyByKey.values()].map((p, i) => ({
    ...p,
    solDeltaSol: p.solDelta / 1e9,
    usdValue: lamportsToUsd(p.solDelta),
    isFeePayer: p.role === 'signer' && i === 0,
  }));

  const signer = parties.find((p) => p.role === 'signer') ?? null;
  void signerIndex;

  // Winners — non-signer parties with positive SOL delta. Sorted by gain desc.
  const winners = parties
    .filter((p) => p !== signer && p.solDelta > 0)
    .sort((a, b) => b.solDelta - a.solDelta);

  // Losers — anyone with negative SOL delta. We keep these in the table but
  // distinguish "real" payouts (>= 0.01 SOL) from fee-dust noise (< 0.005 SOL).
  const losers = parties.filter((p) => p.solDelta < 0).sort((a, b) => a.solDelta - b.solDelta);

  const totalSolPaidOut = losers
    .filter((p) => Math.abs(p.solDelta) >= 5_000_000) // >= 0.005 SOL — drop fee dust
    .reduce((sum, p) => sum + Math.abs(p.solDelta), 0);
  const totalSolReceived = parties
    .filter((p) => p.solDelta > 0)
    .reduce((sum, p) => sum + p.solDelta, 0);

  const signerShare =
    totalSolReceived > 0 && signer && signer.solDelta > 0 ? signer.solDelta / totalSolReceived : 0;

  // tokenSource — the wallet that lost the most token value. In limit-order
  // fills this is typically a program escrow PDA holding the maker's tokens.
  const tokenLosers = parties
    .filter((p) => p.tokenDeltas.some((t) => t.uiDelta < 0))
    .sort((a, b) => {
      const aMax = Math.max(
        ...a.tokenDeltas.filter((t) => t.uiDelta < 0).map((t) => Math.abs(t.uiDelta))
      );
      const bMax = Math.max(
        ...b.tokenDeltas.filter((t) => t.uiDelta < 0).map((t) => Math.abs(t.uiDelta))
      );
      return bMax - aMax;
    });
  const tokenSource = tokenLosers[0] ?? null;

  // intendedRecipient — the largest non-signer SOL recipient that isn't a
  // pool/AMM losing SOL on the same row. This is the human end-user wallet
  // that received the fill payout in a limit-order tx. In a normal swap
  // this resolves to the same wallet as the signer.
  const intendedRecipient =
    winners.find((p) => p.solDelta >= 10_000_000) ?? // >= 0.01 SOL
    null;

  // Filler / relayer pattern: signer is not the wallet that owned the
  // tokens spent in this tx, AND signer captured significant SOL.
  const isFillerPattern =
    !!signer &&
    !!tokenSource &&
    tokenSource.pubkey !== signer.pubkey &&
    signer.solDelta >= 10_000_000;

  // Spread — what the signer kept while a different wallet bore the token
  // outflow. This is the canonical "filler captured arbitrage" number.
  const spread =
    isFillerPattern && signer
      ? {
          taker: signer.pubkey,
          lamports: signer.solDelta,
          sol: signer.solDelta / 1e9,
          usd: signer.usdValue,
        }
      : null;

  // Labels for the UI so each row reads as a role, not just a pubkey.
  if (signer) {
    signer.label = isFillerPattern ? 'signer · spread captured here' : 'transaction signer';
  }
  if (tokenSource && signer && tokenSource.pubkey !== signer.pubkey) {
    tokenSource.label =
      intendedRecipient && tokenSource.pubkey === intendedRecipient.pubkey
        ? 'maker / token-bearing wallet'
        : 'token escrow / vault';
  }
  if (intendedRecipient && signer && intendedRecipient.pubkey !== signer.pubkey) {
    intendedRecipient.label = isFillerPattern ? 'intended recipient (maker)' : 'recipient';
  }

  // ── Warnings ──
  const warnings: string[] = [];

  // Filler / relayer pattern: signer is not the wallet that owned the
  // tokens spent in this tx.
  if (isFillerPattern && signer && tokenSource) {
    warnings.push(
      `Tokens (${tokenSource.tokenDeltas.find((t) => t.uiDelta < 0)?.uiDelta != null ? Math.abs(tokenSource.tokenDeltas.find((t) => t.uiDelta < 0)!.uiDelta).toLocaleString() + ' ' + (tokenSource.tokenDeltas.find((t) => t.uiDelta < 0)!.symbol ?? tokenSource.tokenDeltas.find((t) => t.uiDelta < 0)!.mint.slice(0, 4) + '…') : 'unknown'}) flowed out of ${shortPubkey(tokenSource.pubkey)}, but the transaction was signed by ${shortPubkey(signer.pubkey)}. This pattern is typical of a filler / relayer settling a pre-signed order — common in limit-order fills.`
    );
  }

  // Signer captured most of the SOL paid by the pools while a different
  // wallet received the actual fill. This is the LOBSTAR-style anomaly:
  // the maker's expected payout was much lower than the spot price the
  // pools paid, and the signer pocketed the difference.
  if (
    isFillerPattern &&
    signer &&
    signer.solDelta > 0 &&
    totalSolPaidOut > 0 &&
    signer.solDelta > totalSolPaidOut * 0.3
  ) {
    const pctRetained = (signer.solDelta / totalSolPaidOut) * 100;
    const recipSol = intendedRecipient?.solDelta ?? 0;
    const recipSolStr = (recipSol / 1e9).toFixed(4);
    const signerSolStr = (signer.solDelta / 1e9).toFixed(4);
    const recipLabel = intendedRecipient ? shortPubkey(intendedRecipient.pubkey) : 'the maker';
    warnings.push(
      `Signer kept ~${pctRetained.toFixed(0)}% of the SOL paid by liquidity pools (${signerSolStr} SOL), while ${recipLabel} only received ${recipSolStr} SOL. Consistent with an underpriced limit-order fill or MEV/arbitrage spread.`
    );
  }

  // Even when signer == intended recipient, flag when they got way less SOL
  // than the pools paid (e.g. multi-hop swap with bad routing or hidden fees).
  if (
    !isFillerPattern &&
    intendedRecipient &&
    intendedRecipient.pubkey === signer?.pubkey &&
    intendedRecipient.solDelta > 0 &&
    totalSolPaidOut > 0 &&
    intendedRecipient.solDelta < totalSolPaidOut * 0.5
  ) {
    const pct = (intendedRecipient.solDelta / totalSolPaidOut) * 100;
    warnings.push(
      `The signer received only ${pct.toFixed(0)}% of the total SOL paid out by liquidity pools. Worth checking for hidden fees or sandwich attacks.`
    );
  }

  // ── Narrative ──
  const narrative = (() => {
    if (!signer) return 'Transaction with no clear signer.';

    // Filler / limit-order-fill pattern
    if (isFillerPattern && tokenSource) {
      const sentToken = tokenSource.tokenDeltas.find((t) => t.uiDelta < 0);
      const tokenLabel = sentToken
        ? `${Math.abs(sentToken.uiDelta).toLocaleString()} ${sentToken.symbol ?? sentToken.mint.slice(0, 4) + '…'}`
        : 'tokens';
      const outSolStr = (totalSolPaidOut / 1e9).toFixed(4);
      const signerGainStr = (signer.solDelta / 1e9).toFixed(4);
      const recipPart =
        intendedRecipient && intendedRecipient.pubkey !== signer.pubkey
          ? ` ${shortPubkey(intendedRecipient.pubkey)} received ${(intendedRecipient.solDelta / 1e9).toFixed(4)} SOL of that.`
          : '';
      return `${tokenLabel} flowed out of ${shortPubkey(tokenSource.pubkey)}; liquidity pools paid ${outSolStr} SOL for them. The transaction was signed by ${shortPubkey(signer.pubkey)}, who pocketed ${signerGainStr} SOL.${recipPart}`;
    }

    // Plain swap / transfer pattern (signer == maker)
    if (totalSolPaidOut > 0) {
      const inSol = (signer.solDelta / 1e9).toFixed(4);
      const outSol = (totalSolPaidOut / 1e9).toFixed(4);
      return `Pools paid out ${outSol} SOL in total. The signer's net change was ${inSol} SOL.`;
    }

    return 'Transaction completed; balances changed without significant SOL flow.';
  })();

  return {
    signer,
    tokenSource,
    intendedRecipient,
    winners,
    losers,
    totalSolPaidOut,
    totalSolReceived,
    signerShareOfReceived: signerShare,
    spread,
    narrative,
    warnings,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Build the JSON shape the demo page consumes
// ───────────────────────────────────────────────────────────────────────────

export async function analyze(signature: string, network: 'mainnet' | 'devnet') {
  const idlCache = new IdlCache({ verbose: false });

  const rawBundle = await fetchTransaction(signature, network);

  const { Connection } = await import('@solana/web3.js');
  const { AnchorProvider } = await import('@coral-xyz/anchor');
  const rpcUrl =
    network === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';
  const anchorProvider = new AnchorProvider(
    new Connection(rpcUrl, 'confirmed'),
    {
      publicKey: null,
      signTransaction: async (tx: any) => tx,
      signAllTransactions: async (txs: any) => txs,
    } as any,
    { commitment: 'confirmed' }
  );

  const parsedLogSummary = parseLogsFromBundle(rawBundle.logMessages);
  const cuProfile = profileCU(rawBundle.logMessages);
  const rawTrace = buildCPITree(rawBundle.logMessages);
  const cpiTree = toCPITree(rawTrace);
  // Richer trace, with per-node logs and return data, used by the new
  // "Explanation" tab to render a Solscan-style nested log view.
  const executionTrace = {
    roots: rawTrace.roots.map(toExecNode),
    isTruncated: rawTrace.isTruncated,
  };
  const accountDiffs = computeAccountDiffs(rawBundle);

  const analyzed = await mergeAnalysis(
    rawBundle,
    toParsedLogs(rawBundle.logMessages, parsedLogSummary),
    cuProfile,
    cpiTree,
    accountDiffs,
    { idlCache, anchorProvider }
  );

  const insightsReport = await analyzeTransaction(analyzed, [new McpInsightProvider()]);

  // The CU profiler can't attribute per-program CU on its own (the log lines
  // it parses don't carry program ids), so we aggregate from the CPI tree
  // instead — that's the path the CLI's flame graph also uses. Drop the
  // 0-CU Compute Budget rows so the bar chart isn't dominated by phantoms.
  const programs = aggregateProgramsFromCpi(cpiTree).filter(
    (p) => p.cuConsumed > 0 && p.programId !== 'ComputeBudget111111111111111111111111111111'
  );
  const cpiBottleneck = findCpiBottleneck(cpiTree);

  // Decorated bottleneck the demo card consumes — combines the CPI heaviest
  // node with insight-engine context when available so the UI can render
  // a meaningful "⚠ Bottleneck" callout instead of "Unknown Program".
  const bottleneck = cpiBottleneck
    ? {
        programId: cpiBottleneck.programId,
        programName: cpiBottleneck.programName,
        cuConsumed: cpiBottleneck.cuConsumed,
        depth: cpiBottleneck.depth,
        sharePercent:
          cpuConsumedTotal(cpiTree) > 0
            ? (cpiBottleneck.cuConsumed / cpuConsumedTotal(cpiTree)) * 100
            : 0,
      }
    : null;

  // Top-level instructions — the CPI tree only has program ids, not the
  // human instruction name (`swap_v2`, `verify_collection`, …). Pull those
  // out of the parsed transaction so the CPI tab can render them next to
  // each program.
  const instructionNames = (analyzed.parsed?.instructions ?? []).map((ix) => ({
    programId: ix.programId,
    programName: resolveProgramName(ix.programId),
    instructionName: ix.instructionName ?? null,
  }));

  const accountModel = buildAccountModel(cpiTree, accountDiffs, analyzed.transfers ?? []);

  // Per-instruction explanations for the new "Explanation" tab. One entry
  // per top-level instruction with a plain-English summary, structured
  // details and the CU it consumed.
  const instructions = buildInstructionSummaries(
    rawBundle,
    analyzed.parsed?.instructions ?? [],
    cpiTree
  );

  // Money-trail / "transaction flow" summary that sits at the top of the
  // Explanation tab. Surfaces signer net change, counterparty winners, and
  // flags filler/spread anomalies (the LOBSTAR-style limit-order fill).
  const flow = buildTxFlow(
    accountDiffs,
    rawBundle,
    analyzed.parsed.fee,
    analyzed.cuCost?.feeUSD != null && analyzed.cuCost.feeLamports
      ? (analyzed.cuCost.feeUSD / analyzed.cuCost.feeLamports) * 1e9
      : null
  );

  // Learn-tab knowledge base. Composes per-program/per-account explanations
  // with tx-specific stats so each card reads like a tailored briefing.
  const learn = buildLearn(
    programs,
    accountDiffs,
    cpiTree,
    analyzed.raw.computeUnitsConsumed ?? cuProfile.totalConsumed,
    cuProfile.totalLimit || 200_000,
    cpiTree.nodeCount,
    cpiTree.totalDepth,
    analyzed.txType
  );

  return {
    signature,
    network,
    success: !analyzed.raw.err,
    slot: analyzed.raw.slot,
    blockTime: analyzed.raw.blockTime,
    fee: analyzed.parsed.fee,
    feeSol: analyzed.parsed.fee / 1e9,
    computeUnits: {
      consumed: analyzed.raw.computeUnitsConsumed ?? cuProfile.totalConsumed,
      limit: cuProfile.totalLimit,
      utilizationPercent: cuProfile.utilizationPercent,
    },
    bottleneck,
    programs,
    cpiTree,
    executionTrace,
    accountDiffs,
    accountModel,
    instructionNames,
    instructions,
    flow,
    learn,
    transfers: analyzed.transfers ?? [],
    insights: insightsReport.insights,
    primaryBottleneck: insightsReport.primaryBottleneck,
    estimatedSavings: insightsReport.totalEstimatedSavings,
    txType: analyzed.txType,
  };
}

// Latest mainnet Jupiter v6 signature — used by the demo's "live mainnet
// sample" button to pull a fresh, real transaction on every click. Exported
// so the Vercel handler in api/latest-tx.ts can reuse the same logic.
export async function getLatestTx() {
  const { Connection, PublicKey } = await import('@solana/web3.js');
  // Prefer the user-provided Helius RPC (set via HELIUS_RPC_URL env) so the
  // signature lookup doesn't burn the public mainnet rate limit.
  const rpcUrl = process.env.HELIUS_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const conn = new Connection(rpcUrl, 'confirmed');
  const JUPITER_V6 = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');

  const sigs = await conn.getSignaturesForAddress(JUPITER_V6, { limit: 10 });
  const ok = sigs.find((s) => !s.err);
  if (!ok) throw new Error('no recent successful transactions found');

  console.log(`[latest-tx] ${ok.signature.slice(0, 8)}…  slot=${ok.slot}`);
  return {
    signature: ok.signature,
    network: 'mainnet' as const,
    slot: ok.slot,
    blockTime: ok.blockTime,
    source: 'jupiter-v6' as const,
  };
}

// Sum CU across the entire CPI tree so we can compute a "share of total"
// number for the bottleneck callout (matches the CLI's "60%" on the dashboard).
function cpuConsumedTotal(cpi: CPITree): number {
  let total = 0;
  const walk = (nodes: CPINode[]) => {
    for (const n of nodes) {
      total += n.cuConsumed ?? 0;
      if (n.children?.length) walk(n.children);
    }
  };
  walk(cpi.root);
  return total;
}

// ───────────────────────────────────────────────────────────────────────────
// HTTP server
// ───────────────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(
  res: http.ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {}
) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers,
  });
  res.end(body);
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
  const safe = urlPath.replace(/\.\.+/g, '').replace(/^\/+/, '');
  const file = safe === '' ? 'landing.html' : safe;
  const full = path.join(WEB_DIR, file);

  try {
    const data = await fs.readFile(full);
    const ext = path.extname(full).toLowerCase();
    send(res, 200, data, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  } catch {
    send(res, 404, `not found: ${file}`, { 'Content-Type': 'text/plain' });
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url) return send(res, 400, 'bad request');

  if (req.method === 'OPTIONS') return send(res, 204, '');

  const url = new URL(req.url, `http://${req.headers.host}`);

  // health check
  if (url.pathname === '/api/health') {
    return send(res, 200, JSON.stringify({ ok: true, version: '0.1.0' }), {
      'Content-Type': 'application/json',
    });
  }

  // latest-tx — returns the most recent confirmed signature for a high-traffic
  // mainnet program (Jupiter v6). Lets the demo's "live mainnet sample" button
  // pull a fresh, real transaction on every click instead of using a stale one.
  if (url.pathname === '/api/latest-tx') {
    try {
      const result = await getLatestTx();
      return send(res, 200, JSON.stringify(result), {
        'Content-Type': 'application/json',
      });
    } catch (e: any) {
      console.error('[latest-tx] error:', e?.message ?? e);
      return send(res, 500, JSON.stringify({ error: e?.message ?? String(e) }), {
        'Content-Type': 'application/json',
      });
    }
  }

  // analyze endpoint — accepts GET ?signature=...&network=... or POST {signature, network}
  if (url.pathname === '/api/analyze') {
    let signature = url.searchParams.get('signature') ?? '';
    let network = (url.searchParams.get('network') ?? 'mainnet') as 'mainnet' | 'devnet';

    if (req.method === 'POST') {
      const body = await new Promise<string>((resolve) => {
        let buf = '';
        req.on('data', (c) => (buf += c));
        req.on('end', () => resolve(buf));
      });
      try {
        const parsed = JSON.parse(body);
        signature = parsed.signature ?? signature;
        network = parsed.network ?? network;
      } catch {
        return send(res, 400, JSON.stringify({ error: 'invalid JSON body' }), {
          'Content-Type': 'application/json',
        });
      }
    }

    if (!signature || ![87, 88].includes(signature.length)) {
      return send(res, 400, JSON.stringify({ error: 'invalid signature' }), {
        'Content-Type': 'application/json',
      });
    }
    if (network !== 'mainnet' && network !== 'devnet') {
      return send(res, 400, JSON.stringify({ error: 'invalid network' }), {
        'Content-Type': 'application/json',
      });
    }

    try {
      const t0 = Date.now();
      const result = await analyze(signature, network);
      const tookMs = Date.now() - t0;
      console.log(`[analyze] ${signature.slice(0, 8)}…  ${tookMs}ms`);
      return send(res, 200, JSON.stringify({ ...result, tookMs }), {
        'Content-Type': 'application/json',
      });
    } catch (e: any) {
      console.error('[analyze] error:', e?.message ?? e);
      return send(res, 500, JSON.stringify({ error: e?.message ?? String(e) }), {
        'Content-Type': 'application/json',
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // /api/track — POST { event_type, referrer? }
  //
  // Records a "transaction profiled" event. Geo comes from Vercel edge
  // headers in production; in local dev those headers are absent so the
  // row lands without country/city — fine for testing the wiring.
  // ─────────────────────────────────────────────────────────────
  if (url.pathname === '/api/track' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const geo = readGeoHeaders(req);
      await trackEvent(
        {
          event_type: 'tx_profiled',
          referrer: typeof body.referrer === 'string' ? body.referrer : undefined,
        },
        geo
      );
      return send(res, 200, JSON.stringify({ ok: true }), {
        'Content-Type': 'application/json',
      });
    } catch (e: any) {
      console.error('[track] error:', e?.message ?? e);
      // We never want a tracking failure to surface to the user — respond
      // 200 either way. Errors are logged for ops to see.
      return send(res, 200, JSON.stringify({ ok: false }), {
        'Content-Type': 'application/json',
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // /api/stats — GET
  //
  // Returns the full payload the dashboard renders. Cached 60s inside
  // getStats() so a busy dashboard doesn't hammer npm / Supabase.
  // ─────────────────────────────────────────────────────────────
  if (url.pathname === '/api/stats') {
    try {
      const data = await getStats();
      return send(res, 200, JSON.stringify(data), {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30, s-maxage=60',
      });
    } catch (e: any) {
      console.error('[stats] error:', e?.message ?? e);
      return send(res, 500, JSON.stringify({ error: e?.message ?? String(e) }), {
        'Content-Type': 'application/json',
      });
    }
  }

  // static files
  if (req.method === 'GET') {
    return serveStatic(req, res, url.pathname);
  }

  send(res, 405, 'method not allowed');
});

// ─────────────────────────────────────────────────────────────
// Request helpers used by /api/track
// ─────────────────────────────────────────────────────────────

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const buf = await new Promise<string>((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
  if (!buf) return {};
  try {
    return JSON.parse(buf);
  } catch {
    return {};
  }
}

function readGeoHeaders(req: http.IncomingMessage): GeoHeaders {
  const h = (name: string) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  return {
    country: h('x-vercel-ip-country'),
    countryName: h('x-vercel-ip-country-region'), // present on Pro, harmless when absent
    city: h('x-vercel-ip-city'),
    region: h('x-vercel-ip-country-region'),
    latitude: h('x-vercel-ip-latitude'),
    longitude: h('x-vercel-ip-longitude'),
  };
}

// Only start the long-running HTTP server when this file is executed directly
// (`tsx web/server.ts` for local dev). When the file is imported as a module
// — e.g. by api/*.ts on Vercel pulling in the exported analyze/getLatestTx —
// we skip listen() so no port binding happens in serverless contexts.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  server.listen(PORT, () => {
    console.log(`\n  open dev server`);
    console.log(`  → http://localhost:${PORT}/landing.html`);
    console.log(`  → http://localhost:${PORT}/web.html`);
    console.log(`  → POST /api/analyze  { signature, network }`);
    console.log(`  → GET  /api/latest-tx  (latest mainnet Jupiter v6 sig)`);
    console.log(`  → POST /api/track     { event_type, referrer? } (community dashboard)`);
    console.log(`  → GET  /api/stats     (aggregated dashboard payload)\n`);
  });
}

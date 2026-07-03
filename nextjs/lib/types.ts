// Types mirror the JSON returned by `analyze()` in `web/server.ts` (served at
// POST /api/analyze). The task brief carried a simplified sketch; these follow
// the real payload the existing API produces so the client renders live data
// without a translation layer.

export type Network = 'mainnet' | 'devnet';

export interface ComputeUnits {
  consumed: number;
  limit: number;
  utilizationPercent: number;
}

export interface Bottleneck {
  programId: string;
  programName: string;
  cuConsumed: number;
  depth: number;
  sharePercent: number;
}

export interface ProgramCu {
  programId: string;
  programName: string;
  cuConsumed: number;
  count: number;
}

export interface CpiNode {
  programId: string;
  programName: string;
  depth: number;
  status: 'success' | 'failed';
  cuConsumed?: number;
  children: CpiNode[];
}

export interface CpiTree {
  root: CpiNode[];
  totalDepth: number;
  nodeCount: number;
}

export interface TokenDelta {
  mint: string;
  symbol?: string;
  decimals: number;
  rawDelta: string;
  uiDelta: number;
}

export interface AccountDiff {
  pubkey: string;
  role: 'signer' | 'writable' | 'readonly';
  solDelta: number;
  tokenDeltas: TokenDelta[];
}

export type IconKind =
  | 'transfer'
  | 'swap'
  | 'mint'
  | 'burn'
  | 'create'
  | 'compute'
  | 'verify'
  | 'misc';

export interface InstructionDetail {
  label: string;
  value: string;
  mono?: boolean;
}

export interface InstructionAccount {
  role: string;
  pubkey: string;
}

export interface InstructionSummary {
  index: number;
  programId: string;
  programName: string;
  instructionName: string | null;
  iconKind: IconKind;
  title: string;
  summary: string;
  details: InstructionDetail[];
  accounts: InstructionAccount[];
  cuConsumed: number | null;
  innerCount: number;
  warnings: string[];
}

export interface InstructionName {
  programId: string;
  programName: string;
  instructionName: string | null;
}

export interface ExecNode {
  programId: string;
  programName: string;
  depth: number;
  status: 'success' | 'failed' | 'truncated';
  cuConsumed: number | null;
  cuLimit: number | null;
  logs: string[];
  returnData: string | null;
  errorMessage: string | null;
  children: ExecNode[];
}

export interface ExecutionTrace {
  roots: ExecNode[];
  isTruncated: boolean;
}

export interface FlowTokenDelta {
  mint: string;
  symbol?: string;
  uiDelta: number;
  decimals: number;
}

export interface FlowParty {
  pubkey: string;
  role: 'signer' | 'writable' | 'readonly';
  solDelta: number;
  solDeltaSol: number;
  usdValue: number | null;
  tokenDeltas: FlowTokenDelta[];
  isFeePayer: boolean;
  label?: string;
}

export interface FlowSpread {
  taker: string;
  lamports: number;
  sol: number;
  usd: number | null;
}

export interface TxFlow {
  signer: FlowParty | null;
  tokenSource: FlowParty | null;
  intendedRecipient: FlowParty | null;
  winners: FlowParty[];
  losers: FlowParty[];
  totalSolPaidOut: number;
  totalSolReceived: number;
  signerShareOfReceived: number;
  spread: FlowSpread | null;
  narrative: string;
  warnings: string[];
}

export interface LearnCard {
  name: string;
  description: string;
}

export interface LearnPayload {
  programs: LearnCard[];
  accounts: LearnCard[];
  concepts: LearnCard[];
}

export interface ModelNode {
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

export interface ModelEdge {
  from: string;
  to: string;
  label?: string;
}

export interface AccountModel {
  nodes: ModelNode[];
  edges: ModelEdge[];
}

export type InsightSeverity = 'critical' | 'warning' | 'info';

export interface Insight {
  type: string;
  severity: InsightSeverity;
  title: string;
  message: string;
  recommendation: string;
  estimatedCUSavings?: number;
  programId?: string;
  source: 'rule' | 'mcp' | 'hybrid';
  tags?: string[];
}

export interface AnalysisResult {
  signature: string;
  network: Network;
  success: boolean;
  slot: number;
  blockTime: number | null;
  fee: number;
  feeSol: number;
  computeUnits: ComputeUnits;
  bottleneck: Bottleneck | null;
  programs: ProgramCu[];
  cpiTree: CpiTree;
  executionTrace: ExecutionTrace;
  accountDiffs: AccountDiff[];
  accountModel: AccountModel;
  instructionNames: InstructionName[];
  instructions: InstructionSummary[];
  flow: TxFlow;
  learn: LearnPayload;
  transfers: unknown[];
  insights: Insight[];
  primaryBottleneck: Insight | null;
  estimatedSavings: number;
  txType?: string;
  tookMs?: number;
}

export interface LatestTx {
  signature: string;
  network: Network;
  slot: number;
  blockTime: number | null;
  source: string;
}

export interface ApiErrorBody {
  error: string;
}

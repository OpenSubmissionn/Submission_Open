import type { PromptContext } from './prompts.js';

/** Aggregate stats describing the CPI call tree shape. */
export interface CpiTreeStructure {
  /** Maximum depth of the CPI tree. */
  depth: number;
  /** Total number of nodes (root + children). */
  totalNodes: number;
  /** Average children per non-leaf node (1.0 means linear chain, >1.0 means fan-out). */
  branchingFactor: number;
  /** Count of distinct programs invoked across the tree. */
  uniquePrograms: number;
}

/** Detailed information about the program that consumed the most CU. */
export interface BottleneckNodeDetail {
  programId: string;
  programName: string;
  cuConsumed: number;
  utilizationPercent: number;
  /** Status of the bottleneck call ("success" | "failed"). */
  status?: 'success' | 'failed';
  /** Depth of the bottleneck node in the CPI tree, when known. */
  depth?: number;
}

/** Per-account state change with full role and value details. */
export interface DetailedAccountDiff {
  pubkey: string;
  /** First 8 chars of the pubkey for display. */
  pubkeyShort: string;
  /** Account role: signer / writable / readonly. */
  role: 'signer' | 'writable' | 'readonly';
  solDelta: number;
  /** Token deltas attached to this account (mint + uiDelta). */
  tokenDeltas: Array<{
    mint: string;
    symbol?: string;
    uiDelta: number;
  }>;
}

/** Reference to a known optimization pattern for the bottleneck program. */
export interface SimilarPattern {
  programName: string;
  pattern: string;
  optimization: string;
}

export interface MCPPayload {
  bottleneckProgram: string;
  instructionName: string;
  cuConsumed: number;
  cpiDepth: number;
  accountDiffSummary: string;
  parsedErrors: string[];
  logSummary: string;
  /** Optional enriched context (framework examples, trade-offs, CU references). */
  promptContext?: PromptContext;
  /** Aggregate metrics on the CPI tree shape. */
  cpiTreeStructure?: CpiTreeStructure;
  /** Detailed breakdown of the CU bottleneck node. */
  bottleneckNode?: BottleneckNodeDetail;
  /** Per-account state changes with role and token deltas. */
  detailedAccountDiffs?: DetailedAccountDiff[];
  /** Known optimization patterns relevant to this transaction's bottleneck. */
  similarPatterns?: SimilarPattern[];
}

export interface MCPInsightResponse {
  suggestions: string[];
  source: 'mcp';
}

/**
 * AI insights resolution order:
 *   1. MCP_DISABLED=1            → skip AI entirely (rule-based only)
 *   2. MCP_ENDPOINT_URL set      → POST payload to that endpoint (advanced override)
 *   3. GROQ_API_KEY set          → free Groq tier (Llama 3.3 70B, ~30 req/min)
 *   4. ANTHROPIC_API_KEY set     → Claude (paid, ~$0.003/analysis with Sonnet)
 *   5. neither set               → warn, fall back to rule-based
 *
 * Each user pays (or doesn't, with Groq) their own way. The pipeline always
 * works — when AI is unavailable, only rule-based insights render.
 */
import { callAnthropic, type AnthropicResult } from './anthropic.js';
import { callGroq } from './groq.js';

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';

/**
 * Strip ANSI escape sequences and C0/C1 control characters from a model- or
 * endpoint-supplied suggestion before it reaches a consumer (MED-06). The web
 * UI already HTML-escapes these strings, but the CLI prints them straight to a
 * terminal; without this an LLM (or a compromised MCP_ENDPOINT_URL) could embed
 * raw escape codes to rewrite the terminal, spoof output, or trigger
 * title/clipboard escapes. Control chars are collapsed to single spaces.
 */
export function sanitizeSuggestion(s: string): string {
  return s
    // ANSI/VT escape sequences: ESC + introducer + params + final byte.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-_][0-?]*[ -/]*[@-~]?/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-~]/g, '')
    // Remaining C0/C1 control chars (incl. lone ESC, CR, LF, TAB, DEL).
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Validate a user-supplied MCP_ENDPOINT_URL. Rules:
 *   - Must be a syntactically valid URL.
 *   - Must use `https:`. Plain http is rejected so credentials in payload
 *     don't travel in cleartext, and so loopback/internal hosts don't get
 *     a free SSRF primitive over http.
 *   - If `MCP_ENDPOINT_HOST_ALLOWLIST` is set (comma-separated), the URL's
 *     hostname must match one of the entries exactly.
 *
 * Returns the parsed URL on success, `null` on rejection.
 */
function validateMcpEndpoint(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const allowlistRaw = process.env.MCP_ENDPOINT_HOST_ALLOWLIST;
  if (allowlistRaw && allowlistRaw.trim().length > 0) {
    const allowed = allowlistRaw.split(',').map((s) => s.trim().toLowerCase());
    if (!allowed.includes(parsed.hostname.toLowerCase())) return null;
  }
  return parsed;
}

export async function requestInsights(payload: MCPPayload): Promise<MCPInsightResponse> {
  if (process.env.MCP_DISABLED) {
    return { suggestions: [], source: 'mcp' };
  }

  const endpointUrl = process.env.MCP_ENDPOINT_URL;
  if (endpointUrl) {
    // MED-05: validate the custom endpoint URL before making any request.
    // Without this, an operator-set (or env-injected) MCP_ENDPOINT_URL is a
    // server-side request primitive — it could be pointed at instance
    // metadata, internal vault hosts, etc. The validator below enforces
    // https + an optional MCP_ENDPOINT_HOST_ALLOWLIST.
    const validated = validateMcpEndpoint(endpointUrl);
    if (!validated) {
      console.warn(
        '[MCP] MCP_ENDPOINT_URL rejected — must be https and (when MCP_ENDPOINT_HOST_ALLOWLIST is set) on an allowlisted host. Falling back to rule-based insights.'
      );
      return { suggestions: [], source: 'mcp' };
    }
    announceProvider('Custom MCP', validated.host);
    return callMcpEndpoint(validated.toString(), payload);
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    const model = process.env.MCP_MODEL || DEFAULT_GROQ_MODEL;
    announceProvider('Groq', model);
    return callProvider((signal) => callGroq(payload, groqKey, model, signal));
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    const model = process.env.MCP_MODEL || DEFAULT_ANTHROPIC_MODEL;
    announceProvider('Anthropic', model);
    return callProvider((signal) => callAnthropic(payload, anthropicKey, model, signal));
  }

  warnNoKey();
  return { suggestions: [], source: 'mcp' };
}

let announcedProvider = false;
function announceProvider(name: string, model: string): void {
  process.env.MCP_PROVIDER_LABEL = `${name} · ${model}`;
  if (announcedProvider) return;
  announcedProvider = true;
  console.info(`[MCP] AI provider: ${name} · ${model}`);
}

async function callProvider(
  fn: (signal: AbortSignal) => Promise<AnthropicResult>
): Promise<MCPInsightResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const result = await fn(controller.signal);
    if (result.degraded) warnDegraded(result);
    return { suggestions: result.suggestions.map(sanitizeSuggestion), source: 'mcp' };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callMcpEndpoint(url: string, payload: MCPPayload): Promise<MCPInsightResponse> {
  const attempt = async (retryCount: number): Promise<MCPInsightResponse> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status >= 500 && retryCount < 1) return attempt(retryCount + 1);
        console.warn(
          `[MCP] AI insights indisponíveis (HTTP ${response.status}). Rendering rule-based insights only.`
        );
        return { suggestions: [], source: 'mcp' };
      }
      const data = (await response.json()) as { suggestions?: unknown };
      // Strict schema check on responses from a (potentially user-controlled)
      // endpoint. Drop anything that isn't a short string. Length capped at
      // 500 to keep AI-injected payloads bounded — the client renders these
      // strings through escapeHtml, but bounding length is cheap insurance.
      const suggestions = Array.isArray(data.suggestions)
        ? data.suggestions
            .filter((s): s is string => typeof s === 'string')
            .map((s) => sanitizeSuggestion(s.slice(0, 500)))
        : [];
      return { suggestions, source: 'mcp' };
    } catch (error) {
      if (retryCount < 1) return attempt(retryCount + 1);
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[MCP] AI insights indisponíveis (${msg}). Rendering rule-based insights only.`);
      return { suggestions: [], source: 'mcp' };
    } finally {
      clearTimeout(timeoutId);
    }
  };
  return attempt(0);
}

function warnNoKey(): void {
  console.warn(
    '[MCP] No AI key configured. Rendering rule-based insights only.\n' +
      '       Quickest:         opendev login              # browser-assisted, ~30s\n' +
      '       Or pass directly: opendev config set-key groq <KEY>      # or anthropic\n' +
      '       Inspect:          opendev config get-key\n' +
      '\n' +
      '       Providers:\n' +
      '         Groq (free)        Llama 3.3 70B, ~30 req/min   console.groq.com/keys\n' +
      '         Anthropic (paid)   Claude Sonnet, ~$0.003/run   console.anthropic.com'
  );
}

function warnDegraded(result: AnthropicResult): void {
  switch (result.degraded) {
    case 'no_credit':
      console.warn(
        `[MCP] ${result.message ?? 'No credits left.'} Rendering rule-based insights only.`
      );
      return;
    case 'rate_limit':
      console.warn(
        `[MCP] ${result.message ?? 'Rate limit reached.'} Rendering rule-based insights only.`
      );
      return;
    case 'auth':
      console.warn(
        `[MCP] ${result.message ?? 'Auth failed.'} Check your ANTHROPIC_API_KEY. Rendering rule-based insights only.`
      );
      return;
    default:
      console.warn(
        `[MCP] AI insights unavailable (${result.message ?? 'unknown error'}). Rendering rule-based insights only.`
      );
  }
}

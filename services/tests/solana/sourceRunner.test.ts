import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { detectSourceKind, runSourceFile, buildChildEnv } from '../../src/solana/sourceRunner';
import { detectInputKind } from '../../src/solana/simulationService';

describe('sourceRunner - buildChildEnv (HIGH-02 secret stripping)', () => {
  const secretKeys = [
    'ANTHROPIC_API_KEY',
    'GROQ_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'GITHUB_TOKEN',
    'DB_PASSWORD',
    'WALLET_PRIVATE_KEY',
    'MY_SESSION',
    'WALLET_MNEMONIC',
  ];

  beforeAll(() => {
    for (const k of secretKeys) process.env[k] = 'super-secret-value';
    process.env.PATH = process.env.PATH ?? '/usr/bin';
  });

  afterAll(() => {
    for (const k of secretKeys) delete process.env[k];
  });

  it('strips secret-looking vars by default', () => {
    const env = buildChildEnv();
    for (const k of secretKeys) {
      expect(env[k], `${k} should be stripped`).toBeUndefined();
    }
    // Non-secret toolchain vars survive so cargo/npx/node still work.
    expect(env.PATH).toBeDefined();
  });

  it('keeps secrets when inheritFullEnv is true', () => {
    const env = buildChildEnv(undefined, true);
    expect(env.ANTHROPIC_API_KEY).toBe('super-secret-value');
    expect(env.GROQ_API_KEY).toBe('super-secret-value');
  });

  it('does not filter caller-supplied extra vars', () => {
    const env = buildChildEnv({ SOME_API_KEY: 'explicit' });
    expect(env.SOME_API_KEY).toBe('explicit');
  });
});

describe('sourceRunner - detectSourceKind', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-runner-detect-'));
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('detects .rs file as rust-source', () => {
    const f = path.join(tmpDir, 'main.rs');
    fs.writeFileSync(f, 'fn main() {}');
    expect(detectSourceKind(f)).toBe('rust-source');
  });

  it('detects .ts file as ts-source', () => {
    const f = path.join(tmpDir, 'build.ts');
    fs.writeFileSync(f, 'console.log("");');
    expect(detectSourceKind(f)).toBe('ts-source');
  });

  it.each(['build.js', 'build.mjs', 'build.cjs'])('detects %s as js-source', (name) => {
    const f = path.join(tmpDir, name);
    fs.writeFileSync(f, 'console.log("");');
    expect(detectSourceKind(f)).toBe('js-source');
  });

  it('detects directory with Cargo.toml as rust-source', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'cargo-proj-'));
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname="x"');
    expect(detectSourceKind(dir)).toBe('rust-source');
  });

  it('returns null for directory without Cargo.toml', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'plain-'));
    expect(detectSourceKind(dir)).toBeNull();
  });

  it('returns null for unknown extension', () => {
    const f = path.join(tmpDir, 'note.txt');
    fs.writeFileSync(f, 'hello');
    expect(detectSourceKind(f)).toBeNull();
  });

  it('returns null for non-existent path', () => {
    expect(detectSourceKind(path.join(tmpDir, 'nope.rs'))).toBeNull();
  });
});

describe('simulationService.detectInputKind - source routing', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-detect-routing-'));
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('routes .rs to rust-source (overrides plain path)', () => {
    const f = path.join(tmpDir, 'tx.rs');
    fs.writeFileSync(f, 'fn main() {}');
    expect(detectInputKind(f)).toBe('rust-source');
  });

  it('routes .ts to ts-source', () => {
    const f = path.join(tmpDir, 'tx.ts');
    fs.writeFileSync(f, 'console.log("");');
    expect(detectInputKind(f)).toBe('ts-source');
  });

  it('routes .b64 to plain path (unchanged behavior)', () => {
    const f = path.join(tmpDir, 'tx.b64');
    fs.writeFileSync(f, 'AQABAg==');
    expect(detectInputKind(f)).toBe('path');
  });

  it('throws on directory without Cargo.toml with helpful message', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'empty-dir-'));
    expect(() => detectInputKind(dir)).toThrow(/Cargo\.toml/);
  });
});

describe('runSourceFile - js runner', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-runner-exec-'));
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('captures base64 from last stdout line', async () => {
    const f = path.join(tmpDir, 'good.cjs');
    const fakeB64 = 'A'.repeat(120);
    fs.writeFileSync(f, `console.log("warming up...");\nconsole.log("${fakeB64}");`);
    const result = await runSourceFile(f, { timeoutMs: 10_000 });
    expect(result.base64).toBe(fakeB64);
    expect(result.meta.kind).toBe('js-source');
    expect(result.meta.exitCode).toBe(0);
  });

  it('rejects when no base64 line is produced', async () => {
    const f = path.join(tmpDir, 'silent.cjs');
    fs.writeFileSync(f, `console.log("hello");`);
    await expect(runSourceFile(f, { timeoutMs: 10_000 })).rejects.toThrow(/no base64/i);
  });

  it('rejects when runner exits non-zero', async () => {
    const f = path.join(tmpDir, 'fail.cjs');
    fs.writeFileSync(f, `console.error("boom"); process.exit(2);`);
    await expect(runSourceFile(f, { timeoutMs: 10_000 })).rejects.toThrow(/code 2/);
  });

  it('respects timeout', async () => {
    const f = path.join(tmpDir, 'sleep.cjs');
    fs.writeFileSync(f, `setTimeout(() => {}, 60000);`);
    await expect(runSourceFile(f, { timeoutMs: 500 })).rejects.toThrow(/timed out/i);
  });

  it('streams stdout and stderr lines through onProgress', async () => {
    const f = path.join(tmpDir, 'progress.cjs');
    const fakeB64 = 'B'.repeat(120);
    fs.writeFileSync(
      f,
      `console.log("step-1");\nconsole.error("warn-1");\nconsole.log("${fakeB64}");`
    );
    const events: { line: string; stream: 'stdout' | 'stderr' }[] = [];
    const result = await runSourceFile(f, {
      timeoutMs: 10_000,
      onProgress: (line, stream) => events.push({ line, stream }),
    });
    expect(result.base64).toBe(fakeB64);
    expect(events.some((e) => e.stream === 'stdout' && e.line.includes('step-1'))).toBe(true);
    expect(events.some((e) => e.stream === 'stderr' && e.line.includes('warn-1'))).toBe(true);
  });

  it('rejects when input is not a recognized source file', async () => {
    const f = path.join(tmpDir, 'note.txt');
    fs.writeFileSync(f, 'hello');
    await expect(runSourceFile(f, { timeoutMs: 1_000 })).rejects.toThrow(/not a recognized/i);
  });

  // Skipped on Windows: spawn uses shell:true so cmd.exe converts a missing
  // binary into a non-zero exit instead of emitting ENOENT to the parent.
  it.skipIf(process.platform === 'win32')(
    'rejects with install hint when the runner binary is not on PATH',
    async () => {
      const root = fs.mkdtempSync(path.join(tmpDir, 'cargo-enoent-'));
      fs.writeFileSync(
        path.join(root, 'Cargo.toml'),
        '[package]\nname="x"\nversion="0.1.0"\nedition="2021"'
      );
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'main.rs'), 'fn main() {}');
      await expect(
        runSourceFile(root, { timeoutMs: 5_000, env: { PATH: '' } })
      ).rejects.toThrow(/Command not found.*cargo|rustup\.rs/i);
    }
  );

  it('finds Cargo.toml by walking up from a nested .rs path', () => {
    const root = fs.mkdtempSync(path.join(tmpDir, 'cargo-walk-'));
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname="x"');
    const nested = path.join(root, 'src');
    fs.mkdirSync(nested);
    const rs = path.join(nested, 'main.rs');
    fs.writeFileSync(rs, 'fn main() {}');
    expect(detectSourceKind(rs)).toBe('rust-source');
  });
});

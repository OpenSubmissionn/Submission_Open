import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type SourceKind = 'rust-source' | 'ts-source' | 'js-source';

export interface RunSourceOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onProgress?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface SourceRunnerMeta {
  kind: SourceKind;
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number;
}

export interface SourceRunnerResult {
  base64: string;
  meta: SourceRunnerMeta;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const BASE64_LINE_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;
const MIN_BASE64_LEN = 100;
const STDERR_TAIL_LINES = 20;

export function detectSourceKind(input: string): SourceKind | null {
  if (!fs.existsSync(input)) return null;
  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    return fs.existsSync(path.join(input, 'Cargo.toml')) ? 'rust-source' : null;
  }
  if (!stat.isFile()) return null;
  const ext = path.extname(input).toLowerCase();
  if (ext === '.rs') return 'rust-source';
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'ts-source';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'js-source';
  return null;
}

function findCargoRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  if (fs.statSync(current).isFile()) {
    current = path.dirname(current);
  }
  const root = path.parse(current).root;
  while (current !== root) {
    if (fs.existsSync(path.join(current, 'Cargo.toml'))) return current;
    current = path.dirname(current);
  }
  return null;
}

function buildCommand(kind: SourceKind, absInput: string): { cmd: string; args: string[]; cwd: string } {
  const isWindows = process.platform === 'win32';
  if (kind === 'rust-source') {
    const cargoRoot = findCargoRoot(absInput);
    if (!cargoRoot) {
      throw new Error(
        `No Cargo.toml found from "${absInput}" upward. ` +
          `Initialize a Rust project (cargo init) or pass the project root.`
      );
    }
    // On Windows cargo ships as cargo.exe — Node resolves it via PATHEXT
    // when shell is false, so the bare name still works.
    return { cmd: 'cargo', args: ['run', '--release', '--quiet'], cwd: cargoRoot };
  }
  if (kind === 'ts-source') {
    // MED-08: On Windows, npx is shipped as npx.cmd which Node refuses to
    // exec directly when shell:false. Spawn the .cmd extension explicitly
    // and skip shell:true — that eliminates the cmd.exe quoting/expansion
    // surface (%VAR%, ^ escapes, delayed expansion !VAR!) entirely.
    const cmd = isWindows ? 'npx.cmd' : 'npx';
    return { cmd, args: ['-y', 'tsx', absInput], cwd: path.dirname(absInput) };
  }
  // js-source — node.exe is resolvable via PATHEXT on Windows.
  return { cmd: 'node', args: [absInput], cwd: path.dirname(absInput) };
}

function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  /* v8 ignore start -- Windows-only branch, unreachable on Linux CI */
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      /* best-effort */
    }
    return;
  }
  /* v8 ignore stop */
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

function extractBase64(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.length >= MIN_BASE64_LEN && BASE64_LINE_REGEX.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

function lastLines(buf: string, count: number): string[] {
  return buf
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .slice(-count);
}

export async function runSourceFile(
  rawInput: string,
  options: RunSourceOptions = {}
): Promise<SourceRunnerResult> {
  const kind = detectSourceKind(rawInput);
  if (!kind) {
    throw new Error(
      `"${rawInput}" is not a recognized source file (.rs, .ts, .js, .mjs, .cjs) or Rust project directory.`
    );
  }

  const absInput = path.resolve(rawInput);
  const { cmd, args, cwd } = buildCommand(kind, absInput);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandStr = `${cmd} ${args.join(' ')}`;

  const start = Date.now();

  return new Promise((resolve, reject) => {
    // MED-08: shell: false everywhere. On Windows we explicitly spawn
    // npx.cmd / cargo.exe / node.exe (cargo and node resolve via PATHEXT),
    // which bypasses cmd.exe and removes the entire %VAR%/escape/delayed-
    // expansion attack surface. windowsHide keeps the console window from
    // flashing for ts/js runners.
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      killProcessTree(child.pid);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stdout += text;
      if (options.onProgress) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim().length > 0) options.onProgress(line, 'stdout');
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderr += text;
      if (options.onProgress) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim().length > 0) options.onProgress(line, 'stderr');
        }
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        const installHint =
          kind === 'rust-source'
            ? 'Install Rust from https://rustup.rs'
            : kind === 'ts-source'
              ? 'Install Node.js 18+ and ensure npx is on PATH'
              : 'Install Node.js 18+';
        reject(new Error(`Command not found: "${cmd}". ${installHint}.`));
        return;
      }
      reject(new Error(`Failed to spawn "${cmd}": ${err.message}`));
    });

    child.on('close', (exitCode: number | null) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const code = exitCode ?? -1;

      if (timedOut) {
        const tail = lastLines(stderr, STDERR_TAIL_LINES).join('\n');
        reject(
          new Error(
            `Runner timed out after ${timeoutMs}ms (${commandStr}).\n` +
              (tail ? `Last stderr:\n${tail}` : '')
          )
        );
        return;
      }

      if (killed) {
        reject(new Error(`Runner was killed (${commandStr}).`));
        return;
      }

      if (code !== 0) {
        const tail = lastLines(stderr, STDERR_TAIL_LINES).join('\n');
        reject(
          new Error(
            `Runner exited with code ${code} (${commandStr}).\n` +
              (tail ? `Last stderr:\n${tail}` : '')
          )
        );
        return;
      }

      const base64 = extractBase64(stdout);
      if (!base64) {
        const stdoutTail = lastLines(stdout, 5).join('\n') || '<empty>';
        const stderrTail = lastLines(stderr, 5).join('\n') || '<empty>';
        reject(
          new Error(
            `Runner finished but produced no base64 transaction on stdout.\n` +
              `Expected the last non-empty stdout line to be the base64-serialized tx (>= ${MIN_BASE64_LEN} chars).\n` +
              `Last stdout:\n${stdoutTail}\n\nLast stderr:\n${stderrTail}`
          )
        );
        return;
      }

      resolve({
        base64,
        meta: {
          kind,
          command: commandStr,
          cwd,
          durationMs,
          exitCode: code,
        },
      });
    });
  });
}

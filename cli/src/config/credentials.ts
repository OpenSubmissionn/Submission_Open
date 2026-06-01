/**
 * Persistent credential store for AI providers.
 *
 * Lives at ~/.opendev/credentials.json (chmod 600 on unix). Used as the
 * canonical place for `opendev config set-key <provider> <key>` to write,
 * and read at CLI startup so the user doesn't have to manage a .env file.
 *
 * Loading priority for an API key:
 *   1. Existing process.env.<PROVIDER>_API_KEY  — set by the user's shell or
 *      the .env loader. Wins so CI / explicit overrides keep working.
 *   2. ~/.opendev/credentials.json              — what `set-key` writes.
 *   3. .env (legacy)                            — handled elsewhere.
 *
 * The store is intentionally tiny: a flat JSON object mapping provider name
 * to API key. No encryption — relies on filesystem permissions. If you want
 * stronger guarantees, set the env var directly and skip this file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Provider = 'groq' | 'anthropic';

export interface CredentialStore {
  groq?: string;
  anthropic?: string;
}

const ENV_VAR_BY_PROVIDER: Record<Provider, string> = {
  groq: 'GROQ_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

export const SUPPORTED_PROVIDERS: readonly Provider[] = ['groq', 'anthropic'] as const;

const DEFAULT_DIR = path.join(os.homedir(), '.opendev');
const DEFAULT_FILE = path.join(DEFAULT_DIR, 'credentials.json');

/**
 * Resolve the credentials file path, applying safety guards on the
 * env-supplied override (MED-07).
 *
 * Rules for OPENDEV_CREDS_PATH:
 *   - Must resolve to a path under os.homedir() (no /etc, /var, /tmp).
 *   - If the file already exists, it must not be a symlink — refuse to
 *     follow a symlink target the user didn't pick deliberately.
 * Violations fall back to DEFAULT_FILE with a warning so a hostile
 * environment can't silently redirect credential reads/writes.
 */
export function credentialsPath(): string {
  const override = process.env.OPENDEV_CREDS_PATH;
  if (!override) return DEFAULT_FILE;

  const resolved = path.resolve(override);
  const home = path.resolve(os.homedir());
  // path.relative returning an absolute path or one starting with '..'
  // means the override escapes $HOME. Reject it.
  const rel = path.relative(home, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    console.warn(
      `[opendev] OPENDEV_CREDS_PATH=${override} is outside $HOME — ignoring and using ${DEFAULT_FILE}.`
    );
    return DEFAULT_FILE;
  }
  // If the target exists, reject symlinks. A hostile shell init could point
  // a symlink at /etc/sudoers or similar; refuse to follow it.
  try {
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink()) {
      console.warn(
        `[opendev] OPENDEV_CREDS_PATH=${override} is a symlink — ignoring and using ${DEFAULT_FILE}.`
      );
      return DEFAULT_FILE;
    }
  } catch {
    // ENOENT is fine — file may not exist yet.
  }
  return resolved;
}

export function isProvider(value: string): value is Provider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

export function envVarFor(provider: Provider): string {
  return ENV_VAR_BY_PROVIDER[provider];
}

export function readStore(): CredentialStore {
  const file = credentialsPath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as CredentialStore;
    return {};
  } catch {
    return {};
  }
}

function writeStore(store: CredentialStore): void {
  const file = credentialsPath();
  const dir = path.dirname(file);
  // Ensure dir exists with restrictive perms.
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Write to a temp file then rename for atomic update.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  // chmod is a no-op on Windows but enforces 600 on unix in case the file
  // already existed with looser perms.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows or readonly filesystem; ignore. */
  }
}

export function getCredential(provider: Provider): string | undefined {
  const store = readStore();
  return store[provider];
}

export function setCredential(provider: Provider, key: string): void {
  const store = readStore();
  store[provider] = key;
  writeStore(store);
}

export function removeCredential(provider: Provider): boolean {
  const store = readStore();
  if (!(provider in store)) return false;
  delete store[provider];
  writeStore(store);
  return true;
}

/**
 * Hydrate process.env from the credentials store, but only for keys that
 * aren't already set. Called once during CLI startup so downstream code
 * (services/src/mcp/*) sees the same process.env.<PROVIDER>_API_KEY values
 * regardless of whether the user used .env, set-key, or a shell export.
 */
export function applyCredentialsToEnv(): void {
  const store = readStore();
  for (const provider of SUPPORTED_PROVIDERS) {
    const envName = envVarFor(provider);
    if (process.env[envName]) continue; // shell / .env already won
    const fromStore = store[provider];
    if (fromStore) process.env[envName] = fromStore;
  }
}

/**
 * Mask a key for display so we never echo it back in full. Keeps the prefix
 * (so the user can verify they pasted the right one) and the last 4 chars.
 */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 12) return '*'.repeat(key.length);
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

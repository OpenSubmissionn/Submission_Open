import * as fs from 'fs';
import * as crypto from 'crypto';
import {
  Connection,
  VersionedTransaction,
  Transaction,
  PublicKey,
  SimulatedTransactionResponse,
} from '@solana/web3.js';
import { getConnection, withRetry } from './connection.js';
import type { RawTransactionBundle, RawInstruction } from '../analysis/types.js';
import {
  detectSourceKind,
  runSourceFile,
  type SourceKind,
  type SourceRunnerMeta,
  type RunSourceOptions,
} from './sourceRunner.js';

export type SimulationInputKind = 'base64' | 'path' | SourceKind;

export interface SimulatedAccountChange {
  pubkey: string;
  lamportsBefore: number | null;
  lamportsAfter: number | null;
  ownerBefore: string | null;
  ownerAfter: string | null;
  dataLenBefore: number | null;
  dataLenAfter: number | null;
}

export interface SimulationMeta {
  inputKind: SimulationInputKind;
  source: string;
  success: boolean;
  errorJson: string | null;
  returnData: { programId: string; data: string } | null;
  rawResponse: SimulatedTransactionResponse;
  accountChanges: SimulatedAccountChange[];
  isSimulated: true;
  runnerMeta?: SourceRunnerMeta;
}

export interface SimulationOutput {
  bundle: RawTransactionBundle;
  meta: SimulationMeta;
}

export interface SimulateOptions {
  network?: 'mainnet' | 'devnet';
  rpcUrl?: string;
  replaceRecentBlockhash?: boolean;
  sigVerify?: boolean;
  allowExec?: boolean;
  execTimeoutMs?: number;
  /**
   * Inherit the full parent environment into the source-file runner. Defaults
   * to false — secret-looking vars are stripped so user code can't exfiltrate
   * stored API keys (HIGH-02). Only set this when the source legitimately needs
   * an inherited secret (e.g. a private RPC URL in an env var).
   */
  inheritFullEnv?: boolean;
  onRunnerProgress?: RunSourceOptions['onProgress'];
}

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE64_REGEX = /^[A-Za-z0-9+/=\s]+$/;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function detectInputKind(input: string): SimulationInputKind {
  if (fs.existsSync(input)) {
    const sourceKind = detectSourceKind(input);
    if (sourceKind) return sourceKind;
    if (fs.statSync(input).isFile()) return 'path';
    throw new Error(
      `"${truncate(input, 64)}" is a directory but doesn't contain a Cargo.toml. ` +
        `Pass a .b64/.json file, a .ts/.js source file, a .rs file, or a Rust project root.`
    );
  }
  const trimmed = input.trim();
  if ((trimmed.length === 87 || trimmed.length === 88) && BASE58_REGEX.test(trimmed)) {
    throw new Error(
      `"${truncate(input, 32)}" looks like a transaction signature. ` +
        `\`open simulate\` is for transactions that have NOT been broadcast yet — pass a base64 ` +
        `transaction blob or a file path. To inspect a confirmed on-chain transaction, use \`open tx <signature>\`.`
    );
  }
  if (trimmed.length > 0 && BASE64_REGEX.test(trimmed)) {
    return 'base64';
  }
  throw new Error(
    `Unable to detect input kind for "${truncate(input, 32)}". ` +
      `Expected a base64 transaction blob, a file path, or a source file (.rs/.ts/.js).`
  );
}

function readBase64FromPath(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  if (BASE64_REGEX.test(content)) {
    return content;
  }
  try {
    const json = JSON.parse(content);
    if (typeof json === 'string' && BASE64_REGEX.test(json)) return json;
    if (json && typeof json.transaction === 'string' && BASE64_REGEX.test(json.transaction)) {
      return json.transaction;
    }
    if (json && typeof json.tx === 'string' && BASE64_REGEX.test(json.tx)) {
      return json.tx;
    }
  } catch {
    /* not JSON */
  }
  throw new Error(
    `File "${filePath}" does not contain a valid base64 transaction (raw or in {transaction|tx} JSON field).`
  );
}

function deserializeTx(base64: string): VersionedTransaction | Transaction {
  const buf = Buffer.from(base64, 'base64');
  try {
    return VersionedTransaction.deserialize(buf);
  } catch {
    try {
      return Transaction.from(buf);
    } catch (err: any) {
      throw new Error(`Failed to deserialize transaction: ${err.message}`);
    }
  }
}

function decodedLen(data: string | string[]): number {
  const raw = Array.isArray(data) ? (data[0] ?? '') : data;
  return Math.floor((raw.length * 3) / 4);
}

function syntheticSignature(serializedTx: Buffer): string {
  const hash = crypto.createHash('sha256').update(serializedTx).digest('hex');
  return `SIM-${hash.slice(0, 16)}`;
}

function legacyBase58Decode(data: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const map: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET[i]] = i;
  const bytes: number[] = [0];
  for (const c of data) {
    let carry = map[c];
    if (carry === undefined) throw new Error(`Invalid base58 char: ${c}`);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < data.length && data[i] === '1'; i++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

function buildCompiledMessage(tx: VersionedTransaction | Transaction): {
  accountKeys: PublicKey[];
  instructions: RawInstruction[];
  recentBlockhash: string;
} {
  if (tx instanceof VersionedTransaction) {
    const msg = tx.message;
    const compiled = msg.compiledInstructions ?? [];
    const instructions: RawInstruction[] = compiled.map((ci) => ({
      programIdIndex: ci.programIdIndex,
      accounts: Array.from(ci.accountKeyIndexes),
      data: Buffer.from(ci.data).toString('base64'),
    }));
    return {
      accountKeys: msg.staticAccountKeys ?? [],
      instructions,
      recentBlockhash: msg.recentBlockhash,
    };
  }
  const legacyMsg = (tx as Transaction).compileMessage();
  const instructions: RawInstruction[] = legacyMsg.instructions.map((ci) => ({
    programIdIndex: ci.programIdIndex,
    accounts: Array.from(ci.accounts),
    data: Buffer.from(legacyBase58Decode(ci.data)).toString('base64'),
  }));
  return {
    accountKeys: legacyMsg.accountKeys,
    instructions,
    recentBlockhash: legacyMsg.recentBlockhash,
  };
}

function mapInnerInstructions(
  inner: SimulatedTransactionResponse['innerInstructions'] | undefined | null
): { index: number; instructions: RawInstruction[] }[] {
  if (!inner) return [];
  return inner.map((entry: any) => ({
    index: entry.index,
    instructions: (entry.instructions ?? []).map((ix: any) => ({
      programIdIndex: ix.programIdIndex,
      accounts: Array.isArray(ix.accounts) ? Array.from(ix.accounts) : [],
      data: typeof ix.data === 'string' ? ix.data : '',
    })),
  }));
}

function diffAccounts(
  txAccountKeys: PublicKey[],
  preAccounts: ({ lamports: number; owner: string; data?: any } | null)[],
  postAccounts: SimulatedTransactionResponse['accounts']
): SimulatedAccountChange[] {
  if (!postAccounts) return [];
  const changes: SimulatedAccountChange[] = [];
  for (let i = 0; i < postAccounts.length; i++) {
    const post = postAccounts[i];
    const pre = preAccounts ? preAccounts[i] : null;
    const pubkey = txAccountKeys[i]?.toBase58() ?? `idx_${i}`;
    changes.push({
      pubkey,
      lamportsBefore: pre?.lamports ?? null,
      lamportsAfter: post?.lamports ?? null,
      ownerBefore: pre?.owner ?? null,
      ownerAfter: post?.owner ?? null,
      dataLenBefore: pre?.data ? (Array.isArray(pre.data) ? decodedLen(pre.data[0]) : null) : null,
      dataLenAfter: post?.data ? decodedLen(post.data) : null,
    });
  }
  return changes;
}

async function fetchPreAccounts(
  connection: Connection,
  keys: PublicKey[]
): Promise<({ lamports: number; owner: string } | null)[]> {
  if (keys.length === 0) return [];
  try {
    const infos = await withRetry(() => connection.getMultipleAccountsInfo(keys, 'confirmed'));
    return infos.map((info) =>
      info ? { lamports: info.lamports, owner: info.owner.toBase58() } : null
    );
  } catch {
    return keys.map(() => null);
  }
}

export async function simulateTransactionInput(
  rawInput: string,
  options: SimulateOptions = {}
): Promise<SimulationOutput> {
  const kind = detectInputKind(rawInput);
  const network = options.network ?? 'mainnet';
  const connection = getConnection(options.rpcUrl, network);

  let tx: VersionedTransaction | Transaction;
  let runnerMeta: SourceRunnerMeta | undefined;
  const source = rawInput;

  if (kind === 'base64') {
    tx = deserializeTx(rawInput.trim());
  } else if (kind === 'path') {
    const base64 = readBase64FromPath(rawInput);
    tx = deserializeTx(base64);
  } else {
    if (options.allowExec === false) {
      throw new Error(
        `Refusing to execute source file "${rawInput}" because --no-exec is set. ` +
          `Pass a base64 blob or a .b64/.json file instead.`
      );
    }
    const result = await runSourceFile(rawInput, {
      timeoutMs: options.execTimeoutMs,
      inheritFullEnv: options.inheritFullEnv,
      onProgress: options.onRunnerProgress,
    });
    runnerMeta = result.meta;
    tx = deserializeTx(result.base64);
  }

  const { accountKeys, instructions, recentBlockhash } = buildCompiledMessage(tx);
  const accountKeysAsStrings = accountKeys.map((k) => k.toBase58());

  const preAccounts = await fetchPreAccounts(connection, accountKeys);
  const preBalances = preAccounts.map((a) => a?.lamports ?? 0);

  const sim = await withRetry(() => {
    if (tx instanceof VersionedTransaction) {
      return connection.simulateTransaction(tx, {
        replaceRecentBlockhash: options.replaceRecentBlockhash ?? true,
        sigVerify: options.sigVerify ?? false,
        accounts: {
          encoding: 'base64',
          addresses: accountKeysAsStrings,
        },
        innerInstructions: true,
        commitment: 'confirmed',
      } as any);
    }
    return connection.simulateTransaction(tx as Transaction, undefined, accountKeys);
  });

  const value = sim.value;
  const accountChanges = diffAccounts(accountKeys, preAccounts, value.accounts ?? null);
  const postBalances = (value.accounts ?? []).map((a, i) => a?.lamports ?? preBalances[i] ?? 0);
  const innerInstructions = mapInnerInstructions((value as any).innerInstructions);

  const returnData =
    value.returnData && value.returnData.data
      ? {
          programId: value.returnData.programId,
          data: Array.isArray(value.returnData.data)
            ? value.returnData.data[0]
            : value.returnData.data,
        }
      : null;

  const serialized =
    tx instanceof VersionedTransaction
      ? Buffer.from(tx.serialize())
      : Buffer.from(
          (tx as Transaction).serialize({ requireAllSignatures: false, verifySignatures: false })
        );
  const signature = syntheticSignature(serialized);

  const bundle: RawTransactionBundle = {
    signature,
    slot: sim.context?.slot ?? 0,
    blockTime: Math.floor(Date.now() / 1000),
    transaction: {
      message: {
        accountKeys: accountKeysAsStrings,
        instructions,
        recentBlockhash,
      },
      signatures: [],
    },
    logMessages: value.logs ?? [],
    preBalances,
    postBalances,
    preTokenBalances: [],
    postTokenBalances: [],
    innerInstructions,
    computeUnitsConsumed: value.unitsConsumed ?? null,
    fee: 5000,
    err: value.err ?? null,
    accountKeys: accountKeysAsStrings,
    rawResponse: undefined,
  };

  const meta: SimulationMeta = {
    inputKind: kind,
    source,
    success: !value.err,
    errorJson: value.err ? JSON.stringify(value.err) : null,
    returnData,
    rawResponse: value,
    accountChanges,
    isSimulated: true,
    runnerMeta,
  };

  return { bundle, meta };
}

/** accountDiff short explanation:
 * Builds per-account balance diffs for a Solana transaction.
 *
 * It computes:
 * - SOL deltas in lamports (postBalances - preBalances)
 * - Token deltas by account and mint (postTokenBalances - preTokenBalances)
 * - Account role labels (signer, writable, readonly)
 *
 * Returns only accounts with changes, sorted by role importance.
 */

import type { AccountDiff, RawTransactionBundle, TokenBalance, TokenDelta } from './types.js';
import BigNumber from 'bignumber.js';

// Minimal shape from Solana message header needed to infer account roles.
type MessageHeaderLike = {
  numRequiredSignatures: number;
  numReadonlySignedAccounts: number;
  numReadonlyUnsignedAccounts: number;
};

// Extracts and validates message header fields from an unknown transaction payload.
function getHeaderFromTransaction(transaction: unknown): MessageHeaderLike | null {
  if (!transaction || typeof transaction !== 'object') {
    return null;
  }

  const txRecord = transaction as Record<string, unknown>;
  const message = txRecord.message;

  if (!message || typeof message !== 'object') {
    return null;
  }

  const messageRecord = message as Record<string, unknown>;
  const header = messageRecord.header;

  if (!header || typeof header !== 'object') {
    return null;
  }

  const headerRecord = header as Record<string, unknown>;
  const numRequiredSignatures = headerRecord.numRequiredSignatures;
  const numReadonlySignedAccounts = headerRecord.numReadonlySignedAccounts;
  const numReadonlyUnsignedAccounts = headerRecord.numReadonlyUnsignedAccounts;

  if (
    typeof numRequiredSignatures !== 'number' ||
    typeof numReadonlySignedAccounts !== 'number' ||
    typeof numReadonlyUnsignedAccounts !== 'number'
  ) {
    return null;
  }

  return {
    numRequiredSignatures,
    numReadonlySignedAccounts,
    numReadonlyUnsignedAccounts,
  };
}

function getAccountRole(
  accountIndex: number,
  totalAccounts: number,
  header: MessageHeaderLike | null
): AccountDiff['role'] {
  // Fallback when the transaction header is missing/invalid: we cannot infer readonly
  // boundaries, so we treat the first account as signer (fee payer in most cases)
  // and the remaining changed accounts as writable.
  if (!header) {
    return accountIndex === 0 ? 'signer' : 'writable';
  }

  const { numRequiredSignatures, numReadonlyUnsignedAccounts } = header;

  // All required-signature accounts are signers. Readonly signer info is not represented
  // in AccountDiff role and therefore collapses to "signer".
  if (accountIndex < numRequiredSignatures) {
    return 'signer';
  }

  // Unsigned accounts are split into writable first, then readonly unsigned accounts.
  const unsignedAccounts = Math.max(totalAccounts - numRequiredSignatures, 0);
  const unsignedWritableCount = Math.max(unsignedAccounts - numReadonlyUnsignedAccounts, 0);
  const firstReadonlyUnsignedIndex = numRequiredSignatures + unsignedWritableCount;

  if (accountIndex < firstReadonlyUnsignedIndex) {
    return 'writable';
  }

  return 'readonly';
}

function parseRawTokenAmount(tokenBalance: TokenBalance): bigint {
  const rawAmount = tokenBalance.uiTokenAmount?.amount;

  if (!rawAmount) {
    return 0n;
  }

  try {
    return BigInt(rawAmount);
  } catch {
    return 0n;
  }
}

function buildTokenKey(accountIndex: number, mint: string): string {
  return `${accountIndex}:${mint}`;
}

// Computes token deltas by matching pre/post balances using (accountIndex + mint).
function getTokenDeltas(bundle: RawTransactionBundle): Map<number, TokenDelta[]> {
  const preTokenBalances = bundle.preTokenBalances ?? [];
  const postTokenBalances = bundle.postTokenBalances ?? [];

  const preMap = new Map<string, TokenBalance>();
  const postMap = new Map<string, TokenBalance>();

  for (const balance of preTokenBalances) {
    preMap.set(buildTokenKey(balance.accountIndex, balance.mint), balance);
  }

  for (const balance of postTokenBalances) {
    postMap.set(buildTokenKey(balance.accountIndex, balance.mint), balance);
  }

  const allKeys = new Set([...preMap.keys(), ...postMap.keys()]);
  const tokenDeltaByAccount = new Map<number, TokenDelta[]>();

  for (const key of allKeys) {
    const pre = preMap.get(key);
    const post = postMap.get(key);

    const accountIndex = post?.accountIndex ?? pre?.accountIndex;
    const mint = post?.mint ?? pre?.mint;

    if (typeof accountIndex !== 'number' || !mint) {
      continue;
    }

    const preRaw = pre ? parseRawTokenAmount(pre) : 0n;
    const postRaw = post ? parseRawTokenAmount(post) : 0n;
    const rawDelta = postRaw - preRaw;

    if (rawDelta === 0n) {
      continue;
    }

    const decimals = post?.uiTokenAmount?.decimals ?? pre?.uiTokenAmount?.decimals ?? 0;
    // Use BigNumber to avoid precision loss with large token amounts.
    const uiDelta = new BigNumber(rawDelta.toString())
      .dividedBy(new BigNumber(10).pow(decimals))
      .toNumber();

    const tokenDelta: TokenDelta = {
      mint,
      decimals,
      rawDelta: rawDelta.toString(),
      uiDelta,
    };

    const existing = tokenDeltaByAccount.get(accountIndex) ?? [];
    existing.push(tokenDelta);
    tokenDeltaByAccount.set(accountIndex, existing);
  }

  for (const deltas of tokenDeltaByAccount.values()) {
    // Keep deterministic output for tests and consumers.
    deltas.sort((a, b) => a.mint.localeCompare(b.mint));
  }

  return tokenDeltaByAccount;
}

const rolePriority: Record<AccountDiff['role'], number> = {
  signer: 0,
  writable: 1,
  readonly: 2,
};

export function computeAccountDiffs(bundle: RawTransactionBundle): AccountDiff[] {
  const accountKeys = bundle.accountKeys ?? [];
  const preBalances = bundle.preBalances ?? [];
  const postBalances = bundle.postBalances ?? [];

  // Covers cases where fixture/input arrays may be partially inconsistent.
  const totalAccounts = Math.max(accountKeys.length, preBalances.length, postBalances.length);
  const header = getHeaderFromTransaction(bundle.transaction);
  const tokenDeltaByAccount = getTokenDeltas(bundle);

  // Versioned (v0) transactions append address-lookup-table accounts AFTER the
  // static keys, but the message header only describes the static keys. Use the
  // RPC's authoritative meta.loadedAddresses for loaded accounts, and apply the
  // header/index inference only across the static range (Jelleo F06).
  const loaded = (bundle as { loadedAddresses?: { writable?: string[]; readonly?: string[] } })
    .loadedAddresses;
  const loadedWritable = new Set<string>(loaded?.writable ?? []);
  const loadedReadonly = new Set<string>(loaded?.readonly ?? []);
  const staticCount = Math.max(
    totalAccounts - loadedWritable.size - loadedReadonly.size,
    0
  );
  const roleFor = (index: number, pubkey: string): AccountDiff['role'] => {
    if (loadedWritable.has(pubkey)) return 'writable';
    if (loadedReadonly.has(pubkey)) return 'readonly';
    return getAccountRole(index, staticCount, header);
  };

  const diffs: Array<AccountDiff & { _index: number }> = [];

  for (let index = 0; index < totalAccounts; index += 1) {
    const preSol = preBalances[index] ?? 0;
    const postSol = postBalances[index] ?? 0;
    const solDelta = postSol - preSol;
    const tokenDeltas = tokenDeltaByAccount.get(index) ?? [];

    // Emit only accounts with effective changes.
    if (solDelta === 0 && tokenDeltas.length === 0) {
      continue;
    }

    const pubkey = accountKeys[index] ?? `unknown-account-${index}`;
    diffs.push({
      _index: index,
      pubkey,
      role: roleFor(index, pubkey),
      solDelta,
      tokenDeltas,
    });
  }

  diffs.sort((a, b) => {
    // Primary order by role importance, stable fallback by original account index.
    const roleDiff = rolePriority[a.role] - rolePriority[b.role];
    if (roleDiff !== 0) {
      return roleDiff;
    }
    return a._index - b._index;
  });

  return diffs.map(({ _index, ...diff }) => diff);
}

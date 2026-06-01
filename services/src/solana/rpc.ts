import { getConnection, withRetry } from './connection.js';
import { RawTransactionBundle } from '../analysis/types.js';

/**
 * Fetches a transaction from the Solana blockchain and maps it to a RawTransactionBundle.
 * Includes defensive checks to ensure arrays are never undefined.
 */
export const fetchTransaction = async (
  signature: string,
  network: 'mainnet' | 'devnet' = 'devnet'
): Promise<RawTransactionBundle> => {
  const connection = getConnection(undefined, network);

  const tx = await withRetry(() =>
    connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    })
  );

  // A null result means the RPC has no record of this signature (not found,
  // not yet confirmed, or simply invalid). Surface it as a clean error.
  if (!tx) {
    throw new Error(`failed to get transaction: ${signature}`);
  }

  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    transaction: tx.transaction,
    // Using || [] ensures the "default arrays" test passes even if meta is missing
    logMessages: tx.meta?.logMessages || [],
    computeUnitsConsumed: tx.meta?.computeUnitsConsumed ?? null,
    fee: tx.meta?.fee ?? 0,
    preBalances: tx.meta?.preBalances || [],
    postBalances: tx.meta?.postBalances || [],
    preTokenBalances: tx.meta?.preTokenBalances || [],
    postTokenBalances: tx.meta?.postTokenBalances || [],
    innerInstructions: tx.meta?.innerInstructions || [],
    err: tx.meta?.err || null,
    accountKeys: tx.transaction.message.accountKeys.map((key) =>
      typeof key === 'string' ? key : key.pubkey.toBase58()
    ),
    rawResponse: tx,
  };
};

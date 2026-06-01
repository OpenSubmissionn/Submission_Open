import { Connection, ConnectionConfig } from '@solana/web3.js';
import * as dotenv from 'dotenv';

dotenv.config();

// URLs de conexão
const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL;
const DEVNET_RPC_URL = 'https://api.devnet.solana.com';
const MAINNET_RPC_URL = 'https://api.mainnet-beta.solana.com';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF = 1000;

/**
 * Retorna uma instância de conexão com a Solana.
 * Prioridade: 1. URL customizada | 2. Helius RPC | 3. Public RPC (Fallback )
 */
export const getConnection = (
  rpcUrl?: string,
  network: 'mainnet' | 'devnet' = 'devnet'
): Connection => {
  // Aqui está a lógica de fallback que faltava
  const url =
    rpcUrl || HELIUS_RPC_URL || (network === 'mainnet' ? MAINNET_RPC_URL : DEVNET_RPC_URL);

  const config: ConnectionConfig = {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
  };

  return new Connection(url, config);
};

/**
 * Classify an error as worth retrying. Terminal conditions — invalid input,
 * not-found, auth failures — can never succeed on a retry, so retrying them
 * just triples upstream RPC cost and latency (MED-05). Network blips, timeouts,
 * 429s and 5xx are transient and worth a backoff.
 */
export const isRetryableError = (error: any): boolean => {
  const code = error?.code ?? error?.status ?? error?.statusCode;

  // JSON-RPC: invalid request / method-not-found / invalid params are terminal.
  if (code === -32600 || code === -32601 || code === -32602) return false;
  // HTTP terminal statuses (bad request / auth / not found / unprocessable).
  if (typeof code === 'number' && [400, 401, 403, 404, 422].includes(code)) return false;

  const msg = (error?.message ?? String(error ?? '')).toLowerCase();
  const terminalPatterns = [
    'invalid param',
    'invalid signature',
    'invalid public key',
    'invalid base58',
    'not found',
    'unauthorized',
    'forbidden',
    'bad request',
  ];
  if (terminalPatterns.some((p) => msg.includes(p))) return false;

  return true;
};

/**
 * Executa uma função com lógica de retry e backoff exponencial.
 * Retries only transient errors; terminal errors throw immediately.
 */
export const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
  let lastError: any;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // Don't burn retries (and upstream quota) on errors that can't recover.
      if (!isRetryableError(error)) throw error;
      // No need to sleep after the final attempt — we're about to give up.
      if (attempt < MAX_RETRIES - 1) {
        const backoff = INITIAL_BACKOFF * Math.pow(2, attempt);
        console.warn(`Attempt ${attempt + 1} failed. Retrying in ${backoff}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  throw lastError;
};

import type { AnalysisResult, ApiErrorBody, LatestTx, Network } from './types';

// Same-origin by default. Set NEXT_PUBLIC_API_BASE_URL when the client is
// served from a different origin than the /api functions during the migration.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

function friendlyMessage(status: number, raw: string): string {
  const lower = raw.toLowerCase();
  if (status === 400) {
    if (lower.includes('signature')) {
      return 'Assinatura inválida. Confira se você colou a assinatura completa da transação.';
    }
    return 'Requisição inválida. Verifique os dados e tente novamente.';
  }
  if (status === 404) return 'Transação não encontrada nessa rede.';
  if (status === 429) return 'Muitas requisições em sequência. Aguarde alguns segundos e tente de novo.';
  if (status >= 500) {
    if (lower.includes('not found') || lower.includes('não')) {
      return 'Transação não encontrada. Ela pode ainda não ter sido confirmada ou estar em outra rede.';
    }
    return 'Não foi possível analisar a transação agora. Tente novamente em instantes.';
  }
  return raw || 'Ocorreu um erro inesperado ao falar com o servidor.';
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>;
    return typeof body?.error === 'string' ? body.error : '';
  } catch {
    return '';
  }
}

export function isValidSignature(signature: string): boolean {
  const trimmed = signature.trim();
  return trimmed.length === 87 || trimmed.length === 88;
}

export async function analyzeTransaction(
  signature: string,
  network: Network = 'mainnet',
): Promise<AnalysisResult> {
  const trimmed = signature.trim();
  if (!trimmed) {
    throw new ApiRequestError('Cole uma assinatura de transação para analisar.', 400);
  }
  if (!isValidSignature(trimmed)) {
    throw new ApiRequestError(
      'Assinatura inválida. Uma assinatura Solana tem 87 ou 88 caracteres.',
      400,
    );
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: trimmed, network }),
    });
  } catch {
    throw new ApiRequestError(
      'Sem conexão com o servidor. Verifique sua internet e tente novamente.',
      0,
    );
  }

  if (!res.ok) {
    const raw = await readError(res);
    throw new ApiRequestError(friendlyMessage(res.status, raw), res.status);
  }

  return (await res.json()) as AnalysisResult;
}

export async function getLatestTx(): Promise<LatestTx> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/latest-tx`, { method: 'GET' });
  } catch {
    throw new ApiRequestError(
      'Sem conexão com o servidor. Verifique sua internet e tente novamente.',
      0,
    );
  }

  if (!res.ok) {
    const raw = await readError(res);
    throw new ApiRequestError(friendlyMessage(res.status, raw), res.status);
  }

  return (await res.json()) as LatestTx;
}

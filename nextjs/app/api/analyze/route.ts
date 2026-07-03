import { NextRequest, NextResponse } from 'next/server';
import { analyze } from '@/lib/server/analyze';
import { redactSecrets } from '@/lib/server/redact';

// The analysis pipeline pulls in @solana/web3.js + anchor and can take a few
// seconds, so pin to the Node.js runtime (not Edge) with a longer budget —
// mirrors the old api/analyze.ts function config (maxDuration 60).
export const runtime = 'nodejs';
export const maxDuration = 60;

function isValidSignature(sig: string): boolean {
  return sig.length === 87 || sig.length === 88;
}

async function run(signature: string, network: string) {
  const sig = signature.trim();
  if (!sig || !isValidSignature(sig)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }
  if (network !== 'mainnet' && network !== 'devnet') {
    return NextResponse.json({ error: 'invalid network' }, { status: 400 });
  }
  try {
    const t0 = Date.now();
    const result = await analyze(sig, network as 'mainnet' | 'devnet');
    const tookMs = Date.now() - t0;
    console.log(`[analyze] ${sig.slice(0, 8)}…  ${tookMs}ms`);
    return NextResponse.json({ ...result, tookMs });
  } catch (e) {
    // Redact the Helius api-key (embedded in the RPC URL) before it reaches the
    // client or the logs — a failing RPC call would otherwise leak the key.
    const message = redactSecrets(e instanceof Error ? e.message : String(e));
    console.error('[analyze] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: { signature?: string; network?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  return run(body.signature ?? '', body.network ?? 'mainnet');
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  return run(params.get('signature') ?? '', params.get('network') ?? 'mainnet');
}

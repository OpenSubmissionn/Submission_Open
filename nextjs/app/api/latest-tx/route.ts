import { NextResponse } from 'next/server';
import { getLatestTx } from '@/lib/server/analyze';
import { redactSecrets } from '@/lib/server/redact';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const result = await getLatestTx();
    return NextResponse.json(result);
  } catch (e) {
    const message = redactSecrets(e instanceof Error ? e.message : String(e));
    console.error('[latest-tx] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

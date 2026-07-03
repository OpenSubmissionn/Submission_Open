import { NextResponse } from 'next/server';
import { getLatestTx } from '@/lib/server/analyze';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const result = await getLatestTx();
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[latest-tx] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

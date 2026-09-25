import { NextResponse } from 'next/server';
import { getMarket } from '../../../lib/queries.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/regions → US + all states with the latest prices for every grade
export async function GET() {
  try {
    const data = await getMarket();
    return NextResponse.json(data, { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=86400' } });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}


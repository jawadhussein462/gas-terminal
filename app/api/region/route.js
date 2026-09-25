import { NextResponse } from 'next/server';
import { getRegion } from '../../../lib/queries.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/region?code=TX → latest table for all grades, record highs, metro areas
export async function GET(request) {
  const code = (request.nextUrl.searchParams.get('code') || 'US').slice(0, 80);
  try {
    const data = await getRegion(code);
    if (!data) return NextResponse.json({ error: 'Region not found' }, { status: 404 });
    return NextResponse.json(data, { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=86400' } });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

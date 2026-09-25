import { NextResponse } from 'next/server';
import { getStatus } from '../../../lib/queries.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/status → last scraper runs + database totals
export async function GET() {
  try {
    const data = await getStatus(10);
    return NextResponse.json(data, { headers: { 'Cache-Control': 'public, s-maxage=60' } });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

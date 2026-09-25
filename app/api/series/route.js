import { NextResponse } from 'next/server';
import { getSeries } from '../../../lib/queries.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/series?region=US&grade=regular → [{ time: 'YYYY-MM-DD', value, source }]
export async function GET(request) {
  const sp = request.nextUrl.searchParams;
  const region = (sp.get('region') || 'US').slice(0, 80);
  const grade = (sp.get('grade') || 'regular').toLowerCase();
  try {
    const points = await getSeries(region, grade);
    return NextResponse.json(
      { region, grade, points },
      { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=86400' } },
    );
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 400 });
  }
}

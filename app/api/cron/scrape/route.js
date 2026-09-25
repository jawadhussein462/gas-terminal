import { NextResponse } from 'next/server';
import { runScrape } from '../../../../lib/run-scrape.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // seconds (max on Vercel Hobby with Fluid compute)

// Vercel Cron calls this once a day (see vercel.json) with
// "Authorization: Bearer $CRON_SECRET". You can also trigger it by hand:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/scrape
//   or open https://your-app.vercel.app/api/cron/scrape?secret=YOUR_CRON_SECRET
export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    const key = request.nextUrl.searchParams.get('secret');
    if (auth !== `Bearer ${secret}` && key !== secret) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
  }

  const isCron = (request.headers.get('user-agent') || '').includes('vercel-cron');
  const lines = [];
  try {
    const result = await runScrape({ trigger: isCron ? 'vercel-cron' : 'http', log: (m) => lines.push(m) });
    return NextResponse.json({ ...result, log: lines }, { status: result.ok ? 200 : 502 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err.message || err), log: lines }, { status: 500 });
  }
}

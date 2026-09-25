#!/usr/bin/env node
// Run the scraper from your computer or from GitHub Actions.
//   npm run scrape        → scrape + save to DATABASE_URL
//   npm run scrape:dry    → scrape only, print a summary (no database needed)
import { readFileSync, existsSync } from 'node:fs';

// Minimal .env.local / .env loader (no dependency)
for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const dry = process.argv.includes('--dry');
const log = (msg) => console.log(`[scrape] ${msg}`);

if (dry) {
  const { scrapeAll } = await import('../lib/scraper.js');
  const r = await scrapeAll({ log });
  console.log(JSON.stringify({
    asOf: r.asOf,
    pages: r.pages,
    regions: r.regions.length,
    metros: r.regions.filter((x) => x.type === 'metro').length,
    tables: r.tables.length,
    records: r.records,
    national: r.tables.filter((t) => t.region === 'US'),
    errors: r.errors,
  }, null, 2));
  process.exit(r.tables.length ? 0 : 1);
} else {
  const { runScrape } = await import('../lib/run-scrape.js');
  const r = await runScrape({ trigger: process.env.GITHUB_ACTIONS ? 'github-actions' : 'cli', log });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

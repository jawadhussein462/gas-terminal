// Integration test against a local Postgres through psql (skipped when psql / PGDATABASE isn't available).
// Run: PGHOST=localhost PGUSER=... PGPASSWORD=... PGDATABASE=... npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { __setQueryFn } from '../lib/db.js';
import { runScrape } from '../lib/run-scrape.js';
import { getMarket, getRegion, getSeries, getStatus } from '../lib/queries.js';

const enabled = !!process.env.PGDATABASE && spawnSync('psql', ['--version']).status === 0;

function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}
function psqlQuery(text, params) {
  let sql = text.replace(/\$(\d+)/g, (_, n) => {
    const v = params[Number(n) - 1];
    return Array.isArray(v) ? `'{${v.map((x) => (x == null ? 'NULL' : `"${String(x).replace(/["\\]/g, '\\$&').replace(/'/g, "''")}"`)).join(',')}}'` : lit(v);
  });
  const returnsRows = /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
  if (returnsRows) sql = `WITH __t AS (${sql}) SELECT coalesce(json_agg(__t), '[]'::json) FROM __t`;
  const r = spawnSync('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${r.stderr}\n--- SQL ---\n${sql.slice(0, 2000)}`);
  return returnsRows ? JSON.parse(r.stdout.trim()) : [];
}

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
function mockFetch(dayShift = null) {
  return async (url) => {
    let body;
    if (url.endsWith('aaa.com/')) body = fx('home.html');
    else if (url.includes('state-gas-price-averages')) body = fx('state-averages.html');
    else if (url.includes('state=TX')) body = fx('state-TX.html');
    else return new Response('nope', { status: 403 });
    if (dayShift) body = dayShift(body);
    return new Response(body, { status: 200 });
  };
}

test('scrape → database → API queries', { skip: !enabled && 'no local Postgres' }, async () => {
  __setQueryFn(psqlQuery);
  psqlQuery('DROP TABLE IF EXISTS prices, snapshots, records, scrape_runs, regions CASCADE');

  const states = [{ code: 'TX', name: 'Texas' }, { code: 'CA', name: 'California' }];
  const r1 = await runScrape({ trigger: 'test', states, fetchImpl: mockFetch(), delayMs: 0 });
  assert.equal(r1.ok, true);
  assert.equal(r1.status, 'partial'); // CA page failed → fallback used
  assert.equal(r1.asOf, '2026-09-25');

  // Day 2: AAA page now says 9/26 and regular went to 4.5100; "yesterday" column = 4.4918
  const day2 = (html) => html.replace('9/25/26', '9/26/26').replace('$4.4918', '$4.5100').replace('$4.4825', '$4.4918');
  const r2 = await runScrape({ trigger: 'test', states, fetchImpl: mockFetch(day2), delayMs: 0 });
  assert.equal(r2.asOf, '2026-09-26');

  const series = await getSeries('US', 'regular');
  const byDate = Object.fromEntries(series.map((p) => [p.time, p]));
  assert.equal(byDate['2026-09-26'].value, 4.51);
  assert.equal(byDate['2026-09-26'].source, 'observed');
  assert.equal(byDate['2026-09-25'].value, 4.4918);
  assert.equal(byDate['2026-09-25'].source, 'observed'); // stays observed, not overwritten by derived
  assert.equal(byDate['2025-09-25'].value, 3.1579);
  assert.ok(series.length >= 8);
  assert.deepEqual(series.map((p) => p.time), [...series.map((p) => p.time)].sort());

  const market = await getMarket();
  assert.equal(market.asOf, '2026-09-26');
  assert.equal(market.regions[0].code, 'US');
  assert.equal(market.regions[0].grades.regular.current, 4.51);
  assert.equal(market.regions.find((x) => x.code === 'CA').grades.regular.current, 6.2882);

  const tx = await getRegion('TX');
  assert.equal(tx.metros.length, 4);
  assert.equal(tx.records.regular.price, 4.6949);
  assert.equal(tx.records.regular.date, '2022-06-15');
  assert.equal(tx.grades.diesel.current, 5.9196);
  assert.equal(tx.parent.code, 'US');

  const metro = await getRegion('TX-houston');
  assert.equal(metro.type, 'metro');
  assert.equal(metro.parent.code, 'TX');
  const ms = await getSeries('TX-houston', 'regular');
  assert.ok(ms.length >= 5);

  const status = await getStatus();
  assert.equal(status.runs.length, 2);
  assert.equal(status.runs[0].status, 'partial');
  assert.ok(status.counts.price_rows > 50);

  await assert.rejects(() => getSeries('US', 'kerosene'));
});

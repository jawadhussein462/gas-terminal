import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseRegionPage, parseStateAverages, periodDate, shiftDate, slugify,
} from '../lib/aaa-parser.js';
import { scrapeAll } from '../lib/scraper.js';
import { toPricePoints } from '../lib/store.js';
import { toCandles, sma } from '../lib/candles.js';
import { STATE_BY_NAME } from '../lib/states.js';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('national page', () => {
  const p = parseRegionPage(fx('home.html'), { isNational: true });
  assert.equal(p.asOf, '2026-09-25');
  assert.deepEqual(p.main.regular, { current: 4.4918, yesterday: 4.4825, week_ago: 4.4687, month_ago: 4.0969, year_ago: 3.1579 });
  assert.equal(p.main.e85.current, 3.4641);
  assert.equal(p.main.diesel.year_ago, 3.689);
  assert.deepEqual(p.records, [
    { grade: 'regular', price: 5.0165, date: '2022-06-14' },
    { grade: 'diesel', price: 6.5276, date: '2026-09-22' },
  ]);
  assert.equal(Object.keys(p.main).length, 5);
});

test('state page with metros', () => {
  const p = parseRegionPage(fx('state-TX.html'), { expectCurrentRegular: 3.9529 });
  assert.equal(p.main.regular.current, 3.9529);
  assert.equal(p.main.diesel.year_ago, 3.1882);
  assert.equal(p.main.e85, undefined);
  assert.deepEqual(p.metros.map((m) => m.name), ['Amarillo', 'Austin-San Marcos', 'Houston', 'Texarkana (TX only)']);
  assert.equal(p.metros[2].grid.regular.current, 3.9228);
  assert.deepEqual(p.records, [
    { grade: 'regular', price: 4.6949, date: '2022-06-15' },
    { grade: 'diesel', price: 5.9797, date: '2026-09-19' },
  ]);
});

test('variant layout: transposed tables, national table first, non-heading titles', () => {
  const p = parseRegionPage(fx('variant-TX.html'), { expectCurrentRegular: 3.9529 });
  assert.equal(p.main.regular.current, 3.9529);
  assert.equal(p.main.diesel.week_ago, 5.9785);
  assert.deepEqual(p.metros.map((m) => m.name), ['Dallas & Fort Worth']);
  // Without the hint it should still skip the "National" table
  const p2 = parseRegionPage(fx('variant-TX.html'));
  assert.equal(p2.main.regular.current, 3.9529);
});

test('state averages page', () => {
  const a = parseStateAverages(fx('state-averages.html'), STATE_BY_NAME);
  assert.equal(a.asOf, '2026-09-25');
  assert.deepEqual(Object.keys(a.states), ['AK', 'CA', 'TX', 'DC']);
  assert.deepEqual(a.states.CA, { name: 'California', regular: 6.2882, midgrade: 6.5044, premium: 6.7024, diesel: 8.4385 });
});

test('date helpers', () => {
  assert.equal(shiftDate('2026-03-31', -1, 'month'), '2026-02-28');
  assert.equal(shiftDate('2024-02-29', -1, 'year'), '2023-02-28');
  assert.equal(periodDate('2026-09-25', 'week_ago'), '2026-09-18');
  assert.equal(periodDate('2026-01-01', 'yesterday'), '2025-12-31');
  assert.equal(slugify('Texarkana (TX only)'), 'texarkana-tx-only');
});

test('scrapeAll end-to-end with mocked fetch (incl. one failing state)', async () => {
  const fetchImpl = async (url) => {
    let body;
    if (url.endsWith('aaa.com/')) body = fx('home.html');
    else if (url.includes('state-gas-price-averages')) body = fx('state-averages.html');
    else if (url.includes('state=TX')) body = fx('state-TX.html');
    else return new Response('blocked', { status: 403 });
    return new Response(body, { status: 200 });
  };
  const r = await scrapeAll({
    states: [{ code: 'TX', name: 'Texas' }, { code: 'CA', name: 'California' }],
    fetchImpl, delayMs: 0,
  });
  assert.equal(r.asOf, '2026-09-25');
  assert.equal(r.regions.filter((x) => x.type === 'metro').length, 4);
  assert.ok(r.regions.find((x) => x.code === 'TX-houston'));
  // CA page "blocked" → fallback to averages page current prices
  const ca = r.tables.filter((t) => t.region === 'CA');
  assert.equal(ca.length, 4);
  assert.equal(ca.find((t) => t.grade === 'regular').current, 6.2882);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].page, 'CA');
});

test('scrapeAll retries HTTP 429 instead of skipping the state', async () => {
  let txHits = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('aaa.com/')) return new Response(fx('home.html'), { status: 200 });
    if (url.includes('state-gas-price-averages')) return new Response(fx('state-averages.html'), { status: 200 });
    if (url.includes('state=TX')) {
      txHits += 1;
      if (txHits < 3) return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
      return new Response(fx('state-TX.html'), { status: 200 });
    }
    return new Response('blocked', { status: 403 });
  };
  const r = await scrapeAll({
    states: [{ code: 'TX', name: 'Texas' }],
    fetchImpl,
    delayMs: 0,
    sleepImpl: async () => {},
  });
  assert.equal(txHits, 3);
  assert.equal(r.errors.length, 0);
  assert.ok(r.regions.find((x) => x.code === 'TX-houston'));
});

test('price points: current is observed, other columns are back-filled', () => {
  const pts = toPricePoints('2026-09-25', [
    { region: 'US', grade: 'regular', current: 4.49, yesterday: 4.48, week_ago: 4.47, month_ago: 4.1, year_ago: 3.16 },
  ]);
  assert.deepEqual(pts.map((p) => [p.date, p.source]), [
    ['2026-09-25', 'observed'], ['2026-09-24', 'derived'], ['2026-09-18', 'derived'], ['2026-08-25', 'derived'], ['2025-09-25', 'derived'],
  ]);
});

test('candles', () => {
  const pts = [
    { time: '2026-09-21', value: 4.0 }, // Mon
    { time: '2026-09-22', value: 4.2 },
    { time: '2026-09-23', value: 4.1 },
    { time: '2026-09-28', value: 4.3 }, // next Mon
    { time: '2026-10-01', value: 4.25 },
  ];
  const d = toCandles(pts, 'D');
  assert.deepEqual(d[1], { time: '2026-09-22', open: 4.0, high: 4.2, low: 4.0, close: 4.2 });
  assert.deepEqual(d[0], { time: '2026-09-21', open: 4.0, high: 4.0, low: 4.0, close: 4.0 });
  const w = toCandles(pts, 'W');
  assert.equal(w.length, 2);
  assert.deepEqual(w[1], { time: '2026-09-28', open: 4.1, high: 4.3, low: 4.1, close: 4.25 });
  const m = toCandles(pts, 'M');
  assert.deepEqual(m.map((c) => c.time), ['2026-09-01', '2026-10-01']);
  assert.equal(m[1].open, 4.3);
  const ma = sma(d, 2);
  assert.equal(ma.length, 4);
  assert.equal(ma[0].value, 4.1);
});

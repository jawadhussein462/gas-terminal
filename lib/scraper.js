// Fetches every page on gasprices.aaa.com that carries price data and turns it
// into plain records. Does not touch the database (see store.js).
import {
  parseRegionPage, parseStateAverages, slugify, PERIODS,
} from './aaa-parser.js';
import { STATES, STATE_BY_NAME } from './states.js';

export const BASE_URL = 'https://gasprices.aaa.com/';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(res) {
  const raw = res.headers?.get?.('retry-after');
  if (raw == null || raw === '') return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return secs * 1000;
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return when - Date.now();
  return null;
}

// Honor Retry-After when AAA sends one. Otherwise wait 8s, 16s, 32s, then 60s.
function rateLimitWait(attempt, headerMs) {
  if (headerMs != null && Number.isFinite(headerMs)) {
    return Math.min(60_000, Math.max(2_000, headerMs));
  }
  return Math.min(60_000, 8_000 * 2 ** attempt);
}

// One page at a time, with a gap after each response so a burst cannot trip AAA's limiter.
function createGate(minIntervalMs, sleepImpl) {
  let tail = Promise.resolve();
  let lastDone = 0;
  return function run(fn) {
    const prev = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    return prev.then(async () => {
      try {
        if (minIntervalMs > 0) {
          const wait = lastDone + minIntervalMs - Date.now();
          if (wait > 0) await sleepImpl(wait);
        }
        return await fn();
      } finally {
        lastDone = Date.now();
        release();
      }
    });
  };
}

export async function fetchHtml(url, {
  retries = 2,
  rateLimitRetries = 5,
  timeoutMs = 20000,
  fetchImpl = fetch,
  sleepImpl = sleep,
  onRetry = () => {},
} = {}) {
  let netTries = 0;
  let rateHits = 0;
  for (;;) {
    try {
      const res = await fetchImpl(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status === 503) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        if (rateHits >= rateLimitRetries) throw Object.assign(err, { noRetry: true });
        const wait = rateLimitWait(rateHits, retryAfterMs(res));
        rateHits += 1;
        onRetry({ url, status: res.status, wait, attempt: rateHits, max: rateLimitRetries });
        await sleepImpl(wait);
        continue;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        if (res.status >= 400 && res.status < 500) err.noRetry = true;
        throw err;
      }
      const html = await res.text();
      if (html.length < 2000) throw new Error(`Suspiciously small page (${html.length} bytes) for ${url}`);
      return html;
    } catch (err) {
      if (err.noRetry || netTries >= retries) throw err;
      netTries += 1;
      await sleepImpl(1500 * netTries);
    }
  }
}

async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

function todayInNewYork() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

/**
 * Scrape everything.
 * @returns {{ asOf, regions, tables, records, pages, errors }}
 *   regions: [{code, name, type, parent}]
 *   tables:  [{region, grade, current, yesterday, week_ago, month_ago, year_ago}]
 *   records: [{region, grade, price, date}]
 */
export async function scrapeAll({
  states = STATES, concurrency = 1, delayMs = 1500, log = () => {}, fetchImpl, sleepImpl = sleep,
} = {}) {
  const errors = [];
  const regions = [];
  const tables = [];
  const records = [];
  let pages = 0;
  const gate = createGate(delayMs, sleepImpl);
  const get = (url) => gate(() => fetchHtml(url, {
    fetchImpl,
    sleepImpl,
    onRetry: ({ status, wait, attempt, max }) => {
      log(`HTTP ${status} for ${url}, waiting ${Math.round(wait / 1000)}s (${attempt}/${max})`);
    },
  }));

  const addGrid = (region, grid) => {
    for (const [grade, periods] of Object.entries(grid || {})) {
      const row = { region, grade };
      for (const p of PERIODS) row[p] = periods[p] ?? null;
      if (row.current != null) tables.push(row);
    }
  };

  // 1) National page
  let asOf = null;
  try {
    const html = await get(BASE_URL);
    pages++;
    const page = parseRegionPage(html, { isNational: true });
    if (!page.main) throw new Error('No national price table found (layout changed or request blocked)');
    asOf = page.asOf;
    regions.push({ code: 'US', name: 'United States', type: 'national', parent: null });
    addGrid('US', page.main);
    for (const r of page.records) records.push({ region: 'US', ...r });
    log(`national: ${Object.keys(page.main).length} grades, as of ${page.asOf}`);
  } catch (err) {
    errors.push({ page: 'national', error: String(err.message || err) });
    log(`national FAILED: ${err.message}`);
  }

  // 2) State averages page (all states on one page — used to validate and as a fallback)
  let averages = { states: {} };
  try {
    const html = await get(`${BASE_URL}state-gas-price-averages/`);
    pages++;
    averages = parseStateAverages(html, STATE_BY_NAME);
    asOf ||= averages.asOf;
    log(`state averages: ${Object.keys(averages.states).length} states`);
  } catch (err) {
    errors.push({ page: 'state-averages', error: String(err.message || err) });
    log(`state averages FAILED: ${err.message}`);
  }

  // 3) Each state page (state table + every metro table)
  await pool(states, concurrency, async (st) => {
    const avg = averages.states[st.code];
    regions.push({ code: st.code, name: st.name, type: 'state', parent: 'US' });
    try {
      const html = await get(`${BASE_URL}?state=${st.code}`);
      pages++;
      const page = parseRegionPage(html, { expectCurrentRegular: avg?.regular ?? null });
      if (!page.main) throw new Error('No state price table found');
      asOf ||= page.asOf;
      addGrid(st.code, page.main);
      for (const r of page.records) records.push({ region: st.code, ...r });
      for (const metro of page.metros) {
        const code = `${st.code}-${slugify(metro.name)}`;
        regions.push({ code, name: metro.name, type: 'metro', parent: st.code });
        addGrid(code, metro.grid);
      }
      log(`${st.code}: ${Object.keys(page.main).length} grades, ${page.metros.length} metros`);
    } catch (err) {
      errors.push({ page: st.code, error: String(err.message || err) });
      log(`${st.code} FAILED: ${err.message}`);
      // Fallback: at least keep today's price from the averages page
      if (avg) {
        for (const g of ['regular', 'midgrade', 'premium', 'diesel', 'e85']) {
          if (avg[g] != null) tables.push({ region: st.code, grade: g, current: avg[g], yesterday: null, week_ago: null, month_ago: null, year_ago: null });
        }
      }
    }
  });

  asOf ||= todayInNewYork();

  // De-duplicate regions (a metro name can repeat inside a state)
  const seen = new Set();
  const uniqRegions = regions.filter((r) => (seen.has(r.code) ? false : seen.add(r.code)));
  const seenT = new Set();
  const uniqTables = tables.filter((t) => {
    const k = `${t.region}|${t.grade}`;
    return seenT.has(k) ? false : seenT.add(k);
  });

  return { asOf, regions: uniqRegions, tables: uniqTables, records, pages, errors };
}

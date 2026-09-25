// Read-side queries used by the API routes.
import { q, ensureSchema } from './db.js';
import { GRADES } from './states.js';

const num = (v) => (v == null ? null : Number(v));

/** Latest snapshot for the US + every state (for the watchlist / ticker). */
export async function getMarket() {
  await ensureSchema();
  const rows = await q(
    `SELECT DISTINCT ON (s.region_code, s.grade)
            r.code, r.name, r.type, s.grade, s.as_of::text AS as_of,
            s.current_avg::float8 AS current, s.yesterday::float8 AS yesterday, s.week_ago::float8 AS week_ago,
            s.month_ago::float8 AS month_ago, s.year_ago::float8 AS year_ago
       FROM snapshots s JOIN regions r ON r.code = s.region_code
      WHERE r.type IN ('national','state')
      ORDER BY s.region_code, s.grade, s.as_of DESC`,
  );
  const map = new Map();
  let asOf = null;
  for (const r of rows) {
    if (!map.has(r.code)) map.set(r.code, { code: r.code, name: r.name, type: r.type, asOf: r.as_of, grades: {} });
    const e = map.get(r.code);
    if (r.as_of > e.asOf) e.asOf = r.as_of;
    if (!asOf || r.as_of > asOf) asOf = r.as_of;
    e.grades[r.grade] = pickPeriods(r);
  }
  const regions = [...map.values()].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'national' ? -1 : 1);
  return { asOf, regions };
}

/** Everything about one region: latest table for all grades, records, metros, parent. */
export async function getRegion(code) {
  await ensureSchema();
  const [region] = await q(`SELECT code, name, type, parent_code FROM regions WHERE code = $1`, [code]);
  if (!region) return null;

  const [snap, recs, metros, parent] = await Promise.all([
    q(
      `SELECT DISTINCT ON (grade) grade, as_of::text AS as_of,
              current_avg::float8 AS current, yesterday::float8 AS yesterday, week_ago::float8 AS week_ago,
              month_ago::float8 AS month_ago, year_ago::float8 AS year_ago
         FROM snapshots WHERE region_code = $1 ORDER BY grade, as_of DESC`,
      [code],
    ),
    q(`SELECT grade, price::float8 AS price, record_date::text AS date FROM records WHERE region_code = $1`, [code]),
    region.type === 'state'
      ? q(
          `SELECT DISTINCT ON (s.region_code, s.grade) r.code, r.name, s.grade, s.as_of::text AS as_of,
                  s.current_avg::float8 AS current, s.yesterday::float8 AS yesterday, s.week_ago::float8 AS week_ago,
                  s.month_ago::float8 AS month_ago, s.year_ago::float8 AS year_ago
             FROM regions r JOIN snapshots s ON s.region_code = r.code
            WHERE r.parent_code = $1 AND r.type = 'metro'
            ORDER BY s.region_code, s.grade, s.as_of DESC`,
          [code],
        )
      : Promise.resolve([]),
    region.parent_code
      ? q(`SELECT code, name, type FROM regions WHERE code = $1`, [region.parent_code])
      : Promise.resolve([]),
  ]);

  const grades = {};
  let asOf = null;
  for (const r of snap) {
    grades[r.grade] = pickPeriods(r);
    if (!asOf || r.as_of > asOf) asOf = r.as_of;
  }
  const records = Object.fromEntries(recs.map((r) => [r.grade, { price: r.price, date: r.date }]));

  const metroMap = new Map();
  for (const r of metros) {
    if (!metroMap.has(r.code)) metroMap.set(r.code, { code: r.code, name: r.name, grades: {} });
    metroMap.get(r.code).grades[r.grade] = pickPeriods(r);
  }

  return {
    code: region.code,
    name: region.name,
    type: region.type,
    parent: parent[0] || null,
    asOf,
    grades,
    records,
    metros: [...metroMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Daily series for charting. */
export async function getSeries(code, grade) {
  if (!GRADES.includes(grade)) throw new Error(`Unknown grade "${grade}"`);
  await ensureSchema();
  const rows = await q(
    `SELECT price_date::text AS time, price::float8 AS value, source
       FROM prices WHERE region_code = $1 AND grade = $2 ORDER BY price_date`,
    [code, grade],
  );
  return rows.map((r) => ({ time: r.time, value: num(r.value), source: r.source }));
}

export async function getStatus(limit = 10) {
  await ensureSchema();
  const runs = await q(
    `SELECT id, started_at, finished_at, status, as_of::text AS as_of, pages, regions, price_rows, errors, trigger
       FROM scrape_runs ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  const [counts] = await q(
    `SELECT (SELECT count(*)::int FROM regions) AS regions,
            (SELECT count(*)::int FROM prices) AS price_rows,
            (SELECT count(DISTINCT price_date)::int FROM prices WHERE source = 'observed') AS observed_days,
            (SELECT min(price_date)::text FROM prices) AS first_date,
            (SELECT max(price_date)::text FROM prices) AS last_date`,
  );
  return { runs, counts };
}

function pickPeriods(r) {
  return {
    current: num(r.current),
    yesterday: num(r.yesterday),
    week_ago: num(r.week_ago),
    month_ago: num(r.month_ago),
    year_ago: num(r.year_ago),
  };
}

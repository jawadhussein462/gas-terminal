// Writes scraper output into Postgres.
import { q, ensureSchema } from './db.js';
import { periodDate, PERIODS } from './aaa-parser.js';

/** Turn AAA tables into daily time-series points. */
export function toPricePoints(asOf, tables) {
  const points = new Map();
  for (const t of tables) {
    for (const period of PERIODS) {
      const price = t[period];
      if (price == null) continue;
      const date = periodDate(asOf, period);
      const key = `${t.region}|${t.grade}|${date}`;
      const source = period === 'current' ? 'observed' : 'derived';
      const prev = points.get(key);
      if (!prev || (prev.source === 'derived' && source === 'observed')) {
        points.set(key, { region: t.region, grade: t.grade, date, price, source });
      }
    }
  }
  return [...points.values()];
}

export async function startRun(trigger) {
  await ensureSchema();
  const rows = await q(`INSERT INTO scrape_runs (trigger) VALUES ($1) RETURNING id`, [trigger]);
  return rows[0].id;
}

export async function finishRun(id, { status, asOf = null, pages = null, regions = null, priceRows = null, errors = [] }) {
  await q(
    `UPDATE scrape_runs
        SET finished_at = now(), status = $2, as_of = $3::date, pages = $4, regions = $5, price_rows = $6, errors = $7::jsonb
      WHERE id = $1`,
    [id, status, asOf, pages, regions, priceRows, JSON.stringify(errors)],
  );
}

export async function saveScrape(result) {
  await ensureSchema();
  const { asOf, regions, tables, records } = result;

  // Regions
  if (regions.length) {
    await q(
      `INSERT INTO regions (code, name, type, parent_code)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name, type = EXCLUDED.type, parent_code = EXCLUDED.parent_code, updated_at = now()`,
      [regions.map((r) => r.code), regions.map((r) => r.name), regions.map((r) => r.type), regions.map((r) => r.parent)],
    );
  }

  // Raw snapshots (everything AAA shows)
  if (tables.length) {
    await q(
      `INSERT INTO snapshots (region_code, grade, as_of, current_avg, yesterday, week_ago, month_ago, year_ago)
       SELECT r, g, $3::date, c, y, w, m, yr
         FROM unnest($1::text[], $2::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[])
              AS t(r, g, c, y, w, m, yr)
       ON CONFLICT (region_code, grade, as_of) DO UPDATE
         SET current_avg = EXCLUDED.current_avg, yesterday = EXCLUDED.yesterday, week_ago = EXCLUDED.week_ago,
             month_ago = EXCLUDED.month_ago, year_ago = EXCLUDED.year_ago, scraped_at = now()`,
      [
        tables.map((t) => t.region), tables.map((t) => t.grade), asOf,
        tables.map((t) => t.current), tables.map((t) => t.yesterday), tables.map((t) => t.week_ago),
        tables.map((t) => t.month_ago), tables.map((t) => t.year_ago),
      ],
    );
  }

  // Daily time series. Observed values always win over back-filled ("derived") ones.
  const points = toPricePoints(asOf, tables);
  const CHUNK = 5000;
  for (let i = 0; i < points.length; i += CHUNK) {
    const part = points.slice(i, i + CHUNK);
    await q(
      `INSERT INTO prices (region_code, grade, price_date, price, source)
       SELECT * FROM unnest($1::text[], $2::text[], $3::date[], $4::numeric[], $5::text[])
       ON CONFLICT (region_code, grade, price_date) DO UPDATE
         SET price = EXCLUDED.price, source = EXCLUDED.source, scraped_at = now()
       WHERE prices.source = 'derived' OR EXCLUDED.source = 'observed'`,
      [part.map((p) => p.region), part.map((p) => p.grade), part.map((p) => p.date), part.map((p) => p.price), part.map((p) => p.source)],
    );
  }

  // Record highs
  const recs = dedupe(records, (r) => `${r.region}|${r.grade}`);
  if (recs.length) {
    await q(
      `INSERT INTO records (region_code, grade, price, record_date)
       SELECT * FROM unnest($1::text[], $2::text[], $3::numeric[], $4::date[])
       ON CONFLICT (region_code, grade) DO UPDATE
         SET price = EXCLUDED.price, record_date = EXCLUDED.record_date, scraped_at = now()`,
      [recs.map((r) => r.region), recs.map((r) => r.grade), recs.map((r) => r.price), recs.map((r) => r.date)],
    );
  }

  return { priceRows: points.length, snapshotRows: tables.length, regionRows: regions.length, recordRows: recs.length };
}

function dedupe(arr, key) {
  const m = new Map();
  for (const x of arr) m.set(key(x), x);
  return [...m.values()];
}

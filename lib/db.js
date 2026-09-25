// Database access (Neon Postgres over HTTP — ideal for Vercel serverless functions).

let sql = null;
let queryOverride = null; // used by tests to run against a local Postgres

export function databaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
}

/** Run one SQL statement with $1..$n parameters. Returns an array of rows. */
export async function q(text, params = []) {
  if (queryOverride) return queryOverride(text, params);
  if (!sql) {
    const url = databaseUrl();
    if (!url) throw new Error('DATABASE_URL is not set. Add Neon in Vercel → Storage, or put it in .env.local');
    const { neon } = await import('@neondatabase/serverless');
    sql = neon(url);
  }
  return sql.query(text, params);
}

/** Test hook: route q() to another executor. */
export function __setQueryFn(fn) {
  queryOverride = fn;
  schemaReady = null;
}

// ---------------------------------------------------------------------------
// Schema. Created automatically (IF NOT EXISTS) on first use — no manual migration step.
// ---------------------------------------------------------------------------
export const SCHEMA = [
  // Every place AAA publishes prices for: the US, 50 states + DC, and metro areas.
  `CREATE TABLE IF NOT EXISTS regions (
     code        TEXT PRIMARY KEY,            -- 'US', 'TX', 'TX-houston'
     name        TEXT NOT NULL,
     type        TEXT NOT NULL CHECK (type IN ('national','state','metro')),
     parent_code TEXT,
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // The time series the chart draws: one price per region / grade / day.
  // source = 'observed' (AAA "Current Avg." on that day) or 'derived'
  // (back-filled from "Yesterday / Week Ago / Month Ago / Year Ago" columns).
  `CREATE TABLE IF NOT EXISTS prices (
     region_code TEXT    NOT NULL REFERENCES regions(code) ON DELETE CASCADE,
     grade       TEXT    NOT NULL,            -- regular | midgrade | premium | diesel | e85
     price_date  DATE    NOT NULL,
     price       NUMERIC(8,4) NOT NULL,
     source      TEXT    NOT NULL DEFAULT 'observed',
     scraped_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (region_code, grade, price_date)
   )`,

  // Raw copy of every AAA price table exactly as scraped (all 5 comparison columns).
  `CREATE TABLE IF NOT EXISTS snapshots (
     region_code TEXT NOT NULL REFERENCES regions(code) ON DELETE CASCADE,
     grade       TEXT NOT NULL,
     as_of       DATE NOT NULL,
     current_avg NUMERIC(8,4),
     yesterday   NUMERIC(8,4),
     week_ago    NUMERIC(8,4),
     month_ago   NUMERIC(8,4),
     year_ago    NUMERIC(8,4),
     scraped_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (region_code, grade, as_of)
   )`,

  // "Highest recorded average price" per region / grade.
  `CREATE TABLE IF NOT EXISTS records (
     region_code TEXT NOT NULL REFERENCES regions(code) ON DELETE CASCADE,
     grade       TEXT NOT NULL,
     price       NUMERIC(8,4) NOT NULL,
     record_date DATE,
     scraped_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (region_code, grade)
   )`,

  // Log of every scraper run.
  `CREATE TABLE IF NOT EXISTS scrape_runs (
     id          BIGSERIAL PRIMARY KEY,
     started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     finished_at TIMESTAMPTZ,
     status      TEXT NOT NULL DEFAULT 'running',  -- running | ok | partial | failed
     as_of       DATE,
     pages       INT,
     regions     INT,
     price_rows  INT,
     errors      JSONB,
     trigger     TEXT
   )`,

  `CREATE INDEX IF NOT EXISTS prices_date_idx ON prices (price_date)`,
  `CREATE INDEX IF NOT EXISTS regions_parent_idx ON regions (parent_code)`,
];

let schemaReady = null;
/** Creates tables once per server instance. */
export function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const stmt of SCHEMA) await q(stmt);
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

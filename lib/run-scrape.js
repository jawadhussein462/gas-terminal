// One full scrape → save cycle, with logging to scrape_runs. Used by the cron route and the CLI.
import { scrapeAll } from './scraper.js';
import { saveScrape, startRun, finishRun } from './store.js';

export async function runScrape({ trigger = 'manual', log = () => {}, ...opts } = {}) {
  const runId = await startRun(trigger);
  const started = Date.now();
  try {
    const result = await scrapeAll({ log, ...opts });
    if (!result.tables.length) {
      await finishRun(runId, { status: 'failed', asOf: result.asOf, pages: result.pages, errors: result.errors });
      return { ok: false, runId, ...summary(result), error: 'No price data scraped', errors: result.errors };
    }
    const saved = await saveScrape(result);
    const status = result.errors.length ? 'partial' : 'ok';
    await finishRun(runId, {
      status, asOf: result.asOf, pages: result.pages, regions: saved.regionRows, priceRows: saved.priceRows, errors: result.errors,
    });
    return { ok: true, status, runId, ms: Date.now() - started, ...summary(result), saved, errors: result.errors };
  } catch (err) {
    await finishRun(runId, { status: 'failed', errors: [{ page: '*', error: String(err.message || err) }] }).catch(() => {});
    throw err;
  }
}

function summary(r) {
  return {
    asOf: r.asOf,
    pages: r.pages,
    regions: r.regions.length,
    metros: r.regions.filter((x) => x.type === 'metro').length,
    tables: r.tables.length,
  };
}

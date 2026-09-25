# PumpTape — trading-style charts for US gasoline prices

A single Next.js app that runs on Vercel:

- **Backend.** Once a day, a Vercel Cron job calls `/api/cron/scrape`. It scrapes
  [gasprices.aaa.com](https://gasprices.aaa.com/) and writes the results to Neon Postgres.
- **Frontend.** A trading-terminal UI built on TradingView Lightweight Charts. It shows
  candles, area or line charts, moving averages, a US comparison line, a watchlist, a ticker
  tape, and metro tables.

## What gets scraped (about 53 pages a day)

| Page | Data |
|---|---|
| `/` (national) | Regular, Mid-Grade, Premium, Diesel and E85. Each has Current, Yesterday, Week-ago, Month-ago and Year-ago averages, plus the record highs |
| `/state-gas-price-averages/` | All 50 states + DC on one page. Used to check the state pages, and as a fallback if a state page fails |
| `/?state=XX` × 51 | The state's own table (all grades and periods), record highs, and a table for **every metro area** in the state |

### Database tables (created automatically on the first run)

| Table | Contents |
|---|---|
| `regions` | US, the states and every metro (`TX`, `TX-houston`, …) |
| `prices` | The chart's daily time series: one row per region / grade / day |
| `snapshots` | A raw copy of every AAA table on every day, with all 5 comparison columns |
| `records` | The highest recorded average price per region / grade |
| `scrape_runs` | A log of each run: status, pages, rows and errors |

**Instant history.** The first run already back-fills 5 points per series: today, yesterday,
a week ago, a month ago and a year ago. These come from AAA's comparison columns and are
stored with `source = 'derived'`. A real daily observation (`observed`) always replaces a
back-filled value.

## Deploy to Vercel (about 10 minutes)

1. **Push this folder to GitHub.**
   ```bash
   git init && git add . && git commit -m "PumpTape"
   git branch -M main
   git remote add origin https://github.com/<you>/gas-terminal.git
   git push -u origin main
   ```
2. **Import the project in Vercel.** Go to vercel.com → *Add New… → Project* and pick the repo.
   The Next.js settings are detected automatically. Click **Deploy**.
3. **Add the database.** In the project, open the **Storage** tab, click **Create Database**,
   choose **Neon (Postgres)** and connect it to the project. This sets `DATABASE_URL` for you.
4. **Add the cron secret.** Go to *Settings → Environment Variables* and add
   `CRON_SECRET`. Any long random string works (for example, the output of `openssl rand -hex 32`).
5. **Redeploy.** Go to *Deployments → … → Redeploy* so the new variables are picked up.
6. **Run the first scrape** so you don't have to wait for the cron. Open:
   ```
   https://<your-app>.vercel.app/api/cron/scrape?secret=<CRON_SECRET>
   ```
   It takes about 30–60 s and returns a JSON summary. Then open the site.

From then on, Vercel Cron runs the scrape every day at **13:00 UTC** (9 AM US Eastern).
You can see the schedule in `vercel.json` and the runs under *Settings → Cron Jobs*.
On the Hobby plan, the job fires at some point within that hour.

### If AAA blocks Vercel

Some sites block requests from cloud data centers. If the *Scraper log* on the site shows
`failed` or `HTTP 403`, use the included GitHub Action instead. It runs the same scraper
from GitHub's servers:

1. In the GitHub repo, go to *Settings → Secrets → Actions* and add the secret `DATABASE_URL`.
   Copy the value from Vercel → Storage → Neon → `.env.local` tab.
2. In `.github/workflows/scrape.yml`, un-comment the `schedule:` lines and push.
3. Test it with *Actions → Daily AAA scrape → Run workflow*.

Both runners can stay on. Writes are idempotent, so running twice on the same day does no harm.

## Local development

```bash
npm install
cp .env.example .env.local        # paste your Neon DATABASE_URL
npm run scrape:dry                # scrape only, print summary (no DB needed)
npm run scrape                    # scrape + save
npm run dev                       # http://localhost:3000
npm test                          # parser / candle / DB tests
```

## API

| Endpoint | Returns |
|---|---|
| `GET /api/regions` | US + all states with the latest prices for every grade |
| `GET /api/series?region=TX&grade=diesel` | The daily series `[{time, value, source}]` |
| `GET /api/region?code=TX` | All grades and periods, record highs, and metro areas |
| `GET /api/status` | The last 10 scraper runs and database totals |
| `GET /api/cron/scrape` | Runs the scraper (needs `Authorization: Bearer $CRON_SECRET` or `?secret=`) |

Region codes: `US`, two-letter state codes, and metro codes such as `TX-houston` (listed by `/api/region?code=TX`).
Grades: `regular`, `midgrade`, `premium`, `diesel`, `e85`.

## Project layout

```
app/
  page.js, layout.js, globals.css
  components/Terminal.jsx     UI: watchlist, ticker, stats, tables
  components/PriceChart.jsx   lightweight-charts wrapper
  api/…                       route handlers above
lib/
  aaa-parser.js   HTML → price tables (no dependencies; matches by content, not CSS classes)
  scraper.js      fetches all pages (4 at a time, retries, fallbacks)
  store.js        upserts into Postgres
  run-scrape.js   scrape + save + log run
  queries.js      read queries for the API
  candles.js      daily points → D / W / M OHLC candles, moving averages
  db.js           Neon client + auto-created schema
scripts/scrape.mjs  CLI runner (local / GitHub Actions)
```

## Notes

- AAA publishes one average per day, so a daily candle opens at the previous day's average
  and closes at the current one. Weekly and monthly candles track the high and low of the
  days inside them.
- Check AAA's website terms before you use this data publicly or commercially. The scraper
  requests about 53 pages once a day, 4 at a time, with a short delay between requests.
- The charts use [TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/)
  (Apache-2.0). Its attribution logo is kept on purpose.

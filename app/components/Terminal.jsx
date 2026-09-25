'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import PriceChart from './PriceChart.jsx';
import { toCandles, sma, rangeStart } from '../../lib/candles.js';
import { GRADES, GRADE_LABELS } from '../../lib/states.js';

const RANGES = ['1M', '3M', '6M', 'YTD', '1Y', '5Y', 'ALL'];
const INTERVALS = [['D', '1D'], ['W', '1W'], ['M', '1M']];
const TYPES = [['candles', 'Candles'], ['area', 'Area'], ['line', 'Line']];
const PERIOD_LABELS = [['yesterday', '1D'], ['week_ago', '1W'], ['month_ago', '1M'], ['year_ago', '1Y']];

const fmt = (v, d = 3) => (v == null || Number.isNaN(v) ? '—' : `$${v.toFixed(d)}`);
const fmtChg = (v, d = 3) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`);
const fmtPct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`);
const dir = (v) => (v == null || Math.abs(v) < 1e-9 ? 'flat' : v > 0 ? 'up' : 'down');
const arrow = (v) => (dir(v) === 'up' ? '▲' : dir(v) === 'down' ? '▼' : '■');
function fmtDate(iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
}
function change(p, key) {
  if (!p || p.current == null || p[key] == null) return { abs: null, pct: null };
  const abs = p.current - p[key];
  return { abs, pct: (abs / p[key]) * 100 };
}

async function getJSON(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export default function Terminal() {
  const [market, setMarket] = useState(null);
  const [marketErr, setMarketErr] = useState(null);
  const [code, setCode] = useState('US');
  const [grade, setGrade] = useState('regular');
  const [range, setRange] = useState('ALL');
  const [interval, setInterval_] = useState('D');
  const [type, setType] = useState('candles');
  const [showMA, setShowMA] = useState(true);
  const [compareUS, setCompareUS] = useState(true);
  const [points, setPoints] = useState([]);
  const [usPoints, setUsPoints] = useState([]);
  const [region, setRegion] = useState(null);
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('name');
  const [status, setStatus] = useState(null);
  const [theme, setTheme] = useState('dark');

  // Initial state from URL + theme
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('r')) setCode(sp.get('r'));
    if (GRADES.includes(sp.get('g'))) setGrade(sp.get('g'));
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    getJSON('/api/regions').then(setMarket).catch((e) => setMarketErr(e.message));
    getJSON('/api/status').then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    const sp = new URLSearchParams();
    if (code !== 'US') sp.set('r', code);
    if (grade !== 'regular') sp.set('g', grade);
    const qs = sp.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [code, grade]);

  // Region details
  useEffect(() => {
    let live = true;
    getJSON(`/api/region?code=${encodeURIComponent(code)}`)
      .then((d) => live && setRegion(d))
      .catch(() => live && setRegion(null));
    return () => { live = false; };
  }, [code]);

  // Series for chart
  useEffect(() => {
    let live = true;
    setLoading(true);
    const reqs = [getJSON(`/api/series?region=${encodeURIComponent(code)}&grade=${grade}`)];
    if (code !== 'US') reqs.push(getJSON(`/api/series?region=US&grade=${grade}`));
    Promise.all(reqs)
      .then(([a, b]) => {
        if (!live) return;
        setPoints(a.points || []);
        setUsPoints(b ? b.points || [] : []);
      })
      .catch(() => live && (setPoints([]), setUsPoints([])))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [code, grade]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('pt-theme', next); } catch {}
    setTheme(next);
  };

  // ---- Derived chart data ----
  const chart = useMemo(() => {
    const all = toCandles(points, interval);
    const start = rangeStart(range, points[points.length - 1]?.time);
    const keep = (arr) => (start ? arr.filter((x) => x.time >= start) : arr);
    const candles = keep(all);
    const ma = showMA
      ? [
          { period: interval === 'D' ? 7 : 4, data: keep(sma(all, interval === 'D' ? 7 : 4)) },
          { period: interval === 'D' ? 30 : 12, data: keep(sma(all, interval === 'D' ? 30 : 12)) },
        ]
      : [];
    const compare = compareUS && code !== 'US' && usPoints.length
      ? { label: 'US', data: keep(toCandles(usPoints, interval)).map((k) => ({ time: k.time, value: k.close })) }
      : null;
    return { candles, ma, compare };
  }, [points, usPoints, interval, range, showMA, compareUS, code]);

  const lastCandle = chart.candles[chart.candles.length - 1];
  const shown = hover || lastCandle;
  const viewHigh = chart.candles.length ? Math.max(...chart.candles.map((c) => c.high)) : null;
  const viewLow = chart.candles.length ? Math.min(...chart.candles.map((c) => c.low)) : null;

  const periods = region?.grades?.[grade];
  const dayChg = change(periods, 'yesterday');
  const record = region?.records?.[grade];
  const observedDays = points.filter((p) => p.source === 'observed').length;

  // ---- Watchlist ----
  const watch = useMemo(() => {
    const rows = (market?.regions || []).map((r) => {
      const p = r.grades[grade];
      const c = change(p, 'yesterday');
      return { code: r.code, name: r.name, type: r.type, price: p?.current ?? null, abs: c.abs, pct: c.pct };
    });
    const national = rows.filter((r) => r.type === 'national');
    let states = rows.filter((r) => r.type === 'state');
    if (query) {
      const qq = query.toLowerCase();
      states = states.filter((r) => r.name.toLowerCase().includes(qq) || r.code.toLowerCase() === qq);
    }
    const by = {
      name: (a, b) => a.name.localeCompare(b.name),
      high: (a, b) => (b.price ?? -1) - (a.price ?? -1),
      low: (a, b) => (a.price ?? 99) - (b.price ?? 99),
      chg: (a, b) => (b.pct ?? -99) - (a.pct ?? -99),
    }[sort];
    states.sort(by);
    return { national, states };
  }, [market, grade, query, sort]);

  const tape = useMemo(() => [...watch.national, ...(market?.regions || [])
    .filter((r) => r.type === 'state')
    .map((r) => {
      const p = r.grades[grade];
      const c = change(p, 'yesterday');
      return { code: r.code, name: r.name, price: p?.current ?? null, abs: c.abs, pct: c.pct };
    })
    .sort((a, b) => a.code.localeCompare(b.code))], [watch.national, market, grade]);

  const select = useCallback((c) => {
    setCode(c);
    setHover(null);
    if (typeof window !== 'undefined' && window.innerWidth < 960) window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const noData = market && !market.regions?.length;
  const lastRun = status?.runs?.[0];

  return (
    <div className="app">
      {/* ---------- Top bar ---------- */}
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M5 3h8a1 1 0 0 1 1 1v7h1.5A2.5 2.5 0 0 1 18 13.5V18a1 1 0 0 0 2 0v-6.6l-2.7-2.7 1.4-1.4 3 3c.2.2.3.4.3.7V18a3 3 0 0 1-6 0v-4.5a.5.5 0 0 0-.5-.5H14v7h1v2H3v-2h1V4a1 1 0 0 1 1-1Zm1 2v5h6V5H6Z" /></svg>
          </span>
          <span className="brand-name">PumpTape</span>
          <span className="brand-sub">US retail fuel · daily</span>
        </div>
        <div className="topbar-right">
          {market?.asOf && <span className="pill"><span className="dot live" />AAA data as of {fmtDate(market.asOf)}</span>}
          <button className="icon-btn" onClick={toggleTheme} aria-label="Toggle light / dark theme" title="Toggle theme">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </header>

      {/* ---------- Ticker tape ---------- */}
      {tape.length > 1 && (
        <div className="tape" aria-label="Price ticker">
          <div className="tape-track">
            {[0, 1].map((k) => (
              <div className="tape-group" key={k} aria-hidden={k === 1}>
                {tape.map((t) => (
                  <button key={t.code} className="tape-item" onClick={() => select(t.code)} tabIndex={k ? -1 : 0}>
                    <span className="tape-code">{t.code}</span>
                    <span className="mono">{fmt(t.price)}</span>
                    <span className={`mono ${dir(t.abs)}`}>{arrow(t.abs)} {fmtPct(t.pct)}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="layout">
        {/* ---------- Main ---------- */}
        <main className="main">
          <section className="panel chart-panel">
            <div className="symbol-row">
              <div className="symbol">
                {region?.parent && region.type === 'metro' && (
                  <button className="crumb" onClick={() => select(region.parent.code)}>← {region.parent.name}</button>
                )}
                <select
                  className="mobile-picker"
                  aria-label="Choose region"
                  value={region?.type === 'metro' ? region.parent?.code || code : code}
                  onChange={(e) => select(e.target.value)}
                >
                  {(market?.regions || []).map((r) => (
                    <option key={r.code} value={r.code}>{r.type === 'national' ? 'United States (national)' : `${r.name} (${r.code})`}</option>
                  ))}
                </select>
                <h1>
                  {region?.name || (code === 'US' ? 'United States' : code)}
                  <span className="tag">{region?.type === 'national' ? 'NATIONAL' : region?.type === 'metro' ? 'METRO' : code}</span>
                </h1>
                <div className="quote">
                  <span className="price mono">{fmt(periods?.current)}</span>
                  <span className={`chg mono ${dir(dayChg.abs)}`}>
                    {arrow(dayChg.abs)} {fmtChg(dayChg.abs)} ({fmtPct(dayChg.pct)})
                  </span>
                  <span className="muted small">{GRADE_LABELS[grade]} · $/gal · vs. yesterday</span>
                </div>
              </div>
              <div className="grade-tabs" role="tablist" aria-label="Fuel grade">
                {GRADES.map((g) => (
                  <button key={g} role="tab" aria-selected={grade === g} className={grade === g ? 'on' : ''} onClick={() => setGrade(g)}>
                    {GRADE_LABELS[g]}
                  </button>
                ))}
              </div>
            </div>

            <div className="toolbar">
              <div className="seg" aria-label="Range">
                {RANGES.map((r) => (
                  <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>
                ))}
              </div>
              <div className="seg" aria-label="Candle interval">
                {INTERVALS.map(([k, l]) => (
                  <button key={k} className={interval === k ? 'on' : ''} onClick={() => setInterval_(k)}>{l}</button>
                ))}
              </div>
              <div className="seg" aria-label="Chart type">
                {TYPES.map(([k, l]) => (
                  <button key={k} className={type === k ? 'on' : ''} onClick={() => setType(k)}>{l}</button>
                ))}
              </div>
              <label className="check"><input type="checkbox" checked={showMA} onChange={(e) => setShowMA(e.target.checked)} /> MA</label>
              {code !== 'US' && (
                <label className="check"><input type="checkbox" checked={compareUS} onChange={(e) => setCompareUS(e.target.checked)} /> vs US</label>
              )}
            </div>

            <div className="chart-wrap">
              <div className="legend mono" aria-live="off">
                {shown ? (
                  <>
                    <span className="legend-date">{fmtDate(shown.time)}</span>
                    {'open' in shown ? (
                      <>
                        <span>O <b className={dir(shown.close - shown.open)}>{shown.open.toFixed(3)}</b></span>
                        <span>H <b className={dir(shown.close - shown.open)}>{shown.high.toFixed(3)}</b></span>
                        <span>L <b className={dir(shown.close - shown.open)}>{shown.low.toFixed(3)}</b></span>
                        <span>C <b className={dir(shown.close - shown.open)}>{shown.close.toFixed(3)}</b></span>
                        <span className={dir(shown.close - shown.open)}>{fmtChg(shown.close - shown.open)} ({fmtPct(((shown.close - shown.open) / shown.open) * 100)})</span>
                      </>
                    ) : (
                      <span>Close <b>{shown.value?.toFixed(3)}</b></span>
                    )}
                  </>
                ) : <span className="muted">—</span>}
                {showMA && chart.candles.length > 0 && (
                  <span className="legend-keys">
                    {chart.ma.map((m, i) => (
                      <span key={m.period} className="key"><i style={{ background: `var(--series-${i + 1})` }} />MA{m.period}</span>
                    ))}
                    {chart.compare && <span className="key"><i className="dash" style={{ borderColor: 'var(--series-3)' }} />US avg</span>}
                  </span>
                )}
                {!showMA && chart.compare && (
                  <span className="legend-keys"><span className="key"><i className="dash" style={{ borderColor: 'var(--series-3)' }} />US avg</span></span>
                )}
              </div>

              <PriceChart
                candles={chart.candles}
                type={type}
                ma={chart.ma}
                compare={chart.compare}
                theme={theme}
                onHover={setHover}
              />

              {!loading && !chart.candles.length && (
                <div className="chart-empty">
                  <strong>{marketErr ? 'Can’t reach the database' : 'No price history yet'}</strong>
                  <p>
                    {marketErr
                      ? marketErr
                      : 'The scraper runs every day at 13:00 UTC. To fill the chart now, open /api/cron/scrape?secret=YOUR_CRON_SECRET once.'}
                  </p>
                </div>
              )}
              {loading && <div className="chart-loading"><span className="spinner" /></div>}
            </div>

            <div className="chart-foot small muted">
              <span>{observedDays} daily observation{observedDays === 1 ? '' : 's'} logged · {points.length - observedDays} back-filled from AAA comparison columns</span>
              <span>Source: AAA Gas Prices</span>
            </div>
          </section>

          {/* ---------- Stats ---------- */}
          <section className="stats">
            {PERIOD_LABELS.map(([key, label]) => {
              const c = change(periods, key);
              return (
                <div className="stat" key={key}>
                  <div className="stat-label">{label} change</div>
                  <div className={`stat-value mono ${dir(c.abs)}`}>{fmtChg(c.abs)}</div>
                  <div className="stat-sub mono">{fmtPct(c.pct)} · was {fmt(periods?.[key])}</div>
                </div>
              );
            })}
            <div className="stat">
              <div className="stat-label">Record high</div>
              <div className="stat-value mono">{fmt(record?.price)}</div>
              <div className="stat-sub">
                {record ? <>{fmtDate(record.date)} · <span className="mono">{fmtPct(periods?.current ? ((periods.current - record.price) / record.price) * 100 : null)}</span></> : 'Not published for this grade'}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Range in view</div>
              <div className="stat-value mono">{viewLow != null ? `${viewLow.toFixed(3)}–${viewHigh.toFixed(3)}` : '—'}</div>
              <div className="stat-sub">{range === 'ALL' ? 'All history' : range} · {chart.candles.length} bars</div>
            </div>
          </section>

          {/* ---------- All grades table ---------- */}
          <section className="panel">
            <div className="panel-head">
              <h2>All grades · {region?.name || '—'}</h2>
              <span className="muted small">as of {fmtDate(region?.asOf)}</span>
            </div>
            <div className="table-scroll">
              <table className="grid-table">
                <thead>
                  <tr><th>Grade</th><th>Current</th><th>Yesterday</th><th>Week ago</th><th>Month ago</th><th>Year ago</th><th>1Y chg</th></tr>
                </thead>
                <tbody>
                  {GRADES.filter((g) => region?.grades?.[g]).map((g) => {
                    const p = region.grades[g];
                    const y = change(p, 'year_ago');
                    return (
                      <tr key={g} className={g === grade ? 'sel' : ''} onClick={() => setGrade(g)}>
                        <td>{GRADE_LABELS[g]}</td>
                        <td className="mono strong">{fmt(p.current)}</td>
                        <td className="mono">{fmt(p.yesterday)}</td>
                        <td className="mono">{fmt(p.week_ago)}</td>
                        <td className="mono">{fmt(p.month_ago)}</td>
                        <td className="mono">{fmt(p.year_ago)}</td>
                        <td className={`mono ${dir(y.abs)}`}>{fmtPct(y.pct)}</td>
                      </tr>
                    );
                  })}
                  {!region?.grades || !Object.keys(region.grades).length ? (
                    <tr><td colSpan={7} className="muted">No data yet.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          {/* ---------- Metros ---------- */}
          {region?.metros?.length > 0 && (
            <section className="panel">
              <div className="panel-head">
                <h2>Metro areas · {region.name}</h2>
                <span className="muted small">{region.metros.length} areas · {GRADE_LABELS[grade]} · click to chart</span>
              </div>
              <div className="table-scroll">
                <table className="grid-table">
                  <thead><tr><th>Metro</th><th>Current</th><th>1D</th><th>1W</th><th>1M</th><th>1Y</th><th>vs state</th></tr></thead>
                  <tbody>
                    {region.metros.map((m) => {
                      const p = m.grades[grade];
                      const diff = p?.current != null && periods?.current != null ? p.current - periods.current : null;
                      return (
                        <tr key={m.code} onClick={() => select(m.code)}>
                          <td>{m.name}</td>
                          <td className="mono strong">{fmt(p?.current)}</td>
                          {['yesterday', 'week_ago', 'month_ago', 'year_ago'].map((k) => {
                            const c = change(p, k);
                            return <td key={k} className={`mono ${dir(c.abs)}`}>{fmtPct(c.pct)}</td>;
                          })}
                          <td className={`mono ${dir(diff)}`}>{fmtChg(diff)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ---------- Scraper log ---------- */}
          <section className="panel">
            <div className="panel-head">
              <h2>Scraper log</h2>
              {status?.counts && (
                <span className="muted small">
                  {status.counts.regions} regions · {status.counts.price_rows?.toLocaleString()} price rows · {status.counts.observed_days} days observed
                </span>
              )}
            </div>
            <div className="table-scroll">
              <table className="grid-table compact">
                <thead><tr><th>Run</th><th>Started (UTC)</th><th>Status</th><th>AAA date</th><th>Pages</th><th>Regions</th><th>Rows</th><th>Trigger</th></tr></thead>
                <tbody>
                  {(status?.runs || []).map((r) => (
                    <tr key={r.id} title={r.errors?.length ? r.errors.map((e) => `${e.page}: ${e.error}`).join('\n') : ''}>
                      <td className="mono">#{r.id}</td>
                      <td className="mono">{String(r.started_at).replace('T', ' ').slice(0, 16)}</td>
                      <td><span className={`badge ${r.status}`}>{r.status}{r.errors?.length ? ` · ${r.errors.length} err` : ''}</span></td>
                      <td className="mono">{r.as_of || '—'}</td>
                      <td className="mono">{r.pages ?? '—'}</td>
                      <td className="mono">{r.regions ?? '—'}</td>
                      <td className="mono">{r.price_rows ?? '—'}</td>
                      <td className="muted">{r.trigger}</td>
                    </tr>
                  ))}
                  {!status?.runs?.length && <tr><td colSpan={8} className="muted">No runs yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </main>

        {/* ---------- Watchlist ---------- */}
        <aside className="watchlist panel" aria-label="Watchlist">
          <div className="panel-head">
            <h2>Watchlist</h2>
            <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
              <option value="name">A–Z</option>
              <option value="high">Highest</option>
              <option value="low">Lowest</option>
              <option value="chg">Biggest 1D move</option>
            </select>
          </div>
          <input className="search" placeholder="Search state…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="wl-head small muted"><span>Symbol</span><span>Last</span><span>1D %</span></div>
          <div className="wl-list">
            {[...watch.national, ...watch.states].map((r) => (
              <button key={r.code} className={`wl-row ${code === r.code || region?.parent?.code === r.code ? 'on' : ''} ${r.type}`} onClick={() => select(r.code)}>
                <span className="wl-sym"><b>{r.code}</b><small>{r.name}</small></span>
                <span className="mono">{fmt(r.price)}</span>
                <span className={`mono ${dir(r.abs)}`}>{fmtPct(r.pct)}</span>
              </button>
            ))}
            {!market && !marketErr && Array.from({ length: 10 }).map((_, i) => <div key={i} className="wl-skel" />)}
            {marketErr && <p className="muted small pad">Couldn’t load prices: {marketErr}</p>}
            {noData && <p className="muted small pad">No data in the database yet — run the scraper once.</p>}
          </div>
        </aside>
      </div>

      <footer className="footer small muted">
        Prices scraped daily from gasprices.aaa.com (AAA). Daily candles open at the prior day’s average and close at the day’s average.
        Charts by TradingView Lightweight Charts™.
      </footer>
    </div>
  );
}

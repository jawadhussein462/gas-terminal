// Turns a daily price series into OHLC candles for the chart.
// Gas prices are one number per day, so a daily candle opens at the previous
// day's price and closes at today's; weekly / monthly candles open at the prior
// period's close and track the high / low of every day inside the period.

function bucketKey(iso, interval) {
  if (interval === 'M') return `${iso.slice(0, 7)}-01`;
  if (interval === 'W') {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dow = (dt.getUTCDay() + 6) % 7; // Monday = 0
    dt.setUTCDate(dt.getUTCDate() - dow);
    return dt.toISOString().slice(0, 10);
  }
  return iso;
}

const r4 = (v) => Math.round(v * 10000) / 10000;

/** points: [{time:'YYYY-MM-DD', value}] sorted ascending. interval: 'D' | 'W' | 'M' */
export function toCandles(points, interval = 'D') {
  const out = [];
  let prevClose = null;
  let cur = null;
  for (const p of points) {
    if (p.value == null) continue;
    const key = bucketKey(p.time, interval);
    if (!cur || cur.time !== key) {
      if (cur) {
        out.push(cur);
        prevClose = cur.close;
      }
      const open = prevClose ?? p.value;
      cur = { time: key, open, high: Math.max(open, p.value), low: Math.min(open, p.value), close: p.value };
    } else {
      cur.high = Math.max(cur.high, p.value);
      cur.low = Math.min(cur.low, p.value);
      cur.close = p.value;
    }
  }
  if (cur) out.push(cur);
  return out.map((c) => ({ time: c.time, open: r4(c.open), high: r4(c.high), low: r4(c.low), close: r4(c.close) }));
}

/** Simple moving average over candle closes. */
export function sma(candles, period) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out.push({ time: candles[i].time, value: r4(sum / period) });
  }
  return out;
}

/** Keep candles inside the selected range ('1M','3M','6M','YTD','1Y','5Y','ALL'). */
export function rangeStart(range, lastIso) {
  if (!lastIso || range === 'ALL') return null;
  const [y, m, d] = lastIso.split('-').map(Number);
  const back = { '1M': [0, 1], '3M': [0, 3], '6M': [0, 6], '1Y': [1, 0], '5Y': [5, 0] }[range];
  if (range === 'YTD') return `${y}-01-01`;
  if (!back) return null;
  const dt = new Date(Date.UTC(y - back[0], m - 1 - back[1], d));
  return dt.toISOString().slice(0, 10);
}

'use client';

import { useEffect, useRef, useState } from 'react';

// Reads a CSS custom property so the chart follows the page theme.
function cssVar(name, fallback) {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function palette() {
  return {
    bg: cssVar('--chart-bg', '#0c0f14'),
    text: cssVar('--text-2', '#9aa3b2'),
    grid: cssVar('--grid', '#1a2029'),
    border: cssVar('--border', '#232a35'),
    up: cssVar('--up', '#199e70'),
    down: cssVar('--down', '#e66767'),
    ma1: cssVar('--series-1', '#3987e5'),
    ma2: cssVar('--series-2', '#d95926'),
    cmp: cssVar('--series-3', '#9085e9'),
    crosshair: cssVar('--text-3', '#6b7483'),
    font: `${cssVar('--font-mono', '')}, ui-monospace, Menlo, monospace`.replace(/^, /, ''),
  };
}

const PRICE_FORMAT = { type: 'price', precision: 3, minMove: 0.001 };

/**
 * props:
 *  candles:   [{time, open, high, low, close}]
 *  type:      'candles' | 'line' | 'area'
 *  ma:        [{ period, data:[{time,value}] }]  (max 2)
 *  compare:   { label, data:[{time,value}] } | null
 *  theme:     'dark' | 'light'  (triggers recolor)
 *  onHover:   (candle | null) => void
 */
export default function PriceChart({ candles, type, ma = [], compare = null, theme, onHover }) {
  const boxRef = useRef(null);
  const api = useRef(null); // { LW, chart, series: [] }
  const [ready, setReady] = useState(false);
  const hoverRef = useRef(onHover);
  hoverRef.current = onHover;

  // Create the chart once
  useEffect(() => {
    let disposed = false;
    let chart;
    (async () => {
      const LW = await import('lightweight-charts');
      if (disposed || !boxRef.current) return;
      chart = LW.createChart(boxRef.current, {
        autoSize: true,
        layout: { fontSize: 11 },
        crosshair: { mode: LW.CrosshairMode.Normal },
        rightPriceScale: { scaleMargins: { top: 0.12, bottom: 0.08 } },
        timeScale: { rightOffset: 4, barSpacing: 10, minBarSpacing: 2, fixLeftEdge: false },
        localization: { priceFormatter: (p) => `$${p.toFixed(3)}` },
      });
      api.current = { LW, chart, series: [], main: null };
      chart.subscribeCrosshairMove((param) => {
        const main = api.current?.main;
        if (!main || !param || !param.time) return hoverRef.current?.(null);
        const d = param.seriesData.get(main);
        hoverRef.current?.(d ? { time: param.time, ...d } : null);
      });
      setReady(true);
    })();
    return () => {
      disposed = true;
      if (chart) chart.remove();
      api.current = null;
    };
  }, []);

  // (Re)build series whenever data or options change
  useEffect(() => {
    if (!ready || !api.current) return;
    const { LW, chart } = api.current;
    const c = palette();

    chart.applyOptions({
      layout: { background: { type: LW.ColorType.Solid, color: c.bg }, textColor: c.text, fontFamily: c.font },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
      crosshair: {
        vertLine: { color: c.crosshair, labelBackgroundColor: c.border },
        horzLine: { color: c.crosshair, labelBackgroundColor: c.border },
      },
    });

    for (const s of api.current.series) chart.removeSeries(s);
    api.current.series = [];
    api.current.main = null;

    if (!candles.length) return;

    const last = candles[candles.length - 1];
    const first = candles[0];
    const rising = last.close >= first.open;
    let main;
    if (type === 'line') {
      main = chart.addSeries(LW.LineSeries, { color: rising ? c.up : c.down, lineWidth: 2, priceFormat: PRICE_FORMAT });
      main.setData(candles.map((k) => ({ time: k.time, value: k.close })));
    } else if (type === 'area') {
      const col = rising ? c.up : c.down;
      main = chart.addSeries(LW.AreaSeries, {
        lineColor: col, lineWidth: 2, topColor: hexA(col, 0.28), bottomColor: hexA(col, 0.02), priceFormat: PRICE_FORMAT,
      });
      main.setData(candles.map((k) => ({ time: k.time, value: k.close })));
    } else {
      main = chart.addSeries(LW.CandlestickSeries, {
        upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down,
        wickUpColor: c.up, wickDownColor: c.down, priceFormat: PRICE_FORMAT,
      });
      main.setData(candles);
    }
    api.current.main = main;
    api.current.series.push(main);

    const maColors = [c.ma1, c.ma2];
    ma.slice(0, 2).forEach((m, i) => {
      if (!m.data.length) return;
      const s = chart.addSeries(LW.LineSeries, {
        color: maColors[i], lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false, priceFormat: PRICE_FORMAT, title: `MA${m.period}`,
      });
      s.setData(m.data);
      api.current.series.push(s);
    });

    if (compare && compare.data.length) {
      const s = chart.addSeries(LW.LineSeries, {
        color: c.cmp, lineWidth: 2, lineStyle: LW.LineStyle.Dashed, priceLineVisible: false,
        crosshairMarkerVisible: false, priceFormat: PRICE_FORMAT, title: compare.label,
      });
      s.setData(compare.data);
      api.current.series.push(s);
    }

    chart.timeScale().fitContent();
  }, [ready, candles, type, ma, compare, theme]);

  const zoom = (factor) => {
    const chart = api.current?.chart;
    if (!chart || !candles.length) return;
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    const span = range.to - range.from;
    const next = Math.min(Math.max(span * factor, 5), Math.max(candles.length + 6, span));
    if (Math.abs(next - span) < 0.25) return;
    const mid = (range.from + range.to) / 2;
    const last = candles.length - 1;
    const pinnedRight = range.to >= last - 0.5;
    ts.setVisibleLogicalRange(pinnedRight
      ? { from: range.to - next, to: range.to }
      : { from: mid - next / 2, to: mid + next / 2 });
  };

  const pan = (dir) => {
    const chart = api.current?.chart;
    if (!chart || !candles.length) return;
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    const span = range.to - range.from;
    const shift = Math.max(span * 0.22, 1) * dir;
    const minFrom = -1;
    const maxTo = candles.length - 1 + 4;
    let from = range.from + shift;
    let to = range.to + shift;
    if (from < minFrom) {
      from = minFrom;
      to = minFrom + span;
    }
    if (to > maxTo) {
      to = maxTo;
      from = maxTo - span;
    }
    ts.setVisibleLogicalRange({ from, to });
  };

  const resetView = () => api.current?.chart.timeScale().fitContent();

  return (
    <>
      <div ref={boxRef} className="chart-canvas" />
      {candles.length > 0 && (
        <div className="chart-nav" role="toolbar" aria-label="Chart navigation">
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoom(1.25)}>
            <NavIcon><path d="M3.2 8h9.6" /></NavIcon>
          </button>
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoom(0.8)}>
            <NavIcon>
              <path d="M8 3.2v9.6M3.2 8h9.6" />
            </NavIcon>
          </button>
          <button type="button" aria-label="Scroll left" title="Scroll left" onClick={() => pan(-1)}>
            <NavIcon><path d="M10.2 3.2 5.4 8l4.8 4.8" /></NavIcon>
          </button>
          <button type="button" aria-label="Scroll right" title="Scroll right" onClick={() => pan(1)}>
            <NavIcon><path d="M5.8 3.2 10.6 8l-4.8 4.8" /></NavIcon>
          </button>
          <button type="button" aria-label="Reset view" title="Reset view" onClick={resetView}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}

function NavIcon({ children }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

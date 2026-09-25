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

  return <div ref={boxRef} className="chart-canvas" />;
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

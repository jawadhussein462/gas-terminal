// Dependency-free parser for gasprices.aaa.com pages.
// It finds price tables by their *content* (grade names in the header, period names
// in the first column) rather than by CSS class names, so small markup changes on
// AAA's side don't break it.

const GRADE_PATTERNS = [
  [/mid[\s-]*grade|plus/i, 'midgrade'],
  [/premium/i, 'premium'],
  [/diesel/i, 'diesel'],
  [/\be[\s-]?85\b/i, 'e85'],
  [/regular|unleaded/i, 'regular'],
];

const PERIOD_PATTERNS = [
  [/current/i, 'current'],
  [/yesterday/i, 'yesterday'],
  [/week/i, 'week_ago'],
  [/month/i, 'month_ago'],
  [/year/i, 'year_ago'],
];

export const PERIODS = ['current', 'yesterday', 'week_ago', 'month_ago', 'year_ago'];

function matchFrom(patterns, text) {
  if (!text) return null;
  for (const [re, key] of patterns) if (re.test(text)) return key;
  return null;
}
export const gradeOf = (t) => matchFrom(GRADE_PATTERNS, t);
export const periodOf = (t) => matchFrom(PERIOD_PATTERNS, t);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function textOf(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Remove scripts, styles, comments, svg — never contain the data we want. */
export function cleanHtml(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
}

export function parsePrice(text) {
  const m = String(text ?? '').replace(/,/g, '').match(/\$?\s*(\d{1,2}\.\d{2,4})/);
  if (!m) return null;
  const v = Number(m[1]);
  return v > 0 && v < 50 ? v : null;
}

/** m/d/yy or m/d/yyyy → 'YYYY-MM-DD' */
export function parseUsDate(text) {
  const m = String(text ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let [, mo, d, y] = m;
  y = Number(y);
  if (y < 100) y += 2000;
  const mm = String(mo).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
  return `${y}-${mm}-${dd}`;
}

/** Every <table> with its rows/cells and the HTML that sits between it and the previous table. */
export function extractTables(html) {
  const tables = [];
  const re = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  let lastEnd = 0;
  while ((m = re.exec(html))) {
    const inner = m[1];
    const rows = [];
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(inner))) {
      const cells = [];
      const cellRe = /<t([hd])\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
      let c;
      while ((c = cellRe.exec(tr[1]))) cells.push({ th: c[1].toLowerCase() === 'h', html: c[2], text: textOf(c[2]) });
      if (cells.length) rows.push(cells);
    }
    tables.push({ rows, before: html.slice(lastEnd, m.index), index: m.index, end: re.lastIndex });
    lastEnd = re.lastIndex;
  }
  return tables;
}

/** Best guess at the title shown above a table (e.g. a metro name). */
export function titleBefore(beforeHtml) {
  const hs = [...beforeHtml.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)];
  if (hs.length) {
    const t = textOf(hs[hs.length - 1][1]);
    if (t) return t;
  }
  // Fallback: last non-empty chunk of text before the table
  const chunks = beforeHtml.split(/<[^>]+>/).map((s) => decodeEntities(s).replace(/\s+/g, ' ').trim()).filter(Boolean);
  return chunks.length ? chunks[chunks.length - 1] : '';
}

/**
 * Interpret a table as an AAA price table ({grade: {period: price}}), or null.
 * Handles both layouts: periods as rows (AAA default) or grades as rows.
 */
export function readPriceTable(rows) {
  if (rows.length < 2) return null;
  const headerIdx = rows.findIndex((r) => r.filter((c) => gradeOf(c.text) && parsePrice(c.text) == null).length >= 2);
  const grid = {};
  if (headerIdx !== -1) {
    const header = rows[headerIdx];
    const colGrade = header.map((c) => (parsePrice(c.text) == null ? gradeOf(c.text) : null));
    // Header may omit the empty first corner cell — align from the right.
    for (const row of rows.slice(headerIdx + 1)) {
      const period = periodOf(row[0]?.text);
      if (!period) continue;
      const offset = row.length - header.length;
      row.forEach((cell, i) => {
        if (i === 0) return;
        const grade = colGrade[i - offset];
        const price = parsePrice(cell.text);
        if (grade && price != null) (grid[grade] ||= {})[period] = price;
      });
    }
  } else {
    // Transposed: header has periods, first column has grades
    const pIdx = rows.findIndex((r) => r.filter((c) => periodOf(c.text) && parsePrice(c.text) == null).length >= 2);
    if (pIdx === -1) return null;
    const header = rows[pIdx];
    const colPeriod = header.map((c) => periodOf(c.text));
    for (const row of rows.slice(pIdx + 1)) {
      const grade = gradeOf(row[0]?.text);
      if (!grade) continue;
      const offset = row.length - header.length;
      row.forEach((cell, i) => {
        if (i === 0) return;
        const period = colPeriod[i - offset];
        const price = parsePrice(cell.text);
        if (period && price != null) (grid[grade] ||= {})[period] = price;
      });
    }
  }
  return Object.keys(grid).some((g) => grid[g].current != null) ? grid : null;
}

/** "Price as of 9/25/26" → '2026-09-25' */
export function parseAsOf(html) {
  const t = textOf(html);
  const m = t.match(/price[s]?\s+as\s+of\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  return m ? parseUsDate(m[1]) : null;
}

/** "Highest Recorded Average Price" block → [{grade, price, date}] */
export function parseRecords(html) {
  const t = textOf(html);
  const start = t.search(/highest\s+recorded/i);
  if (start === -1) return [];
  const block = t.slice(start, start + 500);
  const out = [];
  const seen = new Set();
  const labels = [...block.matchAll(/regular(?:\s+unleaded)?|mid[\s-]*grade|premium|diesel|\be[\s-]?85\b/gi)];
  labels.forEach((m, i) => {
    const grade = gradeOf(m[0]);
    if (!grade || seen.has(grade)) return;
    // Look only between this label and the next one, price and date in either order
    const seg = block.slice(m.index + m[0].length, labels[i + 1]?.index ?? m.index + 120);
    const price = seg.match(/\$\s*(\d{1,2}\.\d{2,4})|\b(\d{1,2}\.\d{2,4})\b/);
    if (!price) return;
    seen.add(grade);
    out.push({ grade, price: Number(price[1] ?? price[2]), date: parseUsDate(seg) });
  });
  return out;
}

/**
 * Parse a national (homepage) or state page.
 * Returns { asOf, main, metros:[{name, grid}], records }
 * - main: the page's own average table (national on the homepage, the state on ?state=XX)
 * - metros: every further titled price table (metro areas on state pages)
 * `expectCurrentRegular` (from the state averages page) helps pick the right main table.
 */
export function parseRegionPage(rawHtml, { expectCurrentRegular = null, isNational = false } = {}) {
  const html = cleanHtml(rawHtml);
  const tables = extractTables(html)
    .map((t) => ({ ...t, grid: readPriceTable(t.rows), title: titleBefore(t.before) }))
    .filter((t) => t.grid);

  let mainIdx = -1;
  if (expectCurrentRegular != null) {
    mainIdx = tables.findIndex((t) => Math.abs((t.grid.regular?.current ?? -1) - expectCurrentRegular) < 0.0006);
  }
  if (mainIdx === -1) {
    mainIdx = isNational ? 0 : tables.findIndex((t) => !/national/i.test(t.title));
  }
  const main = mainIdx >= 0 ? tables[mainIdx] : null;

  const metros = [];
  if (!isNational && main) {
    const seen = new Set();
    for (const t of tables.slice(mainIdx + 1)) {
      const name = t.title.replace(/\s*(average\s+)?gas\s+prices?\s*$/i, '').trim();
      if (!name || /national|u\.?s\.?\s+average|record/i.test(name) || name.length > 80) continue;
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      metros.push({ name, grid: t.grid });
    }
  }

  return {
    asOf: parseAsOf(html),
    main: main ? main.grid : null,
    mainTitle: main ? main.title : null,
    metros,
    records: parseRecords(html),
  };
}

/** https://gasprices.aaa.com/state-gas-price-averages/ → { asOf, states: {CODE: {name, regular, midgrade, ...}} } */
export function parseStateAverages(rawHtml, stateByName = {}) {
  const html = cleanHtml(rawHtml);
  const states = {};
  for (const t of extractTables(html)) {
    const hIdx = t.rows.findIndex((r) => r.filter((c) => gradeOf(c.text)).length >= 2 && /state/i.test(r[0]?.text || ''));
    if (hIdx === -1) continue;
    const header = t.rows[hIdx];
    const colGrade = header.map((c, i) => (i === 0 ? null : gradeOf(c.text)));
    for (const row of t.rows.slice(hIdx + 1)) {
      const first = row[0];
      if (!first) continue;
      const name = first.text;
      const codeFromLink = first.html.match(/state=([A-Za-z]{2})\b/);
      const code = (codeFromLink?.[1] || stateByName[name.toLowerCase()]?.code || '').toUpperCase();
      if (!code) continue;
      const entry = { name };
      row.forEach((cell, i) => {
        const g = colGrade[i];
        const p = parsePrice(cell.text);
        if (g && p != null) entry[g] = p;
      });
      if (entry.regular != null) states[code] = entry;
    }
  }
  return { asOf: parseAsOf(html), states };
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Shift an ISO date. unit: 'day' | 'month' | 'year' */
export function shiftDate(iso, amount, unit = 'day') {
  const [y, m, d] = iso.split('-').map(Number);
  let dt;
  if (unit === 'day') dt = new Date(Date.UTC(y, m - 1, d + amount));
  else if (unit === 'month') {
    const target = new Date(Date.UTC(y, m - 1 + amount, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    dt = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last)));
  } else {
    const last = new Date(Date.UTC(y + amount, m, 0)).getUTCDate();
    dt = new Date(Date.UTC(y + amount, m - 1, Math.min(d, last)));
  }
  return dt.toISOString().slice(0, 10);
}

/** Map each comparison column of an AAA table to the calendar date it refers to. */
export function periodDate(asOf, period) {
  switch (period) {
    case 'current': return asOf;
    case 'yesterday': return shiftDate(asOf, -1, 'day');
    case 'week_ago': return shiftDate(asOf, -7, 'day');
    case 'month_ago': return shiftDate(asOf, -1, 'month');
    case 'year_ago': return shiftDate(asOf, -1, 'year');
    default: return null;
  }
}

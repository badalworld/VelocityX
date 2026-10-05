'use strict';
/**
 * Real-kline loader — lets the identical study run on Binance (or any) 5-minute
 * candles instead of synthetic ones.
 *
 *   node simulation/run.js --data ./klines
 *
 * Directory layout: one CSV per symbol, named `<SYMBOL>.csv` (e.g. BTCUSDT.csv):
 *
 *   time,open,high,low,close,volume
 *   1704067200000,42283.1,42300.0,42200.5,42250.0,1234.56
 *
 * • `time` is the candle OPEN time; seconds or milliseconds are both accepted.
 *   A `date`/ISO first column is also accepted (parsed with Date.parse).
 * • volume is quote (USDT) turnover per candle; if the file carries base volume
 *   instead, multiply it by the close before writing the CSV.
 * • All symbols are aligned on the timestamps they share (intersection), then
 *   truncated to the shortest series, so the engine can index them together.
 *
 * The loader does no cleanup, no gap filling and no survivorship correction —
 * that is the analyst's job when preparing the CSVs.
 */
const fs = require('fs');
const path = require('path');

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { rows: [] };
  const header = lines[0].toLowerCase();
  const hasHeader = /[a-z]/.test(header);
  const rows = [];
  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 6) continue;
    let t = Number(parts[0]);
    if (!Number.isFinite(t) || Math.abs(t) < 1e11) {
      const parsed = Date.parse(parts[0]);
      if (Number.isFinite(parsed)) t = parsed;
      else if (Number.isFinite(t)) t *= 1000; // seconds → ms
      else continue;
    }
    const o = Number(parts[1]), h = Number(parts[2]), l = Number(parts[3]), c = Number(parts[4]), v = Number(parts[5]);
    if (![o, h, l, c, v].every(Number.isFinite)) continue;
    rows.push({ t, o, h, l, c, v });
  }
  rows.sort((a, b) => a.t - b.t);
  return { rows };
}

function loadWorldFromCsv(dir, opts = {}) {
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv'));
  if (!files.length) throw new Error(`no CSV files in ${dir}`);
  const series = [];
  for (const file of files) {
    const symbol = path.basename(file, path.extname(file)).toUpperCase();
    const { rows } = parseCsv(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (rows.length < 5000) {
      console.warn(`[data] ${symbol}: only ${rows.length} candles — skipped (need ≥ 5000 for the indicator warm-up)`);
      continue;
    }
    series.push({ symbol, rows });
  }
  if (!series.length) throw new Error('no usable CSV series (need ≥ 5000 five-minute candles each)');

  // intersection of timestamps
  const counts = new Map();
  for (const s of series) for (const r of s.rows) counts.set(r.t, (counts.get(r.t) || 0) + 1);
  let stamps = Array.from(counts.entries()).filter(([, n]) => n === series.length).map(([t]) => t).sort((a, b) => a - b);
  // keep only strictly 5-minute spaced candles (drop gaps so bar math stays valid)
  const clean = [];
  for (let i = 0; i < stamps.length; i++) {
    if (!clean.length || stamps[i] - clean[clean.length - 1].t === 300000) clean.push({ t: stamps[i] });
  }
  const n = Math.min(...series.map((s) => s.rows.length), clean.length);
  const bars = clean.length > n ? clean.slice(clean.length - n) : clean;
  const index = new Map(bars.map((b, i) => [b.t, i]));

  const symbols = series.map((s) => {
    const open = new Float64Array(n), high = new Float64Array(n), low = new Float64Array(n), close = new Float64Array(n), volume = new Float64Array(n);
    for (const r of s.rows) {
      const i = index.get(r.t);
      if (i === undefined) continue;
      open[i] = r.o; high[i] = r.h; low[i] = r.l; close[i] = r.c; volume[i] = r.v;
    }
    // annualised vol + turnover are only used for reporting / class labels
    let sum = 0, sum2 = 0, count = 0;
    for (let i = 1; i < n; i++) {
      if (!close[i] || !close[i - 1]) continue;
      const r = Math.log(close[i] / close[i - 1]);
      sum += r; sum2 += r * r; count++;
    }
    const sd = count ? Math.sqrt(Math.max(0, sum2 / count - Math.pow(sum / count, 2))) : 0;
    const volAnnual = sd * Math.sqrt(288 * 365);
    const turnover = Array.from(volume).reduce((a, b) => a + b, 0) / (n / 288);
    return {
      symbol: s.symbol,
      klass: volAnnual < 0.10 ? 'pegged' : turnover > 8e8 ? 'major' : volAnnual > 1.5 ? 'wild' : 'alt',
      volAnnual, dailyTurnover: turnover, fundingBias: 0,
      open, high, low, close, volume,
    };
  });

  const primary = opts.primary && symbols.some((s) => s.symbol === opts.primary) ? opts.primary : symbols[0].symbol;
  console.log(`[data] loaded ${symbols.length} symbols × ${n.toLocaleString()} 5-minute candles from ${dir}`);
  console.log(`[data] ${new Date(bars[0].t).toISOString()} → ${new Date(bars[n - 1].t).toISOString()} · primary ${primary}`);

  return {
    seed: opts.seed || 1,
    worldType: 'real',
    worldVol: 1,
    bars: n,
    symbols,
    primary,
    real: true,
  };
}

module.exports = { loadWorldFromCsv, parseCsv };

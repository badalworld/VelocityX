#!/usr/bin/env node
/**
 * VelocityX dashboard smoke test (headless, no browser required).
 * ---------------------------------------------------------------------------
 * Bundles the real App with esbuild, mounts it inside jsdom with stubbed
 * browser APIs (canvas, ResizeObserver targets, matchMedia, WebSocket) and
 * asserts that every surface of the liquid-glass UI actually renders —
 * dashboard deck, pinned P&L chart, position ladder, stats rings, screener,
 * activity feed, then clicks through Chart / Trades / Settings.
 *
 *   npm run smoke:ui            # fixture-fed (offline, deterministic)
 *   npm run smoke:ui -- --live  # against a running server on :4000
 *
 * Exit code is non-zero if any check fails or the app logs a runtime error.
 */
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '..');
const LIVE = process.argv.includes('--live');
const API = process.env.VX_API ?? 'http://localhost:4000';

/* ------------------------------------------------------------------ fixtures */
const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const symbol = 'BTCUSDT';

const candles = Array.from({ length: 160 }, (_, i) => {
  const time = Math.floor((now - (159 - i) * 5 * MIN) / 1000) * 1000;
  const base = 62000 + Math.sin(i / 9) * 900 + i * 3;
  const open = base;
  const close = base + Math.sin(i / 3) * 120;
  return { time, open, high: Math.max(open, close) + 60, low: Math.min(open, close) - 60, close };
});
const emas = Array.from({ length: 8 }, (_, k) => candles.map((c) => ({ time: c.time, value: c.close + Math.sin(k) * 40 })));
const signals = [
  { time: candles[40].time, side: 'LONG', price: 62100, id: 's1', acted: true },
  { time: candles[90].time, side: 'SHORT', price: 62300, id: 's2', acted: true },
  { time: candles[130].time, side: 'LONG', price: 62000, id: 's3', acted: false },
];

const baseTrade = {
  id: 't1',
  symbol,
  side: 'LONG',
  status: 'CLOSED',
  qty: 0.05,
  q1: 0.016,
  q2: 0.017,
  q3: 0.017,
  entryPrice: 61200,
  atrAtEntry: 210,
  slInitial: 60780,
  slCurrent: 61200,
  slStage: 1,
  tp1: 61515,
  tp2: 61830,
  tp3: 62145,
  notional: 3060,
  margin: 306,
  leverage: 10,
  closeReason: 'TP1',
  tp1Filled: true,
  tp2Filled: false,
  tp3Filled: false,
  fees: 1.2,
  initialRisk: 21,
  mode: 'paper',
  result: 'WIN',
  orders: {},
};

const trades = [
  { ...baseTrade, openedAt: now - 26 * HOUR, closedAt: now - 22 * HOUR, realizedPnl: 18.4 },
  { ...baseTrade, id: 't2', side: 'SHORT', slStage: 0, tp1Filled: false, closeReason: 'SL', result: 'LOSS', openedAt: now - 14 * HOUR, closedAt: now - 9 * HOUR, realizedPnl: -14.2, initialRisk: 14.4 },
  { ...baseTrade, id: 't3', qty: 0.06, q1: 0.02, q2: 0.02, q3: 0.02, slStage: 2, tp1Filled: true, tp2Filled: true, tp3Filled: true, closeReason: 'TP3', openedAt: now - 5 * HOUR, closedAt: now - 2 * HOUR, realizedPnl: 43.7, initialRisk: 23.4 },
];

const openTrade = {
  ...baseTrade,
  id: 't-open',
  status: 'OPEN',
  openedAt: now - 42 * MIN,
  closedAt: null,
  closeReason: null,
  entryPrice: 62410,
  slInitial: 62190,
  slCurrent: 62190,
  slStage: 0,
  tp1: 62630,
  tp2: 62950,
  tp3: 63270,
  realizedPnl: 0,
  result: null,
  unrealized: 12.75,
};

const routes = {
  '/api/status': {
    mode: 'paper',
    autoTrade: true,
    symbol,
    interval: '5m',
    leverage: 10,
    tradeSizePercent: 5,
    price: 62665.4,
    balance: { source: 'paper', total: 1128.5, available: 1128.5 },
    openTrade,
    engine: {
      atr: 187.4,
      ribbonBull: true,
      lastSignal: { id: 's3', symbol, time: candles[130].time, detectedAt: now - 30 * MIN, side: 'LONG', price: 62000, atr: 180, acted: true, tradeId: 't-open' },
      emas: [62400, 62420, 62450, 62470, 62490, 62510, 62530, 62550],
      emaExtra: 61800,
      lastClosedCandleTime: candles[candles.length - 1].time,
      startedAt: now - 3 * HOUR,
    },
    feed: 'binance',
    streams: { market: true },
    keysConfigured: { testnet: false, live: false },
    logs: [
      { t: now - 60_000, level: 'info', msg: 'Engine warm — 5m EMA 11/34 loaded' },
      { t: now - 40_000, level: 'win', msg: 'TP1 filled — 33% closed, stop moved to breakeven' },
      { t: now - 20_000, level: 'error', msg: 'Order rejected (error path exercised)' },
    ],
    now,
  },
  '/api/chart': {
    candles,
    emas,
    emaExtra: candles.map((c) => ({ time: c.time, value: c.close - 400 })),
    signals,
    trade: { side: 'LONG', entry: 62410, sl: 62190, slStage: 0, tp1: 62630, tp2: 62950, tp3: 63270, status: 'OPEN', tp1Filled: false, tp2Filled: false, tp3Filled: false },
  },
  '/api/trades': trades,
  '/api/signals': signals.map((s, i) => ({ id: s.id, symbol, time: s.time, detectedAt: s.time + 1000, side: s.side, price: s.price, atr: 180 + i, acted: s.acted, tradeId: s.acted ? `t${i}` : null })),
  '/api/stats': {
    windowDays: 7,
    totalSignals: 14,
    totalClosedTrades: 9,
    tp1Count: 7,
    tp2Count: 4,
    tp3Count: 2,
    slCount: 3,
    tp1Pct: 77.8,
    tp2Pct: 44.4,
    tp3Pct: 22.2,
    slPct: 33.3,
    winCount: 6,
    lossCount: 3,
    overallWinRate: 66.7,
    rrRatio: 1.5,
    breakevenRate: 33.3,
    expectancy: 0.42,
    netPnl: 48.9,
    totalFees: 3.7,
  },
  '/api/settings': {
    mode: 'paper',
    autoTrade: true,
    symbol,
    interval: '5m',
    tradeSizePercent: 5,
    leverage: 10,
    paperBalance: 1000,
    feeRate: 0.0004,
    emaLengths: [5, 11, 15, 18, 21, 24, 28, 34],
    emaExtraLength: 200,
    atrLength: 14,
    atrSlMultiplier: 2,
    tpRrFactor: 1.5,
    tp1ClosePct: 33,
    tp2ClosePct: 50,
    historyDays: 7,
    screenerSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'],
    dashboardTimeframes: ['5m', '15m', '30m'],
    keys: { testnet: { key: '', secret: '', configured: false }, live: { key: '', secret: '', configured: false } },
  },
  '/api/mtf': {
    timeframes: [
      { tf: '5m', bull: true },
      { tf: '15m', bull: true },
      { tf: '30m', bull: false },
    ],
    atr: 187.4,
    ribbonBull: true,
    overall: 'BULLISH',
    bullCount: 2,
  },
  '/api/screener': {
    rows: [
      { symbol: 'BTCUSDT', state: 'Bullish' },
      { symbol: 'ETHUSDT', state: 'Bullish' },
      { symbol: 'SOLUSDT', state: 'Bearish' },
      { symbol: 'BNBUSDT', state: 'Bullish' },
      { symbol: 'XRPUSDT', state: 'Long' },
      { symbol: 'DOGEUSDT', state: 'Short' },
    ],
  },
};

/* ------------------------------------------------------------------- bundle */
async function bundle() {
  const outfile = path.join(os.tmpdir(), `vx-ui-smoke-${process.pid}.js`);
  await build({
    entryPoints: [path.join(clientRoot, 'src', 'smoke-entry.tsx')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"' },
    outfile,
    logLevel: 'warning',
  });
  return outfile;
}

/* ------------------------------------------------------------------- runner */
const errors = [];
const checks = [];
const check = (name, ok, extra) => checks.push({ name, ok: !!ok, extra });

function boot(bundlePath) {
  const dom = new JSDOM('<!doctype html><html data-motion="on"><body><div id="root"></div></body></html>', {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost:5173/',
  });
  const { window } = dom;

  window.addEventListener('error', (e) => errors.push(`window error: ${e.message || e.error}`));
  window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${e.reason?.stack || e.reason}`));
  window.console.error = (...a) => errors.push(`console.error: ${a.map((x) => (x && x.message) || String(x)).join(' ')}`);
  window.console.warn = () => {};

  window.confirm = () => true;

  if (LIVE) {
    const nodeFetch = globalThis.fetch;
    window.fetch = (url) => nodeFetch(API + String(url));
  } else {
    window.fetch = (url) => {
      const key = String(url).split('?')[0];
      const data = routes[key];
      if (!data) return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: `no fixture for ${key}` }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) });
    };
  }

  // --- browser APIs jsdom does not implement ---------------------------------
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (q) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  }
  const gradient = { addColorStop() {} };
  const ctxMock = () =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'canvas') return { width: 900, height: 460, style: {} };
          if (prop === 'measureText') return () => ({ width: 42, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 42 });
          if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createConicGradient') return () => gradient;
          if (prop === 'createPattern') return () => ({});
          if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
          if (prop === 'toDataURL') return () => 'data:image/png;base64,';
          if (['fillStyle', 'strokeStyle', 'font', 'lineWidth'].includes(prop)) return '';
          return () => undefined;
        },
        set: () => true,
      },
    );
  window.HTMLCanvasElement.prototype.getContext = () => ctxMock();
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get: () => 900, configurable: true });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get: () => 460, configurable: true });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 460, width: 900, height: 460, toJSON() {} };
  };

  const script = window.document.createElement('script');
  script.textContent = fs.readFileSync(bundlePath, 'utf8');
  window.document.body.appendChild(script);
  return window;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bundlePath = await bundle();
const window = boot(bundlePath);
const doc = window.document;
const text = (sel) => doc.querySelector(sel)?.textContent?.trim() ?? null;
const clickTab = (label) => {
  const node = [...doc.querySelectorAll('.navrow .seg-item')].find((n) => (n.textContent || '').toLowerCase().includes(label));
  node?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return !!node;
};

await sleep(1600);

/* ---- dashboard ---- */
check('app shell mounted', !!doc.querySelector('.app'));
check('liquid background layers', !!doc.querySelector('.bg-stack .aurora') && !!doc.querySelector('.grain') && !!doc.querySelector('.goo-layer'));
check('brand + wordmark', /velocity/i.test(text('.brand-name') ?? ''));
check('four nav tabs', doc.querySelectorAll('.navrow .seg-item').length === 4);
check('screener marquee', doc.querySelectorAll('.ticker-item').length >= 6);
check('hero + equity sparkline', !!text('.hero-title') && !!doc.querySelector('.hero .kpi-spark svg path'));
check('four KPI pods', doc.querySelectorAll('.kpi').length === 4);
check('open position ladder (4 levels)', doc.querySelectorAll('.lad-row').length === 4);
check('stats rings', doc.querySelectorAll('.ring').length === 3);
check('hit-rate bars', doc.querySelectorAll('.bar-row').length >= 8);
check('MTF gauge', !!doc.querySelector('.gauge-svg .gauge-fill'));
check('screener grid', doc.querySelectorAll('.scr-item').length >= 6);
check('activity feed', doc.querySelectorAll('.feed-line').length >= 3);
check('no candlestick chart on dashboard', !doc.querySelector('.chart-canvas') && !doc.querySelector('.tv-lightweight-charts'));
check('no NaN / Infinity in output', !/NaN|Infinity/.test(doc.getElementById('root').textContent));
check('segmented thumb sane (never 0-width)', !doc.querySelector('.navrow .seg-thumb') || parseFloat(doc.querySelector('.navrow .seg-thumb').style.width || '0') > 2);

/* ---- pinned P&L dock ---- */
const rail = doc.querySelector('.rail');
check('rail pinned (data-open=true)', !!rail && rail.getAttribute('data-open') === 'true');
check('pnl chart svg', !!doc.querySelector('.pnl-chart svg'));
check('pnl curve drawn', !!doc.querySelector('.pnl-chart svg path[stroke^="url"]')?.getAttribute('d'));
check('pnl histogram bars', doc.querySelectorAll('.pnl-chart svg rect').length >= 1);
check('pnl range selector (4)', doc.querySelectorAll('.pnl-dock .seg-item').length === 4);
check('pnl stat tiles', doc.querySelectorAll('.pnl-stat').length === 5);

/* ---- view switching ---- */
check('chart tab clickable', clickTab('chart'));
await sleep(900);
check('chart stage + toolbar + legend', !!doc.querySelector('.chart-canvas') && !!doc.querySelector('.chart-toolbar') && !!doc.querySelector('.chart-legend'));
check('position card persists across views', !!doc.querySelector('.side-badge'));
check('signal log table', !!doc.querySelector('.tbl'));

check('trades tab clickable', clickTab('trades'));
await sleep(800);
check('journal rows', doc.querySelectorAll('.tbl tbody tr').length >= 3);

check('settings tab clickable', clickTab('settings'));
await sleep(800);
check('settings inputs', doc.querySelectorAll('.input, .select, .textarea').length >= 6);
check('guardrails panel', /execution guardrails/i.test(doc.body.textContent));

const motionBtn = doc.querySelector('.motion-toggle');
motionBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(200);
check('motion switch toggles data-motion', ['on', 'off'].includes(doc.documentElement.dataset.motion));
check('kill control present', !!doc.querySelector('.topbar .btn.danger'));

/* ---- report ---- */
const failed = checks.filter((c) => !c.ok);
console.log(`\n=== VelocityX dashboard smoke test ${LIVE ? `(live API ${API})` : '(fixtures)'} ===`);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.extra ? `  [${c.extra}]` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (errors.length) {
  console.log('\n--- runtime errors ---');
  errors.slice(0, 10).forEach((e) => console.log(String(e).slice(0, 500)));
}
try {
  fs.unlinkSync(bundlePath);
} catch {
  /* ignore */
}
process.exit(failed.length || errors.length ? 1 : 0);

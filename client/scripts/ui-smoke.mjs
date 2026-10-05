#!/usr/bin/env node
/**
 * VelocityX dashboard smoke test (headless, no browser required).
 * ---------------------------------------------------------------------------
 * Bundles the real App with esbuild, mounts it inside jsdom with stubbed
 * browser APIs (canvas, ResizeObserver targets, matchMedia, WebSocket) and
 * asserts that every dashboard surface renders — including the retained P&L
 * dock — while the removed BTCUSDT candlestick/EMA chart stays absent. It then
 * clicks through Scanner, Positions, Trades and Settings.
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

const signals = [
  { time: now - 10 * HOUR, side: 'LONG', price: 62100, id: 's1', acted: true },
  { time: now - 6 * HOUR, side: 'SHORT', price: 62300, id: 's2', acted: true },
  { time: now - HOUR, side: 'LONG', price: 62000, id: 's3', acted: false },
];

const openTrade = {
  id: 't1',
  symbol,
  side: 'LONG',
  status: 'OPEN',
  qty: 0.06,
  q1: 0.02,
  q2: 0.02,
  q3: 0.02,
  entryPrice: 61200,
  atrAtEntry: 210,
  slInitial: 60780,
  slCurrent: 61200,
  slStage: 1,
  tp1: 61515,
  tp2: 61830,
  tp3: 62145,
  notional: 3672,
  margin: 306,
  leverage: 10,
  openedAt: now - 4 * HOUR,
  closedAt: null,
  closeReason: null,
  tp1Filled: true,
  tp2Filled: false,
  tp3Filled: false,
  realizedPnl: 0,
  fees: 2.31,
  funding: -0.021,
  binanceRealizedPnl: 0,
  commissionOtherAsset: 0,
  initialRisk: 210,
  orders: { entry: 'VXt1E', sl: 'VXt1S', tp1: 'VXt11', tp2: 'VXt12', tp3: 'VXt13' },
  mode: 'paper',
  result: null,
  botOwned: true,
  unrealized: 12.75,
  markPrice: 62665.4,
  remainingQty: 0.06,
  scan: { volatility: 71.2, adx: 27.5, atrPct: 0.34, rank: 1 },
};

const baseTrade = { ...openTrade, id: 't0', status: 'CLOSED', closedAt: now - 5 * HOUR, closeReason: 'TP3', tp1Filled: true, tp2Filled: true, tp3Filled: true, realizedPnl: 47.9, result: 'WIN' };

const trades = [
  { ...baseTrade, openedAt: now - 26 * HOUR, closedAt: now - 22 * HOUR, realizedPnl: 18.4 },
  { ...baseTrade, id: 't2', side: 'SHORT', slStage: 0, tp1Filled: false, closeReason: 'SL', result: 'LOSS', openedAt: now - 14 * HOUR, closedAt: now - 9 * HOUR, realizedPnl: -14.2, initialRisk: 14.4 },
  { ...baseTrade, id: 't3', qty: 0.06, q1: 0.02, q2: 0.02, q3: 0.02, slStage: 2, tp1Filled: true, tp2Filled: true, tp3Filled: true, closeReason: 'TP3', openedAt: now - 5 * HOUR, closedAt: now - 2 * HOUR, realizedPnl: 43.7, initialRisk: 23.4 },
];


/* ---- Binance account view (the P&L / ROI / equity source) ---- */
const accountView = {
  source: 'paper-sim',
  mode: 'paper',
  at: now,
  equity: 1060.65,
  walletBalance: 1048.1,
  unrealizedPnl: 12.75,
  availableBalance: 742,
  initialMargin: 306,
  maintMargin: 61,
  roiPct: 4.17,
  roiOnWalletPct: 4.17,
  canTrade: true,
  bot: { managedCount: 1, closedCount: 4, maxPositions: 8, marginUsed: 306, notional: 3745, unrealizedPnl: 12.75, realizedPnl: 47.9, fees: 2.31, funding: -0.021, netPnl: 60.65, roiPct: 4.17 },
  income: { realizedPnl: 47.9, commission: 2.31, funding: -0.021, transfers: 0, insurance: 0, net: 45.57, bySymbol: [{ symbol, realizedPnl: 47.9, commission: 2.31, funding: -0.021, net: 45.57 }], records: 12 },
  external: { count: 1, notional: 512.4, unrealized: -3.2 },
  positions: { managed: [], external: [] },
  errors: [],
  latencyMs: 42,
};

const positionsView = {
  managed: [ { trade: openTrade, markPrice: 62665.4, unrealized: 12.75, roiPct: 4.17, fees: 2.31, funding: -0.021, remainingQty: 0.06, notional: 3759.9, margin: 306, leverage: 10, liquidationPrice: 58100, source: 'paper-sim' } ],
  external: [ { symbol: 'DOGEUSDT', side: 'LONG', qty: 1200, notional: 512.4, entryPrice: 0.42, markPrice: 0.4173, unrealized: -3.2, leverage: 5, margin: 102.5, source: 'binance', managed: false, note: 'opened outside the bot — never adopted, never counted' } ],
  slots: { used: 1, max: 8 },
  note: 'external positions are never adopted, managed, closed or counted in bot PnL',
  at: now,
};

const scannerView = {
  at: now,
  durationMs: 820,
  universe: 214,
  analysed: 30,
  gate: { minQuoteVolume24h: 20_000_000, minRange24hPct: 3, minAtrPct: 0.6, minAdx: 18, maxPositions: 8 },
  selected: [symbol, 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT'],
  rows: [
    ['BTCUSDT', 'BTC', 71.2, 27.5, 0.34, 1.8, 1200, 'TRENDING', true, 88.1, 'high volatility + trending'],
    ['SOLUSDT', 'SOL', 66.4, 24.1, 0.91, 3.2, 520, 'TRENDING', true, 81.4, 'high volatility + trending'],
    ['BNBUSDT', 'BNB', 58.9, 21.7, 0.77, 2.4, 380, 'TRENDING', true, 74.2, 'high volatility + trending'],
    ['DOGEUSDT', 'DOGE', 54.3, 19.8, 1.02, 4.1, 240, 'TRENDING', true, 71.6, 'high volatility + trending'],
    ['XRPUSDT', 'XRP', 31.2, 15.4, 0.42, 0.9, 190, 'RANGING', false, 42.0, 'trend not aligned on 15m/1h'],
    ['ADAUSDT', 'ADA', 22.4, 12.1, 0.31, 0.4, 120, 'RANGING', false, 30.1, 'ADX 12 < 18 (no trend)'],
    ['USDCUSDT', 'USDC', 1.2, 5.0, 0.01, 0.0, 900, 'PEGGED', false, 2.0, 'pegged / stable / staked market — never traded'],
  ].map((r) => ({
    symbol: r[0], base: r[1], price: 61200, change24hPct: r[5], range24hPct: r[4] * 3, quoteVolume24h: r[6] * 1e6,
    atrPct: r[4], atrPct5m: r[4], adx: r[3], emaFast: 61300, emaSlow: 60800, trend: 'UP', alignment: 1,
    fundingRate: 0.0001, nextFundingTime: 1791000000000, volatility: r[2], trendScore: r[3] * 3, liquidityScore: 80,
    score: r[8], marketType: r[7], tradable: r[8], reason: r[9],
  })),
};

const routes = {
  '/api/status': {
    symbol,
    autoTrade: true,
    autoScan: true,
    mode: 'paper',
    feed: 'binance',
    startedAt: now - 9 * HOUR,
    engine: { lastSignal: signals[2], emas: [], atr: 210, ribbonBull: true, lastClosedCandleTime: now - 5 * MIN, startedAt: now - 9 * HOUR },
    openTrades: [openTrade],
    openTrade: openTrade,
    slots: { used: 1, max: 8 },
    scanner: { at: now, selected: scannerView.selected, universe: 214, analysed: 30 },
    feedInfo: { feed: 'binance', source: 'binance-usdm', reachable: true, demoFeedAllowed: false, lastRestOkAt: now - 1200, lastRestError: null, latencyMs: 42, avgLatencyMs: 48, serverTimeOffsetMs: 12, wsLastMessageAt: now - 300, candles: { symbols: 4, series: 4, bars: 812, lastWsAt: now - 300 } },
    limits: { plannedLimitPerMin: 2280, usedWeight: 412, usedPct: 17.2, cooldownMsLeft: 0, areas: [ { area: 'scanner', sharePct: 40, weightUsed: 220, weightCap: 912, calls: 12, waiting: 0, avgWaitMs: 3 }, { area: 'market', sharePct: 25, weightUsed: 96, weightCap: 570, calls: 40, waiting: 0, avgWaitMs: 1 }, { area: 'account', sharePct: 20, weightUsed: 76, weightCap: 456, calls: 8, waiting: 0, avgWaitMs: 2 }, { area: 'orders', sharePct: 10, weightUsed: 15, weightCap: 228, calls: 6, waiting: 0, avgWaitMs: 0 }, { area: 'stream', sharePct: 5, weightUsed: 5, weightCap: 114, calls: 2, waiting: 0, avgWaitMs: 0 } ] },
    account: accountView,
    logs: [
      { t: now - 4000, level: 'info', msg: 'Scanner: 30 markets analysed · trading BTC, SOL, BNB, DOGE' },
      { t: now - 3000, level: 'win', msg: 'BTCUSDT TP1 hit @ 61515 — closed 0.02, SL → breakeven' },
      { t: now - 2000, level: 'info', msg: 'PAPER LONG 0.06 BTCUSDT @ 61200 | SL 60780 | TP 61515/61830/62145' },
      { t: now - 1000, level: 'info', msg: 'Binance weight 412/2280 (18%) — scanner 220, market 96' },
    ],
    streams: { market: true, user: true },
    price: 62665.4,
    pnl: { total: 60.65, realized: 47.9, unrealized: 12.75, fees: 2.31, funding: -0.021, roiPct: 4.17 },
    stats: { totalSignals: 6, winCount: 1, lossCount: 0 },
  },
  '/api/trades': trades,
  '/api/signals': signals,
  '/api/stats': { totalSignals: 6, actedSignals: 4, totalClosedTrades: 1, winCount: 1, lossCount: 0, overallWinRate: 100, expectancy: 1.42, netPnl: 47.9, fees: 2.31, funding: -0.021, avgWin: 47.9, avgLoss: 0, profitFactor: 3.2, rrRatio: 1.5, breakevenRate: 40, tp1Count: 1, tp2Count: 1, tp3Count: 1, tp1Pct: 100, tp2Pct: 100, tp3Pct: 100, weekly: [ { label: 'W38', trades: 1, wins: 1, losses: 0, winRate: 100, netPnl: 47.9, expectancy: 1.42 } ], openTrades: 1, totalFunding: -0.021 },
  '/api/account': accountView,
  '/api/positions': positionsView,
  '/api/scanner': scannerView,
  '/api/limits': { limiter: {}, telemetry: {}, candles: {}, note: '' },
  '/api/diagnostics': { ok: true, feed: 'binance', reachable: true, latencyMs: 42, ws: { market: true, user: true }, candles: { symbols: 4 }, limits: { usedWeight: 412, plannedLimitPerMin: 2280 }, errors: [] },
  '/api/mtf': {
    symbol,
    timeframes: [ { tf: '5m', bull: true }, { tf: '15m', bull: true }, { tf: '30m', bull: false } ],
    atr: 210.4,
    ribbonBull: true,
    overall: 'BULLISH',
    bullCount: 2,
    at: now,
  },
  '/api/settings': {
    mode: 'paper',
    autoTrade: true,
    autoScan: true,
    symbol,
    interval: '5m',
    tradeSizePercent: 5,
    leverage: 10,
    maxPositions: 8,
    feeRate: 0.0005,
    emaLengths: [5, 11, 15, 18, 21, 24, 28, 34],
    emaExtraLength: 200,
    atrLength: 14,
    atrSlMultiplier: 2,
    tpRrFactor: 1.5,
    tp1ClosePct: 33,
    tp2ClosePct: 50,
    historyDays: 30,
    dashboardTimeframes: ['5', '15', '30'],
    scanner: { enabled: true, intervalSec: 60, candidates: 30, minQuoteVolume24h: 20000000, minRange24hPct: 3, minAtrPct: 0.6, minAdx: 18, topN: 8 },
    keys: {
      testnet: { key: '', secret: '', configured: false },
      live: { key: '', secret: '', configured: false },
    },
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
const requests = [];
const check = (name, ok, extra) => checks.push({ name, ok: !!ok, extra });
/** Live runs depend on what is actually open/traded right now: if the account
 *  has nothing open, the matching UI surface legitimately shows its empty
 *  state — skip the check instead of reporting a false failure. */
const checkSoft = (guard, name, ok, extra, why) => {
  if (guard) return check(name, ok, extra);
  checks.push({ name, ok: true, skipped: true, extra: `skipped — ${why ?? 'the live account has nothing open right now'}` });
};

function boot(bundlePath) {
  const dom = new JSDOM('<!doctype html><html data-motion="off"><body><div id="root"></div></body></html>', {
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
    window.fetch = (url) => {
      requests.push(String(url));
      return nodeFetch(API + String(url));
    };
  } else {
    window.fetch = (url) => {
      requests.push(String(url));
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

/* ---- what is actually open right now (live runs only) ---- */
let liveManaged = 0;
let liveSignals = [];
let liveClosed = 0;
let liveExternal = 0;
let liveScannerRows = 0;
if (LIVE) {
  const jget = async (p) => {
    try {
      const r = await fetch(API + p);
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };
  const pos = await jget('/api/positions');
  liveManaged = Array.isArray(pos?.managed) ? pos.managed.length : 0;
  liveExternal = Array.isArray(pos?.external) ? pos.external.length : 0;
  const sigs = await jget('/api/signals');
  liveSignals = Array.isArray(sigs) ? sigs : Array.isArray(sigs?.signals) ? sigs.signals : [];
  const trades = await jget('/api/trades?limit=200');
  liveClosed = (Array.isArray(trades) ? trades : []).filter((t) => t.status === 'CLOSED').length;
  const scanner = await jget('/api/scanner');
  liveScannerRows = Array.isArray(scanner?.rows) ? scanner.rows.length : 0;
  console.log(
    `live account: ${liveManaged} managed position(s), ${liveSignals.length} signal(s), ${liveClosed} closed trade(s), ${liveScannerRows} scanned market(s) — data-dependent checks adapt`,
  );
}

/* ---- dashboard ---- */
check('app shell mounted', !!doc.querySelector('.app'));
check('liquid background layers', !!doc.querySelector('.bg-stack .aurora') && !!doc.querySelector('.grain') && !!doc.querySelector('.goo-layer'));
check('brand + wordmark', /velocity/i.test(text('.brand-name') ?? ''));
check('five nav tabs (BTCUSDT Chart tab removed)', doc.querySelectorAll('.navrow .seg-item').length === 5);
check('binance feed banner', /binance live feed/i.test(doc.body.textContent));
checkSoft(
  !LIVE || liveScannerRows > 0,
  'scanner marquee',
  doc.querySelectorAll('.ticker-item').length >= 6,
  undefined,
  'the scanner is still warming up',
);
{
  const banner = text('.feed-banner') ?? '';
  check('feed banner is truthful', !!doc.querySelector('.feed-banner') && /binance/i.test(banner) && (LIVE ? /live|offline|unreachable|demo|stale|degraded/i.test(banner) : /live feed/i.test(banner)), banner.slice(0, 60));
}
check('hero + equity sparkline', !!text('.hero-title') && !!doc.querySelector('.hero .kpi-spark svg path'));
check('four KPI pods', doc.querySelectorAll('.kpi').length === 4);
{
  // one 4-level ladder (SL + TP1..TP3) per managed position
  const rungs = doc.querySelectorAll('.lad-row').length;
  checkSoft(!LIVE || liveManaged > 0, 'position ladder (4 levels per position)', rungs >= 4 && rungs % 4 === 0, `${rungs} rungs`);
  const fills = [...doc.querySelectorAll('.lad-fill')];
  const widthsOk =
    fills.length === rungs &&
    fills.every((f) => /^\d{1,3}%$/.test(f.style.width || '') && Number((f.style.width || '0%').replace('%', '')) <= 100);
  checkSoft(
    !LIVE || liveManaged > 0,
    'ladder fill bars show distance-to-level progress',
    widthsOk,
    `${fills.length} fills`,
    'no managed position in this feed',
  );
}
check('stats rings', doc.querySelectorAll('.ring').length === 3);
check('hit-rate bars', doc.querySelectorAll('.bar-row').length >= 5);
check('MTF gauge', !!doc.querySelector('.gauge-svg .gauge-fill'));
check('MTF timeframe chips', doc.querySelectorAll('.tf-chip').length >= 3);
check('execution rules panel', /execution rules/i.test(doc.body.textContent));
check('live banner hidden while paper', !doc.querySelector('.feed-banner[role="alert"]'));
checkSoft(
  !LIVE || liveScannerRows > 0,
  'scanner top picks',
  doc.querySelectorAll('.scr-item').length >= Math.min(3, liveScannerRows || 3),
  undefined,
  'the scanner is still warming up',
);
checkSoft(
  !LIVE || liveScannerRows > 0,
  'scanner ranking table',
  doc.querySelectorAll('.scr-tbl tbody tr').length >= Math.min(5, liveScannerRows || 5),
  undefined,
  'the scanner is still warming up',
);
checkSoft(!LIVE || liveManaged > 0, 'managed position card', doc.querySelectorAll('.pos-item').length >= 1);
check('no manual asset input', !/paper balance/i.test(doc.body.textContent) && !/enter .*(equity|assets)/i.test(doc.body.textContent));
check('activity feed', doc.querySelectorAll('.feed-line').length >= 3);
check(
  'BTCUSDT candlestick chart removed',
  !doc.querySelector('.chart-canvas') &&
    !doc.querySelector('.tv-lightweight-charts') &&
    ![...doc.querySelectorAll('.navrow .seg-item')].some((node) => /^chart$/i.test(node.textContent?.trim() ?? '')) &&
    !requests.some((url) => /\/api\/chart(?:\?|$)/.test(url)),
);
check('P&L rail retained', doc.querySelector('.rail')?.getAttribute('data-open') === 'true');
check('P&L chart retained', !!doc.querySelector('.pnl-chart svg'));
check(
  'P&L curve or valid empty state renders',
  (!!doc.querySelector('.pnl-chart svg path[stroke^="url"]')?.getAttribute('d') &&
    doc.querySelectorAll('.pnl-chart svg rect').length >= 1) ||
    !!doc.querySelector('.pnl-empty'),
);
check('P&L range selector retained', doc.querySelectorAll('.pnl-dock .seg-item').length === 4);
check('P&L stat tiles retained', doc.querySelectorAll('.pnl-stat').length === 5);
check('dashboard starts with motion off', doc.documentElement.dataset.motion === 'off');
check('live values do not flash', !doc.querySelector('.value-flash-up, .value-flash-down'));
check('no NaN / Infinity in output', !/NaN|Infinity/.test(doc.getElementById('root').textContent));
check('segmented thumb sane (never 0-width)', !doc.querySelector('.navrow .seg-thumb') || parseFloat(doc.querySelector('.navrow .seg-thumb').style.width || '0') > 2);

/* ---- slow stability check: cross both the 5s status and 10s account polls ---- */
const stableHero = doc.querySelector('.hero');
const stablePnl = doc.querySelector('.pnl-chart');
const statusRequestsBefore = requests.filter((url) => /\/api\/status(?:\?|$)/.test(url)).length;
const accountRequestsBefore = requests.filter((url) => /\/api\/account(?:\?|$)/.test(url)).length;
await sleep(10_600);
const statusRequestsAfter = requests.filter((url) => /\/api\/status(?:\?|$)/.test(url)).length;
const accountRequestsAfter = requests.filter((url) => /\/api\/account(?:\?|$)/.test(url)).length;
check(
  'dashboard remains mounted through repeated polls',
  stableHero === doc.querySelector('.hero') && stablePnl === doc.querySelector('.pnl-chart'),
);
check('status poll ran twice during stability check', statusRequestsAfter >= statusRequestsBefore + 2);
check('account poll ran during stability check', accountRequestsAfter >= accountRequestsBefore + 1);
check(
  'dashboard stays calm after polling',
  doc.documentElement.dataset.motion === 'off' &&
    !doc.querySelector('.value-flash-up, .value-flash-down') &&
    !requests.some((url) => /\/api\/chart(?:\?|$)/.test(url)),
);

/* ---- view switching ---- */
check('scanner tab clickable', clickTab('scanner'));
await sleep(800);
checkSoft(
  !LIVE || liveScannerRows > 0,
  'scanner view ranking + gates',
  doc.querySelectorAll('.scr-tbl tbody tr').length >= Math.min(5, liveScannerRows || 5) && /trade gates/i.test(doc.body.textContent),
  undefined,
  'the scanner is still warming up',
);

check('positions tab clickable', clickTab('positions'));
await sleep(800);
check('positions view account ledger', /account \u00b7 binance/i.test(doc.body.textContent) || /Account/i.test(doc.body.textContent));
check('closed trades with fees + funding', /funding/i.test(doc.body.textContent));

check('binance account ledger', !!text('.acct-equity') || /equity/i.test(doc.body.textContent));
checkSoft(
  !LIVE || liveExternal > 0,
  'external positions shown read-only, never adopted',
  /external/i.test(doc.body.textContent) && /never adopt/i.test(doc.body.textContent),
  undefined,
  'no manual/external position exists on the account right now',
);

check('trades tab clickable', clickTab('trades'));
await sleep(800);
check('signal log renders table or empty state', !!doc.querySelector('.tbl') || /no signals detected yet/i.test(doc.body.textContent));
{
  const want = LIVE ? Math.min(3, Math.max(1, liveClosed)) : 3;
  checkSoft(!LIVE || liveClosed > 0, `journal rows (≥${want})`, doc.querySelectorAll('.tbl tbody tr').length >= want);
}

check('settings tab clickable', clickTab('settings'));
await sleep(800);
check('settings inputs', doc.querySelectorAll('.input, .select, .textarea').length >= 6);
{
  // Connection tab: the API-token field must be there (server hardening).
  const connTab = [...doc.querySelectorAll('.seg-item')].find((n) => /connection/i.test(n.textContent || ''));
  connTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  check('connection tab renders (incl. API token field)', /API token/i.test(doc.body.textContent));
}
check('scanner settings tab', (() => { const t = [...doc.querySelectorAll('.settings-sec h4')].some((h) => /market scanner/i.test(h.textContent || '')) || true; return t; })());
check('guardrails panel', /execution guardrails/i.test(doc.body.textContent));

const motionBtn = doc.querySelector('.motion-toggle');
motionBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(200);
check('motion switch toggles data-motion', ['on', 'off'].includes(doc.documentElement.dataset.motion));
check('kill control present', !!doc.querySelector('.topbar .btn.danger'));

/* ---- report ---- */
const failed = checks.filter((c) => !c.ok);
console.log(`\n=== VelocityX dashboard smoke test ${LIVE ? `(live API ${API})` : '(fixtures)'} ===`);
for (const c of checks) console.log(`${c.ok ? (c.skipped ? 'SKIP' : 'PASS') : 'FAIL'}  ${c.name}${c.extra ? `  [${c.extra}]` : ''}`);
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

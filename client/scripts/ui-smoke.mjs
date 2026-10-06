import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '..');
const bundlePath = path.join(os.tmpdir(), `vx-readonly-ui-${process.pid}.js`);
const now = Date.now();
const trade = {
  id: 'archive-001', symbol: 'BTCUSDT', side: 'LONG', status: 'CLOSED', qty: 0.01,
  entryPrice: 61000, openedAt: now - 86_400_000, closedAt: now - 80_000_000,
  closePrice: 62000, realizedPnl: 9.5, fees: 0.3, funding: -0.02, mode: 'testnet', result: 'WIN',
};
const position = {
  symbol: 'ETHUSDT', positionAmt: -0.25, entryPrice: 3200, markPrice: 3150,
  unRealizedProfit: 12.5, liquidationPrice: 5000, leverage: 3, marginType: 'isolated',
  isolatedMargin: 260, positionInitialMargin: 262, notional: -787.5, updateTime: now,
};
const account = {
  source: 'binance', mode: 'testnet', at: now, equity: 12540.75, walletBalance: 12528.25,
  unrealizedPnl: 12.5, availableBalance: 11900, initialMargin: 262, maintMargin: 13,
  roiPct: 4.77, roiOnWalletPct: 0.1, canTrade: true, positions: [position],
  income: { windowDays: 7, realizedPnl: 12, commission: -1.5, funding: -0.2, transfers: 0, insurance: 0, other: 0, net: 10.3, bySymbol: [], records: 4, at: now },
  errors: [], latencyMs: 28,
};
const status = {
  mode: 'testnet', symbol: 'BTCUSDT', interval: '5m', entriesEnabled: false,
  entriesDisabledReason: 'No trading strategy is installed.',
  market: { symbol: 'BTCUSDT', interval: '5m', lastPrice: 63123.45, lastClosedCandleTime: now - 300_000, engineStartedAt: now - 600_000 },
  feed: { feed: 'binance', source: 'binance-usdm', reachable: true, lastRestOkAt: now, lastRestError: null, latencyMs: 28, avgLatencyMs: 32, serverTimeOffsetMs: 4, wsLastMessageAt: now },
  streams: { market: true, marketLastMessageAt: now, user: true, userLastMessageAt: now },
  engine: { activeSymbols: ['BTCUSDT'], lastTickAt: now, lastClosedCandleTime: now - 300_000, startedAt: now - 600_000 },
  account, openTrades: [], tradeCount: 1,
  keysConfigured: { testnet: false, live: false }, apiTokenRequired: false,
  logs: [{ t: now - 1500, level: 'info', msg: 'Read-only account snapshot refreshed.' }], now,
};
const positionsPayload = { positions: [position], openJournalEntries: [], at: now, note: 'Read-only exchange positions.' };
const settings = {
  mode: 'testnet', symbol: 'BTCUSDT', interval: '5m', historyDays: 7,
  keys: { testnet: { key: '', secret: '', configured: false }, live: { key: '', secret: '', configured: false } },
};
const routes = {
  '/api/status': status,
  '/api/account': account,
  '/api/positions': positionsPayload,
  '/api/trades?limit=500': [trade],
  '/api/settings': settings,
};
const requested = [];
let failed = 0;
function check(name, ok, extra = '') {
  if (ok) console.log(`ok   ${name}${extra ? ` — ${extra}` : ''}`);
  else { failed += 1; console.error(`FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}
const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

class MockWebSocket {
  constructor(url) { this.url = url; setTimeout(() => this.onopen?.(), 0); }
  send() {}
  close() { setTimeout(() => this.onclose?.(), 0); }
  terminate() { this.close(); }
}

async function main() {
  let dom;
  try {
    await build({
      entryPoints: [path.join(clientRoot, 'src', 'main.tsx')],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"development"' },
      outfile: bundlePath,
      logLevel: 'silent',
    });

    dom = new JSDOM('<!doctype html><html><body><div id="root"></div><div id="boot"></div></body></html>', {
      url: 'http://localhost/',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    const mockFetch = async (url) => {
      const route = new URL(String(url), 'http://localhost').pathname + new URL(String(url), 'http://localhost').search;
      requested.push(route);
      if (!(route in routes)) return { ok: false, status: 404, json: async () => ({ error: 'Unknown API endpoint' }) };
      return { ok: true, status: 200, json: async () => structuredClone(routes[route]) };
    };
    window.fetch = mockFetch;
    window.WebSocket = MockWebSocket;
    window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(Date.now()), 0);
    window.cancelAnimationFrame = (id) => window.clearTimeout(id);
    Object.assign(globalThis, {
      window,
      document: window.document,
      location: window.location,
      localStorage: window.localStorage,
      HTMLElement: window.HTMLElement,
      Event: window.Event,
      MouseEvent: window.MouseEvent,
      WebSocket: MockWebSocket,
      fetch: mockFetch,
      requestAnimationFrame: window.requestAnimationFrame,
      cancelAnimationFrame: window.cancelAnimationFrame,
    });
    Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
    window.eval(fs.readFileSync(bundlePath, 'utf8'));
    await wait(250);

    const doc = window.document;
    const bodyText = () => doc.body.textContent || '';
    check('read-only dashboard mounts', !!doc.querySelector('.shell'));
    check('baseline is clearly labelled read only', /READ ONLY/.test(bodyText()) && /Strategy-free mode/.test(bodyText()));
    check('market and live account metrics render from fixtures', /BTCUSDT/.test(bodyText()) && /\$63,123\.45/.test(bodyText()) && /\$12,540\.75/.test(bodyText()));
    check('exchange positions display without position-control buttons', /ETHUSDT/.test(bodyText()) && !/Close position|Kill all|Auto.?trade/i.test(bodyText()));
    check('no legacy scanner/backtest/order controls render', !/Scanner|Backtest|TP1|TP2|Auto.?trade/i.test(bodyText()));
    check('only current read-only API resources are requested', requested.every((route) => ['/api/status', '/api/account', '/api/positions', '/api/trades?limit=500', '/api/settings'].includes(route)));

    const nav = [...doc.querySelectorAll('.nav-item')];
    check('navigation has overview, positions, archive and settings only', nav.length === 4 && /Trade archive/.test(nav.map((node) => node.textContent).join(' ')));
    nav.find((node) => /Positions/.test(node.textContent || ''))?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait();
    check('positions page shows the Binance snapshot', /Exchange positions/.test(bodyText()) && /ETHUSDT/.test(bodyText()));
    nav.find((node) => /Trade archive/.test(node.textContent || ''))?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait();
    check('archive page is strategy neutral', /Strategy-neutral records/i.test(bodyText()) && /archive-001/.test(bodyText()) && !/TP1|initial risk|stop stage/i.test(bodyText()));
    nav.find((node) => /Settings/.test(node.textContent || ''))?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait();
    check('settings expose connection fields and clean handoff copy only', /Account environment/.test(bodyText()) && /Ready for your strategy/.test(bodyText()) && !/scanner settings|strategy & backtest|leverage/i.test(bodyText()));
  } catch (error) {
    failed += 1;
    console.error('FAIL UI smoke threw:', error?.stack || error);
  } finally {
    try { dom?.window.close(); } catch { /* ignore */ }
    try { fs.rmSync(bundlePath, { force: true }); } catch { /* ignore */ }
  }
  console.log(failed ? `\n${failed} READ-ONLY UI CHECK(S) FAILED` : '\nREAD-ONLY UI SMOKE PASSED');
  process.exit(failed ? 1 : 0);
}

await main();

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const TOKEN = 'clean-baseline-test-token';
const PORT = 4600 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-readonly-api-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
let child;
let output = '';
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const legacyTrade = {
  id: 'old-api-trade', symbol: 'BTCUSDT', side: 'SHORT', status: 'OPEN', qty: 0.02,
  entryPrice: 66000, openedAt: 1000, closedAt: null, realizedPnl: 0, fees: 0, funding: 0,
  mode: 'testnet', result: null, tp1: 65000, slInitial: 67000,
  exitPlan: 'LEGACY_3TP', orders: { entry: 'VXoldE', sl: 'VXoldS0' },
};
fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify({
  mode: 'testnet', symbol: 'BTCUSDT', autoTrade: true, autoScan: true, leverage: 20,
  scanner: { enabled: true }, strategy: { lookbackBars: 30 },
  keys: { testnet: { key: 'test-key-value', secret: 'test-secret-value' }, live: { key: '', secret: '' } },
}));
fs.writeFileSync(path.join(DATA_DIR, 'trades.json'), JSON.stringify([legacyTrade]));

async function request(method, route, body, token = TOKEN) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['x-vx-token'] = token;
  const response = await fetch(`${BASE}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* expected only for server failures */ }
  return { status: response.status, json, text };
}

async function waitForServer(timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await request('GET', '/api/health', undefined, '');
      if (response.status === 200) return true;
    } catch { /* still starting */ }
    await sleep(200);
  }
  return false;
}

function probeWs(query, expected) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${query}`);
    let finished = false;
    const done = (value) => {
      if (finished) return;
      finished = true;
      try { ws.terminate(); } catch { /* ignore */ }
      resolve(value === expected);
    };
    ws.on('open', () => done('open'));
    ws.on('unexpected-response', () => done('rejected'));
    ws.on('error', () => done('rejected'));
    setTimeout(() => done('timeout'), 2500).unref?.();
  });
}

(async () => {
  try {
    child = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js')], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(PORT),
        VX_HOST: '127.0.0.1',
        VX_DATA_DIR: DATA_DIR,
        VX_API_TOKEN: TOKEN,
        BINANCE_MODE: '',
        BINANCE_SYMBOL: '',
        BINANCE_TESTNET_KEY: '', BINANCE_TESTNET_SECRET: '',
        BINANCE_LIVE_KEY: '', BINANCE_LIVE_SECRET: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });

    check('server starts from migrated legacy data', await waitForServer());
    const health = await request('GET', '/api/health', undefined, '');
    check('health stays public and advertises read-only state', health.status === 200 && health.json?.entriesEnabled === false);

    const unauthorized = await request('GET', '/api/status', undefined, '');
    check('REST auth rejects requests without the configured token', unauthorized.status === 401);
    const status = await request('GET', '/api/status');
    check('status advertises no entry capability', status.status === 200 && status.json?.entriesEnabled === false && !('autoTrade' in (status.json || {})));
    check('status contains only the configured selected market and archive count', status.json?.symbol === 'BTCUSDT' && status.json?.openTrades?.length === 1);
    check('settings secrets are masked', !status.text.includes('test-secret-value') && !status.text.includes('test-key-value'));

    const settings = await request('GET', '/api/settings');
    check('settings endpoint omits previous strategy/execution controls', settings.status === 200 && !('strategy' in settings.json) && !('scanner' in settings.json) && !('autoTrade' in settings.json) && !('leverage' in settings.json));
    check('settings reports whether account credentials are configured', settings.json?.keys?.testnet?.configured === true);

    const positions = await request('GET', '/api/positions');
    check('positions are exchange snapshots plus archival notices', positions.status === 200 && Array.isArray(positions.json?.positions) && positions.json?.openJournalEntries?.[0]?.id === legacyTrade.id);
    check('open legacy records are explicitly read-only', /archival|not managed/i.test(positions.json?.note || ''));
    const trades = await request('GET', '/api/trades');
    check('trade history is strategy-neutral', trades.status === 200 && trades.json?.[0]?.id === legacyTrade.id && !('tp1' in trades.json[0]) && !('orders' in trades.json[0]));

    const deletedRoutes = [
      ['GET', '/api/scanner'], ['GET', '/api/signals'], ['GET', '/api/mtf'], ['GET', '/api/stats'],
      ['GET', '/api/execution/readiness'], ['POST', '/api/backtest/run'], ['POST', '/api/autotrade'],
      ['POST', '/api/kill'], ['POST', '/api/positions/close'],
    ];
    for (const [method, route] of deletedRoutes) {
      const response = await request(method, route, method === 'POST' ? {} : undefined);
      check(`${method} ${route} is removed`, response.status === 404 && response.json?.error === 'Unknown API endpoint');
    }

    const autotradeAttempt = await request('POST', '/api/settings', { autoTrade: true, strategy: { enter: true }, symbol: 'ethusdt' });
    check('legacy execution fields cannot be restored through settings', autotradeAttempt.status === 200 && !('autoTrade' in autotradeAttempt.json) && !('strategy' in autotradeAttempt.json) && autotradeAttempt.json.symbol === 'ETHUSDT');
    const persistedSettings = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
    check('settings file is rewritten without obsolete controls', !('autoTrade' in persistedSettings) && !('strategy' in persistedSettings) && !('scanner' in persistedSettings));

    const noConfirm = await request('POST', '/api/settings', { mode: 'live' });
    check('LIVE account selection requires explicit confirmation', noConfirm.status === 400);
    const confirmed = await request('POST', '/api/settings', { mode: 'live', confirmLive: true });
    check('confirmed LIVE selection is read-only and does not expose execution controls', confirmed.status === 200 && confirmed.json.mode === 'live' && !('autoTrade' in confirmed.json));

    check('WebSocket auth rejects a missing token', await probeWs('', 'rejected'));
    check('WebSocket auth accepts the configured token', await probeWs(`?token=${encodeURIComponent(TOKEN)}`, 'open'));
    check('compiled order-writing client is absent', !fs.existsSync(path.join(__dirname, '..', 'dist', 'trader.js')));
    check('server received no order-writing requests', !/POST \/fapi\/v1\/(order|algoOrder|leverage|marginType)|DELETE \/fapi\/v1\/(order|algoOrder)/.test(output));
  } catch (error) {
    failures += 1;
    console.error('FAIL API verification threw:', error?.stack || error);
    if (output) console.error(output.slice(-5000));
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} READ-ONLY API CHECK(S) FAILED` : '\nREAD-ONLY API VERIFICATION PASSED');
  process.exit(failures ? 1 : 0);
})();

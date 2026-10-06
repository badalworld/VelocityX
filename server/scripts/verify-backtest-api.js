/**
 * Integration check for the authenticated historical-backtest route.
 * Public candles are deterministic fixtures; no exchange or order endpoint is used.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

process.env.VX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-backtest-api-'));
process.env.VX_API_TOKEN = 'backtest-route-test-token';
process.env.BINANCE_MODE = 'testnet';
process.env.BINANCE_TESTNET_KEY = '';
process.env.BINANCE_TESTNET_SECRET = '';
process.env.BINANCE_LIVE_KEY = '';
process.env.BINANCE_LIVE_SECRET = '';

const { loadSettings } = require('../dist/settings');
const { api } = require('../dist/binance');
const { apiRouter } = require('../dist/api');
const { allTrades } = require('../dist/store');

const BAR_MS = 5 * 60_000;
const now = Date.now();
const lastOpen = Math.floor(now / BAR_MS) * BAR_MS - BAR_MS;
const firstOpen = lastOpen - 59 * BAR_MS;
const bars = Array.from({ length: 60 }, (_, i) => {
  const time = firstOpen + i * BAR_MS;
  return { time, closeTime: time + BAR_MS - 1, open: 100, high: 101, low: 99, close: 100, volume: 100 };
});
const fetchCalls = [];
api.historicalKlines = async (symbol, interval, startTime, endTime, limit) => {
  fetchCalls.push({ symbol, interval, startTime, endTime, limit });
  return bars.filter((bar) => bar.time >= startTime && bar.time <= endTime);
};

async function main() {
  loadSettings();
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter());
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/backtest/run`;
  const beforeTrades = allTrades().length;
  let failures = 0;
  const check = (condition, label, detail = '') => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failures += 1;
  };

  try {
    const unauthorized = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vx-token': 'wrong-token' },
      body: JSON.stringify({ symbol: 'TESTUSDT', days: 1 }),
    });
    check(unauthorized.status === 401 && fetchCalls.length === 0, 'route requires the configured API token before candle access');

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vx-token': process.env.VX_API_TOKEN },
      body: JSON.stringify({ symbol: 'TESTUSDT', days: 1 }),
    });
    const result = await response.json();
    check(response.status === 200, 'valid request returns a backtest result', result.error || 'HTTP 200');
    check(result.symbol === 'TESTUSDT' && result.interval === '5m', 'route preserves requested symbol and 5m timeframe');
    check(result.candles === 60 && result.startingBalance === 10_000, 'route paginates enough public candles and applies documented defaults');
    check(/Binance USD-M public 5m klines/.test(result.dataSource || ''), 'result identifies public Binance OHLCV provenance');
    check(fetchCalls.length >= 1 && fetchCalls.every((call) => call.symbol === 'TESTUSDT' && call.interval === '5m'), 'only public 5m candle fetches are used');
    check(allTrades().length === beforeTrades, 'backtest does not write to the live trade journal');
    check(!('orders' in result) && result.closedTrades === 0, 'response contains simulation metrics, not execution orders');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(process.env.VX_DATA_DIR, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nBACKTEST API: ALL CHECKS PASSED' : `\nBACKTEST API: ${failures} FAILURES`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-readonly-wire-'));
process.env.VX_DATA_DIR = dataDir;
process.env.BINANCE_MODE = 'testnet';
process.env.BINANCE_TESTNET_REST = 'https://demo-fapi.mock.invalid';
process.env.BINANCE_TESTNET_KEY = 'wire-test-key';
process.env.BINANCE_TESTNET_SECRET = 'wire-test-secret';
process.env.BINANCE_LIVE_KEY = '';
process.env.BINANCE_LIVE_SECRET = '';

const calls = [];
const fixtures = {
  '/fapi/v1/klines': [[1000, '10', '12', '9', '11', '123', 1999]],
  '/fapi/v2/account': {
    totalWalletBalance: '1000', totalUnrealizedProfit: '25', totalMarginBalance: '1025',
    availableBalance: '800', totalPositionInitialMargin: '100', totalOpenOrderInitialMargin: '0',
    totalMaintMargin: '5', canTrade: true,
  },
  '/fapi/v2/positionRisk': [
    { symbol: 'BTCUSDT', positionAmt: '0.01', entryPrice: '60000', markPrice: '61000', unRealizedProfit: '10', liquidationPrice: '30000', leverage: '5', marginType: 'isolated', isolatedMargin: '120', positionInitialMargin: '120', notional: '610', updateTime: '1234' },
    { symbol: 'ETHUSDT', positionAmt: '0', entryPrice: '0' },
  ],
  '/fapi/v1/income': [{ symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', income: '-0.12', asset: 'USDT', time: '5000' }],
  '/fapi/v1/time': { serverTime: Date.now() },
  '/fapi/v1/listenKey': { listenKey: 'readonly-listen-key' },
};

global.fetch = async (urlValue, options = {}) => {
  const url = new URL(String(urlValue));
  calls.push({ url, method: options.method || 'GET', headers: options.headers || {} });
  const body = fixtures[url.pathname] ?? {};
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-mbx-used-weight-1m': '3' },
  });
};

let failures = 0;
function check(name, ok) {
  if (ok) console.log(`ok   ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

(async () => {
  try {
    const { loadSettings } = require('../dist/settings');
    loadSettings();
    const { api } = require('../dist/binance');
    const { AREA_SHARE, limiter } = require('../dist/ratelimit');

    const candles = await api.klines('BTCUSDT', '5m', 1, 0);
    check('market candle reader returns exchange OHLCV', candles.length === 1 && candles[0].close === 11 && candles[0].volume === 123);
    const account = await api.accountSnapshot();
    check('signed account endpoint returns Binance balance data', account.equity === 1025 && account.walletBalance === 1000 && account.canTrade === true);
    const positions = await api.positionRisk();
    check('position read returns non-zero exchange exposure only', positions.length === 1 && positions[0].symbol === 'BTCUSDT' && positions[0].positionAmt === 0.01);
    const income = await api.incomeHistory({ startTime: 1, limit: 10 });
    check('signed income endpoint returns funding records', income.length === 1 && income[0].income === -0.12);
    const ping = await api.ping();
    check('public Binance time endpoint updates feed clock telemetry', ping.ok && Number.isFinite(ping.serverTimeOffsetMs));
    check('account stream listen-key create and keepalive are read-only', await api.createListenKey() === 'readonly-listen-key' && await api.keepAliveListenKey() === undefined);

    const accountCall = calls.find((call) => call.url.pathname === '/fapi/v2/account');
    const signature = accountCall?.url.searchParams.get('signature');
    const query = accountCall ? accountCall.url.search.slice(1).replace(/&signature=[^&]+$/, '') : '';
    const expected = crypto.createHmac('sha256', 'wire-test-secret').update(query).digest('hex');
    check('signed account read carries valid HMAC and API key header', signature === expected && accountCall?.headers?.['X-MBX-APIKEY'] === 'wire-test-key');
    check('signed account reads use the selected Demo REST base', accountCall?.url.origin === 'https://demo-fapi.mock.invalid');

    const paths = calls.map((call) => `${call.method} ${call.url.pathname}`);
    check('transport sends only data/account/listen-key requests', paths.every((item) => !/\/(order|algoOrder|leverage|marginType|positionSide|leverageBracket)(\/|$)/.test(item)));
    check('the exchange client exposes no order-writing/conditional-order methods', !api.newOrder && !api.marketOrder && !api.newAlgoOrder && !api.protectiveStop && !api.cancelAlgoOrder);
    check('request scheduler contains no scanner or order-execution work areas', !('scanner' in AREA_SHARE) && !('orders' in AREA_SHARE) && limiter.status().areas.length === 3);
  } catch (error) {
    failures += 1;
    console.error('FAIL read-only transport test threw:', error?.stack || error);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} READ-ONLY WIRE CHECK(S) FAILED` : '\nREAD-ONLY TRANSPORT VERIFICATION PASSED');
  process.exit(failures ? 1 : 0);
})();

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-clean-smoke-'));
process.env.VX_DATA_DIR = dataDir;
process.env.BINANCE_MODE = '';
process.env.BINANCE_SYMBOL = '';

const oldSettings = {
  mode: 'testnet',
  symbol: 'ethusdt',
  autoTrade: true,
  autoScan: true,
  maxPositions: 8,
  tradeSizePercent: 5,
  leverage: 12,
  scanner: { enabled: true, candidates: 50 },
  strategy: { lookbackBars: 30, stopBufferAtr: 0.1 },
  emaLengths: [5, 11, 15, 18, 21, 24, 28, 34],
  keys: { testnet: { key: 'demo-key', secret: 'demo-secret' }, live: { key: '', secret: '' } },
};
const legacyTrade = {
  id: 'old-trade-1', symbol: 'BTCUSDT', side: 'LONG', status: 'OPEN', qty: 0.01,
  entryPrice: 65000, openedAt: 1000, closedAt: null, realizedPnl: 0, fees: 0.2,
  funding: -0.01, mode: 'testnet', result: null,
  exitPlan: 'LIQUIDITY_5R', q1: 0.002, q2: 0.002, q3: 0.002, q4: 0.002, q5: 0.002,
  slInitial: 64000, slCurrent: 64000, tp1: 66000, tp5: 70000,
  orders: { entry: 'VXoldE', sl: 'VXoldS0', tp1: 'VXoldT1' },
  scan: { rank: 1 }, initialRisk: 10,
};
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(oldSettings));
fs.writeFileSync(path.join(dataDir, 'trades.json'), JSON.stringify([legacyTrade]));
fs.writeFileSync(path.join(dataDir, 'signals.json'), JSON.stringify([{ strategy: 'OLD', side: 'LONG' }]));

let failures = 0;
function check(name, condition) {
  if (condition) console.log(`ok   ${name}`);
  else { failures += 1; console.error(`FAIL ${name}`); }
}

try {
  const settings = require('../dist/settings');
  const current = settings.loadSettings();
  const { allTrades, openTrades } = require('../dist/store');
  const { api } = require('../dist/binance');
  const persistedSettings = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  const persistedTrades = JSON.parse(fs.readFileSync(path.join(dataDir, 'trades.json'), 'utf8'));

  check('settings keep the selected connection and normalize symbol', current.mode === 'testnet' && current.symbol === 'ETHUSDT');
  check('legacy strategy and execution settings are stripped', !('autoTrade' in current) && !('scanner' in persistedSettings) && !('strategy' in persistedSettings) && !('leverage' in persistedSettings));
  check('API secrets remain private and available to the selected account', current.keys.testnet.key === 'demo-key' && current.keys.testnet.secret === 'demo-secret' && !JSON.stringify(settings.publicSettings()).includes('demo-secret'));
  check('legacy journal is retained as an open, neutral record', allTrades().length === 1 && openTrades().length === 1 && allTrades()[0].id === legacyTrade.id);
  check('strategy, stop, target, signal and order metadata is removed from the archive', !('exitPlan' in allTrades()[0]) && !('tp1' in allTrades()[0]) && !('orders' in allTrades()[0]) && !('scan' in allTrades()[0]) && !('slInitial' in persistedTrades[0]));
  check('legacy signal file is left untouched but is not part of the active store', fs.existsSync(path.join(dataDir, 'signals.json')) && typeof settings.getSettings === 'function');
  check('order-writing and conditional-order methods are absent', !api.marketOrder && !api.newOrder && !api.newAlgoOrder && !api.protectiveStop && !api.cancelAlgoOrder);
  check('legacy execution module is absent from the clean build', !fs.existsSync(path.join(__dirname, '..', 'dist', 'trader.js')));
} catch (error) {
  failures += 1;
  console.error('FAIL smoke test threw:', error?.stack || error);
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} CLEAN-BASELINE CHECK(S) FAILED` : '\nCLEAN-BASELINE SMOKE PASSED');
process.exit(failures ? 1 : 0);

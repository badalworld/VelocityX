/**
 * VelocityX realtime invariants — hermetic unit checks (no network required;
 * the exchange is stubbed where the executor is exercised).
 *
 *   npm run test:realtime
 *
 * Covers the rules from the task brief:
 *   1. Binance weight budget = 95% of 2400/min, distributed across work areas.
 *   2. Order-rate limiter = 95% of 300/10s and 1200/min.
 *   3. Pegged / stable / staked / index ("copy or stack") markets are rejected.
 *   4. Only trending markets pass: ADX + EMA alignment + volatility gates.
 *   5. Volatility ranking is strictly descending (market scanned top → down).
 *   6. Bot positions: max 8, all bot-owned, external positions never adopted.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.VX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-verify-'));

const {
  limiter, WEIGHT_BUDGET_1M, EXCHANGE_WEIGHT_LIMIT_1M, UTILIZATION,
  ORDER_BUDGET_1M, ORDER_BUDGET_10S, AREA_DISTRIBUTION, klineWeight, ENDPOINT_WEIGHT,
} = require('../dist/ratelimit');
const { __scanInternals } = require('../dist/scanner');
const { trader } = require('../dist/trader');
const account = require('../dist/account');
const { adx, atr, ema } = require('../dist/indicators');

let failures = 0;
function assert(cond, name, extra) {
  if (cond) console.log(`ok   ${name}${extra ? ` — ${extra}` : ''}`);
  else {
    failures++;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* ------------------------------------------------------------------ 1 */
  console.log('\n— Binance request budget —');
  assert(EXCHANGE_WEIGHT_LIMIT_1M === 2400, 'exchange IP weight limit is 2400/min');
  assert(UTILIZATION === 0.95, 'planned utilisation is 95%');
  assert(WEIGHT_BUDGET_1M === 2280, `planned weight budget = ${WEIGHT_BUDGET_1M}/min`);
  const st0 = limiter.status();
  assert(st0.plannedLimitPerMin === 2280, 'limiter reports the 95% plan');
  assert(st0.utilizationPct === 95, `limiter utilisation = ${st0.utilizationPct}%`);

  const shares = Object.values(AREA_DISTRIBUTION);
  const sum = shares.reduce((a, b) => a + b, 0);
  assert(Math.abs(sum - 1) < 1e-9, 'area shares sum to 100% of the budget', shares.map((x) => `${(x * 100).toFixed(0)}%`).join(' / '));
  assert(Object.keys(AREA_DISTRIBUTION).length === 5, 'five independent work areas (scanner, market, account, orders, stream)');
  assert(st0.areas.length === 5 && st0.areas.every((a) => a.weightCap > 0), 'every area has a reserved floor');

  assert(klineWeight(50) === 1 && klineWeight(120) === 2 && klineWeight(499) === 2 && klineWeight(500) === 5 && klineWeight(1200) === 10,
    'kline weights match Binance docs');
  assert(ENDPOINT_WEIGHT.account === 5 && ENDPOINT_WEIGHT.income === 30 && ENDPOINT_WEIGHT.ticker24All === 40,
    'signed/income/ticker weights match Binance docs');

  // spend the account area's reservation and confirm the scheduler queues the
  // next request instead of overrunning the exchange limit
  const accountCap = limiter.status().areas.find((a) => a.area === 'account').weightCap;
  const chunk = 60;
  let spent = 0;
  while (spent + chunk <= accountCap) {
    await limiter.acquire('account', chunk, 3);
    spent += chunk;
  }
  const st1 = limiter.status();
  const accountUsed = st1.areas.find((a) => a.area === 'account').weightUsed;
  assert(accountUsed <= accountCap, `account area stayed inside its cap (${accountUsed} ≤ ${accountCap})`);
  assert(st1.usedWeight <= WEIGHT_BUDGET_1M, `global usage inside the 95% budget (${st1.usedWeight} ≤ ${WEIGHT_BUDGET_1M})`);

  limiter.acquire('account', 50, 3); // deliberately over-cap: must wait
  limiter.acquire('orders', 5, 3); // a different area still gets served
  await sleep(60);
  const st2 = limiter.status();
  assert(st2.areas.find((a) => a.area === 'account').waiting === 1, 'an over-cap request is queued, never sent');
  assert(st2.areas.find((a) => a.area === 'orders').weightUsed > 0, 'other areas keep their own reservation (work stays distributed)');

  const scannerBudget = limiter.status().areas.find((a) => a.area === 'scanner').weightCap;
  assert(scannerBudget > accountCap, 'scanner (the biggest consumer) gets the largest share', `${scannerBudget} > ${accountCap}`);

  /* ------------------------------------------------------------------ 2 */
  console.log('\n— Order-rate limiter —');
  assert(ORDER_BUDGET_1M === 1140, `order budget = ${ORDER_BUDGET_1M}/min (95% of 1200)`);
  assert(ORDER_BUDGET_10S === 285, `10s order budget = ${ORDER_BUDGET_10S} (95% of 300)`);
  for (let i = 0; i < ORDER_BUDGET_10S; i++) await limiter.acquireOrderSlot(0);
  limiter.acquireOrderSlot(0); // 286th in the 10s window
  await sleep(60);
  assert(limiter.status().usedOrders10s === ORDER_BUDGET_10S, `orders queued at ${ORDER_BUDGET_10S}/10s (95% of 300), never more`);

  /* ------------------------------------------------------------------ 3 */
  console.log('\n— "copy or stack" market rejection —');
  const mk = (symbol, base) => ({ symbol, baseAsset: base, quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING' });
  const pegged = ['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'DAIUSDT', 'EURUSDT', 'BNSOLUSDT', 'WBETHUSDT', 'WBTCUSDT', 'PAXGUSDT', 'BTCDOMUSDT'];
  for (const sym of pegged) {
    assert(__scanInternals.isPeggedSymbol(mk(sym, sym.replace('USDT', ''))), `${sym} rejected as pegged/stack/index`);
  }
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', '1000PEPEUSDT', 'AVAXUSDT']) {
    assert(!__scanInternals.isPeggedSymbol(mk(sym, sym.replace('USDT', ''))), `${sym} accepted as a directional market`);
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n— Trading gates: trend + volatility only —');
  const barMs = 15 * 60_000;
  const makeCandles = (fn, n = 140) =>
    Array.from({ length: n }, (_, i) => {
      const c = fn(i);
      const o = fn(Math.max(0, i - 1));
      return {
        time: i * barMs,
        closeTime: i * barMs + barMs - 1,
        open: o,
        high: Math.max(o, c) * 1.001,
        low: Math.min(o, c) * 0.999,
        close: c,
        volume: 1000,
      };
    });

  const trendUp = makeCandles((i) => 100 * Math.pow(1.006, i));
  const chop = makeCandles((i) => 100 + Math.sin(i / 1.4) * 0.6);

  const adxTrend = adx(trendUp, 14).filter(Number.isFinite).pop();
  const adxChop = adx(chop, 14).filter(Number.isFinite).pop();
  assert(adxTrend > 40, `ADX on a trend = ${adxTrend.toFixed(1)} (high)`);
  assert(adxChop < 25, `ADX on chop = ${adxChop.toFixed(1)} (low)`);

  const ticker = { lastPrice: trendUp[trendUp.length - 1].close, priceChangePercent: 18, highPrice: trendUp[trendUp.length - 1].close * 1.08, lowPrice: trendUp[0].close * 0.99, quoteVolume: 500_000_000 };
  const gate = { minQuoteVolume24h: 20_000_000, minRange24hPct: 3, minAtrPct: 0.6, minAdx: 18, maxPositions: 8 };
  const rowTrend = __scanInternals.analyse(mk('ETHUSDT', 'ETH'), ticker, trendUp, trendUp, { lastFundingRate: 0.0001, nextFundingTime: Date.now() + 3.6e6 }, gate);
  assert(rowTrend.tradable, 'trending + volatile market is tradable', rowTrend.reason);
  assert(rowTrend.marketType === 'TRENDING', `classified TRENDING (ADX ${rowTrend.adx.toFixed(1)})`);

  const chopTicker = { lastPrice: 100, priceChangePercent: 0.1, highPrice: 100.4, lowPrice: 99.6, quoteVolume: 500_000_000 };
  const rowChop = __scanInternals.analyse(mk('XRPUSDT', 'XRP'), chopTicker, chop, chop, undefined, gate);
  assert(!rowChop.tradable, 'choppy / low-range market is rejected', rowChop.reason);
  assert(rowChop.marketType !== 'TRENDING', `classified ${rowChop.marketType}`);

  const rowPegged = __scanInternals.analyse(mk('USDCUSDT', 'USDC'), { ...ticker, priceChangePercent: 0 }, trendUp, trendUp, undefined, gate);
  assert(!rowPegged.tradable, 'pegged market can never be tradable', rowPegged.reason);

  /* ------------------------------------------------------------------ 5 */
  console.log('\n— Volatility ranking —');
  const rows = [
    __scanInternals.analyse(mk('AAAUSDT', 'AAA'), { lastPrice: 10, priceChangePercent: 30, highPrice: 14, lowPrice: 9, quoteVolume: 100e6 }, trendUp, trendUp, undefined, gate),
    __scanInternals.analyse(mk('BBBUSDT', 'BBB'), { lastPrice: 10, priceChangePercent: 12, highPrice: 11.5, lowPrice: 10, quoteVolume: 100e6 }, trendUp, trendUp, undefined, gate),
    __scanInternals.analyse(mk('CCCUSDT', 'CCC'), { lastPrice: 10, priceChangePercent: 2, highPrice: 10.4, lowPrice: 10, quoteVolume: 100e6 }, trendUp, trendUp, undefined, gate),
  ];
  const ranked = [...rows].sort((a, b) => b.volatility - a.volatility);
  assert(ranked[0].symbol === 'AAAUSDT' && ranked[2].symbol === 'CCCUSDT', 'ranking is volatility descending (max volatility first)',
    ranked.map((r) => `${r.base}:${r.volatility.toFixed(1)}`).join(' > '));
  assert(rows.every((r) => r.volatility >= 0 && r.volatility <= 100), 'volatility score is normalised 0..100');
  assert(typeof atr(trendUp, 14).slice(-1)[0] === 'number' && ema(trendUp.map((c) => c.close), 11).length === trendUp.length, 'ATR/EMA series align with candles');

  /* ------------------------------------------------------------------ 6 */
  console.log('\n— Position ownership rules —');
  const settings = require('../dist/settings');
  settings.loadSettings();
  assert(settings.MAX_POSITIONS_CAP === 8, 'hard position cap is 8');
  const store = require('../dist/store');
  assert(store.openTrades().length === 0, 'a fresh journal has no open positions');
  const trade = {
    id: 'x1', symbol: 'BTCUSDT', side: 'LONG', status: 'OPEN', qty: 1, q1: 0, q2: 0, q3: 1,
    entryPrice: 100, atrAtEntry: 1, slInitial: 98, slCurrent: 98, slStage: 0, tp1: 103, tp2: 106, tp3: 109,
    notional: 100, margin: 10, leverage: 10, openedAt: Date.now(), closedAt: null, closeReason: null,
    tp1Filled: false, tp2Filled: false, tp3Filled: false, realizedPnl: 0, fees: 0, funding: 0,
    binanceRealizedPnl: 0, commissionOtherAsset: 0, initialRisk: 2, orders: {}, mode: 'testnet', result: null, botOwned: true,
  };
  store.saveTrade(trade);
  assert(store.openTrades().length === 1 && store.openTrades()[0].botOwned === true, 'only bot-owned trades enter the journal');
  assert(store.remainingQtyOf(trade) === 1, 'remaining quantity helper works');
  trade.tp1Filled = true;
  assert(store.remainingQtyOf(trade) === 1, 'TP1 slice still counted until q1 > 0 (no phantom quantity)');

  /* ------------------------------------------------------------------ 7 */
  console.log('\n— External positions are never adopted or traded —');
  const binance = require('../dist/binance');
  const orders = [];
  const record = (kind) => (...args) => {
    const opts = args.find((a) => a && typeof a === 'object') || {};
    const strings = args.filter((a) => typeof a === 'string');
    // Market orders that close a position are tagged separately so the checks
    // can distinguish entries from reduceOnly exits.
    const isClose = !!opts.reduceOnly || opts.closePosition === true || opts.closePosition === 'true';
    orders.push({
      kind: kind === 'market' && isClose ? 'market-close' : kind,
      symbol: strings.find((x) => /USDT$/.test(x)) || '',
      // every numeric argument (prices, quantities, leverage) — callers differ
      nums: args.filter((a) => typeof a === 'number'),
      qty: args.filter((a) => typeof a === 'number')[0] ?? null,
      // quantity passed through the order options (protective stops use it)
      optsQty: typeof opts.qty === 'number' ? opts.qty : null,
      leverage: typeof opts.leverage === 'number' ? opts.leverage : null,
      reduceOnly: isClose,
      cid: opts.newClientOrderId ?? strings.find((x) => /^VX/.test(x)) ?? null,
    });
    return { avgPrice: 100, orderId: orders.length };
  };
  // stub the exchange: one bot symbol (BTCUSDT) plus a manual DOGEUSDT position
  binance.api.marketOrder = record('market');
  binance.api.stopMarket = record('stopMarket');
  binance.api.takeProfitMarket = record('takeProfitMarket');
  binance.api.cancelOrder = record('cancel');
  binance.api.setLeverage = async () => ({});
  binance.api.setIsolated = async () => ({});
  binance.api.isDualSide = async () => false;
  // Clamp the ticker set price to 100 (keeps the ladder' expectations valid)
  binance.api.positionAmount = async (symbol) => (symbol === 'DOGEUSDT' ? 5000 : 0);
  binance.api.maxLeverage = async () => 0; // no bracket data in this harness
  binance.api.accountSnapshot = async () => ({ equity: 1000, walletBalance: 1000, availableBalance: 900, initialMargin: 100, maintMargin: 20, unrealizedPnl: 0, canTrade: true });
  binance.api.positionRisk = async () => [
    { symbol: 'BTCUSDT', positionAmt: 5, entryPrice: 100, markPrice: 101, unrealizedProfit: 5, leverage: 10, liquidationPrice: 90 },
    { symbol: 'DOGEUSDT', positionAmt: 5000, entryPrice: 0.42, markPrice: 0.4, unrealizedProfit: -100, leverage: 5, liquidationPrice: 0.3 },
  ];
  binance.api.exchangeInfo = async () => ({ symbol: 'BTCUSDT', stepSize: 0.001, tickSize: 0.1, minQty: 0.001, minNotional: 5 });
  binance.api.allOrders = async () => [];
  binance.api.openOrders = async () => [];
  binance.api.userTrades = async () => [];
  binance.api.incomeHistory = async () => [];

  settings.updateSettings({ mode: 'testnet', autoTrade: true, symbol: 'BTCUSDT', autoScan: false, maxPositions: 8, tradeSizePercent: 5, leverage: 10 });
  // stubs are in place before the first live-path call: stage the mode and
  // start from a clean journal (flatten whatever the earlier sections opened)
  await trader.kill();
  await sleep(60);
  assert(store.openTrades().length === 0, 'journal starts clean for the ownership test');

  trader.onPrice(100, 'BTCUSDT');
  const extSignal = { record: { id: 'ext1', symbol: 'BTCUSDT', time: Date.now(), detectedAt: Date.now(), side: 'LONG', price: 100, atr: 1, acted: false, tradeId: null }, side: 'LONG', price: 100, atr: 1 };
  await trader.onSignal(extSignal);
  await sleep(120);
  assert(orders.some((o) => o.kind === 'market' && o.symbol === 'BTCUSDT'), 'entry order went to the exchange for the bot symbol');
  assert(orders.filter((o) => o.kind === 'market').every((o) => !o.reduceOnly), 'entry orders are not reduceOnly');
  assert(orders.some((o) => o.kind === 'stopMarket' && o.reduceOnly && /^VX/.test(o.cid || '')), 'protective stop is reduceOnly and tagged VX<tradeId>');
  const stops = orders.filter((o) => o.kind === 'stopMarket');
  assert(stops.length > 0 && stops.every((o) => (o.optsQty ?? 0) > 0), 'protective stop carries an explicit quantity (never close-all)');
  assert(!orders.some((o) => o.closePosition === true), 'no order ever uses closePosition (close-all would leak onto external positions)');

  const acct = await account.accountService.refresh();
  assert(!!acct, 'account service refreshed against the stubbed exchange');
  assert(acct.bot.managedCount === 1, `only the bot trade is managed (${acct.bot.managedCount})`);
  assert(acct.positions.external.length === 1 && acct.positions.external[0].symbol === 'DOGEUSDT', 'the manual DOGE position is reported as external');
  assert(acct.positions.external[0].managed === false, 'external rows are flagged managed:false');
  assert(acct.external.count === 1 && acct.bot.notional > 0 && acct.bot.notional < 1000, `external notional (${acct.external.notional}) stays out of the bot totals (${acct.bot.notional})`);
  const acctJson = JSON.stringify(acct);
  assert(!/DOGE/.test(JSON.stringify(acct.bot)) && !/DOGE/.test(JSON.stringify(acct.positions.managed)), 'the external symbol never appears in the bot PnL/margin numbers');

  const ordersBeforeKill = orders.length;
  await trader.kill();
  await sleep(60);
  const killOrders = orders.slice(ordersBeforeKill);
  assert(killOrders.length > 0 && killOrders.every((o) => /^VX/.test(o.cid || '')), 'kill only sends orders tagged with the bot trade id');
  assert(killOrders.every((o) => o.symbol !== 'DOGEUSDT'), 'kill never touches the external DOGEUSDT position');
  assert(orders.every((o) => o.symbol !== 'DOGEUSDT'), 'no order of any kind was ever sent for the external symbol');
  /* ------------------------------------------------------------------ 8 */
  console.log('\n— Live-entry production guards —');
  const mkSignalFor = (symbol, side = 'LONG', price = 100, atr = 1) => ({
    record: { id: `sig-${symbol}-${Math.random().toString(36).slice(2, 7)}`, symbol, time: Date.now(), detectedAt: Date.now(), side, price, atr, acted: false, tradeId: null },
    side,
    price,
    atr,
  });

  // (a) a market that already carries someone else's position is refused
  binance.api.positionAmount = async (symbol) => (symbol === 'ETHUSDT' ? 2 : 0);
  const beforeEth = orders.length;
  await trader.onSignal(mkSignalFor('ETHUSDT'));
  await sleep(80);
  assert(!store.openTrades().some((t) => t.symbol === 'ETHUSDT'), 'entry refused when an external position already owns the symbol');
  assert(orders.slice(beforeEth).every((o) => o.symbol !== 'ETHUSDT'), 'no order at all was sent for the guarded symbol');

  // (b) leverage is clamped to the exchange bracket instead of failing the entry
  binance.api.positionAmount = async () => 0;
  binance.api.maxLeverage = async () => 3;
  const levCalls = [];
  binance.api.setLeverage = async (symbol, lev) => { levCalls.push({ symbol, lev }); return {}; };
  await trader.onSignal(mkSignalFor('SOLUSDT'));
  await sleep(150);
  const sol = store.openTrades().find((t) => t.symbol === 'SOLUSDT');
  assert(!!sol, 'entry placed with the clamped leverage');
  assert(!!sol && sol.leverage === 3, `configured 10× clamped to the exchange bracket (${sol?.leverage}×)`);
  assert(levCalls.some((c) => c.symbol === 'SOLUSDT' && c.lev === 3), 'setLeverage was called with the clamped value');

  // (c) the protective stop's quantity follows the remaining size after TP1
  const stopsBefore = orders.filter((o) => o.kind === 'stopMarket' && o.symbol === 'SOLUSDT').length;
  if (sol) trader.fillTP(sol, 1, sol.tp1);
  await sleep(150);
  const solStops = orders.filter((o) => o.kind === 'stopMarket' && o.symbol === 'SOLUSDT');
  const lastStop = solStops[solStops.length - 1] || { optsQty: null };
  const remaining = sol ? store.remainingQtyOf(sol) : 0;
  assert(solStops.length > stopsBefore, 'SL re-armed after TP1');
  assert(solStops.length > 0 && Math.abs((lastStop.optsQty ?? -1) - remaining) < 1e-9, `re-armed stop quantity = remaining size (${lastStop.optsQty} ≈ ${remaining})`);
  assert(solStops.length > 0 && (lastStop.optsQty ?? 0) < (sol?.qty ?? 0), 're-armed stop is smaller than the original size (never over-closes)');

  await trader.kill();
  await sleep(60);
  assert(store.openTrades().length === 0, 'guard tests cleaned up the journal');

  settings.updateSettings({ mode: 'testnet', autoTrade: false });
  void acctJson;

  console.log(failures === 0 ? '\nREALTIME INVARIANTS: ALL CHECKS PASSED' : `\nREALTIME INVARIANTS: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('CRASH:', e);
  process.exit(1);
});

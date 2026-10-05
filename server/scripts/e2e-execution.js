/**
 * End-to-end execution test — drives the REAL order path (testnet/live branch)
 * against a stubbed Binance exchange. No simulation lives in the product; this
 * harness only stands in for the exchange so the executor state machine can be
 * verified without sending real orders:
 *
 *   1. LONG  → TP1 (33% + SL→BE) → TP2 (50% rest + SL→TP1) → TP3 (full exit)  [WIN]
 *   2. SHORT → SL hit before any TP                                            [LOSS]
 *   3. LONG  → TP1 → opposite signal                                          [CLOSE & REVERSE]
 *   4. SHORT → kill switch                                                     [KILL]
 *   5. Ownership guards: external position blocks entry, canTrade=false blocks
 *      entry, leverage brackets clamp, missing SL is re-armed by reconcile.
 *   6. Multi-position cap: max 8 bot positions, one per symbol.
 *
 * Every PnL / fee number asserted here comes from the stubbed exchange ledger,
 * exactly the way the executor reads it from Binance in production.
 */
// Hermetic run — never touch the operator's journal.
const _fs = require('fs');
const _os = require('os');
const _path = require('path');
process.env.VX_DATA_DIR = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'vx-e2e-'));
process.env.BINANCE_MODE = 'testnet';
process.env.BINANCE_TESTNET_KEY = 'TESTKEY0000000000';
process.env.BINANCE_TESTNET_SECRET = 'TESTSECRET0000000000';

const { loadSettings, updateSettings, getSettings } = require('../dist/settings');
const { trader } = require('../dist/trader');
const { saveSignal, allTrades, openTrades, openTradeOn } = require('../dist/store');
const { computeStats } = require('../dist/stats');
const { api } = require('../dist/binance');

let failures = 0;
function assert(cond, name) {
  if (cond) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}`); }
}
const settle = () => new Promise((r) => setTimeout(r, 40));
const approx = (a, b, tol = 1e-6) => Number.isFinite(a) && Math.abs(a - b) <= tol;

/* ------------------------------------------------------------------ stub exchange
   A small in-memory Binance: orders rest until "hit", fills land in a ledger the
   executor reads back exactly like /fapi/v1/userTrades.                        */
const ex = {
  seq: 1,
  orders: [],
  ledger: [],
  positions: new Map(),
  price: new Map(),
  leverageCalls: [],
  account: { equity: 1000, availableBalance: 900, canTrade: true },
  maxLev: 0,
  isDual: false,
};
const mark = (symbol) => ex.price.get(symbol) ?? 68000;

function bookOrder(kind, symbol, side, qty, opts = {}) {
  const order = {
    orderId: ex.seq++,
    clientOrderId: opts.cid ?? null,
    symbol, side, type: kind,
    status: opts.status ?? 'NEW',
    avgPrice: opts.price ?? 0,
    stopPrice: opts.stopPrice ?? 0,
    executedQty: qty,
    reduceOnly: !!opts.reduceOnly,
    time: Date.now(),
  };
  ex.orders.push(order);
  return order;
}

function ledgerFill(order, price, rp = 0, commission = 0) {
  ex.ledger.push({
    orderId: order.orderId,
    clientOrderId: order.clientOrderId,
    symbol: order.symbol,
    side: order.side,
    qty: order.executedQty,
    price,
    realizedPnl: rp,
    commission,
    commissionAsset: 'USDT',
    time: Date.now(),
  });
}

function applyPosition(symbol, side, qty) {
  const dir = side === 'BUY' ? 1 : -1;
  ex.positions.set(symbol, (ex.positions.get(symbol) ?? 0) + dir * qty);
}

/** Simulate an ORDER_TRADE_UPDATE fill for one of our tagged orders. */
function fillCid(cid, price, rp = 0, commission = 0) {
  const order = ex.orders.find((o) => o.clientOrderId === cid);
  if (!order) throw new Error(`stub: no order ${cid}`);
  order.status = 'FILLED';
  order.avgPrice = price;
  ledgerFill(order, price, rp, commission);
  applyPosition(order.symbol, order.side, order.executedQty);
  trader.onOrderUpdate({
    o: {
      c: cid, s: order.symbol, x: 'TRADED', X: 'FILLED', L: String(price),
      sp: String(order.stopPrice || 0), rp: String(rp), n: String(commission), N: 'USDT', ap: String(price),
    },
  });
  return order;
}

/* ------------------------------------------------------------------ api stubs
   Only the transport/account surface is stubbed. All order shaping (marketOrder,
   protectiveStop, takeProfitMarket, leverage/dual-side handling) runs the REAL
   code, so this harness verifies exactly what would be sent to Binance.        */
function bookParams(params) {
  const order = {
    orderId: ex.seq++,
    clientOrderId: params.newClientOrderId ?? null,
    symbol: params.symbol,
    side: params.side,
    type: params.type,
    status: 'NEW',
    avgPrice: 0,
    stopPrice: Number(params.stopPrice || 0),
    executedQty: Number(params.quantity || 0),
    reduceOnly: params.reduceOnly === 'true' || params.reduceOnly === true,
    positionSide: params.positionSide ?? null,
    time: Date.now(),
  };
  if (params.type === 'MARKET') {
    const price = mark(params.symbol);
    order.status = 'FILLED';
    order.avgPrice = price;
    ledgerFill(order, price, 0, 0);
    applyPosition(order.symbol, order.side, order.executedQty);
  }
  ex.orders.push(order);
  return order;
}

api.newOrder = async (params) => bookParams(params);
api.exchangeInfo = async (symbol) => ({ symbol, stepSize: 0.001, tickSize: 0.1, minQty: 0.001, minNotional: 5, stepDecimals: 3, tickDecimals: 1 });
api.accountSnapshot = async () => ({ ...ex.account, walletBalance: ex.account.equity, unrealizedPnl: 0, initialMargin: 0, maintMargin: 0, crossWalletBalance: ex.account.equity, openOrderInitialMargin: 0, roiPct: 0, roiOnWalletPct: 0, at: Date.now() });
api.positionAmount = async (symbol) => ex.positions.get(symbol) ?? 0;
api.positionRisk = async () => [...ex.positions.entries()]
  .filter(([, amt]) => amt !== 0)
  .map(([symbol, amt]) => ({ symbol, positionAmt: amt, entryPrice: mark(symbol), markPrice: mark(symbol), unRealizedProfit: 0, liquidationPrice: 0, leverage: 10, marginType: 'isolated', isolatedMargin: 0, positionInitialMargin: 0, notional: Math.abs(amt * mark(symbol)), updateTime: Date.now() }));
api.maxLeverage = async () => ex.maxLev;
api.setLeverage = async (symbol, leverage) => { ex.leverageCalls.push({ symbol, leverage }); return {}; };
api.setIsolated = async () => ({});
api.isDualSide = async () => ex.isDual;
api.cancelOrder = async (symbol, orderId, cid) => {
  const order = ex.orders.find((o) => o.symbol === symbol && (o.clientOrderId === cid || o.orderId === orderId));
  if (order && order.status === 'NEW') order.status = 'CANCELED';
  return {};
};
api.openOrders = async (symbol) => ex.orders.filter((o) => o.symbol === symbol && o.status === 'NEW');
api.allOrders = async (symbol) => ex.orders.filter((o) => o.symbol === symbol);
api.userTrades = async (symbol, opts = {}) => ex.ledger.filter((f) => f.symbol === symbol && f.time >= (opts.startTime ?? 0));
api.incomeHistory = async () => [];

/* ------------------------------------------------------------------ helpers */
function mkSignal(side, price, atr, symbol = 'BTCUSDT') {
  const rec = {
    id: Math.random().toString(36).slice(2, 10),
    symbol, time: Date.now() - 60000, detectedAt: Date.now(),
    side, price, atr, acted: false, tradeId: null,
  };
  saveSignal(rec);
  ex.price.set(symbol, price);
  trader.onPrice(price, symbol);
  return { record: rec, side, price, atr };
}
const ordersOf = (symbol, kind) => ex.orders.filter((o) => o.symbol === symbol && (kind ? o.type === kind : true));
const openOf = (symbol) => openTradeOn(symbol);
const cidSuffix = (tradeId, suffix) => `VX${tradeId}${suffix}`;

async function main() {
  loadSettings();
  updateSettings({ autoTrade: true, symbol: 'BTCUSDT', autoScan: false, tradeSizePercent: 5, leverage: 10 });
  ex.maxLev = 0;

  const P = 68000, A = 100; // entry price, ATR → SL ±200, TP1 ±150·... (×1.5 = 300/600/900)

  /* ---------- 1. LONG → full TP ladder ---------- */
  console.log('\n— Entry + protective ladder (real order path) —');
  await trader.onSignal(mkSignal('LONG', P, A));
  let t1 = openOf('BTCUSDT');
  assert(!!t1 && t1.side === 'LONG' && t1.status === 'OPEN', 'LONG entered on signal');
  assert(!!t1 && t1.mode === 'testnet', `trade is recorded in the exchange mode (${t1?.mode})`);
  assert(!!t1 && approx(t1.entryPrice, P), `entry price = exchange fill average (${t1?.entryPrice})`);
  assert(!!t1 && approx(t1.slInitial, P - 200, 0.05), `SL = entry − ATR×2 (${t1?.slInitial})`);
  assert(!!t1 && approx(t1.tp1, P + 300, 0.05) && approx(t1.tp2, P + 600, 0.05) && approx(t1.tp3, P + 900, 0.05), 'TP1/2/3 at 1.5R/3R/4.5R');
  assert(!!t1 && t1.qty > 0 && approx(t1.q1 + t1.q2 + t1.q3, t1.qty), `qty ladder sums (${t1?.qty} = ${t1?.q1}+${t1?.q2}+${t1?.q3})`);
  assert(!!t1 && approx(t1.margin * t1.leverage, t1.notional, 1e-6), 'notional = margin × leverage');
  assert(!!t1 && t1.margin <= 50 + 1e-6 && t1.margin > 40, `margin = 5% of equity, lot-floored (${t1?.margin})`);

  const entryOrder = ex.orders.find((o) => o.clientOrderId === cidSuffix(t1.id, 'E'));
  assert(!!entryOrder && !entryOrder.reduceOnly && entryOrder.side === 'BUY', 'entry is a plain BUY market order (never reduceOnly)');
  const stop = ordersOf('BTCUSDT', 'STOP_MARKET')[0];
  assert(!!stop && stop.reduceOnly && stop.side === 'SELL' && stop.clientOrderId.startsWith(`VX${t1.id}S`), 'protective stop is reduceOnly + tagged VX<tradeId>S');
  assert(!!stop && approx(stop.executedQty, t1.qty), `protective stop carries the explicit full quantity (${stop?.executedQty})`);
  assert(!!stop && approx(stop.stopPrice, t1.slInitial, 0.05), 'protective stop sits at the ATR level');
  assert(ex.orders.every((o) => o.type !== 'STOP_MARKET' || o.reduceOnly), 'no un-reduceOnly stop was ever sent');
  const tps = ordersOf('BTCUSDT', 'TAKE_PROFIT_MARKET');
  assert(tps.length === 3 && tps.every((o) => o.reduceOnly), 'three reduceOnly take-profit legs placed');
  assert(tps.some((o) => approx(o.executedQty, t1.q1)) && tps.some((o) => approx(o.executedQty, t1.q2)) && tps.some((o) => approx(o.executedQty, t1.q3)), 'TP legs size q1/q2/q3');

  console.log('\n— TP1 → breakeven, TP2 → SL at TP1, TP3 → full exit —');
  // TP1: rp = (68150-68000) * q1
  const rp1 = 150 * t1.q1;
  fillCid(cidSuffix(t1.id, '1'), 68150, rp1, 0.01);
  await settle();
  t1 = openOf('BTCUSDT');
  assert(!!t1 && t1.tp1Filled && t1.slStage === 1 && approx(t1.slCurrent, t1.entryPrice, 0.05), 'TP1 filled → SL moved to BREAKEVEN');
  const slAfter1 = ordersOf('BTCUSDT', 'STOP_MARKET').filter((o) => o.clientOrderId.startsWith(`VX${t1.id}S`)).pop();
  assert(!!slAfter1 && approx(slAfter1.executedQty, t1.qty - t1.q1, 1e-9), `re-armed stop = remaining size after TP1 (${slAfter1?.executedQty})`);
  assert(!!slAfter1 && slAfter1.executedQty < t1.qty, 're-armed stop can never over-close the position');
  assert(!stop || stop.status === 'CANCELED', 'the original stop was cancelled before the replacement');

  const rp2 = 300 * t1.q2;
  fillCid(cidSuffix(t1.id, '2'), 68300, rp2, 0.01);
  await settle();
  t1 = openOf('BTCUSDT');
  assert(!!t1 && t1.tp2Filled && t1.slStage === 2 && approx(t1.slCurrent, t1.tp1, 0.05), 'TP2 filled → SL locked at TP1');

  const rp3 = 450 * t1.q3;
  fillCid(cidSuffix(t1.id, '3'), 68450, rp3, 0.01);
  await settle();
  t1 = allTrades()[0];
  assert(t1.status === 'CLOSED' && t1.closeReason === 'TP3' && t1.result === 'WIN', 'TP3 filled → full exit, WIN');
  assert(approx(t1.realizedPnl, rp1 + rp2 + rp3 - 0.03, 1e-6), `realised PnL = Binance ledger − fees (${t1.realizedPnl.toFixed(4)})`);
  assert(approx(t1.fees, 0.03, 1e-9), `fees = exchange commission only (${t1.fees})`);
  assert(!openOf('BTCUSDT'), 'no open trade after TP3');
  assert(ex.orders.filter((o) => o.symbol === 'BTCUSDT' && o.status === 'NEW').length === 0, 'every remaining ladder order was cancelled on close');

  /* ---------- 2. SHORT → SL hit ---------- */
  console.log('\n— SHORT → stop-loss (no TP) —');
  await trader.onSignal(mkSignal('SHORT', P, A));
  const t2 = openOf('BTCUSDT');
  assert(!!t2 && t2.side === 'SHORT', 'SHORT opened');
  assert(!!t2 && approx(t2.slInitial, P + 200, 0.05), `SHORT SL above entry (${t2?.slInitial})`);
  fillCid(cidSuffix(t2.id, 'S0'), P + 200, -200 * t2.qty, 0.01);
  await settle();
  const t2c = allTrades().find((x) => x.id === t2.id);
  assert(t2c.status === 'CLOSED' && t2c.closeReason === 'SL' && t2c.result === 'LOSS', 'SL hit → closed as LOSS');
  assert(t2c.realizedPnl < 0, `SL PnL is negative (${t2c.realizedPnl.toFixed(4)})`);

  /* ---------- 3. close & reverse ---------- */
  console.log('\n— Opposite signal → close & reverse —');
  await trader.onSignal(mkSignal('LONG', P, A));
  let t3 = openOf('BTCUSDT');
  assert(!!t3 && t3.side === 'LONG', 'LONG opened for the reverse test');
  fillCid(cidSuffix(t3.id, '1'), P + 300, 300 * t3.q1, 0.01);
  await settle();
  await trader.onSignal(mkSignal('SHORT', P + 50, A));
  await settle();
  const t3c = allTrades().find((x) => x.id === t3.id);
  assert(t3c.status === 'CLOSED' && t3c.closeReason === 'REVERSE', 'opposite signal closed the LONG (close & reverse)');
  const reverseClose = ex.orders.find((o) => o.clientOrderId === cidSuffix(t3.id, 'X'));
  assert(!!reverseClose && reverseClose.reduceOnly && approx(reverseClose.executedQty, t3.qty - t3.q1), 'reverse close is a tagged reduceOnly order for the remaining size');
  const t4 = openOf('BTCUSDT');
  assert(!!t4 && t4.side === 'SHORT', 'SHORT opened on the same signal (close & reverse)');
  assert(!!t4 && t4.qty > 0 && t4.status === 'OPEN', 'the reversed position is live with a fresh ladder');

  /* ---------- 4. kill switch ---------- */
  console.log('\n— Kill switch —');
  const killed = await trader.kill();
  await settle();
  const t4c = allTrades().find((x) => x.id === t4.id);
  assert(killed >= 1 && t4c.status === 'CLOSED' && t4c.closeReason === 'KILL', 'kill switch flattened the bot position (KILL)');
  assert(openTrades().length === 0, 'no open trade after the kill switch');

  /* ---------- 5. auto-trade OFF ---------- */
  console.log('\n— Auto-trade master switch —');
  updateSettings({ autoTrade: false });
  const before = allTrades().length;
  await trader.onSignal(mkSignal('LONG', P, A));
  assert(allTrades().length === before, 'auto-trade OFF → signal logged but no entry');
  assert(require('../dist/store').allSignals().length > 0, 'the signal is still recorded in the journal');

  /* ---------- 6. ownership + account guards ---------- */
  console.log('\n— Ownership / key guards —');
  updateSettings({ autoTrade: true });
  ex.positions.set('ETHUSDT', 2);
  await trader.onSignal(mkSignal('LONG', 100, 1, 'ETHUSDT'));
  assert(!openTradeOn('ETHUSDT'), 'entry refused when the symbol already carries an external position');
  assert(ex.orders.every((o) => o.symbol !== 'ETHUSDT'), 'not a single order was sent for the guarded symbol');
  ex.positions.delete('ETHUSDT');

  ex.account.canTrade = false;
  await trader.onSignal(mkSignal('LONG', 100, 1, 'SOLUSDT'));
  assert(!openTradeOn('SOLUSDT'), 'entry refused when the API key reports canTrade=false');
  ex.account.canTrade = true;

  ex.maxLev = 3;
  await trader.onSignal(mkSignal('LONG', 100, 1, 'SOLUSDT'));
  await settle();
  const sol = openTradeOn('SOLUSDT');
  assert(!!sol && sol.leverage === 3, `configured 10× clamped to the exchange bracket (${sol?.leverage}×)`);
  assert(ex.leverageCalls.some((c) => c.symbol === 'SOLUSDT' && c.leverage === 3), 'setLeverage was called with the clamped value');
  ex.maxLev = 0;

  /* ---------- 7. reconcile re-arms a missing stop ---------- */
  console.log('\n— Reconcile: missing protective stop is re-armed —');
  const solStop = ex.orders.filter((o) => o.symbol === 'SOLUSDT' && o.type === 'STOP_MARKET' && o.status === 'NEW').pop();
  if (solStop) solStop.status = 'CANCELED';
  await trader.reconcile();
  await settle();
  const rearmed = ex.orders.filter((o) => o.symbol === 'SOLUSDT' && o.type === 'STOP_MARKET' && o.status === 'NEW').pop();
  assert(!!rearmed && rearmed.reduceOnly && rearmed.executedQty > 0, 'reconcile re-armed the missing stop with an explicit quantity');

  /* ---------- 8. multi-position cap (max 8, one per symbol) ---------- */
  console.log('\n— Multi-position cap (hard 8) —');
  await trader.kill();
  await settle();
  assert(openTrades().length === 0, 'journal cleared before the cap test');
  const syms = ['ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT'];
  for (const sym of syms) {
    await trader.onSignal(mkSignal('LONG', 100, 0.5, sym));
    await settle();
  }
  assert(openTrades().length === 8, `8 concurrent positions open (${openTrades().length})`);
  assert(openTrades().every((t) => t.botOwned === true), 'every open trade is bot-owned (never adopted)');
  await trader.onSignal(mkSignal('LONG', 100, 0.5, 'TRXUSDT'));
  await settle();
  assert(openTrades().length === 8, 'a 9th signal is rejected — hard cap of 8 positions');
  assert(!openTradeOn('TRXUSDT'), 'no position opened beyond the cap');
  const killed8 = await trader.kill();
  await settle();
  assert(killed8 === 8 && openTrades().length === 0, `kill closed all 8 bot positions (${killed8})`);

  /* ---------- 9. hedge mode: exits are scoped by positionSide ---------- */
  console.log('\n— Hedge mode (positionSide, no reduceOnly) —');
  ex.isDual = true;
  await trader.onSignal(mkSignal('LONG', 100, 1, 'ETHUSDT'));
  await settle();
  const hedged = openTradeOn('ETHUSDT');
  assert(!!hedged, 'hedge-mode entry opened');
  // Scope to THIS trade's client-order-id prefix: earlier sections left their
  // own ETHUSDT orders in the book and they must not leak into these checks.
  const hedgeOrders = () => ex.orders.filter((o) => String(o.clientOrderId || '').startsWith(`VX${hedged.id}`));
  const hTps = hedgeOrders().filter((o) => o.type === 'TAKE_PROFIT_MARKET');
  assert(hTps.length === 3 && hTps.every((o) => o.positionSide === 'LONG'), 'hedge-mode TP legs carry positionSide=LONG');
  assert(hTps.every((o) => !o.reduceOnly), 'hedge-mode TP legs never send reduceOnly (Binance rejects it there)');
  const hStop = hedgeOrders().find((o) => o.type === 'STOP_MARKET');
  assert(!!hStop && hStop.positionSide === 'LONG' && !hStop.reduceOnly, 'hedge-mode stop is scoped by positionSide');
  fillCid(`VX${hedged.id}E`, 100, 0, 0);
  await trader.kill();
  await settle();
  assert(openTrades().length === 0, 'hedge-mode position closed through the tagged reduce path');
  ex.isDual = false;

  /* ---------- 10. stats ---------- */
  const st = computeStats();
  assert(st.totalClosedTrades >= 10, `stats count the closed journal (${st.totalClosedTrades})`);
  assert(st.winCount >= 1 && st.lossCount >= 1, `wins and losses are counted (${st.winCount}W/${st.lossCount}L)`);

  updateSettings({ autoTrade: false }); // leave the system SAFE
  console.log(failures === 0 ? '\nE2E: ALL TESTS PASSED' : `\nE2E: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('CRASH:', e); process.exit(1); });

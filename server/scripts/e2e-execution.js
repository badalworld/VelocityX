/**
 * End-to-end execution test — drives the REAL order path (testnet/live branch)
 * against a stubbed Binance exchange. No simulation lives in the product; this
 * harness only stands in for the exchange so the executor state machine can be
 * verified without sending real orders.
 *
 * The stub sits at the HTTP boundary (BinanceApi.signed) and behaves like the
 * 2026 exchange: STOP_MARKET / TAKE_PROFIT_MARKET are REJECTED on /fapi/v1/order
 * (-4120) and only accepted by the Algo Service (/fapi/v1/algoOrder). Every
 * order-shaping function in binance.ts therefore runs for real.
 *
 *   1. LONG  → TP1 (33% + SL→BE) → TP2 (50% rest + SL→TP1) → TP3 (full exit)  [WIN]
 *   2. SHORT → SL hit before any TP                                            [LOSS]
 *   3. LONG  → TP1 → opposite signal                                          [CLOSE & REVERSE]
 *   4. SHORT → kill switch                                                     [KILL]
 *   5. Ownership guards: external position blocks entry, canTrade=false blocks
 *      entry, leverage brackets clamp, missing legs are re-armed by reconcile.
 *   6. Recovery: fills the WebSocket missed are booked from REST, flaky answers
 *      never duplicate a leg, events are idempotent, lost POST responses are
 *      resolved by client id, stale legs are swept, other-mode trades are skipped.
 *   7. Multi-position cap: max 8 bot positions, one per symbol.
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
trader.setRuntimeGate(() => ({ ready: true, reasons: [] }));
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
   A small in-memory Binance. Regular orders live in ex.orders, conditional
   (algo) orders in ex.algo; fills land in a ledger the executor reads back
   exactly like /fapi/v1/userTrades.                                            */
const CONDITIONAL = new Set(['STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP_MARKET']);
const ex = {
  seq: 1,
  orders: [],
  algo: [],
  ledger: [],
  calls: [],
  positions: new Map(),
  price: new Map(),
  minNotional: new Map(),
  leverageCalls: [],
  account: { equity: 1000, availableBalance: 900, canTrade: true },
  maxLev: 0,
  isDual: false,
  legacyConditionalAttempts: 0,
  // fault injection
  loseNextAlgoResponse: false, // book the order, then fail in transit
  rejectAlgo: null, // (params) => Error | null
  flakyAlgoQuery: false, // GET /algoOrder answers 503
  hideOpenList: false, // GET /openAlgoOrders answers []
  failNextAlgoCancel: false, // the next DELETE /algoOrder fails transiently (order stays resting)
  delayCloseMs: 0, // reduce-only market closes take this long on the wire
  omitAvg: 0, // 1: POST has no avgPrice · 2: neither POST nor GET has it
};
const mark = (symbol) => ex.price.get(symbol) ?? 68000;
const apiError = (path, status, code, msg) => new Error(`Binance ${path} HTTP ${status}: ${JSON.stringify({ code, msg })}`);

function ledgerFill(order, price, rp = 0, commission = 0) {
  ex.ledger.push({
    orderId: order.orderId,
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

/** POST /fapi/v1/order — MARKET only (conditional types are refused above this). */
function bookMarket(params) {
  const price = mark(params.symbol);
  const order = {
    orderId: ex.seq++,
    clientOrderId: params.newClientOrderId ?? null,
    symbol: params.symbol,
    side: params.side,
    type: params.type,
    status: 'FILLED',
    avgPrice: price,
    executedQty: Number(params.quantity || 0),
    reduceOnly: params.reduceOnly === 'true' || params.reduceOnly === true,
    positionSide: params.positionSide ?? null,
    time: Date.now(),
  };
  ledgerFill(order, price, 0, 0);
  applyPosition(order.symbol, order.side, order.executedQty);
  ex.orders.push(order);
  return { ...order, avgPrice: ex.omitAvg ? '0.00000' : String(price) };
}

/** POST /fapi/v1/algoOrder — validates like the real Algo Service. */
function bookAlgo(params) {
  const path = '/fapi/v1/algoOrder';
  if (ex.rejectAlgo) {
    const err = ex.rejectAlgo(params);
    if (err) throw err;
  }
  if (params.algoType !== 'CONDITIONAL') throw apiError(path, 400, -1102, "Mandatory parameter 'algotype' was not sent, was empty/null, or malformed.");
  if (!CONDITIONAL.has(params.type)) throw apiError(path, 400, -1116, 'Invalid orderType.');
  if (params.stopPrice !== undefined) throw apiError(path, 400, -1104, "Not all sent parameters were read; read 'stopPrice'. Use triggerPrice.");
  if (params.closePosition !== undefined) throw apiError(path, 400, -1104, "closePosition must never be used by this bot.");
  if (params.newClientOrderId !== undefined) throw apiError(path, 400, -1104, "Use clientAlgoId.");
  if (!params.triggerPrice) throw apiError(path, 400, -1102, "Mandatory parameter 'triggerprice' was not sent, was empty/null, or malformed.");
  if (!(Number(params.quantity) > 0)) throw apiError(path, 400, -1102, "Mandatory parameter 'quantity' was not sent, was empty/null, or malformed.");
  if (params.clientAlgoId && !/^[.A-Za-z0-9:/_-]{1,36}$/.test(params.clientAlgoId)) throw apiError(path, 400, -4055, 'clientAlgoId is invalid.');
  if (ex.isDual) {
    if (!params.positionSide || params.positionSide === 'BOTH') throw apiError(path, 400, -4061, "Order's position side does not match user's setting.");
    if (params.reduceOnly !== undefined) throw apiError(path, 400, -1106, "Parameter 'reduceonly' sent when not required.");
  } else if (params.positionSide && params.positionSide !== 'BOTH') {
    throw apiError(path, 400, -4061, "Order's position side does not match user's setting.");
  }
  if (params.clientAlgoId && ex.algo.some((a) => a.clientAlgoId === params.clientAlgoId && a.algoStatus === 'NEW')) {
    throw apiError(path, 400, -4116, 'ClientOrderId is duplicated.');
  }
  const m = mark(params.symbol);
  const trigger = Number(params.triggerPrice);
  const isStop = params.type === 'STOP_MARKET';
  const wouldTrigger = (params.side === 'SELL') === isStop ? trigger >= m : trigger <= m;
  if (wouldTrigger) throw apiError(path, 400, -2021, 'Order would immediately trigger.');
  const algo = {
    algoId: ex.seq++,
    clientAlgoId: params.clientAlgoId ?? `auto${ex.seq}`,
    symbol: params.symbol,
    side: params.side,
    type: params.type,
    algoType: params.algoType,
    algoStatus: 'NEW',
    triggerPrice: trigger,
    quantity: Number(params.quantity),
    reduceOnly: params.reduceOnly === 'true' || params.reduceOnly === true,
    positionSide: params.positionSide ?? null,
    workingType: params.workingType,
    actualOrderId: '',
    actualPrice: '0.00000',
    time: Date.now(),
  };
  ex.algo.push(algo);
  if (ex.loseNextAlgoResponse) {
    ex.loseNextAlgoResponse = false;
    throw new Error('fetch failed'); // accepted by Binance, response lost in transit
  }
  return { algoId: algo.algoId, clientAlgoId: algo.clientAlgoId, algoStatus: 'NEW', code: '200', msg: 'success' };
}

const algoView = (a) => ({
  algoId: a.algoId, clientAlgoId: a.clientAlgoId, algoType: a.algoType, orderType: a.type, symbol: a.symbol,
  side: a.side, positionSide: a.positionSide ?? 'BOTH', quantity: String(a.quantity), algoStatus: a.algoStatus,
  triggerPrice: String(a.triggerPrice), workingType: a.workingType, reduceOnly: a.reduceOnly,
  actualOrderId: a.actualOrderId === '' ? '' : String(a.actualOrderId), actualPrice: String(a.actualPrice),
});

/** The HTTP boundary: every signed request of the real client lands here. */
api.signed = async (method, path, params = {}) => {
  ex.calls.push(`${method} ${path}`);
  if (method === 'POST' && path === '/fapi/v1/order') {
    if (CONDITIONAL.has(params.type)) {
      ex.legacyConditionalAttempts += 1;
      throw apiError(path, 400, -4120, 'Order type not supported for this endpoint. Please use the Algo Order API endpoints instead.');
    }
    if (ex.delayCloseMs && (params.reduceOnly === 'true' || params.reduceOnly === true)) {
      await new Promise((r) => setTimeout(r, ex.delayCloseMs));
    }
    return bookMarket(params);
  }
  if (method === 'GET' && path === '/fapi/v1/order') {
    const order = ex.orders.find((o) => o.symbol === params.symbol && (
      (params.origClientOrderId !== undefined && o.clientOrderId === params.origClientOrderId) ||
      (params.orderId !== undefined && String(o.orderId) === String(params.orderId))));
    if (!order) throw apiError(path, 400, -2013, 'Order does not exist.');
    const avgPrice = ex.omitAvg === 2 ? '0.00000' : String(order.avgPrice);
    return { ...order, avgPrice, executedQty: String(order.executedQty) };
  }
  if (method === 'POST' && path === '/fapi/v1/algoOrder') return bookAlgo(params);
  if (method === 'DELETE' && path === '/fapi/v1/algoOrder') {
    if (ex.failNextAlgoCancel) {
      ex.failNextAlgoCancel = false;
      throw apiError(path, 503, -1000, 'Unknown error, please check your request or try again later.');
    }
    const a = ex.algo.find((x) => x.clientAlgoId === params.clientAlgoId);
    if (!a) throw apiError(path, 400, -2013, 'Order does not exist.');
    if (a.algoStatus !== 'NEW') throw apiError(path, 400, -2011, 'Unknown order sent.');
    a.algoStatus = 'CANCELED';
    return { algoId: a.algoId, clientAlgoId: a.clientAlgoId, code: '200', msg: 'success' };
  }
  if (method === 'GET' && path === '/fapi/v1/algoOrder') {
    if (ex.flakyAlgoQuery) throw apiError(path, 503, -1000, 'Unknown error, please check your request or try again later.');
    const a = ex.algo.find((x) => x.clientAlgoId === params.clientAlgoId);
    if (!a) throw apiError(path, 400, -2013, 'Order does not exist.');
    return algoView(a);
  }
  if (method === 'GET' && path === '/fapi/v1/openAlgoOrders') {
    if (ex.hideOpenList) return [];
    return ex.algo.filter((a) => a.symbol === params.symbol && a.algoStatus === 'NEW').map(algoView);
  }
  throw new Error(`stub: unhandled ${method} ${path}`);
};

/**
 * A conditional leg fires on the exchange. Binance creates a separate
 * matching-engine order for it — with an UNRELATED client order id unless
 * `sameCid` — and reports ALGO_UPDATE over the user stream.
 *   via: 'stream' → ALGO_UPDATE is delivered; 'rest' → the WebSocket frame is lost.
 */
const delivered = new Map();
/** Replay the exact frames of an earlier fireAlgo() — Binance may repeat a frame after a reconnect. */
function redeliver(cid) {
  const frames = delivered.get(cid);
  if (!frames) throw new Error(`stub: nothing delivered for ${cid}`);
  if (frames.order) trader.onOrderUpdate(frames.order);
  trader.onAlgoUpdate(frames.algo);
}
function fireAlgo(cid, price, { rp = 0, commission = 0, via = 'stream', sameCid = false, repeat = 1 } = {}) {
  const a = ex.algo.find((x) => x.clientAlgoId === cid);
  if (!a) throw new Error(`stub: no algo order ${cid}`);
  if (a.algoStatus !== 'NEW') throw new Error(`stub: algo order ${cid} is ${a.algoStatus}`);
  const engine = {
    orderId: ex.seq++,
    clientOrderId: sameCid ? cid : `autotrigger${ex.seq}`,
    symbol: a.symbol, side: a.side, type: 'MARKET', status: 'FILLED',
    avgPrice: price, executedQty: a.quantity, reduceOnly: a.reduceOnly, positionSide: a.positionSide, time: Date.now(),
  };
  ex.orders.push(engine);
  ledgerFill(engine, price, rp, commission);
  applyPosition(a.symbol, a.side, a.quantity);
  ex.price.set(a.symbol, price);
  a.algoStatus = 'FINISHED';
  a.actualOrderId = engine.orderId;
  a.actualPrice = price;
  if (via !== 'stream') return engine;
  const frames = {
    order: sameCid
      ? { o: { c: cid, s: a.symbol, x: 'TRADE', X: 'FILLED', L: String(price), sp: String(a.triggerPrice), rp: String(rp), n: String(commission), N: 'USDT', ap: String(price) } }
      : null,
    algo: {
      e: 'ALGO_UPDATE',
      o: { caid: cid, aid: a.algoId, s: a.symbol, S: a.side, X: 'FINISHED', ai: String(engine.orderId), ap: String(price), aq: String(a.quantity), tp: String(a.triggerPrice), R: a.reduceOnly, rm: '' },
    },
  };
  delivered.set(cid, frames);
  if (frames.order) trader.onOrderUpdate(frames.order);
  for (let i = 0; i < repeat; i++) trader.onAlgoUpdate(frames.algo);
  return engine;
}

/* ------------------------------------------------------------------ api stubs
   Only the account/market surface is stubbed here. All order shaping
   (marketOrder, protectiveStop, takeProfitMarket, newAlgoOrder, cancelAlgoOrder,
   algoLegState, leverage/dual-side handling) runs the REAL code above the
   api.signed boundary, so this harness verifies exactly what would be sent.   */
api.exchangeInfo = async (symbol) => ({ symbol, stepSize: 0.001, tickSize: 0.1, minQty: 0.001, minNotional: ex.minNotional.get(symbol) ?? 5, stepDecimals: 3, tickDecimals: 1 });
api.accountSnapshot = async () => ({ ...ex.account, walletBalance: ex.account.equity, unrealizedPnl: 0, initialMargin: 0, maintMargin: 0, roiPct: 0, roiOnWalletPct: 0, at: Date.now() });
api.positionAmount = async (symbol) => ex.positions.get(symbol) ?? 0;
api.positionRisk = async () => [...ex.positions.entries()]
  .filter(([, amt]) => amt !== 0)
  .map(([symbol, amt]) => ({ symbol, positionAmt: amt, entryPrice: mark(symbol), markPrice: mark(symbol), unRealizedProfit: 0, liquidationPrice: 0, leverage: 10, marginType: 'isolated', isolatedMargin: 0, positionInitialMargin: 0, notional: Math.abs(amt * mark(symbol)), updateTime: Date.now() }));
api.maxLeverage = async () => ex.maxLev;
api.setLeverage = async (symbol, leverage) => { ex.leverageCalls.push({ symbol, leverage }); return {}; };
api.setIsolated = async () => ({});
api.isDualSide = async () => ex.isDual;
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
const algoOf = (symbol, type) => ex.algo.filter((a) => a.symbol === symbol && (type ? a.type === type : true));
const liveAlgo = (symbol) => ex.algo.filter((a) => a.symbol === symbol && a.algoStatus === 'NEW');
const liveOfTrade = (id) => ex.algo.filter((a) => a.clientAlgoId.startsWith(`VX${id}`) && a.algoStatus === 'NEW');
const openOf = (symbol) => openTradeOn(symbol);
const cidSuffix = (tradeId, suffix) => `VX${tradeId}${suffix}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  loadSettings();
  updateSettings({ autoTrade: true, symbol: 'BTCUSDT', autoScan: false, tradeSizePercent: 5, leverage: 10 });
  ex.maxLev = 0;

  const P = 68000, A = 100; // entry price, ATR → SL ±200, TP ladder ×1.5 = +300 / +600 / +900

  /* ---------- 0. the legacy endpoint can never carry a conditional order ---------- */
  console.log('\n— Conditional orders never use /fapi/v1/order (Binance -4120) —');
  let refused = null;
  try {
    await api.newOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', stopPrice: '67800', quantity: '0.01', reduceOnly: 'true' });
  } catch (e) { refused = e; }
  assert(!!refused && /newAlgoOrder/.test(String(refused.message)), 'newOrder() refuses STOP_MARKET and points at newAlgoOrder()');
  assert(ex.calls.length === 0, 'the refusal is client-side — no request reached the exchange');

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
  assert(!!entryOrder && !entryOrder.reduceOnly && entryOrder.side === 'BUY' && entryOrder.type === 'MARKET', 'entry is a plain BUY market order (never reduceOnly)');
  const stop = algoOf('BTCUSDT', 'STOP_MARKET')[0];
  assert(!!stop && stop.reduceOnly && stop.side === 'SELL' && stop.clientAlgoId.startsWith(`VX${t1.id}S`), 'protective stop is a reduceOnly algo order tagged VX<tradeId>S');
  assert(!!stop && stop.algoType === 'CONDITIONAL' && stop.workingType === 'CONTRACT_PRICE', 'stop is a CONDITIONAL algo order on the contract price');
  assert(!!stop && approx(stop.quantity, t1.qty), `protective stop carries the explicit full quantity (${stop?.quantity})`);
  assert(!!stop && approx(stop.triggerPrice, t1.slInitial, 0.05), 'protective stop triggers at the ATR level');
  assert(ex.algo.every((o) => o.type !== 'STOP_MARKET' || o.reduceOnly), 'no un-reduceOnly stop was ever sent');
  const tps = algoOf('BTCUSDT', 'TAKE_PROFIT_MARKET');
  assert(tps.length === 3 && tps.every((o) => o.reduceOnly && o.side === 'SELL'), 'three reduceOnly take-profit algo legs placed');
  assert(tps.some((o) => approx(o.quantity, t1.q1)) && tps.some((o) => approx(o.quantity, t1.q2)) && tps.some((o) => approx(o.quantity, t1.q3)), 'TP legs size q1/q2/q3');
  assert(ex.legacyConditionalAttempts === 0, 'not a single conditional order was sent to /fapi/v1/order');

  console.log('\n— TP1 → breakeven, TP2 → SL at TP1, TP3 → full exit (ALGO_UPDATE) —');
  // The triggered legs become matching-engine orders with UNRELATED client ids —
  // fills are routed purely by the algo order's own client id.
  const rp1 = 300 * t1.q1;
  fireAlgo(cidSuffix(t1.id, '1'), 68300, { rp: rp1, commission: 0.01 });
  await settle();
  t1 = openOf('BTCUSDT');
  assert(!!t1 && t1.tp1Filled && t1.slStage === 1 && approx(t1.slCurrent, t1.entryPrice, 0.05), 'TP1 filled → SL moved to BREAKEVEN');
  const slAfter1 = algoOf('BTCUSDT', 'STOP_MARKET').filter((o) => o.clientAlgoId.startsWith(`VX${t1.id}S`)).pop();
  assert(!!slAfter1 && approx(slAfter1.quantity, t1.qty - t1.q1, 1e-9), `re-armed stop = remaining size after TP1 (${slAfter1?.quantity})`);
  assert(!!slAfter1 && slAfter1.quantity < t1.qty && slAfter1.algoStatus === 'NEW', 're-armed stop can never over-close the position');
  assert(!!slAfter1 && approx(slAfter1.triggerPrice, t1.entryPrice, 0.05), 'the replacement stop rests at breakeven');
  assert(!stop || stop.algoStatus === 'CANCELED', 'the original stop was cancelled before the replacement');
  await sleep(2700); // debounced ledger refresh: ALGO_UPDATE carries no commission / PnL
  t1 = openOf('BTCUSDT');
  assert(approx(t1.binanceRealizedPnl, rp1, 1e-9) && approx(t1.fees, 0.01, 1e-9), `TP1 numbers read back from the exchange ledger after the fill (${t1.binanceRealizedPnl} / ${t1.fees})`);

  const rp2 = 600 * t1.q2;
  fireAlgo(cidSuffix(t1.id, '2'), 68600, { rp: rp2, commission: 0.01 });
  await settle();
  t1 = openOf('BTCUSDT');
  assert(!!t1 && t1.tp2Filled && t1.slStage === 2 && approx(t1.slCurrent, t1.tp1, 0.05), 'TP2 filled → SL locked at TP1');

  const rp3 = 900 * t1.q3;
  fireAlgo(cidSuffix(t1.id, '3'), 68900, { rp: rp3, commission: 0.01 });
  await settle();
  t1 = allTrades()[0];
  assert(t1.status === 'CLOSED' && t1.closeReason === 'TP3' && t1.result === 'WIN', 'TP3 filled → full exit, WIN');
  assert(approx(t1.realizedPnl, rp1 + rp2 + rp3 - 0.03, 1e-6), `realised PnL = Binance ledger − fees (${t1.realizedPnl.toFixed(4)})`);
  assert(approx(t1.fees, 0.03, 1e-9), `fees = exchange commission only (${t1.fees})`);
  assert(!openOf('BTCUSDT'), 'no open trade after TP3');
  assert(liveAlgo('BTCUSDT').length === 0, 'every remaining ladder order was cancelled on close');
  assert((ex.positions.get('BTCUSDT') ?? 0) === 0, 'the exchange position is flat after the full ladder');

  /* ---------- 2. SHORT → SL hit ---------- */
  console.log('\n— SHORT → stop-loss (no TP) —');
  await trader.onSignal(mkSignal('SHORT', P, A));
  const t2 = openOf('BTCUSDT');
  assert(!!t2 && t2.side === 'SHORT', 'SHORT opened');
  assert(!!t2 && approx(t2.slInitial, P + 200, 0.05), `SHORT SL above entry (${t2?.slInitial})`);
  const shortStop = algoOf('BTCUSDT', 'STOP_MARKET').find((o) => o.clientAlgoId === cidSuffix(t2.id, 'S0'));
  assert(!!shortStop && shortStop.side === 'BUY' && shortStop.reduceOnly, 'SHORT protective stop is a reduceOnly BUY');
  fireAlgo(cidSuffix(t2.id, 'S0'), P + 200, { rp: -200 * t2.qty, commission: 0.01 });
  await settle();
  const t2c = allTrades().find((x) => x.id === t2.id);
  assert(t2c.status === 'CLOSED' && t2c.closeReason === 'SL' && t2c.result === 'LOSS', 'SL hit → closed as LOSS');
  assert(t2c.realizedPnl < 0, `SL PnL is negative (${t2c.realizedPnl.toFixed(4)})`);
  assert(liveOfTrade(t2.id).length === 0, 'the take-profit legs were cancelled after the stop-out');

  /* ---------- 3. close & reverse ---------- */
  console.log('\n— Opposite signal → close & reverse —');
  await trader.onSignal(mkSignal('LONG', P, A));
  let t3 = openOf('BTCUSDT');
  assert(!!t3 && t3.side === 'LONG', 'LONG opened for the reverse test');
  fireAlgo(cidSuffix(t3.id, '1'), P + 300, { rp: 300 * t3.q1, commission: 0.01 });
  await settle();
  await trader.onSignal(mkSignal('SHORT', P + 50, A));
  await settle();
  const t3c = allTrades().find((x) => x.id === t3.id);
  assert(t3c.status === 'CLOSED' && t3c.closeReason === 'REVERSE', 'opposite signal closed the LONG (close & reverse)');
  const reverseClose = ex.orders.find((o) => o.clientOrderId === cidSuffix(t3.id, 'X'));
  assert(!!reverseClose && reverseClose.reduceOnly && approx(reverseClose.executedQty, t3.qty - t3.q1), 'reverse close is a tagged reduceOnly order for the remaining size');
  assert(liveOfTrade(t3.id).length === 0, 'the closed trade left no conditional order resting');
  const t4 = openOf('BTCUSDT');
  assert(!!t4 && t4.side === 'SHORT', 'SHORT opened on the same signal (close & reverse)');
  assert(!!t4 && t4.qty > 0 && t4.status === 'OPEN' && liveOfTrade(t4.id).length === 4, 'the reversed position is live with a fresh four-leg ladder');

  /* ---------- 4. kill switch ---------- */
  console.log('\n— Kill switch —');
  const killed = await trader.kill();
  await settle();
  const t4c = allTrades().find((x) => x.id === t4.id);
  assert(killed >= 1 && t4c.status === 'CLOSED' && t4c.closeReason === 'KILL', 'kill switch flattened the bot position (KILL)');
  assert(openTrades().length === 0, 'no open trade after the kill switch');
  assert(liveOfTrade(t4.id).length === 0, 'kill cancelled the whole ladder');

  console.log('\n— Failed close can never become a stacked reverse —');
  await trader.onSignal(mkSignal('LONG', 100, 1, 'LTCUSDT'));
  const guardedReverse = openOf('LTCUSDT');
  assert(!!guardedReverse && guardedReverse.side === 'LONG', 'reverse guard fixture opened a LONG');
  const realMarketOrder = api.marketOrder.bind(api);
  api.marketOrder = async (symbol, side, qty, opts = {}) => {
    if (symbol === 'LTCUSDT' && opts.reduceOnly) throw new Error('stub: close transport failure');
    return realMarketOrder(symbol, side, qty, opts);
  };
  await trader.onSignal(mkSignal('SHORT', 99, 1, 'LTCUSDT'));
  const afterFailedReverse = openOf('LTCUSDT');
  assert(afterFailedReverse?.id === guardedReverse.id && afterFailedReverse?.side === 'LONG', 'failed close stays OPEN in the journal');
  assert(openTrades().filter((t) => t.symbol === 'LTCUSDT').length === 1, 'no reverse entry was stacked on the unconfirmed close');
  assert(liveOfTrade(guardedReverse.id).length === 4, 'the unconfirmed position keeps its full protective ladder');
  api.marketOrder = realMarketOrder;
  await trader.kill();
  await settle();
  assert(!openOf('LTCUSDT'), 'reverse guard fixture cleaned up after transport recovery');

  console.log('\n— Same-symbol external size is left untouched —');
  await trader.onSignal(mkSignal('LONG', 100, 1, 'ATOMUSDT'));
  const atom = openOf('ATOMUSDT');
  assert(!!atom, 'ownership-drift fixture opened a bot LONG');
  ex.positions.set('ATOMUSDT', (ex.positions.get('ATOMUSDT') ?? 0) + 2); // manual same-side size added later
  const atomClosed = await trader.closeByMarket(atom, 'KILL');
  assert(atomClosed && !openOf('ATOMUSDT'), 'bot portion closed and journal finalized');
  assert(approx(ex.positions.get('ATOMUSDT') ?? 0, 2), 'the extra external quantity remains on the exchange');
  ex.positions.delete('ATOMUSDT');

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
  assert(ex.orders.every((o) => o.symbol !== 'ETHUSDT') && algoOf('ETHUSDT').length === 0, 'not a single order was sent for the guarded symbol');
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

  /* ---------- 7. reconcile re-arms missing legs ---------- */
  console.log('\n— Reconcile: legs cancelled behind the bot’s back are re-armed —');
  const solStop = liveAlgo('SOLUSDT').find((o) => o.type === 'STOP_MARKET');
  solStop.algoStatus = 'CANCELED';
  const solTp2 = ex.algo.find((o) => o.clientAlgoId === `VX${sol.id}2`);
  solTp2.algoStatus = 'CANCELED';
  await trader.reconcile();
  await settle();
  const rearmed = liveAlgo('SOLUSDT').filter((o) => o.type === 'STOP_MARKET').pop();
  assert(!!rearmed && rearmed.reduceOnly && rearmed.quantity > 0 && rearmed.clientAlgoId.startsWith(`VX${sol.id}S`), 'reconcile re-armed the missing stop with an explicit quantity');
  const rearmedTp2 = liveAlgo('SOLUSDT').find((o) => o.type === 'TAKE_PROFIT_MARKET' && o.clientAlgoId.startsWith(`VX${sol.id}2R`));
  assert(!!rearmedTp2 && rearmedTp2.reduceOnly && rearmedTp2.quantity > 0, 'reconcile re-armed a missing TP leg with a persisted recovery id');
  assert(openTradeOn('SOLUSDT').orders.tp2 === rearmedTp2?.clientAlgoId, 'the recovery id is persisted so a later fill routes to it');
  assert(liveAlgo('SOLUSDT').length === 4, 'exactly one stop and three take-profits rest — nothing doubled');

  /* ---------- 8. fills the stream missed ---------- */
  console.log('\n— Reconcile: fills the WebSocket missed are booked from REST —');
  const solNow = openTradeOn('SOLUSDT');
  fireAlgo(solNow.orders.tp1, solNow.tp1, { rp: 5, commission: 0.01, via: 'rest' });
  assert(!openTradeOn('SOLUSDT').tp1Filled, 'precondition: the journal has not heard about the TP1 fill');
  await trader.reconcile();
  await settle();
  const solAfterTp1 = openTradeOn('SOLUSDT');
  assert(solAfterTp1.tp1Filled && solAfterTp1.slStage === 1, 'a missed TP1 was detected from the algo order state and the stop moved to breakeven');
  assert(liveAlgo('SOLUSDT').some((o) => o.type === 'STOP_MARKET' && o.clientAlgoId.startsWith(`VX${sol.id}S1`)), 'the breakeven stop is resting on the exchange');
  const slCid = solAfterTp1.orders.sl;
  fireAlgo(slCid, solAfterTp1.slCurrent, { rp: 0, commission: 0.01, via: 'rest' });
  await trader.reconcile();
  await settle();
  const solClosed = allTrades().find((x) => x.id === sol.id);
  assert(solClosed.status === 'CLOSED' && solClosed.closeReason === 'SL_PARTIAL' && solClosed.result === 'WIN', 'a missed stop-out is booked as SL_PARTIAL (a win after TP1)');
  assert(liveOfTrade(sol.id).length === 0, 'the ladder was cleaned up after the missed stop-out');
  assert(solClosed.fees > 0, `fees came from the exchange ledger (${solClosed.fees})`);

  /* ---------- 8b. stop gone AND already breached ---------- */
  console.log('\n— Reconcile: a vanished stop that the market has already crossed → flatten —');
  await trader.onSignal(mkSignal('LONG', 100, 1, 'RUNEUSDT'));
  await settle();
  const rune = openTradeOn('RUNEUSDT');
  assert(!!rune && liveOfTrade(rune.id).length === 4, 'RUNE fixture has a full ladder');
  liveAlgo('RUNEUSDT').find((o) => o.type === 'STOP_MARKET').algoStatus = 'CANCELED'; // the stop disappears…
  ex.price.set('RUNEUSDT', rune.slCurrent - 0.5); // …while the market has already fallen through it
  await trader.reconcile();
  await settle();
  const runeClosed = allTrades().find((x) => x.id === rune.id);
  assert(runeClosed.status === 'CLOSED' && runeClosed.closeReason === 'KILL', 'a breached, un-armable stop closes the position at market instead of leaving it naked');
  assert((ex.positions.get('RUNEUSDT') ?? 0) === 0 && liveOfTrade(rune.id).length === 0, 'flat on the exchange with nothing left resting');

  /* ---------- 8c. one un-armable TP leg must not starve the others ---------- */
  console.log('\n— Reconcile: TP legs are re-armed independently —');
  await trader.onSignal(mkSignal('LONG', 100, 1, 'GRTUSDT'));
  await settle();
  const grt = openTradeOn('GRTUSDT');
  assert(!!grt && liveOfTrade(grt.id).length === 4, 'GRT fixture has a full ladder');
  for (const k of ['tp1', 'tp2', 'tp3']) ex.algo.find((o) => o.clientAlgoId === grt.orders[k]).algoStatus = 'CANCELED';
  ex.rejectAlgo = (params) => (params.type === 'TAKE_PROFIT_MARKET' && Math.abs(Number(params.triggerPrice) - grt.tp1) < 1e-6
    ? apiError('/fapi/v1/algoOrder', 400, -2021, 'Order would immediately trigger.') : null);
  await trader.reconcile();
  await settle();
  ex.rejectAlgo = null;
  const grtNow = openTradeOn('GRTUSDT');
  assert(!!grtNow && liveOfTrade(grt.id).some((o) => o.clientAlgoId.startsWith(`VX${grt.id}2R`)) && liveOfTrade(grt.id).some((o) => o.clientAlgoId.startsWith(`VX${grt.id}3R`)), 'TP2 and TP3 were re-armed although TP1 could not be');
  assert(liveOfTrade(grt.id).filter((o) => o.type === 'STOP_MARKET').length === 1, 'and the position kept its stop');
  await trader.kill();
  await settle();

  /* ---------- 9. never duplicate a leg ---------- */
  console.log('\n— Reconcile never doubles a leg (incomplete or failing answers) —');
  await trader.onSignal(mkSignal('LONG', 100, 1, 'DOGEUSDT'));
  await settle();
  const dg = openTradeOn('DOGEUSDT');
  assert(!!dg && liveAlgo('DOGEUSDT').length === 4, 'DOGE fixture has a full four-leg ladder');
  ex.hideOpenList = true; // the list endpoint answers [] although the legs rest
  await trader.reconcile();
  await settle();
  assert(liveAlgo('DOGEUSDT').length === 4, 'an empty open-orders list alone never re-arms resting legs (each leg is verified by id)');
  ex.flakyAlgoQuery = true; // …and the per-leg lookup fails as well
  await trader.reconcile();
  await settle();
  assert(liveAlgo('DOGEUSDT').length === 4 && openTradeOn('DOGEUSDT')?.id === dg.id, 'when Binance cannot answer, nothing is re-armed (unknown ≠ gone)');
  ex.hideOpenList = false;
  ex.flakyAlgoQuery = false;
  liveAlgo('DOGEUSDT').find((o) => o.type === 'STOP_MARKET').algoStatus = 'CANCELED';
  await Promise.all([trader.reconcile(), trader.reconcile(), trader.reconcile()]);
  await settle();
  assert(liveAlgo('DOGEUSDT').filter((o) => o.type === 'STOP_MARKET').length === 1, 'overlapping reconcile passes re-arm the stop exactly once');

  /* ---------- 10. idempotent events ---------- */
  console.log('\n— Events are idempotent (ALGO_UPDATE + ORDER_TRADE_UPDATE + repeats) —');
  const dgNow = openTradeOn('DOGEUSDT');
  const dgStopsBefore = algoOf('DOGEUSDT', 'STOP_MARKET').length;
  fireAlgo(dgNow.orders.tp1, dgNow.tp1, { rp: 3, commission: 0.01, sameCid: true, repeat: 2 });
  await settle();
  const dgAfter = openTradeOn('DOGEUSDT');
  assert(dgAfter.tp1Filled && dgAfter.slStage === 1, 'TP1 booked from the first event');
  assert(approx(dgAfter.fees, 0.01, 1e-9) && approx(dgAfter.binanceRealizedPnl, 3, 1e-9), `fill numbers counted once, not once per event (${dgAfter.fees} / ${dgAfter.binanceRealizedPnl})`);
  assert(algoOf('DOGEUSDT', 'STOP_MARKET').length === dgStopsBefore + 1, 'the stop was moved exactly once');
  // …and a frame replayed LATER (after a reconnect) is dropped before any request is made.
  const callsAfterFirst = ex.calls.length;
  redeliver(dgNow.orders.tp1);
  redeliver(dgNow.orders.tp1);
  await settle();
  assert(ex.calls.length === callsAfterFirst, 'a replayed fill frame triggers no request at all (no second stop move)');
  const dgReplayed = openTradeOn('DOGEUSDT');
  assert(approx(dgReplayed.fees, 0.01, 1e-9) && approx(dgReplayed.binanceRealizedPnl, 3, 1e-9) && dgReplayed.slStage === 1, 'a replayed fill frame changes no number and no stage');
  trader.onAlgoUpdate({ o: { caid: dgAfter.orders.tp2, s: 'DOGEUSDT', X: 'FINISHED', aq: '0', rm: 'test' } });
  trader.onAlgoUpdate({ o: { caid: 'MANUAL-1', s: 'DOGEUSDT', X: 'FINISHED', aq: '1', ap: '1' } });
  trader.onAlgoUpdate({ o: { caid: 'VXunknown1S0', s: 'DOGEUSDT', X: 'FINISHED', aq: '1', ap: '1' } });
  trader.onAlgoUpdate({ o: { caid: dgAfter.orders.tp2, s: 'ETHUSDT', X: 'FINISHED', aq: '1', ap: '1' } }); // wrong symbol
  trader.onAlgoUpdate({});
  await settle();
  assert(!openTradeOn('DOGEUSDT').tp2Filled, 'an ALGO_UPDATE that executed nothing / a foreign or mismatched id never books a fill');
  await trader.kill();
  await settle();

  console.log('\n— A stop that could not be cancelled while moving is still swept at close —');
  await trader.onSignal(mkSignal('LONG', 100, 1, 'SANDUSDT'));
  await settle();
  const sand = openTradeOn('SANDUSDT');
  assert(!!sand && liveOfTrade(sand.id).length === 4, 'SAND fixture has a full ladder');
  ex.failNextAlgoCancel = true; // the old stop cannot be cancelled while the bot moves it to breakeven
  fireAlgo(sand.orders.tp1, sand.tp1, { rp: 1, commission: 0.01 });
  await settle();
  const sandStops = algoOf('SANDUSDT', 'STOP_MARKET').filter((o) => o.algoStatus === 'NEW');
  assert(sandStops.length === 2, 'precondition: the old stop survived the failed cancel next to its replacement');
  await trader.kill();
  await settle();
  assert(liveOfTrade(sand.id).length === 0, 'the untracked old stop was found by the prefix sweep and cancelled at close');

  console.log('\n— A close in flight owns the trade —');
  await trader.onSignal(mkSignal('LONG', 100, 1, 'GALAUSDT'));
  await settle();
  const gala = openTradeOn('GALAUSDT');
  assert(!!gala && liveOfTrade(gala.id).length === 4, 'GALA fixture has a full ladder');
  liveAlgo('GALAUSDT').find((o) => o.type === 'STOP_MARKET').algoStatus = 'CANCELED'; // the stop vanished: reconcile WOULD re-arm it
  ex.delayCloseMs = 150; // the close takes a while on the wire
  const postsBeforeClose = ex.calls.filter((c) => c === 'POST /fapi/v1/algoOrder').length;
  const closePromise = trader.closeByMarket(gala, 'KILL');
  await sleep(30);
  await trader.reconcile(); // runs while the close is in flight
  const secondClose = await trader.closeByMarket(gala, 'KILL'); // a second, concurrent close request
  const firstClose = await closePromise;
  ex.delayCloseMs = 0;
  assert(firstClose === true && !openTradeOn('GALAUSDT'), 'the in-flight close completed and the trade is closed');
  assert(secondClose === false, 'a second close request while one is in flight is refused');
  assert(ex.orders.filter((o) => o.clientOrderId === `VX${gala.id}X`).length === 1, 'exactly one close order reached the exchange');
  assert(ex.calls.filter((c) => c === 'POST /fapi/v1/algoOrder').length === postsBeforeClose, 'reconcile re-armed nothing underneath the close');
  assert(liveOfTrade(gala.id).length === 0 && (ex.positions.get('GALAUSDT') ?? 0) === 0, 'flat, with no leg left resting');

  /* ---------- 11. lost POST response · refused leg ---------- */
  console.log('\n— A lost POST response is resolved by client id; a refused leg flattens —');
  ex.loseNextAlgoResponse = true;
  const lookupsBefore = ex.calls.filter((c) => c === 'GET /fapi/v1/algoOrder').length;
  await trader.onSignal(mkSignal('LONG', 100, 1, 'MATICUSDT'));
  await settle();
  const matic = openTradeOn('MATICUSDT');
  assert(!!matic && matic.status === 'OPEN', 'entry survived a stop-order response lost in transit (no emergency flatten)');
  assert(algoOf('MATICUSDT', 'STOP_MARKET').length === 1, 'the stop exists exactly once — the POST was never repeated');
  assert(ex.calls.filter((c) => c === 'GET /fapi/v1/algoOrder').length > lookupsBefore, 'the lost response was resolved by looking the order up by its client id');
  assert(liveAlgo('MATICUSDT').length === 4, 'the full ladder is in place');
  await trader.kill();
  await settle();

  let tpPosts = 0;
  ex.rejectAlgo = (params) => (params.type === 'TAKE_PROFIT_MARKET' && ++tpPosts === 2
    ? apiError('/fapi/v1/algoOrder', 400, -2021, 'Order would immediately trigger.')
    : null);
  await trader.onSignal(mkSignal('LONG', 100, 1, 'DOTUSDT'));
  await settle();
  ex.rejectAlgo = null;
  const dot = allTrades().find((x) => x.symbol === 'DOTUSDT');
  assert(!!dot && dot.status === 'CLOSED' && dot.closeReason === 'KILL', 'a leg refused by the exchange triggered the emergency flatten');
  assert((ex.positions.get('DOTUSDT') ?? 0) === 0, 'the position was flattened on the exchange');
  assert(liveAlgo('DOTUSDT').length === 0, 'the legs that had already been placed were cancelled');

  /* ---------- 11b. circuit breaker ---------- */
  console.log('\n— Repeated protective-ladder failures disarm auto-trade (no fee-burning loop) —');
  const protocolBroke = () => apiError('/fapi/v1/algoOrder', 400, -4120, 'Order type not supported for this endpoint.');
  // earlier scenarios already produced a failed ladder — a healthy entry resets the streak
  await trader.onSignal(mkSignal('LONG', 100, 1, 'EGLDUSDT'));
  await settle();
  assert(!!openTradeOn('EGLDUSDT'), 'a healthy entry precedes the breaker scenario (streak reset)');
  await trader.kill();
  await settle();
  ex.rejectAlgo = protocolBroke; // as if Binance changed its protocol again
  await trader.onSignal(mkSignal('LONG', 100, 1, 'EGLDUSDT'));
  await settle();
  assert(getSettings().autoTrade === true, 'a single unprotected entry (flattened again) does not disarm yet');
  await trader.onSignal(mkSignal('LONG', 100, 1, 'EGLDUSDT'));
  await settle();
  assert(getSettings().autoTrade === false, 'the second consecutive failure disarmed auto-trade');
  const ordersAtDisarm = ex.orders.length;
  await trader.onSignal(mkSignal('LONG', 100, 1, 'EGLDUSDT'));
  await settle();
  assert(ex.orders.length === ordersAtDisarm, 'a disarmed bot sends nothing further');
  assert(allTrades().filter((x) => x.symbol === 'EGLDUSDT').every((x) => x.status === 'CLOSED') && (ex.positions.get('EGLDUSDT') ?? 0) === 0, 'every failed entry was flattened — nothing left naked');
  ex.rejectAlgo = null;
  updateSettings({ autoTrade: true });
  await trader.onSignal(mkSignal('LONG', 100, 1, 'EGLDUSDT'));
  await settle();
  assert(!!openTradeOn('EGLDUSDT'), 'after re-arming, a healthy entry works again');
  await trader.kill();
  await settle();
  ex.rejectAlgo = protocolBroke;
  await trader.onSignal(mkSignal('LONG', 100, 1, 'EGLDUSDT'));
  await settle();
  ex.rejectAlgo = null;
  assert(getSettings().autoTrade === true, 'a healthy trade reset the streak — one later failure does not disarm');

  // an emergency close that cannot be confirmed disarms immediately
  ex.rejectAlgo = protocolBroke;
  api.marketOrder = async (symbol, side, qty, opts = {}) => {
    if (symbol === 'ZILUSDT' && opts.reduceOnly) throw new Error('stub: close transport failure');
    return realMarketOrder(symbol, side, qty, opts);
  };
  await trader.onSignal(mkSignal('LONG', 100, 1, 'ZILUSDT'));
  await settle();
  const zil = openTradeOn('ZILUSDT');
  assert(!!zil && getSettings().autoTrade === false, 'an unconfirmed emergency close leaves the trade managed AND disarms auto-trade at once');
  api.marketOrder = realMarketOrder;
  ex.rejectAlgo = null;
  await trader.kill();
  await settle();
  assert(!openTradeOn('ZILUSDT'), 'the stuck position was closed once the exchange answered');
  updateSettings({ autoTrade: true });

  /* ---------- 12. stale legs · foreign orders · other-mode trades ---------- */
  console.log('\n— Stale legs are swept; foreign orders and other-mode trades are never touched —');
  const rawAlgo = (cid, symbol) => ({
    algoId: ex.seq++, clientAlgoId: cid, symbol, side: 'SELL', type: 'STOP_MARKET', algoType: 'CONDITIONAL',
    algoStatus: 'NEW', triggerPrice: 1, quantity: 1, reduceOnly: true, positionSide: null, actualOrderId: '', actualPrice: '0', time: Date.now(),
  });
  ex.algo.push(rawAlgo('VXdeadbeefS0', 'LINKUSDT'), rawAlgo('my-manual-stop', 'LINKUSDT'));
  await trader.onSignal(mkSignal('LONG', 100, 1, 'LINKUSDT'));
  await settle();
  assert(ex.algo.find((o) => o.clientAlgoId === 'VXdeadbeefS0').algoStatus === 'CANCELED', 'a stale VX leg of an earlier trade was removed before the new entry');
  assert(ex.algo.find((o) => o.clientAlgoId === 'my-manual-stop').algoStatus === 'NEW', 'the operator’s own conditional order was left alone');
  assert(!!openTradeOn('LINKUSDT'), 'the entry went ahead');
  await trader.kill();
  await settle();
  assert(ex.algo.find((o) => o.clientAlgoId === 'my-manual-stop').algoStatus === 'NEW', 'kill never cancels foreign conditional orders either');

  const { saveTrade } = require('../dist/store');
  saveTrade({
    id: 'zzother1', symbol: 'BCHUSDT', side: 'LONG', status: 'OPEN', qty: 1, q1: 0, q2: 0, q3: 1, entryPrice: 100, atrAtEntry: 1,
    slInitial: 98, slCurrent: 98, slStage: 0, tp1: 103, tp2: 106, tp3: 109, notional: 100, margin: 10, leverage: 10,
    openedAt: Date.now(), closedAt: null, closeReason: null, tp1Filled: false, tp2Filled: false, tp3Filled: false,
    realizedPnl: 0, fees: 0, funding: 0, binanceRealizedPnl: 0, commissionOtherAsset: 0, initialRisk: 2,
    orders: { entry: 'VXzzother1E', sl: 'VXzzother1S0', tp3: 'VXzzother13' }, mode: 'live', result: null, botOwned: true,
  });
  const callsBeforeForeign = ex.calls.length;
  await trader.reconcile();
  await settle();
  assert(openTrades().some((x) => x.id === 'zzother1' && x.status === 'OPEN'), 'a trade opened in the OTHER environment is left untouched by reconcile');
  assert(ex.calls.length === callsBeforeForeign, 'no request was made on its behalf (wrong keys / endpoint)');
  saveTrade({ ...openTrades().find((x) => x.id === 'zzother1'), status: 'CLOSED', closedAt: Date.now(), closeReason: 'EXTERNAL' });

  /* ---------- 13. min-notional bump is bounded ---------- */
  console.log('\n— The exchange minimum notional can never silently multiply the risk —');
  // equity 1000 · 5% · 10× → margin 50 / notional 500
  ex.minNotional.set('NEARUSDT', 800); // needs 80 margin ≤ 2× → a modest round-up
  await trader.onSignal(mkSignal('LONG', 100, 1, 'NEARUSDT'));
  await settle();
  const near = openTradeOn('NEARUSDT');
  assert(!!near && near.notional >= 800 - 1e-6 && near.margin <= 100 + 1e-6, `a modest round-up to the exchange minimum is allowed (margin ${near?.margin})`);
  await trader.kill();
  await settle();
  ex.minNotional.set('APTUSDT', 2000); // needs 200 margin > 2× the configured 50 → refused
  const ordersBeforeApt = ex.orders.length;
  await trader.onSignal(mkSignal('LONG', 100, 1, 'APTUSDT'));
  await settle();
  assert(!openTradeOn('APTUSDT') && ex.orders.length === ordersBeforeApt && algoOf('APTUSDT').length === 0, 'a minimum needing more than 2× the configured margin is refused — no order sent');

  /* ---------- 14. entry price source ---------- */
  console.log('\n— Entry price comes from the exchange even when the order reply omits it —');
  ex.omitAvg = 1;
  const filSig = mkSignal('LONG', 123.4, 1, 'FILUSDT');
  ex.price.set('FILUSDT', 123.9); // slippage: the exchange fills above the signal price
  await trader.onSignal(filSig);
  await settle();
  const fil = openTradeOn('FILUSDT');
  assert(!!fil && approx(fil.entryPrice, 123.9, 1e-9), `entry = the order’s avgPrice looked up by client id, not the signal price (${fil?.entryPrice})`);
  ex.omitAvg = 2;
  const icpSig = mkSignal('LONG', 123.4, 1, 'ICPUSDT');
  ex.price.set('ICPUSDT', 123.9);
  await trader.onSignal(icpSig);
  await settle();
  const icp = openTradeOn('ICPUSDT');
  assert(!!icp && approx(icp.entryPrice, 123.9, 1e-9), `…and falls back to the position’s entry price (${icp?.entryPrice})`);
  ex.omitAvg = 0;
  await trader.kill();
  await settle();

  /* ---------- 15. multi-position cap (max 8, one per symbol) ---------- */
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
  assert(ex.algo.filter((o) => o.clientAlgoId.startsWith('VX') && o.algoStatus === 'NEW' && o.clientAlgoId !== 'VXdeadbeefS0').length === 0, 'no bot conditional order is left resting anywhere after the kill');

  /* ---------- 16. hedge mode: exits are scoped by positionSide ---------- */
  console.log('\n— Hedge mode (positionSide, no reduceOnly) —');
  ex.isDual = true;
  await trader.onSignal(mkSignal('LONG', 100, 1, 'ETHUSDT'));
  await settle();
  const hedged = openTradeOn('ETHUSDT');
  assert(!!hedged, 'hedge-mode entry opened');
  // Scope to THIS trade's client-id prefix: earlier sections left their own
  // ETHUSDT orders in the book and they must not leak into these checks.
  const hedgeLegs = () => ex.algo.filter((o) => o.clientAlgoId.startsWith(`VX${hedged.id}`));
  const hTps = hedgeLegs().filter((o) => o.type === 'TAKE_PROFIT_MARKET');
  assert(hTps.length === 3 && hTps.every((o) => o.positionSide === 'LONG'), 'hedge-mode TP legs carry positionSide=LONG');
  assert(hTps.every((o) => !o.reduceOnly), 'hedge-mode TP legs never send reduceOnly (Binance rejects it there)');
  const hStop = hedgeLegs().find((o) => o.type === 'STOP_MARKET');
  assert(!!hStop && hStop.positionSide === 'LONG' && !hStop.reduceOnly, 'hedge-mode stop is scoped by positionSide');
  // After TP1 the replacement stop must stay position-side scoped too.
  fireAlgo(hedged.orders.tp1, hedged.tp1, { rp: 1, commission: 0.01 });
  await settle();
  const hStop2 = hedgeLegs().filter((o) => o.type === 'STOP_MARKET' && o.algoStatus === 'NEW').pop();
  assert(!!hStop2 && hStop2.positionSide === 'LONG' && !hStop2.reduceOnly, 'the moved stop keeps its positionSide scope');
  await trader.kill();
  await settle();
  assert(openTrades().length === 0, 'hedge-mode position closed through the tagged reduce path');
  ex.isDual = false;

  /* ---------- 17. stats ---------- */
  const st = computeStats();
  assert(st.totalClosedTrades >= 10, `stats count the closed journal (${st.totalClosedTrades})`);
  assert(st.winCount >= 1 && st.lossCount >= 1, `wins and losses are counted (${st.winCount}W/${st.lossCount}L)`);

  /* ---------- 18. whole-run invariants ---------- */
  assert(ex.legacyConditionalAttempts === 0, 'across the whole run no conditional order was ever sent to /fapi/v1/order');
  assert(!ex.calls.includes('DELETE /fapi/v1/algoOpenOrders'), 'the cancel-everything-on-symbol endpoint was never used');
  assert(ex.algo.every((o) => o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET'), 'only STOP_MARKET / TAKE_PROFIT_MARKET legs were ever created');

  updateSettings({ autoTrade: false }); // leave the system SAFE
  console.log(failures === 0 ? '\nE2E: ALL TESTS PASSED' : `\nE2E: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('CRASH:', e); process.exit(1); });

/**
 * Wire-level test — runs the REAL HTTP / WebSocket client code (signing, query
 * encoding, error mapping, algo endpoints, listenKey handling, stream URL
 * handling and event routing) against local mock servers that speak Binance's
 * 2026 protocol. Nothing in src/ is stubbed.
 *
 * What it can prove offline: the bytes the bot would put on the wire and how it
 * reacts to the replies documented by Binance. What it cannot prove: that the
 * live exchange still behaves as documented — run the testnet/demo first.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

process.env.VX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-wire-'));
process.env.BINANCE_MODE = 'testnet';
const KEY = 'TESTKEY0000000000';
const SECRET = 'TESTSECRET0000000000';
process.env.BINANCE_TESTNET_KEY = KEY;
process.env.BINANCE_TESTNET_SECRET = SECRET;

const realWs = require('ws');
const { WebSocketServer } = realWs;

let failures = 0;
function assert(cond, name) {
  if (cond) console.log(`ok   ${name}`);
  else { failures += 1; console.log(`FAIL ${name}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}
const uncaught = [];
process.on('uncaughtException', (e) => { uncaught.push(e); });

/* ------------------------------------------------------------------ mock REST */
const seen = [];
let override = null; // (rec) => {status, body} | null — per-test behaviour
const state = { marginCalls: 0, dual: false, algoOpen: [] };
function defaults(rec) {
  const k = `${rec.method} ${rec.path}`;
  switch (k) {
    case 'GET /fapi/v1/positionSide/dual': return { body: { dualSidePosition: state.dual } };
    case 'POST /fapi/v1/marginType': return { body: { code: 200, msg: 'success' } };
    case 'POST /fapi/v1/leverage': return { body: { symbol: rec.query.symbol, leverage: Number(rec.query.leverage), maxNotionalValue: '1000000' } };
    case 'POST /fapi/v1/order': {
      if (/STOP|TAKE_PROFIT|TRAILING/.test(rec.query.type || '')) {
        return { status: 400, body: { code: -4120, msg: 'Order type not supported for this endpoint. Please use the Algo Order API endpoints instead.' } };
      }
      return { body: { orderId: 9001, clientOrderId: rec.query.newClientOrderId, status: 'FILLED', avgPrice: '68000.00', executedQty: rec.query.quantity, type: 'MARKET' } };
    }
    case 'POST /fapi/v1/algoOrder':
      return { body: { algoId: 7001, clientAlgoId: rec.query.clientAlgoId, algoType: 'CONDITIONAL', algoStatus: 'NEW', orderType: rec.query.type } };
    case 'DELETE /fapi/v1/algoOrder':
      return { body: { algoId: 7001, clientAlgoId: rec.query.clientAlgoId, code: '200', msg: 'success' } };
    case 'GET /fapi/v1/openAlgoOrders': return { body: state.algoOpen };
    case 'POST /fapi/v1/listenKey': return { body: { listenKey: 'LKEY123' } };
    case 'PUT /fapi/v1/listenKey': return { body: {} };
    default: return { status: 404, body: { code: -1000, msg: `mock: no route ${k}` } };
  }
}
const rest = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://mock');
  const rec = {
    method: req.method,
    path: u.pathname,
    query: Object.fromEntries(u.searchParams.entries()),
    raw: u.search.slice(1),
    key: req.headers['x-mbx-apikey'],
  };
  if (rec.query.signature) {
    const unsigned = rec.raw.replace(/&signature=[0-9a-f]+$/, '');
    rec.sigOk = crypto.createHmac('sha256', SECRET).update(unsigned).digest('hex') === rec.query.signature;
  }
  seen.push(rec);
  const out = (override && override(rec)) || defaults(rec);
  res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
  res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
});

/* ------------------------------------------------------------------ mock WS */
const wsHits = []; // urls the client asked for
let acceptUser = (url) => true; // which user-stream URL forms are accepted
let marketDelayMs = { '/public/stream': 0, '/market/stream': 0 };
const wss = new WebSocketServer({
  port: 0,
  verifyClient: (info, cb) => {
    const url = info.req.url;
    wsHits.push(url);
    const p = url.split('?')[0];
    const delay = marketDelayMs[p] ?? 0;
    const decide = () => {
      if (p.startsWith('/private') || p.startsWith('/ws/')) {
        if (!acceptUser(url)) return cb(false, 404, 'Not Found');
      }
      cb(true);
    };
    if (delay) setTimeout(decide, delay); else decide();
  },
});
const sockets = new Set();
wss.on('connection', (sock, req) => {
  sockets.add(sock);
  sock.on('close', () => sockets.delete(sock));
  sock.on('error', () => {});
  const p = req.url.split('?')[0];
  if (p === '/public/stream') {
    sock.send(JSON.stringify({ stream: 'btcusdt@bookTicker', data: { e: 'bookTicker', s: 'BTCUSDT', b: '67999.90', a: '68000.10' } }));
  } else if (p === '/market/stream') {
    sock.send(JSON.stringify({ stream: 'btcusdt@kline_5m', data: { e: 'kline', s: 'BTCUSDT', k: { t: 1, T: 2, s: 'BTCUSDT', i: '5m', o: '1', c: '2', h: '3', l: '0.5', v: '9', x: false } } }));
  }
});

async function main() {
  await new Promise((r) => rest.listen(0, '127.0.0.1', r));
  await new Promise((r) => { if (wss.address()) r(); else wss.once('listening', r); });
  const restPort = rest.address().port;
  const wsPort = wss.address().port;
  process.env.BINANCE_TESTNET_REST = `http://127.0.0.1:${restPort}`;
  process.env.BINANCE_TESTNET_WS = `ws://127.0.0.1:${wsPort}`;

  // Market data is mainnet-only by design; the harness redirects that one host
  // to the local mock by subclassing the ws client BEFORE the product loads it.
  class RedirectedWs extends realWs {
    constructor(url, ...rest2) {
      super(String(url).replace('wss://fstream.binance.com', `ws://127.0.0.1:${wsPort}`), ...rest2);
    }
  }
  require.cache[require.resolve('ws')].exports = RedirectedWs;

  const binance = require('../dist/binance');
  const { api } = binance;
  const { loadSettings, updateSettings } = require('../dist/settings');
  loadSettings();
  updateSettings({ autoTrade: false });

  /* ============================================================ URL builders */
  console.log('\n— Endpoint and URL forms —');
  assert(binance.restBase('testnet') === `http://127.0.0.1:${restPort}`, 'BINANCE_TESTNET_REST overrides the demo REST host');
  assert(binance.restBase('live') === 'https://fapi.binance.com', 'live REST is the production host');
  assert(binance.marketStreamUrl('public', ['BTCUSDT', 'ETHUSDT']) === 'wss://fstream.binance.com/public/stream?streams=btcusdt@bookTicker/ethusdt@bookTicker', 'bookTicker rides the /public socket');
  assert(binance.marketStreamUrl('market', ['BTCUSDT', 'ETHUSDT'], '5m') === 'wss://fstream.binance.com/market/stream?streams=btcusdt@kline_5m/ethusdt@kline_5m', 'klines ride the /market socket');
  const live = binance.userStreamUrls('live', 'KEY');
  assert(live[0] === 'wss://fstream.binance.com/private/ws/KEY' && /\/private\/ws\?listenKey=KEY&events=.*ALGO_UPDATE/.test(live[1]), 'user stream candidates start with the documented /private forms');
  assert(!live.slice(0, 3).some((u) => /\/\/fstream\.binance\.com\/(ws|stream)\//.test(u)), 'no candidate except the last resort uses the decommissioned /ws or /stream root');
  const pinnedWs = process.env.BINANCE_TESTNET_WS;
  delete process.env.BINANCE_TESTNET_WS;
  const demoUrls = binance.userStreamUrls('testnet', 'KEY');
  process.env.BINANCE_TESTNET_WS = pinnedWs;
  assert(demoUrls[0] === 'wss://demo-fstream.binance.com/private/ws/KEY' && demoUrls.includes('wss://fstream.binancefuture.com/ws/KEY') && demoUrls.every((u) => !/\/\/fstream\.binance\.com\//.test(u)),
    'testnet tries BOTH documented demo hosts (docs disagree) and never the mainnet legacy root');
  assert(binance.userStreamUrls('testnet', 'KEY').every((u) => u.startsWith(pinnedWs)), 'BINANCE_TESTNET_WS pins the testnet user stream to one host');
  assert(binance.fmtQty(1e-7) === '0.0000001' && binance.fmtQty(0.1 + 0.2) === '0.3' && binance.fmtQty(5) === '5' && binance.fmtPrice(1e21 / 1e15) === '1000000', 'numbers are plain decimals — never exponent form');
  let nanThrown = false;
  try { binance.fmtQty(NaN); } catch { nanThrown = true; }
  assert(nanThrown, 'NaN can never be formatted into an order');

  /* ============================================================ request() */
  console.log('\n— Signed requests and reply handling (real client, mock exchange) —');
  await api.setIsolated('BTCUSDT'); // {"code":200,"msg":"success"}
  assert(true, 'marginType reply {"code":200,"msg":"success"} is a success, not an error');
  const mt = seen.find((r) => r.path === '/fapi/v1/marginType');
  assert(!!mt && mt.sigOk === true && mt.key === KEY && mt.query.recvWindow === '5000' && /^\d{13}$/.test(mt.query.timestamp), 'requests carry key header, recvWindow, timestamp and a valid HMAC-SHA256 signature');

  override = (rec) => (rec.path === '/fapi/v1/marginType'
    ? { status: 400, body: { code: -4046, msg: 'No need to change margin type.' } } : null);
  await api.setIsolated('ETHUSDT');
  assert(true, '-4046 "No need to change margin type" is accepted');
  override = (rec) => (rec.path === '/fapi/v1/marginType'
    ? { status: 400, body: { code: -4047, msg: 'Margin type cannot be changed if there exists open orders.' } } : null);
  let marginErr = null;
  try { await api.setIsolated('SOLUSDT'); } catch (e) { marginErr = e; }
  assert(!!marginErr && /-4047/.test(marginErr.message), 'any other marginType failure still aborts the entry');
  override = (rec) => (rec.path === '/fapi/v1/leverage' ? { body: { code: 200, msg: 'success', symbol: 'X', leverage: 10 } } : null);
  await api.setLeverage('BTCUSDT', 10);
  assert(true, 'a code:200 leverage reply is a success');
  override = null;

  const callsBeforeRefusal = seen.length;
  let refused = null;
  try { await api.newOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', quantity: '0.01', reduceOnly: 'true', stopPrice: '1' }); } catch (e) { refused = e; }
  assert(!!refused && seen.length === callsBeforeRefusal, 'a conditional type on the regular order endpoint is refused before any request is sent');

  /* ============================================================ algo orders */
  console.log('\n— Algo Service orders on the wire —');
  seen.length = 0;
  await api.protectiveStop('BTCUSDT', 'SELL', 67800, 0.007, 'VXabc12345S0');
  const stopReq = seen.find((r) => r.method === 'POST' && r.path === '/fapi/v1/algoOrder');
  assert(!!stopReq && stopReq.sigOk === true && stopReq.key === KEY, 'POST /fapi/v1/algoOrder is signed and keyed');
  const q = stopReq?.query ?? {};
  assert(q.algoType === 'CONDITIONAL' && q.type === 'STOP_MARKET' && q.symbol === 'BTCUSDT' && q.side === 'SELL', 'algoType=CONDITIONAL, type=STOP_MARKET, symbol and side are sent');
  assert(q.triggerPrice === '67800' && q.quantity === '0.007' && q.workingType === 'CONTRACT_PRICE' && q.clientAlgoId === 'VXabc12345S0', 'triggerPrice / quantity / workingType / clientAlgoId are sent');
  assert(q.reduceOnly === 'true' && q.positionSide === undefined, 'one-way mode: reduceOnly=true and no positionSide');
  assert(q.stopPrice === undefined && q.closePosition === undefined && q.newClientOrderId === undefined, 'the legacy stopPrice / closePosition / newClientOrderId parameters are never sent');
  assert(!seen.some((r) => r.method === 'POST' && r.path === '/fapi/v1/order'), 'nothing went to the regular order endpoint');

  seen.length = 0;
  await api.takeProfitMarket('BTCUSDT', 'SELL', 68300, 0.002, { clientAlgoId: 'VXabc123451' });
  const tpq = seen.find((r) => r.path === '/fapi/v1/algoOrder')?.query ?? {};
  assert(tpq.type === 'TAKE_PROFIT_MARKET' && tpq.triggerPrice === '68300' && tpq.quantity === '0.002' && tpq.reduceOnly === 'true', 'take-profit leg: TAKE_PROFIT_MARKET + triggerPrice + reduceOnly');

  api.dualSide = null; // force re-detection → hedge mode
  state.dual = true;
  seen.length = 0;
  await api.takeProfitMarket('BTCUSDT', 'SELL', 68300, 0.002, { clientAlgoId: 'VXabc123452' });
  const hq = seen.find((r) => r.path === '/fapi/v1/algoOrder')?.query ?? {};
  assert(hq.positionSide === 'LONG' && hq.reduceOnly === undefined, 'hedge mode: positionSide=LONG for a SELL exit and no reduceOnly');
  api.dualSide = null;
  state.dual = false;

  const del = await api.cancelAlgoOrder('BTCUSDT', 'VXabc12345S0');
  const delReq = seen.find((r) => r.method === 'DELETE');
  assert(!!del && !!delReq && delReq.path === '/fapi/v1/algoOrder' && delReq.query.clientAlgoId === 'VXabc12345S0' && delReq.sigOk === true, 'cancel uses DELETE /fapi/v1/algoOrder with the client id (a code:"200" reply is a success)');
  assert(!seen.some((r) => r.path === '/fapi/v1/algoOpenOrders'), 'the cancel-everything-on-symbol endpoint is never touched');
  override = (rec) => (rec.method === 'DELETE' ? { status: 400, body: { code: -2013, msg: 'Order does not exist.' } } : null);
  assert((await api.cancelAlgoOrder('BTCUSDT', 'VXnope')) === null, 'cancelling an order that is already gone is not an error');
  override = (rec) => (rec.method === 'DELETE' ? { status: 503, body: { code: -1000, msg: 'Unknown error, please check your request or try again later.' } } : null);
  let cancelErr = null;
  try { await api.cancelAlgoOrder('BTCUSDT', 'VXabc12345S0'); } catch (e) { cancelErr = e; }
  assert(!!cancelErr, 'a transient cancel failure is surfaced (never silently treated as cancelled)');
  override = null;

  state.algoOpen = [{ clientAlgoId: 'VXabc12345S0', algoStatus: 'NEW' }];
  assert((await api.openAlgoOrders('BTCUSDT')).length === 1, 'openAlgoOrders parses the array reply');
  override = (rec) => (rec.path === '/fapi/v1/openAlgoOrders' ? { body: { orders: [{ clientAlgoId: 'A' }, { clientAlgoId: 'B' }] } } : null);
  assert((await api.openAlgoOrders('BTCUSDT')).length === 2, '…and the {orders:[…]} form');
  override = null;
  state.algoOpen = [];

  /* leg state machine */
  const algoReply = (status, extra = {}) => (rec) => (rec.path === '/fapi/v1/algoOrder' && rec.method === 'GET'
    ? { body: { algoId: 1, clientAlgoId: rec.query.clientAlgoId, algoStatus: status, ...extra } } : null);
  override = algoReply('NEW');
  assert((await api.algoLegState('BTCUSDT', 'VXabc12345S0')).state === 'alive', 'algoStatus NEW → alive');
  for (const st of ['CANCELED', 'EXPIRED', 'REJECTED']) {
    override = algoReply(st);
    assert((await api.algoLegState('BTCUSDT', 'VXabc12345S0')).state === 'gone', `algoStatus ${st} → gone`);
  }
  override = (rec) => (rec.path === '/fapi/v1/algoOrder' ? { status: 400, body: { code: -2013, msg: 'Order does not exist.' } } : null);
  assert((await api.algoLegState('BTCUSDT', 'VXabc12345S0')).state === 'gone', 'order not found → gone');
  override = (rec) => (rec.path === '/fapi/v1/algoOrder' ? { status: 503, body: { code: -1000, msg: 'Unknown error, please check your request or try again later.' } } : null);
  assert((await api.algoLegState('BTCUSDT', 'VXabc12345S0')).state === 'unknown', 'a 503 from the exchange → unknown (never acted on)');
  override = (rec) => (rec.path === '/fapi/v1/algoOrder' ? { status: 404, body: '<html><body>404 Not Found</body></html>' } : null);
  assert((await api.algoLegState('BTCUSDT', 'VXabc12345S0')).state === 'unknown', 'an HTTP 404 page (endpoint missing / proxy) → unknown, never mistaken for "leg gone"');
  override = (rec) => (rec.method === 'DELETE' ? { status: 404, body: '<html>Not Found</html>' } : null);
  let notFoundCancel = null;
  try { await api.cancelAlgoOrder('BTCUSDT', 'VXabc12345S0'); } catch (e) { notFoundCancel = e; }
  assert(!!notFoundCancel, 'a 404 page on cancel is an error, not "already cancelled"');
  override = algoReply('FINISHED', { actualOrderId: '' });
  assert((await api.algoLegState('BTCUSDT', 'VXabc12345S0')).state === 'unknown', 'FINISHED without an actualOrderId → unknown');
  override = (rec) => {
    if (rec.path === '/fapi/v1/algoOrder') return { body: { algoStatus: 'FINISHED', actualOrderId: '555', actualPrice: '68010' } };
    if (rec.path === '/fapi/v1/order') return { body: { orderId: 555, status: 'FILLED', executedQty: '0.005', avgPrice: '68012.5' } };
    return null;
  };
  const filled = await api.algoLegState('BTCUSDT', 'VXabc12345S0');
  assert(filled.state === 'filled' && filled.avgPrice === 68012.5 && filled.executedQty === 0.005 && filled.orderId === '555', 'FINISHED + a FILLED engine order → filled with the real average price');
  override = (rec) => {
    if (rec.path === '/fapi/v1/algoOrder') return { body: { algoStatus: 'TRIGGERED', actualOrderId: '556' } };
    if (rec.path === '/fapi/v1/order') return { body: { orderId: 556, status: 'NEW', executedQty: '0', avgPrice: '0' } };
    return null;
  };
  assert((await api.algoLegState('BTCUSDT', 'VXabc12345S0')).state === 'unknown', 'TRIGGERED but the engine order has not executed yet → unknown');
  override = null;

  /* lost response on the algo POST */
  let posted = 0;
  override = (rec) => {
    if (rec.method === 'POST' && rec.path === '/fapi/v1/algoOrder') { posted += 1; return { status: 503, body: { code: -1000, msg: 'Unknown error, please check your request or try again later.' } }; }
    if (rec.method === 'GET' && rec.path === '/fapi/v1/algoOrder') return { body: { algoId: 9, clientAlgoId: rec.query.clientAlgoId, algoStatus: 'NEW' } };
    return null;
  };
  const recovered = await api.protectiveStop('BTCUSDT', 'SELL', 67800, 0.007, 'VXlost0001S0');
  assert(posted === 1 && recovered?.algoStatus === 'NEW', 'a failed POST is resolved by client id and never repeated');
  override = (rec) => (rec.method === 'POST' && rec.path === '/fapi/v1/algoOrder'
    ? { status: 400, body: { code: -2021, msg: 'Order would immediately trigger.' } }
    : rec.path === '/fapi/v1/algoOrder' ? { status: 400, body: { code: -2013, msg: 'Order does not exist.' } } : null);
  let trig = null;
  try { await api.protectiveStop('BTCUSDT', 'SELL', 99999, 0.007, 'VXlost0002S0'); } catch (e) { trig = e; }
  assert(!!trig && /-2021/.test(trig.message), 'a definite rejection (-2021) is reported, not hidden by the lookup');
  override = null;

  /* clock drift */
  seen.length = 0;
  override = (rec) => (rec.method === 'POST' && rec.path === '/fapi/v1/algoOrder'
    ? { status: 400, body: { code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' } } : null);
  let drift = null;
  try { await api.protectiveStop('BTCUSDT', 'SELL', 67800, 0.007, 'VXdrift001S0'); } catch (e) { drift = e; }
  assert(!!drift && seen.filter((r) => r.method === 'POST' && r.path === '/fapi/v1/algoOrder').length === 1, 'a -1021 on a POST is reported and the order is never replayed');
  override = null;

  /* entry order */
  seen.length = 0;
  const entry = await api.marketOrder('BTCUSDT', 'BUY', 0.007, { newClientOrderId: 'VXabc12345E' });
  const eq = seen.find((r) => r.path === '/fapi/v1/order')?.query ?? {};
  assert(entry.status === 'FILLED' && eq.type === 'MARKET' && eq.newOrderRespType === 'RESULT' && eq.newClientOrderId === 'VXabc12345E' && eq.reduceOnly === undefined, 'market entry: MARKET + RESULT + client id, not reduceOnly');

  /* listenKey */
  await api.keepAliveListenKey();
  override = (rec) => (rec.method === 'PUT' ? { status: 400, body: { code: -1125, msg: 'This listenKey does not exist.' } } : null);
  let keepErr = null;
  try { await api.keepAliveListenKey(); } catch (e) { keepErr = e; }
  assert(!!keepErr && /1125/.test(keepErr.message), 'a rejected listenKey keep-alive is surfaced so the stream can be rebuilt');
  override = null;

  /* ============================================================ user stream */
  console.log('\n— User-data stream (real WebSocket client, mock server) —');
  const { trader } = require('../dist/trader');
  const { accountService } = require('../dist/account');
  const { candleStore } = require('../dist/candles');
  const got = { algo: [], order: [], account: [], reconcile: 0, klines: [] };
  trader.onAlgoUpdate = (e) => got.algo.push(e);
  trader.onOrderUpdate = (e) => got.order.push(e);
  trader.reconcile = async () => { got.reconcile += 1; };
  accountService.onUserStreamAccount = (e) => got.account.push(e);
  candleStore.applyKline = (d) => got.klines.push(d);
  const { userStream, marketStream } = require('../dist/streams');
  const broadcastFrom = (obj) => { for (const s of sockets) if (s.readyState === 1 && s._vxUser) s.send(JSON.stringify(obj)); };
  wss.on('connection', (sock, req) => { if (req.url.startsWith('/private') || req.url.startsWith('/ws/')) sock._vxUser = true; });

  wsHits.length = 0;
  userStream.start();
  assert(await until(() => userStream.isConnected), 'user stream connected');
  assert(wsHits[0] === '/private/ws/LKEY123', `first connection uses the documented /private/ws/<listenKey> form (${wsHits[0]})`);
  assert(await until(() => got.reconcile >= 1, 1500), 'a (re)connect triggers an immediate reconcile pass');
  broadcastFrom({ e: 'ALGO_UPDATE', o: { caid: 'VXabc12345S0', s: 'BTCUSDT', X: 'FINISHED', aq: '0.007', ap: '67795' } });
  broadcastFrom({ e: 'ORDER_TRADE_UPDATE', o: { c: 'VXabc12345E', s: 'BTCUSDT', X: 'FILLED' } });
  broadcastFrom({ e: 'ACCOUNT_UPDATE', a: { B: [] } });
  broadcastFrom({ stream: 'LKEY123', data: { e: 'ALGO_UPDATE', o: { caid: 'VXabc12345S1', s: 'BTCUSDT', X: 'NEW' } } });
  assert(await until(() => got.algo.length >= 2 && got.order.length >= 1 && got.account.length >= 1, 2000), 'ALGO_UPDATE, ORDER_TRADE_UPDATE and ACCOUNT_UPDATE frames are routed');
  assert(got.algo[0]?.o?.caid === 'VXabc12345S0' && got.algo[1]?.o?.caid === 'VXabc12345S1', 'a {stream,data} wrapped frame is unwrapped before routing');
  userStream.stop();
  assert(!userStream.isConnected, 'stop() disconnects the user stream');

  // The first documented URL form is refused → the client rotates to the next form.
  acceptUser = (url) => url.startsWith('/private/ws?listenKey=LKEY123');
  wsHits.length = 0;
  userStream.start();
  assert(await until(() => userStream.isConnected, 8000), 'when the first URL form is refused the stream rotates to the next one');
  assert(wsHits.length >= 2 && wsHits[0] === '/private/ws/LKEY123' && /events=.*ALGO_UPDATE/.test(wsHits[wsHits.length - 1]), `rotation order: ${wsHits.map((u) => u.split('?')[0]).join(' → ')}`);
  userStream.stop();
  acceptUser = () => true;

  // Rotating the API key rebuilds the stream (a stale key must not keep feeding fills).
  userStream.start();
  assert(await until(() => userStream.isConnected), 'stream reconnects');
  const hitsBeforeNoop = wsHits.length;
  userStream.start();
  await sleep(150);
  assert(wsHits.length === hitsBeforeNoop && userStream.isConnected, 'start() with unchanged credentials is a no-op (no second socket)');
  const reconnectsBefore = got.reconcile;
  updateSettings({ keys: { testnet: { key: 'ROTATEDKEY0000000', secret: SECRET } } });
  userStream.start();
  assert(await until(() => got.reconcile > reconnectsBefore, 6000), 'a new API key makes start() rebuild the stream');
  updateSettings({ keys: { testnet: { key: KEY, secret: SECRET } } });
  userStream.stop();

  // Crash regression: stopping while the socket is still CONNECTING must not throw.
  const stall = net.createServer((s) => { s.on('error', () => {}); });
  await new Promise((r) => stall.listen(0, '127.0.0.1', r));
  process.env.BINANCE_TESTNET_WS = `ws://127.0.0.1:${stall.address().port}`;
  let stalled = false;
  stall.on('connection', () => { stalled = true; });
  userStream.start();
  assert(await until(() => stalled, 4000), 'a stalled upgrade leaves the client CONNECTING');
  userStream.stop();
  await sleep(400);
  assert(uncaught.length === 0, `stopping a CONNECTING socket raises no uncaught exception (${uncaught[0]?.message ?? 'none'})`);
  stall.close();
  process.env.BINANCE_TESTNET_WS = `ws://127.0.0.1:${wsPort}`;

  /* ============================================================ market stream */
  console.log('\n— Market stream: two sockets managed as one —');
  wsHits.length = 0;
  marketDelayMs = { '/public/stream': 0, '/market/stream': 500 };
  marketStream.subscribe(['BTCUSDT', 'ETHUSDT']);
  assert(await until(() => wsHits.some((u) => u.startsWith('/public/stream')), 2000), 'the /public socket connects');
  await sleep(150);
  assert(marketStream.isConnected === false, 'with only one of the two sockets up the stream is NOT connected');
  assert(await until(() => marketStream.isConnected, 4000), 'connected once both sockets are up');
  assert(wsHits.some((u) => u === '/public/stream?streams=btcusdt@bookTicker/ethusdt@bookTicker') && wsHits.some((u) => u === '/market/stream?streams=btcusdt@kline_5m/ethusdt@kline_5m'), `subscribed to the right stream names (${wsHits.join(' | ')})`);
  assert(await until(() => marketStream.lastMessage() > 0 && marketStream.price('BTCUSDT') > 0 && got.klines.length > 0, 2000), 'prices and klines flow from the two sockets');
  assert(marketStream.price('BTCUSDT') === 67999.9, 'bookTicker bid becomes the price');

  // Crash regression: re-subscribing while the previous sockets are still CONNECTING.
  marketDelayMs = { '/public/stream': 400, '/market/stream': 400 };
  marketStream.subscribe(['BTCUSDT']);
  await sleep(100);
  marketStream.subscribe(['BTCUSDT', 'SOLUSDT']);
  await sleep(100);
  marketStream.subscribe(['BTCUSDT', 'SOLUSDT', 'XRPUSDT']);
  assert(await until(() => marketStream.isConnected, 5000), 'the final subscription connects');
  await sleep(500);
  assert(uncaught.length === 0, `re-subscribing during the handshake raises no uncaught exception (${uncaught[0]?.message ?? 'none'})`);
  marketStream.stop();
  assert(!marketStream.isConnected, 'stop() tears both sockets down');

  /* ============================================================ done */
  userStream.stop();
  marketStream.stop();
  for (const s of sockets) s.terminate();
  console.log(failures === 0 ? '\nWIRE: ALL CHECKS PASSED' : `\nWIRE: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);

}

main().catch((e) => { console.error('CRASH:', e); process.exit(1); });

/**
 * Go-live preflight — run this ON THE HOST that will trade, before enabling
 * auto-trade. It uses the bot's own client and credentials (same .env, same
 * settings file, same environment selection) and sends NO orders unless you pass
 * --algo-roundtrip.
 *
 *   npm run preflight --prefix server                    # read-only checks
 *   npm run preflight --prefix server -- --algo-roundtrip
 *
 * Read-only checks
 *   • which environment (testnet = Binance demo trading | live) and which REST host
 *   • API key valid, IP-allowed, canTrade, equity / available balance
 *   • one-way vs hedge position mode
 *   • the Algo Service endpoint answers for this key (GET /fapi/v1/openAlgoOrders)
 *   • every candidate user-data WebSocket URL form, using a real listenKey — the
 *     bot rotates through them, this tells you which one your environment accepts
 *   • both market WebSockets (/public bookTicker, /market kline) deliver frames
 *   • positions already open on the account (the bot refuses those symbols)
 *
 * --algo-roundtrip (opt-in, can touch the exchange)
 *   Places ONE conditional BUY STOP_MARKET for the minimum size on BTCUSDT with its
 *   trigger 50% ABOVE the market (it cannot fire in the second it exists), checks that
 *   Binance reports it NEW, then cancels it and checks it is CANCELED. This proves
 *   the exact parameter names and replies the bot relies on. If the cancel fails the
 *   script says so loudly and prints the id to cancel by hand.
 */
require('dotenv/config');
const WebSocket = require('ws');

const argv = process.argv.slice(2);
let failures = 0;
let warnings = 0;
const ok = (cond, name, extra) => {
  if (cond) console.log(`ok    ${name}${extra ? ` — ${extra}` : ''}`);
  else { failures += 1; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
  return !!cond;
};
const warn = (name, extra) => { warnings += 1; console.log(`WARN  ${name}${extra ? ` — ${extra}` : ''}`); };
const info = (msg) => console.log(`      ${msg}`);
const mask = (v) => (v ? `${'•'.repeat(Math.max(0, String(v).length - 4))}${String(v).slice(-4)}` : '(none)');
const errText = (e) => String(e?.message || e).replace(/\s+/g, ' ').slice(0, 220);

/** Open a socket; resolve with how it went. `needFrame` waits for a data frame as well. */
function probe(url, { needFrame = false, ms = 8000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, why: needFrame ? 'connected but no frame within the timeout' : 'timeout' }), ms);
    try { ws = new WebSocket(url); } catch (e) { clearTimeout(timer); resolve({ ok: false, why: errText(e) }); return; }
    ws.on('open', () => { if (!needFrame) done({ ok: true, why: 'connected' }); });
    ws.on('message', () => { if (needFrame) done({ ok: true, why: 'frames flowing' }); });
    ws.on('unexpected-response', (_req, res) => done({ ok: false, why: `HTTP ${res.statusCode}` }));
    ws.on('error', (e) => done({ ok: false, why: errText(e) }));
  });
}

async function run(args = argv) {
  const { loadSettings, getSettings } = require('../dist/settings');
  const binance = require('../dist/binance');
  const { api } = binance;
  loadSettings();
  const s = getSettings();
  const mode = s.mode;
  const creds = s.keys[mode];
  const rest = binance.restBase(mode);

  console.log('\nVelocityX go-live preflight');
  console.log(`      environment : ${mode === 'live' ? 'LIVE (real funds)' : 'TESTNET (Binance demo trading)'}`);
  console.log(`      REST host   : ${rest}`);
  console.log(`      API key     : ${mask(creds.key)}`);
  console.log(`      auto-trade  : ${s.autoTrade ? 'ARMED' : 'off'}`);
  console.log(`      VX_API_TOKEN: ${process.env.VX_API_TOKEN ? 'set' : 'NOT set'}   VX_ALLOW_LIVE: ${process.env.VX_ALLOW_LIVE === '1' ? '1' : 'not 1'}`);

  console.log('\n— Credentials and account —');
  if (!ok(!!creds.key && !!creds.secret, `API key + secret configured for ${mode}`)) {
    console.log('\nPREFLIGHT: cannot continue without keys.');
    return 1;
  }
  const ping = await api.ping();
  ok(ping.ok, 'Binance time endpoint reachable', ping.ok ? `${ping.latencyMs} ms` : ping.error);
  if (ping.ok) {
    if (Math.abs(ping.serverTimeOffsetMs) > 1000) warn('host clock differs from Binance', `${ping.serverTimeOffsetMs} ms — enable NTP (recvWindow is 5000 ms)`);
    else ok(true, 'host clock is in sync', `${ping.serverTimeOffsetMs} ms`);
  }

  let account = null;
  try {
    account = await api.accountSnapshot();
    ok(true, 'signed request accepted (key valid, IP allowed)');
    ok(account.canTrade, 'key has trading permission (canTrade)');
    info(`equity ${account.equity.toFixed(2)} USDT · available ${account.availableBalance.toFixed(2)} USDT`);
    if (account.equity <= 0) warn('account equity is zero', 'fund the futures wallet first');
  } catch (e) {
    ok(false, 'signed account request', errText(e));
    info('Typical causes: wrong key for this environment, IP not whitelisted, Futures not enabled on the key.');
  }

  try {
    const dual = await api.isDualSide();
    ok(true, `position mode: ${dual ? 'HEDGE (positionSide) — supported' : 'ONE-WAY (reduceOnly) — supported'}`);
  } catch (e) { ok(false, 'position mode query', errText(e)); }

  try {
    const open = await api.positionRisk();
    ok(true, `open positions on the account: ${open.length}`);
    for (const p of open) info(`${p.symbol} ${p.positionAmt} — the bot will REFUSE to trade this symbol (it never touches positions it did not open)`);
  } catch (e) { ok(false, 'position query', errText(e)); }

  console.log('\n— Algo Service (stop-loss / take-profit orders) —');
  try {
    const open = await api.openAlgoOrders('BTCUSDT');
    ok(true, 'GET /fapi/v1/openAlgoOrders answers for this key', `${open.length} conditional order(s) on BTCUSDT`);
  } catch (e) {
    ok(false, 'GET /fapi/v1/openAlgoOrders', errText(e));
    info('Without this endpoint the bot cannot place or verify stops: do NOT arm auto-trade.');
  }

  console.log('\n— WebSockets —');
  let listenKey = null;
  try {
    listenKey = await api.createListenKey();
    ok(true, 'listenKey created');
  } catch (e) { ok(false, 'listenKey creation', errText(e)); }
  if (listenKey) {
    const urls = binance.userStreamUrls(mode, listenKey);
    let accepted = -1;
    for (let i = 0; i < urls.length; i += 1) {
      const shown = urls[i].replace(listenKey, '<listenKey>').replace(/events=.*/, 'events=…');
      const r = await probe(urls[i]);
      console.log(`      form ${i + 1}/${urls.length}  ${shown}  →  ${r.ok ? 'ACCEPTED' : `refused (${r.why})`}`);
      if (r.ok && accepted < 0) accepted = i;
    }
    ok(accepted >= 0, 'a user-data stream URL form is accepted', accepted >= 0 ? `the bot will use form ${accepted + 1} (it rotates automatically)` : 'no fill/trigger notifications would arrive; REST reconcile (10 s) would still book fills, but do not arm until this passes');
    try { await api.keepAliveListenKey(); ok(true, 'listenKey keep-alive accepted'); } catch (e) { ok(false, 'listenKey keep-alive', errText(e)); }
  }
  const pub = await probe(binance.marketStreamUrl('public', ['BTCUSDT']), { needFrame: true });
  ok(pub.ok, 'market data: /public bookTicker socket', pub.why);
  const mkt = await probe(binance.marketStreamUrl('market', ['BTCUSDT'], '5m'), { needFrame: true });
  ok(mkt.ok, 'market data: /market kline socket', mkt.why);

  if (args.includes('--algo-roundtrip')) {
    console.log('\n— Algo order round-trip (opt-in) —');
    console.log(`      Placing ONE far-from-market conditional order on ${mode.toUpperCase()} BTCUSDT, then cancelling it.`);
    const symbol = 'BTCUSDT';
    let cid = null;
    try {
      const sym = await api.exchangeInfo(symbol);
      const r = await fetch(`${rest}/fapi/v1/ticker/price?symbol=${symbol}`, { signal: AbortSignal.timeout(8000) });
      const price = Number((await r.json()).price);
      if (!(price > 0)) throw new Error('could not read the BTCUSDT price from the order environment');
      const trigger = binance.roundToTick(price * 1.5, sym.tickSize);
      const qty = Math.max(sym.minQty, Math.ceil((sym.minNotional * 1.2) / price / sym.stepSize) * sym.stepSize);
      cid = `VXPRE${Date.now().toString(36).slice(-8).toUpperCase()}`;
      const params = {
        symbol, side: 'BUY', type: 'STOP_MARKET',
        triggerPrice: binance.fmtPrice(trigger), quantity: binance.fmtQty(binance.floorToStep(qty, sym.stepSize)),
        clientAlgoId: cid,
      };
      if (await api.isDualSide()) params.positionSide = 'LONG';
      info(`BUY STOP_MARKET ${params.quantity} ${symbol} trigger ${params.triggerPrice} (market ${price}) id ${cid}`);
      const placed = await api.newAlgoOrder(params);
      ok(!!placed?.clientAlgoId || !!placed?.algoId, 'POST /fapi/v1/algoOrder accepted', `algoId ${placed?.algoId ?? '?'}`);
      const q = await api.queryAlgoOrder(cid);
      ok(String(q?.algoStatus).toUpperCase() === 'NEW', 'GET /fapi/v1/algoOrder reports NEW', `status ${q?.algoStatus}`);
      const list = await api.openAlgoOrders(symbol);
      ok(list.some((o) => String(o.clientAlgoId) === cid), 'GET /fapi/v1/openAlgoOrders lists it by clientAlgoId');
      const state = await api.algoLegState(symbol, cid);
      ok(state.state === 'alive', 'the bot classifies it as an alive leg');
    } catch (e) {
      ok(false, 'algo order placement / lookup', errText(e));
    }
    if (cid) {
      try {
        const cancelled = await api.cancelAlgoOrder('BTCUSDT', cid);
        const after = await api.queryAlgoOrder(cid).catch((e) => ({ algoStatus: `lookup failed: ${errText(e)}` }));
        const st = String(after?.algoStatus).toUpperCase();
        ok(cancelled !== null && (st === 'CANCELED' || st === 'CANCELLED'), 'DELETE /fapi/v1/algoOrder cancelled it', `status ${after?.algoStatus}`);
        if (cancelled === null || !(st === 'CANCELED' || st === 'CANCELLED')) throw new Error(`status ${after?.algoStatus}`);
      } catch (e) {
        console.log(`\n!!!  MANUAL ACTION REQUIRED: conditional order ${cid} on BTCUSDT may still be resting.`);
        console.log('!!!  Cancel it in the Binance Futures UI (Conditional Orders) — it is a BUY STOP_MARKET far above the market.');
        ok(false, 'cancel of the preflight order', errText(e));
      }
    }
  } else {
    info('Tip: add --algo-roundtrip (run it on testnet first) to prove the stop/take-profit order format end-to-end.');
  }

  console.log(failures === 0
    ? `\nPREFLIGHT: ALL CHECKS PASSED${warnings ? ` (${warnings} warning${warnings > 1 ? 's' : ''})` : ''}`
    : `\nPREFLIGHT: ${failures} FAILURE${failures > 1 ? 'S' : ''} — do not arm auto-trade until fixed`);
  return failures === 0 ? 0 : 1;
}

module.exports = { run, probe };

if (require.main === module) {
  run().then((code) => process.exit(code)).catch((e) => { console.error('CRASH:', e); process.exit(1); });
}

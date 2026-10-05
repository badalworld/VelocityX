/**
 * End-to-end paper-trading test — drives the trader state machine through:
 *   1. LONG  → TP1 (33% + SL→BE) → TP2 (50% rest + SL→TP1) → TP3 (full exit)  [WIN]
 *   2. SHORT → SL hit before any TP                                            [LOSS]
 *   3. LONG  → TP1 → opposite signal                                          [CLOSE & REVERSE]
 *   4. SHORT → kill switch                                                     [KILL]
 * Also validates paper balance accounting and the stats table output.
 */
// Paper-mode harness: allow the labelled offline demo feed so exchange
// metadata is available when this sandbox has no Binance egress.
process.env.VX_OFFLINE_DEMO = process.env.VX_OFFLINE_DEMO || '1';
// Hermetic run — never touch the operator's journal.
const _fs = require('fs');
const _os = require('os');
const _path = require('path');
process.env.VX_DATA_DIR = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'vx-e2e-'));

const { loadSettings, updateSettings, getSettings } = require('../dist/settings');
const { trader } = require('../dist/trader');
const { saveSignal, allTrades, activeTrade, openTrades, getPaperBalance, setPaperBalance } = require('../dist/store');
const { computeStats } = require('../dist/stats');

let failures = 0;
function assert(cond, name) {
  if (cond) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}`); }
}
const settle = () => new Promise((r) => setTimeout(r, 30));
function mkSignal(side, price, atr) {
  const rec = {
    id: Math.random().toString(36).slice(2, 10),
    symbol: 'BTCUSDT',
    time: Date.now() - 60000,
    detectedAt: Date.now(),
    side, price, atr, acted: false, tradeId: null,
  };
  saveSignal(rec);
  return { record: rec, side, price, atr };
}

async function main() {
  loadSettings();
  setPaperBalance(1000);
  updateSettings({ autoTrade: true, symbol: 'BTCUSDT', tradeSizePercent: 5, leverage: 10 });

  const P = 68000, A = 100; // entry price, ATR
  // SL = ±200, TP1 = ±300, TP2 = ±600, TP3 = ±900

  // ---------- Trade 1: full TP ladder ----------
  await trader.onSignal(mkSignal('LONG', P, A));
  let t1 = activeTrade();
  assert(t1 && t1.side === 'LONG' && t1.status === 'OPEN', 'LONG opened @ market on signal');
  assert(Math.abs(t1.slInitial - (P - 200)) < 1e-6, `SL initial = entry − ATR×2 (${t1.slInitial})`);
  assert(Math.abs(t1.tp1 - (P + 300)) < 1e-6 && Math.abs(t1.tp2 - (P + 600)) < 1e-6 && Math.abs(t1.tp3 - (P + 900)) < 1e-6, 'TP1/2/3 at 1.5R/3R/4.5R');
  assert(t1.qty > 0 && Math.abs(t1.q1 + t1.q2 + t1.q3 - t1.qty) < 1e-9, `qty ladder sums: ${t1.qty} = ${t1.q1}+${t1.q2}+${t1.q3}`);
  assert(Math.abs(t1.margin * t1.leverage - t1.notional) < 1e-6, 'notional = margin × leverage');
  assert(t1.margin <= 50 + 1e-6 && t1.margin > 42, `margin = 5% of 1000, floored to lot step = ${t1.margin}`);

  const bal0 = getPaperBalance(1000);

  trader.onPrice(P + 301); await settle();
  t1 = activeTrade();
  assert(t1.status === 'OPEN' && t1.tp1Filled, 'TP1 filled (33% booked)');
  assert(t1.slStage === 1 && Math.abs(t1.slCurrent - t1.entryPrice) < 1e-9, 'SL moved to BREAKEVEN after TP1');
  assert(getPaperBalance(1000) > bal0, 'paper balance increased after TP1');

  trader.onPrice(P + 601); await settle();
  t1 = activeTrade();
  assert(t1.status === 'OPEN' && t1.tp2Filled, 'TP2 filled (50% of remaining booked)');
  assert(t1.slStage === 2 && Math.abs(t1.slCurrent - t1.tp1) < 1e-9, 'SL moved to TP1 after TP2');
  assert(!t1.tp3Filled, 'TP3 still pending');

  trader.onPrice(P + 901); await settle();
  t1 = allTrades()[0];
  assert(t1.status === 'CLOSED' && t1.closeReason === 'TP3', 'TP3 filled → full exit');
  assert(t1.result === 'WIN', 'trade1 result = WIN');
  assert(t1.realizedPnl > 0, `trade1 net PnL = ${t1.realizedPnl.toFixed(4)} USDT`);
  assert(!activeTrade(), 'no open trade after TP3');
  const balAfter1 = getPaperBalance(1000);
  assert(Math.abs((balAfter1 - bal0) - t1.realizedPnl) < 1e-6, 'paper balance tracks realized PnL');

  // ---------- Trade 2: SL hit before TP ----------
  await trader.onSignal(mkSignal('SHORT', P, A));
  let t2 = activeTrade();
  assert(t2 && t2.side === 'SHORT' && t2.status === 'OPEN', 'SHORT opened');
  assert(Math.abs(t2.slInitial - (P + 200)) < 1e-6, `SHORT SL above entry (${t2.slInitial})`);

  trader.onPrice(P + 201); await settle();
  t2 = allTrades()[0];
  assert(t2.status === 'CLOSED' && t2.closeReason === 'SL', 'SL hit → closed');
  assert(t2.result === 'LOSS', 'trade2 result = LOSS (no TP hit)');
  assert(t2.realizedPnl < 0, `trade2 net PnL = ${t2.realizedPnl.toFixed(4)} USDT`);

  // ---------- Trade 3: close & reverse ----------
  await trader.onSignal(mkSignal('LONG', P, A));
  let t3 = activeTrade();
  assert(t3 && t3.side === 'LONG', 'LONG opened for reverse test');
  trader.onPrice(P + 301); await settle();
  t3 = activeTrade();
  assert(t3 && t3.tp1Filled && t3.slStage === 1, 'TP1 hit before reverse (SL at breakeven)');

  await trader.onSignal(mkSignal('SHORT', P + 50, A));
  const trades = allTrades();
  const t3closed = trades.find((x) => x.id === t3.id);
  assert(t3closed.status === 'CLOSED' && t3closed.closeReason === 'REVERSE', 'opposite signal closed the LONG (close & reverse)');
  const t4 = activeTrade();
  assert(t4 && t4.side === 'SHORT' && t4.status === 'OPEN', 'SHORT immediately opened on same signal');

  // ---------- Trade 4: kill switch ----------
  await trader.kill(); await settle();
  const t4closed = allTrades().find((x) => x.id === t4.id);
  assert(t4closed.status === 'CLOSED' && t4closed.closeReason === 'KILL', 'kill switch flattened the position');
  assert(!activeTrade(), 'no open trade after kill');

  // ---------- Auto-trade OFF blocks entries ----------
  updateSettings({ autoTrade: false });
  const sigCountBefore = require('../dist/store').allSignals().length;
  const blockedSig = mkSignal('LONG', P, A);
  await trader.onSignal(blockedSig);
  assert(!activeTrade(), 'auto-trade OFF → signal logged but no entry');
  assert(require('../dist/store').allSignals().length === sigCountBefore + 1, 'signal still recorded once');

  // ---------- Multi-position cap (max 8, one per symbol) ----------
  updateSettings({ autoTrade: true, autoScan: false });
  const syms = ['ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT'];
  for (const sym of syms) {
    const base = 100;
    const sig = mkSignal('LONG', base, 0.5);
    sig.record = { ...sig.record, symbol: sym };
    sig.symbol = sym;
    trader.onPrice(base, sym); // live price for that symbol (multi-symbol book)
    await trader.onSignal(sig);
    await settle();
  }
  assert(openTrades().length === 8, `8 concurrent positions open (${openTrades().length})`);
  assert(openTrades().every((t) => t.botOwned === true), 'every open trade is bot-owned (never adopted)');
  const extraSig = mkSignal('LONG', 100, 0.5);
  extraSig.record = { ...extraSig.record, symbol: 'TRXUSDT' };
  extraSig.symbol = 'TRXUSDT';
  await trader.onSignal(extraSig); await settle();
  assert(openTrades().length === 8, 'a 9th signal is rejected — hard cap of 8 positions');
  assert(!openTrades().some((t) => t.symbol === 'TRXUSDT'), 'no position opened beyond the cap');

  // ---------- Kill switch closes every bot position, nothing else ----------
  for (const sym of syms) trader.onPrice(100, sym);
  const killed = await trader.kill(); await settle();
  assert(killed === 8 && openTrades().length === 0, `kill closed all 8 bot positions (${killed})`);

  // ---------- Stats ----------
  const st = computeStats();
  assert(st.totalSignals === 14, `14 signals recorded (${st.totalSignals})`);
  assert(st.totalClosedTrades === 12, `12 closed trades (${st.totalClosedTrades})`);
  assert(st.winCount === 1 && st.lossCount === 1, `1 win / 1 loss (ignores REVERSE/KILL) → WR ${st.overallWinRate.toFixed(1)}%`);
  assert(Math.abs(st.expectancy - (0.5 * 1.5 - 0.5)) < 1e-9, `expectancy = ${st.expectancy}R at 50% WR`);
  assert(st.netPnl > -5 && st.netPnl < 10, `net PnL sanity: ${st.netPnl.toFixed(4)} USDT`);

  updateSettings({ autoTrade: false }); // leave the system SAFE
  console.log(failures === 0 ? '\nE2E: ALL TESTS PASSED' : `\nE2E: ${failures} FAILURES`);
  console.log(`Final paper balance: ${getPaperBalance(1000).toFixed(2)} USDT`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('CRASH:', e); process.exit(1); });

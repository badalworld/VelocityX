/**
 * Hermetic tests for the 5m liquidity/POC strategy and OHLCV simulator.
 * The fixture is deliberately deterministic and synthetic; results are not
 * historical performance or evidence of profitability.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.VX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-liquidity-'));

const { calculateVolumeProfile, detectLiquiditySweep, LiquiditySweepStrategy } = require('../dist/liquidityStrategy');
const { runLiquidityBacktest } = require('../dist/liquidityBacktest');
const { splitFiveWayQty } = require('../dist/trader');

let failures = 0;
function assert(condition, name, extra = '') {
  if (condition) console.log(`ok   ${name}${extra ? ` — ${extra}` : ''}`);
  else { failures += 1; console.log(`FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}
const closeEnough = (a, b, tolerance = 1e-8) => Number.isFinite(a) && Math.abs(a - b) <= tolerance;
const config = {
  lookbackBars: 30,
  profileBins: 24,
  setupExpiryBars: 24,
  sweepMinAtr: 0.05,
  retestToleranceAtr: 0.2,
  stopBufferAtr: 0.1,
  maxStopAtr: 20,
};
const BAR_MS = 5 * 60_000;
function candle(i, open, high, low, close, volume = 100) {
  return { time: i * BAR_MS, closeTime: i * BAR_MS + BAR_MS - 1, open, high, low, close, volume };
}
function longPrefix() {
  const bars = Array.from({ length: 30 }, (_, i) => candle(i, 101, 102, 100, 101, 100));
  bars.push(candle(30, 101, 101.4, 99, 100.5, 140)); // sweep prior low; close back inside
  bars.push(candle(31, 100.6, 101.4, 100.4, 101.2, 110)); // close above locked POC
  bars.push(candle(32, 100.8, 101.3, 100, 101, 120)); // subsequent bullish POC retest
  return bars;
}
function shortPrefix() {
  const bars = Array.from({ length: 30 }, (_, i) => candle(i, 101, 102, 100, 101, 100));
  bars.push(candle(30, 101, 103, 100.6, 101.5, 140)); // sweep prior high; close back inside
  bars.push(candle(31, 101, 101.4, 99.5, 99.8, 110)); // close below locked POC
  bars.push(candle(32, 100.2, 100.3, 99.5, 99.8, 120)); // bearish POC retest
  return bars;
}

(async () => {
  console.log('\n— Approximate fixed-range volume profile —');
  const prior = longPrefix().slice(0, 30);
  const profile = calculateVolumeProfile(prior, config.profileBins);
  assert(!!profile && profile.bins === 24, 'profile builds the configured number of bins');
  assert(!!profile && profile.poc >= profile.low && profile.poc <= profile.high, 'POC remains inside the fixed range');
  const volumeIn = prior.reduce((sum, bar) => sum + bar.volume, 0);
  const volumeOut = profile?.volumeAtPrice.reduce((sum, value) => sum + value, 0) ?? 0;
  assert(closeEnough(volumeIn, volumeOut, 1e-7), 'uniform OHLC range allocation conserves candle volume', `${volumeOut.toFixed(4)} / ${volumeIn.toFixed(4)}`);

  console.log('\n— Closed 5m sweep → reclaim → retest signals —');
  const longBars = longPrefix();
  const sweptLong = detectLiquiditySweep(longBars, 30, config);
  assert(sweptLong?.side === 'LONG' && sweptLong.phase === 'WAIT_POC_RECLAIM', 'prior-low sweep sets up a long and locks the POC');
  const longEngine = new LiquiditySweepStrategy();
  let longSignal = null;
  for (let i = 30; i < longBars.length; i++) longSignal = longEngine.process('SYNTHUSDT', longBars, i, config) || longSignal;
  assert(longSignal?.side === 'LONG' && longSignal.index === 32, 'long entry appears only on the later bullish retest candle');
  assert(longSignal?.pocPrice === sweptLong?.poc && longSignal?.stopPrice < longSignal?.sweepExtreme, 'signal preserves locked POC and structural stop below sweep wick');

  const shortBars = shortPrefix();
  const shortEngine = new LiquiditySweepStrategy();
  let shortSignal = null;
  for (let i = 30; i < shortBars.length; i++) shortSignal = shortEngine.process('SYNTHUSDT', shortBars, i, config) || shortSignal;
  assert(shortSignal?.side === 'SHORT' && shortSignal.index === 32, 'prior-high sweep mirrors to a bearish POC retest');
  assert(shortSignal?.stopPrice > shortSignal?.sweepExtreme, 'short stop is beyond the sweep wick');

  const ambiguous = longPrefix();
  ambiguous[30] = candle(30, 101, 103, 99, 101, 100); // sweeps both prior extrema
  assert(detectLiquiditySweep(ambiguous, 30, config) === null, 'ambiguous two-sided sweep is rejected');

  const invalid = longPrefix();
  invalid[31] = candle(31, 100, 100.5, 98.7, 98.9, 100); // trades through stop and fails to reclaim prior low
  const invalidEngine = new LiquiditySweepStrategy();
  invalidEngine.process('INVALIDUSDT', invalid, 30, config);
  invalidEngine.process('INVALIDUSDT', invalid, 31, config);
  assert(invalidEngine.pending('INVALIDUSDT') === null, 'setup is discarded when price invalidates the sweep stop');

  const restartEngine = new LiquiditySweepStrategy();
  restartEngine.prime('RESTARTUSDT', longBars.slice(0, 32), config);
  assert(restartEngine.pending('RESTARTUSDT')?.phase === 'WAIT_POC_RETEST', 'restart priming restores a pending setup without emitting an old entry');
  const restoredSignal = restartEngine.process('RESTARTUSDT', longBars, 32, config);
  assert(restoredSignal?.side === 'LONG', 'a fresh post-restart retest can emit the entry');

  console.log('\n— Five-way quantity split —');
  const slices = splitFiveWayQty(1, 0.001, 0.001);
  assert(!!slices && closeEnough(slices.q1 + slices.q2 + slices.q3 + slices.q4 + slices.q5, 1), 'all exchange-sized slices conserve the entry quantity');
  assert(!!slices && [slices.q1, slices.q2, slices.q3, slices.q4].every((qty) => closeEnough(qty, 0.2)), 'first four legs are 20% of original where lot precision permits');
  assert(splitFiveWayQty(0.004, 0.001, 0.001) === null, 'entry smaller than five minimum lots is rejected before order placement');

  console.log('\n— Deterministic synthetic OHLCV simulation (not historical data) —');
  const fixture = longPrefix();
  const seeded = new LiquiditySweepStrategy();
  let signal = null;
  for (let i = 30; i < fixture.length; i++) signal = seeded.process('SYNTHUSDT', fixture, i, config) || signal;
  const entry = signal.entryPrice;
  const risk = signal.riskDistance;
  // The entry fills at the next candle open. Keep that candle below TP1 and
  // above the initial stop, then let later candles reach one target each.
  fixture.push(candle(fixture.length, entry, entry + risk * 0.5, entry - risk * 0.1, entry + risk * 0.2, 150));
  let previousTarget = entry;
  for (let level = 1; level <= 5; level++) {
    const target = entry + risk * level;
    const low = level === 1 ? entry + risk * 0.05 : previousTarget + risk * 0.1;
    const open = level === 1 ? entry + risk * 0.1 : previousTarget + risk * 0.15;
    fixture.push(candle(fixture.length, open, target + risk * 0.05, low, target, 150));
    previousTarget = target;
  }
  const source = 'Deterministic synthetic fixture (NOT historical market data)';
  const result = runLiquidityBacktest(fixture, config, {
    startingBalance: 10_000,
    riskPercent: 1,
    feeRate: 0,
    slippageBps: 0,
    dataSource: source,
  }, 'SYNTHUSDT');
  console.log(`fixture result: ${result.closedTrades} closed · P&L ${result.netPnl.toFixed(2)} USDT · ${result.averageR.toFixed(2)}R · source=${result.dataSource}`);
  assert(result.dataSource === source, 'synthetic fixture provenance is explicit');
  assert(result.closedTrades === 1 && result.trades[0].closeReason === 'TP5', 'synthetic price path reaches the complete five-target exit');
  assert(result.trades[0].tpHits.join(',') === '1,2,3,4,5', 'all five target levels execute in order');
  assert(closeEnough(result.averageR, 3, 1e-8) && closeEnough(result.netPnl, 300, 1e-6), '20% tranches at 1R..5R produce the expected frictionless 3R fixture outcome');
  assert(result.profitFactor === null, 'profit factor reports no losing trades rather than inventing a finite estimate');
  assert([result.tpHitCounts.tp1, result.tpHitCounts.tp2, result.tpHitCounts.tp3, result.tpHitCounts.tp4, result.tpHitCounts.tp5].every((count) => count === 1), 'simulator counts all five exits');

  console.log(failures === 0 ? '\nLIQUIDITY STRATEGY: ALL TESTS PASSED' : `\nLIQUIDITY STRATEGY: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Offline strategy validator — generates synthetic 5m OHLCV that mimics a
 * cyclical, trend-mean-reverting market with occasional stop runs, then runs
 * the production liquidity-sweep / POC-retest / 5-leg ladder through it.
 *
 * Usage:  node server/scripts/backtest-offline.js
 */
process.env.VX_DATA_DIR = '/tmp/vx-offline';
const { LiquiditySweepStrategy, calculateVolumeProfile } = require('../dist/liquidityStrategy');
const { runLiquidityBacktest } = require('../dist/liquidityBacktest');

const BAR_MS = 5 * 60_000;

// ---------------- PRNG (mulberry32) for deterministic series ------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a synthetic 5m series that produces authentic-looking sweeps and POC
 * reclaims. We layer (a) slow drift, (b) 30-bar cycles, (c) noise, and
 * occasionally inject a liquidity-sweep candle (a wick through a local
 * extreme followed by a reclaim and a retest) so the strategy has setups to
 * act on.
 */
function generateCandles(bars, seed = 42) {
  const rand = mulberry32(seed);
  const candles = [];
  let price = 100;
  let drift = 0;
  // Inject ~25 sweep windows across the run.
  const sweepAt = new Set();
  for (let k = 0; k < Math.floor(bars / 180); k++) sweepAt.add(120 + k * 180 + Math.floor(rand() * 40));

  for (let i = 0; i < bars; i++) {
    drift += (rand() - 0.5) * 0.002;
    drift *= 0.995;
    const cycle = Math.sin((i / 30) * Math.PI) * 0.15;
    const noise = (rand() - 0.5) * 0.08;
    const base = price + drift + cycle + noise;
    let high = base + 0.04 + rand() * 0.06;
    let low = base - 0.04 - rand() * 0.06;
    const open = price;
    const close = base;
    let vol = 80 + rand() * 40 + Math.abs(close - open) * 200;

    if (sweepAt.has(i)) {
      // 50/50 long/short sweep
      if (rand() < 0.5) {
        // bearish sweep: long wick down, close back in range
        low -= 0.35 + rand() * 0.25;
        vol *= 2.2;
      } else {
        high += 0.35 + rand() * 0.25;
        vol *= 2.2;
      }
    }
    candles.push({
      time: i * BAR_MS,
      closeTime: i * BAR_MS + BAR_MS - 1,
      open: +open.toFixed(4),
      high: +high.toFixed(4),
      low: +low.toFixed(4),
      close: +close.toFixed(4),
      volume: +vol.toFixed(2),
    });
    price = close;
  }
  return candles;
}

function fmt(n, d = 2) {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(d);
}

const cfg = {
  lookbackBars: 30,
  profileBins: 24,
  setupExpiryBars: 24,
  retestWindowBars: 8,
  sweepMinAtr: 0.05,
  sweepVolumeMultiplier: 1.1,
  retestToleranceAtr: 0.25,
  retestCloseStrength: 0.55,
  stopBufferAtr: 0.1,
  maxStopAtr: 6,
  trendFilterEma: 0,
  cooldownBarsAfterLoss: 6,
  pocVolumeMinRatio: 1.0,
};

const bars = 4000; // ~14 days of 5m bars
const candles = generateCandles(bars, 42);
const res = runLiquidityBacktest(candles, cfg, {
  startingBalance: 10_000,
  riskPercent: 1,
  feeRate: 0.0004,
  slippageBps: 2,
  dataSource: 'Synthetic GBM+cycles+sweeps (offline validator)',
}, 'SYNTHUSDT');

console.log('');
console.log('=== VelocityX — Liquidity-Sweep / POC-Retest / 5R Ladder (offline validator) ===');
console.log('');
console.log(`  candles              : ${res.candles} (${(res.candles * 5 / 60 / 24).toFixed(1)} days of 5m)`);
console.log(`  starting balance     : $${fmt(res.startingBalance, 0)}`);
console.log(`  ending equity        : $${fmt(res.endingEquity, 2)}  (${res.returnPct >= 0 ? '+' : ''}${fmt(res.returnPct, 2)}%)`);
console.log(`  net P&L              : $${fmt(res.netPnl, 2)}`);
console.log(`  closed trades        : ${res.closedTrades}`);
console.log(`  wins / losses        : ${res.wins} / ${res.losses}   (win rate ${fmt(res.winRatePct, 1)}%)`);
console.log(`  average R            : ${fmt(res.averageR, 2)} R`);
console.log(`  profit factor        : ${res.profitFactor === null ? 'n/a (no losses)' : fmt(res.profitFactor, 2)}`);
console.log(`  max drawdown         : $${fmt(res.maxDrawdown, 2)}  (${fmt(res.maxDrawdownPct, 2)}%)`);
console.log(`  fees paid            : $${fmt(res.fees, 2)}`);
console.log(`  TP1/2/3/4/5 hits     : ${res.tpHitCounts.tp1} / ${res.tpHitCounts.tp2} / ${res.tpHitCounts.tp3} / ${res.tpHitCounts.tp4} / ${res.tpHitCounts.tp5}`);
console.log('');
console.log('Strategy parameters used:');
console.log('  timeframe        = 5m');
console.log(`  lookback / bins  = ${cfg.lookbackBars} bars / ${cfg.profileBins} bins`);
console.log(`  sweep min        = ${cfg.sweepMinAtr}×ATR, volume ≥ ${cfg.sweepVolumeMultiplier}×avg`);
console.log(`  retest window    = ${cfg.retestWindowBars} bars, tolerance ${cfg.retestToleranceAtr}×ATR`);
console.log(`  retest strength  = close in top/bottom ${(cfg.retestCloseStrength * 100).toFixed(0)}% of bar`);
console.log(`  stop buffer      = ${cfg.stopBufferAtr}×ATR beyond sweep wick`);
console.log(`  risk per trade   = 1% of equity, max stop ${cfg.maxStopAtr}×ATR`);
console.log(`  ladder           = 20% @ 1R (SL→BE) · 20% @ 2R (SL→1R) · 20% @ 3R · 20% @ 4R · 20% @ 5R`);
console.log(`  cooldown         = ${cfg.cooldownBarsAfterLoss} bars after stop-out`);
console.log('');
console.log('NOTE: This is synthetic data — it proves the engine wires up correctly,');
console.log('      not that the strategy is profitable on live markets. Point the bot');
console.log('      at Binance testnet first and review real-candle performance in the');
console.log('      dashboard\'s Backtest panel (Settings → Connection, then Backtest).');
console.log('');

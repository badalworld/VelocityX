'use strict';
/** Shared study design: worlds, configurations and methodology text. */

const WORLD_TYPES_ORDER = ['bull', 'bear', 'chop', 'volatile', 'crisis'];
const VOLS = [0.85, 1.0, 1.25, 1.55];

function buildWorldPlan(n) {
  const plan = [];
  for (let i = 0; i < n; i++) {
    plan.push({
      index: i,
      worldType: WORLD_TYPES_ORDER[i % WORLD_TYPES_ORDER.length],
      worldVol: VOLS[Math.floor(i / WORLD_TYPES_ORDER.length) % VOLS.length],
      seed: 1001 + i * 37,
    });
  }
  return plan;
}

const CONFIGS = [
  { key: 'default', label: 'Default (5m, 8 slots, taker)', cfg: {} },
  { key: 'tf15', label: '15m candles', cfg: { signalTimeframe: '15m' } },
  { key: 'tf60', label: '1h candles', cfg: { signalTimeframe: '1h' } },
  { key: 'flip', label: 'Signals inverted', cfg: { signalSource: 'flip' } },
  { key: 'random', label: 'Random entries (null)', cfg: { signalSource: 'random', randomSignalRate: 0.028 } },
  { key: 'noreverse', label: 'No close & reverse', cfg: { noReverse: true } },
  { key: 'slots2', label: 'Max 2 positions', cfg: { maxPositions: 2 } },
  { key: 'maker', label: 'Maker fee 0.02 %', cfg: { feeRate: 0.0002 } },
  { key: 'sl3_tp2', label: '3×ATR stop, 2R ladder', cfg: { atrSlMultiplier: 3, tpRrFactor: 2 } },
  { key: 'size2', label: 'Margin 2 % of equity', cfg: { tradeSizePercent: 2 } },
  { key: 'tf15_norev', label: '15m + no reverse', cfg: { signalTimeframe: '15m', noReverse: true } },
];

const METHODOLOGY = {
  marketGenerator: 'regime-switching GARCH(1,1) × slow log-AR(1) vol level, Student-t(5) bar shocks, jumps, 8 sub-step OHLC; 40-symbol universe incl. a pegged pair, an illiquid pair and a quiet pair that must be rejected by the scanner',
  signals: 'EMA(11)/EMA(34) confirmed cross (server/src/indicators.signalAt), entry at signal candle close',
  execution: 'mirrors server/src/trader.ts: 5 % margin × 10× isolated, ≤8 positions, 2×ATR stop, TP1 33 % @1.5R→BE, TP2 50 % of rest @3R→SL TP1, TP3 rest @4.5R, close & reverse, taker 0.05 %, slippage 1bp/side, funding every 8h, isolated liquidation',
  intrabar: 'conservative: stop assumed hit before take-profit inside the same candle (measured: only 0.02 % of trades ever see a candle span both, so the assumption is immaterial); stops gap-honest',
  limitations: 'no order rejections, latency, downtime, partial fills or rate limits (all would worsen results); synthetic (not historical) prices — rerun with --data on real klines when exchange egress is available',
};

module.exports = { WORLD_TYPES_ORDER, VOLS, buildWorldPlan, CONFIGS, METHODOLOGY };

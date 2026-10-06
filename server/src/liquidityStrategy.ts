/**
 * Closed-candle liquidity-sweep → approximate volume-profile POC → retest strategy.
 *
 * Volume at price is not present in Binance 5m klines. The profile therefore
 * spreads each candle's base-asset volume uniformly across its [low, high]
 * range and bins it. This is an OHLCV approximation, not exchange trade-level
 * volume-at-price data. All levels are calculated from completed candles only.
 */
import { Candle } from './indicators';
import { LiquidityStrategySettings } from './settings';

export type StrategySide = 'LONG' | 'SHORT';
export type SetupPhase = 'WAIT_POC_RECLAIM' | 'WAIT_POC_RETEST';

export interface VolumeProfile {
  poc: number;
  binSize: number;
  low: number;
  high: number;
  bins: number;
  volumeAtPrice: number[];
}

export interface PendingLiquiditySetup {
  side: StrategySide;
  phase: SetupPhase;
  poc: number;
  profileBinSize: number;
  profileLow: number;
  profileHigh: number;
  sweptLevel: number;
  sweepExtreme: number;
  sweepTime: number;
  sweepIndex: number;
  stopPrice: number;
  reclaimIndex: number | null;
}

export interface LiquiditySignal {
  side: StrategySide;
  time: number;
  index: number;
  entryPrice: number;
  atr: number;
  stopPrice: number;
  riskDistance: number;
  pocPrice: number;
  sweptLevel: number;
  sweepExtreme: number;
  sweepTime: number;
  profileBinSize: number;
}

const isValidCandle = (c: Candle): boolean =>
  [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) &&
  c.high >= c.low && c.volume >= 0;

/**
 * Approximate a fixed-range volume profile from OHLCV candles. The caller
 * chooses the candles; live/backtest callers pass the 30 bars preceding the
 * sweep candle, deliberately excluding the sweep bar from its own profile.
 */
export function calculateVolumeProfile(candles: Candle[], bins = 24): VolumeProfile | null {
  const usable = candles.filter(isValidCandle);
  const binCount = Math.max(1, Math.floor(bins));
  if (!usable.length) return null;

  const low = Math.min(...usable.map((c) => c.low));
  const high = Math.max(...usable.map((c) => c.high));
  const span = high - low;
  if (!(span > 0)) {
    return {
      poc: usable[usable.length - 1].close,
      binSize: 0,
      low,
      high,
      bins: binCount,
      volumeAtPrice: Array.from({ length: binCount }, (_, i) => (i === 0 ? usable.reduce((s, c) => s + c.volume, 0) : 0)),
    };
  }

  const binSize = span / binCount;
  const volumeAtPrice = new Array<number>(binCount).fill(0);
  for (const c of usable) {
    if (c.volume <= 0) continue;
    const barSpan = c.high - c.low;
    if (barSpan <= 0) {
      const index = Math.max(0, Math.min(binCount - 1, Math.floor((c.close - low) / binSize)));
      volumeAtPrice[index] += c.volume;
      continue;
    }

    let assigned = 0;
    for (let i = 0; i < binCount; i++) {
      const binLow = low + i * binSize;
      const binHigh = i === binCount - 1 ? high : binLow + binSize;
      const overlap = Math.max(0, Math.min(c.high, binHigh) - Math.max(c.low, binLow));
      if (overlap <= 0) continue;
      const amount = c.volume * (overlap / barSpan);
      volumeAtPrice[i] += amount;
      assigned += amount;
    }
    // Floating point / zero-width boundary guard: preserve all bar volume.
    if (assigned <= 0) {
      const typical = (c.high + c.low + c.close) / 3;
      const index = Math.max(0, Math.min(binCount - 1, Math.floor((typical - low) / binSize)));
      volumeAtPrice[index] += c.volume;
    }
  }

  let pocIndex = 0;
  for (let i = 1; i < volumeAtPrice.length; i++) {
    if (volumeAtPrice[i] > volumeAtPrice[pocIndex]) pocIndex = i;
  }
  return {
    poc: low + (pocIndex + 0.5) * binSize,
    binSize,
    low,
    high,
    bins: binCount,
    volumeAtPrice,
  };
}

/** Simple ATR from completed bars ending at `endIndex`, inclusive. */
export function averageTrueRangeAt(candles: Candle[], endIndex: number, length = 14): number {
  if (length <= 0 || endIndex < 0 || endIndex >= candles.length) return NaN;
  const start = Math.max(0, endIndex - Math.floor(length) + 1);
  let sum = 0;
  let count = 0;
  for (let i = start; i <= endIndex; i++) {
    const c = candles[i];
    if (!isValidCandle(c)) continue;
    const prevClose = i > 0 && Number.isFinite(candles[i - 1].close) ? candles[i - 1].close : c.open;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    count += 1;
  }
  return count ? sum / count : NaN;
}

/**
 * Liquidity sweep on the current completed candle versus the prior N completed
 * candles. A wick must breach the prior extreme and close back inside. If one
 * outside bar sweeps both sides, it is ambiguous and is ignored.
 */
export function detectLiquiditySweep(
  candles: Candle[],
  index: number,
  config: LiquidityStrategySettings,
  atrLength = 14,
): PendingLiquiditySetup | null {
  const lookback = Math.max(5, Math.floor(config.lookbackBars));
  if (index < lookback || index >= candles.length) return null;
  const bar = candles[index];
  if (!isValidCandle(bar)) return null;

  const prior = candles.slice(index - lookback, index);
  if (prior.length !== lookback || prior.some((c) => !isValidCandle(c))) return null;
  const priorLow = Math.min(...prior.map((c) => c.low));
  const priorHigh = Math.max(...prior.map((c) => c.high));
  const atrBefore = averageTrueRangeAt(candles, index - 1, atrLength);
  if (!Number.isFinite(atrBefore) || atrBefore <= 0) return null;
  const minimumSweep = atrBefore * Math.max(0, config.sweepMinAtr);
  const sweptDown = bar.low < priorLow - minimumSweep && bar.close > priorLow;
  const sweptUp = bar.high > priorHigh + minimumSweep && bar.close < priorHigh;
  if (sweptDown === sweptUp) return null;

  const profile = calculateVolumeProfile(prior, config.profileBins);
  if (!profile || !(profile.poc > 0)) return null;
  const buffer = atrBefore * Math.max(0, config.stopBufferAtr);
  if (sweptDown) {
    return {
      side: 'LONG',
      phase: 'WAIT_POC_RECLAIM',
      poc: profile.poc,
      profileBinSize: profile.binSize,
      profileLow: profile.low,
      profileHigh: profile.high,
      sweptLevel: priorLow,
      sweepExtreme: bar.low,
      sweepTime: bar.time,
      sweepIndex: index,
      stopPrice: bar.low - buffer,
      reclaimIndex: null,
    };
  }
  return {
    side: 'SHORT',
    phase: 'WAIT_POC_RECLAIM',
    poc: profile.poc,
    profileBinSize: profile.binSize,
    profileLow: profile.low,
    profileHigh: profile.high,
    sweptLevel: priorHigh,
    sweepExtreme: bar.high,
    sweepTime: bar.time,
    sweepIndex: index,
    stopPrice: bar.high + buffer,
    reclaimIndex: null,
  };
}

/**
 * Stateful per-symbol setup tracker. Entry is emitted only after:
 *   1. sweep + close back through the prior 30-bar extreme,
 *   2. a later close reclaiming the locked POC, and
 *   3. a subsequent candle retesting the POC and rejecting it in sweep direction.
 *
 * `prime()` replays history to reconstruct a pending setup after a process
 * restart, but deliberately discards any signal from the past.
 */
export class LiquiditySweepStrategy {
  private setups = new Map<string, PendingLiquiditySetup>();

  pending(symbol: string): PendingLiquiditySetup | null {
    const setup = this.setups.get(symbol);
    return setup ? { ...setup } : null;
  }

  reset(symbol?: string): void {
    if (symbol) this.setups.delete(symbol);
    else this.setups.clear();
  }

  prime(symbol: string, candles: Candle[], config: LiquidityStrategySettings, atrLength = 14): void {
    this.setups.delete(symbol);
    const first = Math.max(0, Math.floor(config.lookbackBars));
    for (let i = first; i < candles.length; i++) {
      // Historical signals are consumed during priming, never traded retroactively.
      this.process(symbol, candles, i, config, atrLength);
    }
  }

  process(
    symbol: string,
    candles: Candle[],
    index: number,
    config: LiquidityStrategySettings,
    atrLength = 14,
  ): LiquiditySignal | null {
    if (index < 0 || index >= candles.length) return null;
    const bar = candles[index];
    if (!isValidCandle(bar)) return null;

    // A newer sweep replaces an older unfilled setup and locks a fresh profile.
    const freshSweep = detectLiquiditySweep(candles, index, config, atrLength);
    if (freshSweep) {
      this.setups.set(symbol, freshSweep);
      return null;
    }

    const setup = this.setups.get(symbol);
    if (!setup || index <= setup.sweepIndex) return null;

    if (index - setup.sweepIndex > Math.max(1, Math.floor(config.setupExpiryBars))) {
      this.setups.delete(symbol);
      return null;
    }

    // Before entry, a return through the sweep extreme/stop invalidates the thesis.
    const invalidated = setup.side === 'LONG'
      ? bar.low <= setup.stopPrice || bar.close <= setup.sweptLevel
      : bar.high >= setup.stopPrice || bar.close >= setup.sweptLevel;
    if (invalidated) {
      this.setups.delete(symbol);
      return null;
    }

    if (setup.phase === 'WAIT_POC_RECLAIM') {
      const reclaimed = setup.side === 'LONG' ? bar.close > setup.poc : bar.close < setup.poc;
      if (reclaimed) {
        setup.phase = 'WAIT_POC_RETEST';
        setup.reclaimIndex = index;
      }
      return null;
    }

    // A retest must occur on a later candle than the POC reclaim.
    if (setup.reclaimIndex === null || index <= setup.reclaimIndex) return null;
    const atrNow = averageTrueRangeAt(candles, index, atrLength);
    if (!Number.isFinite(atrNow) || atrNow <= 0) return null;
    const tolerance = Math.max(setup.profileBinSize * 0.5, atrNow * Math.max(0, config.retestToleranceAtr));
    const bullishReject =
      setup.side === 'LONG' &&
      candles[index - 1]?.close > setup.poc &&
      bar.low >= setup.poc - tolerance &&
      bar.low <= setup.poc + tolerance &&
      bar.close > setup.poc &&
      bar.close > bar.open;
    const bearishReject =
      setup.side === 'SHORT' &&
      candles[index - 1]?.close < setup.poc &&
      bar.high >= setup.poc - tolerance &&
      bar.high <= setup.poc + tolerance &&
      bar.close < setup.poc &&
      bar.close < bar.open;
    if (!bullishReject && !bearishReject) return null;

    const direction = setup.side === 'LONG' ? 1 : -1;
    const riskDistance = direction * (bar.close - setup.stopPrice);
    const maxRisk = atrNow * Math.max(0.1, config.maxStopAtr);
    this.setups.delete(symbol); // signal is one-shot, including when auto-trading is disarmed
    if (!(riskDistance > 0) || riskDistance > maxRisk) return null;

    return {
      side: setup.side,
      time: bar.time,
      index,
      entryPrice: bar.close,
      atr: atrNow,
      stopPrice: setup.stopPrice,
      riskDistance,
      pocPrice: setup.poc,
      sweptLevel: setup.sweptLevel,
      sweepExtreme: setup.sweepExtreme,
      sweepTime: setup.sweepTime,
      profileBinSize: setup.profileBinSize,
    };
  }
}

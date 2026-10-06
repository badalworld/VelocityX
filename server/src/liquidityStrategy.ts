/**
 * Closed-candle liquidity-sweep → approximate volume-profile POC → retest strategy.
 *
 * Professional upgrades over a naive sweep+POC system:
 *   1. Sweep bar must exceed prior N-bar average volume (real institutional move).
 *   2. POC must carry meaningfully more volume than the profile's average bin (true consensus).
 *   3. Multi-bar retest window (default 8 bars after reclaim) instead of a single candle.
 *   4. Retest candle must close strongly back in our direction (lower-wick bullish
 *      / upper-wick bearish) — removes marginal "touch" bars.
 *   5. Optional EMA200 higher-timeframe bias filter — only trade with the macro trend.
 *   6. Cooldown after losses handled by the caller via prime(); strategy state remains pure.
 *
 * Volume-at-price is not present in Binance 5m klines. The profile spreads each
 * candle's base-asset volume uniformly across its [low, high] range and bins it.
 * All levels are calculated from completed candles only.
 */
import { Candle, ema } from './indicators';
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
  pocVolumeRatio: number; // poc bin / mean bin — quality metric
}

export interface PendingLiquiditySetup {
  side: StrategySide;
  phase: SetupPhase;
  poc: number;
  profileBinSize: number;
  profileLow: number;
  profileHigh: number;
  pocVolumeRatio: number;
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
  pocVolumeRatio: number;
  sweptLevel: number;
  sweepExtreme: number;
  sweepTime: number;
  profileBinSize: number;
}

const isValidCandle = (c: Candle): boolean =>
  [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) &&
  c.high >= c.low &&
  c.volume >= 0;

/**
 * Approximate a fixed-range volume profile from OHLCV candles. The caller
 * chooses the candles; live/backtest callers pass the lookback bars preceding
 * the sweep candle, deliberately excluding the sweep bar from its own profile.
 */
export function calculateVolumeProfile(candles: Candle[], bins = 24): VolumeProfile | null {
  const usable = candles.filter(isValidCandle);
  const binCount = Math.max(1, Math.floor(bins));
  if (!usable.length) return null;

  const low = Math.min(...usable.map((c) => c.low));
  const high = Math.max(...usable.map((c) => c.high));
  const span = high - low;
  if (!(span > 0)) {
    const totalVol = usable.reduce((s, c) => s + c.volume, 0);
    return {
      poc: usable[usable.length - 1].close,
      binSize: 0,
      low,
      high,
      bins: binCount,
      volumeAtPrice: Array.from({ length: binCount }, (_, i) => (i === 0 ? totalVol : 0)),
      pocVolumeRatio: binCount,
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
  const totalVol = volumeAtPrice.reduce((a, b) => a + b, 0);
  const meanBin = totalVol / binCount;
  const pocVol = volumeAtPrice[pocIndex];
  return {
    poc: low + (pocIndex + 0.5) * binSize,
    binSize,
    low,
    high,
    bins: binCount,
    volumeAtPrice,
    pocVolumeRatio: meanBin > 0 ? pocVol / meanBin : binCount,
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

/** EMA at index `endIndex`, seeded Pine-style with an SMA. */
function emaAt(candles: Candle[], endIndex: number, length: number): number {
  if (length <= 0 || endIndex < length - 1) return NaN;
  const closes: number[] = [];
  for (let i = 0; i <= endIndex; i++) closes.push(candles[i].close);
  const series = ema(closes, length);
  return series[endIndex];
}

/**
 * Average volume over the `lookback` closed bars ending at endIndex inclusive.
 */
function averageVolumeAt(candles: Candle[], endIndex: number, lookback: number): number {
  if (endIndex < 0 || lookback <= 0) return NaN;
  const start = Math.max(0, endIndex - lookback + 1);
  let sum = 0; let count = 0;
  for (let i = start; i <= endIndex; i++) {
    const c = candles[i];
    if (!isValidCandle(c)) continue;
    sum += c.volume; count += 1;
  }
  return count ? sum / count : NaN;
}

/**
 * Liquidity sweep on the current completed candle versus the prior N completed
 * candles. A wick must breach the prior extreme and close back inside.
 * Professional filter: sweep bar volume must exceed recent average volume.
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

  // Sweep-volume confirmation: we want a real stop-run, not a quiet probe.
  const avgVol = averageVolumeAt(candles, index - 1, lookback);
  if (Number.isFinite(avgVol) && avgVol > 0 && bar.volume < avgVol * config.sweepVolumeMultiplier) {
    return null;
  }

  const profile = calculateVolumeProfile(prior, config.profileBins);
  if (!profile || !(profile.poc > 0)) return null;
  if (profile.pocVolumeRatio < Math.max(0.5, config.pocVolumeMinRatio)) return null; // weak POC
  const buffer = atrBefore * Math.max(0, config.stopBufferAtr);

  // EMA trend bias filter (configurable: 0 disables).
  if (config.trendFilterEma > 0 && index >= config.trendFilterEma) {
    const trendEma = emaAt(candles, index - 1, config.trendFilterEma);
    if (Number.isFinite(trendEma) && trendEma > 0) {
      if (sweptDown && bar.close < trendEma) return null; // don't go long into a macro downtrend
      if (sweptUp && bar.close > trendEma) return null;   // don't short into a macro uptrend
    }
  }

  if (sweptDown) {
    return {
      side: 'LONG',
      phase: 'WAIT_POC_RECLAIM',
      poc: profile.poc,
      profileBinSize: profile.binSize,
      profileLow: profile.low,
      profileHigh: profile.high,
      pocVolumeRatio: profile.pocVolumeRatio,
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
    pocVolumeRatio: profile.pocVolumeRatio,
    sweptLevel: priorHigh,
    sweepExtreme: bar.high,
    sweepTime: bar.time,
    sweepIndex: index,
    stopPrice: bar.high + buffer,
    reclaimIndex: null,
  };
}

export interface StrategyCooldown {
  /** Bar index until which signals are suppressed (inclusive). */
  untilIndex: number;
}

/**
 * Stateful per-symbol setup tracker. Entry is emitted only after:
 *   1. sweep + close back through the prior lookback extreme (with volume filter),
 *   2. a later close reclaiming the locked POC, and
 *   3. a subsequent candle retesting the POC with a strong directional rejection.
 *
 * `prime()` replays history to reconstruct pending setup after a process restart
 * but deliberately discards any signal from the past.
 */
export class LiquiditySweepStrategy {
  private setups = new Map<string, PendingLiquiditySetup>();
  /** Per-symbol cooldown (e.g. after a stop-out). */
  private cooldowns = new Map<string, StrategyCooldown>();

  pending(symbol: string): PendingLiquiditySetup | null {
    const setup = this.setups.get(symbol);
    return setup ? { ...setup } : null;
  }

  /** Suppress new setups/signals on `symbol` for the next `bars` closed candles. */
  setCooldown(symbol: string, currentIndex: number, bars: number): void {
    if (bars <= 0) { this.cooldowns.delete(symbol); return; }
    this.cooldowns.set(symbol, { untilIndex: currentIndex + Math.floor(bars) });
    this.setups.delete(symbol);
  }

  reset(symbol?: string): void {
    if (symbol) {
      this.setups.delete(symbol);
      this.cooldowns.delete(symbol);
    } else {
      this.setups.clear();
      this.cooldowns.clear();
    }
  }

  prime(symbol: string, candles: Candle[], config: LiquidityStrategySettings, atrLength = 14): void {
    this.setups.delete(symbol);
    this.cooldowns.delete(symbol);
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

    // Respect active cooldown (e.g. post-loss pause). While cooling down we do
    // NOT lock new sweeps either; a fresh sweep that prints during cooldown
    // would have its profile/reclaim window expire before we can trade it.
    const cd = this.cooldowns.get(symbol);
    if (cd) {
      if (index > cd.untilIndex) this.cooldowns.delete(symbol);
      else {
        // While cooling we still track invalidation properly: a setup from
        // before cooldown started is discarded.
        this.setups.delete(symbol);
        return null;
      }
    }

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

    // A retest must occur on a later candle than the POC reclaim, within the window.
    if (setup.reclaimIndex === null || index <= setup.reclaimIndex) return null;
    const retestWindow = Math.max(1, Math.floor(config.retestWindowBars));
    if (index - setup.reclaimIndex > retestWindow) {
      this.setups.delete(symbol);
      return null;
    }
    const atrNow = averageTrueRangeAt(candles, index, atrLength);
    if (!Number.isFinite(atrNow) || atrNow <= 0) return null;
    const tolerance = Math.max(setup.profileBinSize * 0.5, atrNow * Math.max(0, config.retestToleranceAtr));
    const barRange = bar.high - bar.low;
    const strength = Math.max(0.2, Math.min(0.95, config.retestCloseStrength));

    // Strong rejection: price reaches the POC zone (wick) and closes decisively back
    // in trade direction, with a respectable body-to-range ratio (no doji/indecision).
    const touchPocBull =
      setup.side === 'LONG' &&
      bar.low <= setup.poc + tolerance &&
      bar.low >= setup.poc - tolerance * 1.5;
    const touchPocBear =
      setup.side === 'SHORT' &&
      bar.high >= setup.poc - tolerance &&
      bar.high <= setup.poc + tolerance * 1.5;

    const bullishReject =
      touchPocBull &&
      bar.close > setup.poc &&
      bar.close > bar.open &&
      barRange > 0 &&
      (bar.close - bar.low) / barRange >= strength; // closed in the top `strength` of the bar

    const bearishReject =
      touchPocBear &&
      bar.close < setup.poc &&
      bar.close < bar.open &&
      barRange > 0 &&
      (bar.high - bar.close) / barRange >= strength; // closed in the bottom `strength` of the bar

    if (!bullishReject && !bearishReject) return null;

    const direction = setup.side === 'LONG' ? 1 : -1;
    const riskDistance = direction * (bar.close - setup.stopPrice);
    const maxRisk = atrNow * Math.max(0.1, config.maxStopAtr);
    this.setups.delete(symbol); // signal is one-shot
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
      pocVolumeRatio: setup.pocVolumeRatio,
      sweptLevel: setup.sweptLevel,
      sweepExtreme: setup.sweepExtreme,
      sweepTime: setup.sweepTime,
      profileBinSize: setup.profileBinSize,
    };
  }
}

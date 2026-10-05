/**
 * Technical indicator math — exact ports of the TradingView SUPER INDIBOT script.
 *  - ta.ema  -> EMA seeded with SMA of the first `length` values (Pine behaviour)
 *  - ta.atr  -> Wilder's RMA of True Range (Pine ta.atr)
 *  - Signals use *confirmed* values (close[1] based) so they never repaint.
 */

export interface Candle {
  time: number; // open time, ms
  closeTime: number; // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function ema(values: number[], length: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < length || length <= 0) return out;
  const alpha = 2 / (length + 1);
  let seed = 0;
  for (let i = 0; i < length; i++) seed += values[i];
  let prev = seed / length;
  out[length - 1] = prev;
  for (let i = length; i < values.length; i++) {
    prev = values[i] * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

export function trueRange(candles: Candle[]): number[] {
  const tr: number[] = new Array(candles.length).fill(NaN);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      tr[i] = c.high - c.low;
    } else {
      const pc = candles[i - 1].close;
      tr[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    }
  }
  return tr;
}

/** Pine ta.atr = RMA(trueRange, length) */
export function atr(candles: Candle[], length: number): number[] {
  const tr = trueRange(candles);
  const out: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < length || length <= 0) return out;
  let seed = 0;
  for (let i = 0; i < length; i++) seed += tr[i];
  let prev = seed / length;
  out[length - 1] = prev;
  for (let i = length; i < candles.length; i++) {
    prev = (prev * (length - 1) + tr[i]) / length;
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder ADX(length) — trend-strength gate used by the market scanner so the
 * bot only trades *trending* markets (chop/range/pegged pairs are rejected).
 * Returns an array aligned with the candles; values before 2×length are NaN.
 */
export function adx(candles: Candle[], length = 14): number[] {
  const n = candles.length;
  const out: number[] = new Array(n).fill(NaN);
  if (length <= 0 || n < length * 2 + 2) return out;

  const tr = trueRange(candles);
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
  }

  // Wilder smoothing of TR / +DM / -DM
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= length; i++) {
    trS += tr[i];
    pS += plusDM[i];
    mS += minusDM[i];
  }
  const dx: number[] = [];
  for (let i = length + 1; i < n; i++) {
    trS = trS - trS / length + tr[i];
    pS = pS - pS / length + plusDM[i];
    mS = mS - mS / length + minusDM[i];
    const pdi = trS > 0 ? (pS / trS) * 100 : 0;
    const mdi = trS > 0 ? (mS / trS) * 100 : 0;
    const sum = pdi + mdi;
    dx.push(sum > 0 ? (Math.abs(pdi - mdi) / sum) * 100 : 0);
  }
  if (dx.length < length) return out;
  let val = 0;
  for (let i = 0; i < length; i++) val += dx[i];
  val /= length;
  out[2 * length] = val;
  for (let k = length; k < dx.length; k++) {
    val = (val * (length - 1) + dx[k]) / length;
    out[length + 1 + k] = val;
  }
  return out;
}

/** Last finite value of a series (or NaN). */
export function lastFinite(series: number[]): number {
  for (let i = series.length - 1; i >= 0; i--) if (Number.isFinite(series[i])) return series[i];
  return NaN;
}

export type SignalSide = 'LONG' | 'SHORT';

/**
 * Non-repaint signal from the indicator:
 *   ema2_confirmed = ta.ema(close[1], ema2Len)   (EMA as of previous bar)
 *   longSignal  = ta.crossover(ema2_confirmed, ema8_confirmed)  on a confirmed bar
 *
 * Evaluated at closed bar index i (i >= 2):
 *   LONG  <=> EMA_fast[i-1] >  EMA_slow[i-1]  &&  EMA_fast[i-2] <= EMA_slow[i-2]
 *   SHORT <=> EMA_fast[i-1] <  EMA_slow[i-1]  &&  EMA_fast[i-2] >= EMA_slow[i-2]
 * where fast = emaLengths[1] (11) and slow = emaLengths[7] (34).
 */
export function signalAt(fast: number[], slow: number[], i: number): SignalSide | null {
  if (i < 2) return null;
  const f1 = fast[i - 1], s1 = slow[i - 1];
  const f2 = fast[i - 2], s2 = slow[i - 2];
  if (![f1, s1, f2, s2].every(Number.isFinite)) return null;
  if (f1 > s1 && f2 <= s2) return 'LONG';
  if (f1 < s1 && f2 >= s2) return 'SHORT';
  return null;
}

export interface IndicatorSnapshot {
  candles: Candle[];
  emas: number[][]; // emas[k][i] — ribbon
  emaExtra: number[];
  atrSeries: number[];
}

/** Full ribbon + extra EMA + ATR for a candle series. */
export function computeSnapshot(candles: Candle[], emaLengths: number[], extraLen: number, atrLen: number): IndicatorSnapshot {
  const closes = candles.map((c) => c.close);
  const emas = emaLengths.map((l) => ema(closes, l));
  const emaExtra = ema(closes, extraLen);
  const atrSeries = atr(candles, atrLen);
  return { candles, emas, emaExtra, atrSeries };
}

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

/** Signal state for the screener: Bullish/Bearish bias + fresh cross (same logic, current bar). */
export function screenerState(candles: Candle[], fastLen: number, slowLen: number): 'Long' | 'Short' | 'Bullish' | 'Bearish' {
  const closes = candles.map((c) => c.close);
  const f = ema(closes, fastLen);
  const s = ema(closes, slowLen);
  const i = candles.length - 1;
  const sig = signalAt(f, s, i);
  if (sig === 'LONG') return 'Long';
  if (sig === 'SHORT') return 'Short';
  const fi = f[i], si = s[i];
  if (Number.isFinite(fi) && Number.isFinite(si)) return fi > si ? 'Bullish' : 'Bearish';
  return 'Bearish';
}

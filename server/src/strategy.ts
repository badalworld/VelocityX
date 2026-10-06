/**
 * CryptoVN WaveTrend strategy calculations.
 *
 * The TradingView script is protected, so this is a clean implementation of
 * the public rules shown on its page: WaveTrend fast/slow lines, overbought /
 * oversold zones, and the stated fast-line reversal/crossover signals.
 * This module is deliberately pure: it produces signals and backtest results
 * but never sends an exchange order.
 */
import type { Candle } from './candles';

export interface StrategySettings {
  channelLength: number;
  averageLength: number;
  signalLength: number;
  overbought: number;
  oversold: number;
  atrLength: number;
  atrMultiplier: number;
}

export const DEFAULT_STRATEGY: StrategySettings = {
  channelLength: 10,
  averageLength: 21,
  signalLength: 4,
  overbought: 53,
  oversold: -53,
  atrLength: 14,
  atrMultiplier: 3,
};

export interface IndicatorPoint {
  time: number;
  fema: number;
  fsma: number;
  atr: number;
}

export type Signal = 'BUY' | 'SELL' | null;
export type PositionSide = 'LONG' | 'SHORT';

export interface StrategySignal extends IndicatorPoint {
  signal: Exclude<Signal, null>;
  reason: string;
}

export interface BacktestTrade {
  side: PositionSide;
  entryTime: number;
  entryPrice: number;
  stopPrice: number;
  exitTime: number;
  exitPrice: number;
  exitReason: 'ATR_STOP' | 'OPPOSITE_ZONE' | 'END_OF_DATA';
  pnl: number;
  pnlPct: number;
}

export interface BacktestResult {
  settings: StrategySettings;
  points: IndicatorPoint[];
  signals: StrategySignal[];
  trades: BacktestTrade[];
  netPnlPct: number;
  wins: number;
  losses: number;
}

function safeSettings(input?: Partial<StrategySettings>): StrategySettings {
  const s = { ...DEFAULT_STRATEGY, ...(input || {}) };
  return {
    channelLength: Math.max(1, Math.floor(Number(s.channelLength) || DEFAULT_STRATEGY.channelLength)),
    averageLength: Math.max(1, Math.floor(Number(s.averageLength) || DEFAULT_STRATEGY.averageLength)),
    signalLength: Math.max(1, Math.floor(Number(s.signalLength) || DEFAULT_STRATEGY.signalLength)),
    overbought: Number.isFinite(Number(s.overbought)) ? Number(s.overbought) : DEFAULT_STRATEGY.overbought,
    oversold: Number.isFinite(Number(s.oversold)) ? Number(s.oversold) : DEFAULT_STRATEGY.oversold,
    atrLength: Math.max(1, Math.floor(Number(s.atrLength) || DEFAULT_STRATEGY.atrLength)),
    atrMultiplier: Math.max(0.1, Number(s.atrMultiplier) || DEFAULT_STRATEGY.atrMultiplier),
  };
}

function ema(values: number[], length: number): number[] {
  const alpha = 2 / (length + 1);
  const out: number[] = [];
  let previous = values[0] || 0;
  for (const value of values) {
    previous = alpha * value + (1 - alpha) * previous;
    out.push(previous);
  }
  return out;
}

function sma(values: number[], length: number): number[] {
  let sum = 0;
  return values.map((value, i) => {
    sum += value;
    if (i >= length) sum -= values[i - length];
    return sum / Math.min(i + 1, length);
  });
}

function atr(candles: Candle[], length: number): number[] {
  const tr = candles.map((c, i) => {
    const previousClose = i ? candles[i - 1].close : c.close;
    return Math.max(c.high - c.low, Math.abs(c.high - previousClose), Math.abs(c.low - previousClose));
  });
  return ema(tr, length);
}

/** WaveTrend fast EMA (fema) and signal SMA (fsma), aligned to candles. */
export function indicator(candles: Candle[], input?: Partial<StrategySettings>): IndicatorPoint[] {
  const s = safeSettings(input);
  if (!candles.length) return [];
  const ap = candles.map((c) => (c.high + c.low + c.close) / 3);
  const esa = ema(ap, s.channelLength);
  const deviation = ema(ap.map((value, i) => Math.abs(value - esa[i])), s.channelLength);
  const ci = ap.map((value, i) => deviation[i] === 0 ? 0 : (value - esa[i]) / (0.015 * deviation[i]));
  const fema = ema(ci, s.averageLength);
  const fsma = sma(fema, s.signalLength);
  const ranges = atr(candles, s.atrLength);
  return candles.map((c, i) => ({ time: c.time, fema: fema[i], fsma: fsma[i], atr: ranges[i] }));
}

/**
 * Generates entries only after a reversal in an extreme zone. A short is
 * opened when fema turns down while above overbought and below fsma; a long
 * is the mirrored oversold condition. One position is assumed at a time.
 */
export function signals(candles: Candle[], input?: Partial<StrategySettings>): StrategySignal[] {
  const s = safeSettings(input);
  const points = indicator(candles, s);
  const out: StrategySignal[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i - 1];
    const c = points[i];
    if (c.fema >= s.overbought && c.fema < p.fema && c.fema < c.fsma) {
      out.push({ ...c, signal: 'SELL', reason: 'FEMA reversed down in the overbought zone' });
    } else if (c.fema <= s.oversold && c.fema > p.fema && c.fema > c.fsma) {
      out.push({ ...c, signal: 'BUY', reason: 'FEMA reversed up in the oversold zone' });
    }
  }
  return out;
}

export function backtest(candles: Candle[], input?: Partial<StrategySettings>): BacktestResult {
  const s = safeSettings(input);
  const points = indicator(candles, s);
  const signalByTime = new Map(signals(candles, s).map((x) => [x.time, x]));
  const signalList = [...signalByTime.values()];
  const trades: BacktestTrade[] = [];
  let open: { side: PositionSide; entryTime: number; entryPrice: number; stopPrice: number } | null = null;

  for (let i = 1; i < candles.length; i += 1) {
    const candle = candles[i];
    const point = points[i];
    if (open) {
      const stopped = open.side === 'LONG' ? candle.low <= open.stopPrice : candle.high >= open.stopPrice;
      const oppositeZone = open.side === 'LONG' ? point.fema >= s.overbought : point.fema <= s.oversold;
      // Conservative assumption: if stop and target happen in one candle,
      // stop is filled first because OHLC data has no intrabar ordering.
      if (stopped || oppositeZone) {
        const exitPrice = stopped ? open.stopPrice : candle.close;
        const pnl = open.side === 'LONG' ? exitPrice - open.entryPrice : open.entryPrice - exitPrice;
        trades.push({ side: open.side, entryTime: open.entryTime, entryPrice: open.entryPrice, stopPrice: open.stopPrice, exitTime: candle.time, exitPrice, exitReason: stopped ? 'ATR_STOP' : 'OPPOSITE_ZONE', pnl, pnlPct: (pnl / open.entryPrice) * 100 });
        open = null;
      }
    }
    if (!open) {
      const signal = signalByTime.get(candle.time);
      if (signal) {
        const side: PositionSide = signal.signal === 'BUY' ? 'LONG' : 'SHORT';
        open = { side, entryTime: candle.time, entryPrice: candle.close, stopPrice: side === 'LONG' ? candle.close - point.atr * s.atrMultiplier : candle.close + point.atr * s.atrMultiplier };
      }
    }
  }
  if (open && candles.length) {
    const last = candles[candles.length - 1];
    const pnl = open.side === 'LONG' ? last.close - open.entryPrice : open.entryPrice - last.close;
    trades.push({ side: open.side, entryTime: open.entryTime, entryPrice: open.entryPrice, stopPrice: open.stopPrice, exitTime: last.time, exitPrice: last.close, exitReason: 'END_OF_DATA', pnl, pnlPct: (pnl / open.entryPrice) * 100 });
  }
  return { settings: s, points, signals: signalList, trades, netPnlPct: trades.reduce((sum, t) => sum + t.pnlPct, 0), wins: trades.filter((t) => t.pnl > 0).length, losses: trades.filter((t) => t.pnl <= 0).length };
}

export function latestStrategy(candles: Candle[], input?: Partial<StrategySettings>): { point: IndicatorPoint | null; signal: StrategySignal | null; settings: StrategySettings } {
  const settings = safeSettings(input);
  const points = indicator(candles, settings);
  const recent = signals(candles, settings);
  return { point: points.at(-1) || null, signal: recent.at(-1) || null, settings };
}

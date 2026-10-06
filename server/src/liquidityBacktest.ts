/**
 * Historical OHLCV backtest for the live liquidity-sweep strategy.
 * This module is pure: it never imports the executor, exchange order API, or
 * persistent trade journal. It assumes a single-symbol position at a time.
 */
import { Candle } from './indicators';
import { averageTrueRangeAt, LiquiditySweepStrategy, LiquiditySignal } from './liquidityStrategy';
import { LiquidityStrategySettings } from './settings';

export interface BacktestOptions {
  startingBalance?: number;
  riskPercent?: number;
  feeRate?: number;
  slippageBps?: number;
  dataSource?: string;
}

export interface BacktestTrade {
  side: 'LONG' | 'SHORT';
  entryTime: number;
  exitTime: number | null;
  entryPrice: number;
  exitPrice: number | null;
  initialStop: number;
  pocPrice: number;
  sweptLevel: number;
  sweepTime: number;
  barsHeld: number;
  tpHits: number[];
  closeReason: 'TP5' | 'SL' | 'SL_PARTIAL' | 'END_OF_DATA' | null;
  status: 'CLOSED' | 'OPEN';
  grossPnl: number;
  fees: number;
  netPnl: number;
  initialRiskCash: number;
  rMultiple: number;
}

export interface BacktestResult {
  symbol: string;
  interval: '5m';
  dataSource: string;
  startTime: number | null;
  endTime: number | null;
  candles: number;
  startingBalance: number;
  endingEquity: number;
  netPnl: number;
  returnPct: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  averageR: number;
  expectancyR: number;
  profitFactor: number | null;
  maxDrawdown: number;
  maxDrawdownPct: number;
  fees: number;
  stopExits: number;
  tpHitCounts: { tp1: number; tp2: number; tp3: number; tp4: number; tp5: number };
  openPosition: BacktestTrade | null;
  trades: BacktestTrade[];
  assumptions: string[];
}

interface SimPosition {
  side: 'LONG' | 'SHORT';
  direction: 1 | -1;
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  initialStop: number;
  currentStop: number;
  riskDistance: number;
  qty: number;
  remainingQty: number;
  initialRiskCash: number;
  pocPrice: number;
  sweptLevel: number;
  sweepTime: number;
  nextTarget: number;
  tpHits: number[];
  grossPnl: number;
  fees: number;
  netPnl: number;
  weightedExitPrice: number;
  exitQty: number;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
const finiteOr = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const adverseFill = (price: number, direction: 1 | -1, isEntry: boolean, slippage: number): number => {
  const signed = direction * (isEntry ? 1 : -1);
  return price * (1 + signed * slippage);
};

function valid(c: Candle): boolean {
  return [c.time, c.closeTime, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) &&
    c.open > 0 && c.high >= c.low && c.volume >= 0;
}

function stopTouched(pos: SimPosition, bar: Candle): { hit: boolean; basePrice: number } {
  if (pos.direction === 1) {
    if (bar.open <= pos.currentStop) return { hit: true, basePrice: bar.open };
    if (bar.low <= pos.currentStop) return { hit: true, basePrice: pos.currentStop };
  } else {
    if (bar.open >= pos.currentStop) return { hit: true, basePrice: bar.open };
    if (bar.high >= pos.currentStop) return { hit: true, basePrice: pos.currentStop };
  }
  return { hit: false, basePrice: pos.currentStop };
}

function targetTouched(pos: SimPosition, bar: Candle, target: number): boolean {
  return pos.direction === 1 ? bar.high >= target : bar.low <= target;
}

/**
 * Run a conservative bar-by-bar simulation. If the bar's starting stop and a
 * target are both reachable, the stop is assumed first. After a target advances
 * the stop, the full candle's adverse extreme is checked before another target.
 */
export function runLiquidityBacktest(
  input: Candle[],
  strategy: LiquidityStrategySettings,
  options: BacktestOptions = {},
  symbol = 'BTCUSDT',
): BacktestResult {
  const barsByTime = new Map<number, Candle>();
  for (const c of input) if (valid(c)) barsByTime.set(c.time, c);
  const candles = [...barsByTime.values()].sort((a, b) => a.time - b.time);
  const startingBalance = Math.max(1, finiteOr(options.startingBalance, 10_000));
  const riskPercent = clamp(finiteOr(options.riskPercent, 1), 0.1, 5);
  const feeRate = clamp(finiteOr(options.feeRate, 0.0004), 0, 0.01);
  const slippageBps = clamp(finiteOr(options.slippageBps, 2), 0, 100);
  const slippage = slippageBps / 10_000;
  const atrLength = 14;
  let equity = startingBalance;
  let peakEquity = startingBalance;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let position: SimPosition | null = null;
  let signalsSeen = 0;
  const trades: BacktestTrade[] = [];
  const tpHitCounts = [0, 0, 0, 0, 0];
  const engine = new LiquiditySweepStrategy();

  const updateDrawdown = (bar: Candle, index: number) => {
    let marked = equity;
    if (position && index >= position.entryIndex && position.remainingQty > 0) {
      const floating = position.direction * (bar.close - position.entryPrice) * position.remainingQty;
      const estimatedExitFee = Math.abs(bar.close * position.remainingQty) * feeRate;
      marked += floating - estimatedExitFee;
    }
    peakEquity = Math.max(peakEquity, marked);
    const drawdown = Math.max(0, peakEquity - marked);
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    if (peakEquity > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (drawdown / peakEquity) * 100);
  };

  const bookExit = (pos: SimPosition, quantity: number, basePrice: number, isStop: boolean): void => {
    const qty = Math.min(pos.remainingQty, Math.max(0, quantity));
    if (!(qty > 0)) return;
    const fill = adverseFill(basePrice, pos.direction, false, slippage);
    const gross = pos.direction * (fill - pos.entryPrice) * qty;
    const fee = Math.abs(fill * qty) * feeRate;
    pos.grossPnl += gross;
    pos.fees += fee;
    pos.netPnl += gross - fee;
    pos.weightedExitPrice += fill * qty;
    pos.exitQty += qty;
    pos.remainingQty = Math.max(0, pos.remainingQty - qty);
    equity += gross - fee;
    if (isStop) pos.remainingQty = pos.remainingQty < 1e-10 ? 0 : pos.remainingQty;
  };

  const closeTrade = (pos: SimPosition, index: number, reason: BacktestTrade['closeReason']): BacktestTrade => {
    const barsHeld = Math.max(0, index - pos.entryIndex + 1);
    const result: BacktestTrade = {
      side: pos.side,
      entryTime: pos.entryTime,
      exitTime: candles[index]?.closeTime ?? candles[index]?.time ?? null,
      entryPrice: pos.entryPrice,
      exitPrice: pos.exitQty > 0 ? pos.weightedExitPrice / pos.exitQty : null,
      initialStop: pos.initialStop,
      pocPrice: pos.pocPrice,
      sweptLevel: pos.sweptLevel,
      sweepTime: pos.sweepTime,
      barsHeld,
      tpHits: [...pos.tpHits],
      closeReason: reason,
      status: 'CLOSED',
      grossPnl: pos.grossPnl,
      fees: pos.fees,
      netPnl: pos.netPnl,
      initialRiskCash: pos.initialRiskCash,
      rMultiple: pos.initialRiskCash > 0 ? pos.netPnl / pos.initialRiskCash : 0,
    };
    trades.push(result);
    return result;
  };

  const managePosition = (pos: SimPosition, bar: Candle, index: number): boolean => {
    const stop = stopTouched(pos, bar);
    if (stop.hit) {
      bookExit(pos, pos.remainingQty, stop.basePrice, true);
      closeTrade(pos, index, pos.tpHits.length ? 'SL_PARTIAL' : 'SL');
      return true;
    }

    while (pos.nextTarget <= 5) {
      const level = pos.nextTarget;
      const target = pos.entryPrice + pos.direction * pos.riskDistance * level;
      if (!targetTouched(pos, bar, target)) break;
      const tranche = level === 5 ? pos.remainingQty : Math.min(pos.qty * 0.2, pos.remainingQty);
      bookExit(pos, tranche, target, false);
      pos.tpHits.push(level);
      tpHitCounts[level - 1] += 1;
      pos.nextTarget += 1;
      if (level === 5 || pos.remainingQty <= 1e-10) {
        pos.remainingQty = 0;
        closeTrade(pos, index, 'TP5');
        return true;
      }
      pos.currentStop = level === 1
        ? pos.entryPrice
        : pos.entryPrice + pos.direction * pos.riskDistance * (level - 1);
      const movedStopTouched = pos.direction === 1 ? bar.low <= pos.currentStop : bar.high >= pos.currentStop;
      if (movedStopTouched) {
        bookExit(pos, pos.remainingQty, pos.currentStop, true);
        closeTrade(pos, index, 'SL_PARTIAL');
        return true;
      }
    }
    return false;
  };

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    if (i >= Math.max(1, strategy.lookbackBars)) {
      const signal: LiquiditySignal | null = engine.process(symbol, candles, i, strategy, atrLength);
      if (signal) {
        signalsSeen += 1;
        if (!position && i + 1 < candles.length && equity > 0) {
          const next = candles[i + 1];
          const direction: 1 | -1 = signal.side === 'LONG' ? 1 : -1;
          const entryPrice = adverseFill(next.open, direction, true, slippage);
          const riskDistance = direction * (entryPrice - signal.stopPrice);
          const atrAtEntry = averageTrueRangeAt(candles, i, atrLength);
          const allowedRisk = atrAtEntry * Math.max(0.1, strategy.maxStopAtr);
          if (riskDistance > 0 && Number.isFinite(riskDistance) && riskDistance <= allowedRisk) {
            const riskCash = equity * (riskPercent / 100);
            const qty = riskCash / riskDistance;
            const entryFee = Math.abs(entryPrice * qty) * feeRate;
            equity -= entryFee;
            position = {
              side: signal.side,
              direction,
              entryIndex: i + 1,
              entryTime: next.time,
              entryPrice,
              initialStop: signal.stopPrice,
              currentStop: signal.stopPrice,
              riskDistance,
              qty,
              remainingQty: qty,
              initialRiskCash: riskDistance * qty,
              pocPrice: signal.pocPrice,
              sweptLevel: signal.sweptLevel,
              sweepTime: signal.sweepTime,
              nextTarget: 1,
              tpHits: [],
              grossPnl: 0,
              fees: entryFee,
              netPnl: -entryFee,
              weightedExitPrice: 0,
              exitQty: 0,
            };
          }
        }
      }
    }

    if (position && i >= position.entryIndex && managePosition(position, bar, i)) position = null;
    updateDrawdown(bar, i);
  }

  let openPosition: BacktestTrade | null = null;
  if (position && candles.length) {
    const last = candles[candles.length - 1];
    const floatingGross = position.direction * (last.close - position.entryPrice) * position.remainingQty;
    const estimatedExitFee = Math.abs(last.close * position.remainingQty) * feeRate;
    const netAtMark = position.netPnl + floatingGross - estimatedExitFee;
    openPosition = {
      side: position.side,
      entryTime: position.entryTime,
      exitTime: null,
      entryPrice: position.entryPrice,
      exitPrice: null,
      initialStop: position.initialStop,
      pocPrice: position.pocPrice,
      sweptLevel: position.sweptLevel,
      sweepTime: position.sweepTime,
      barsHeld: Math.max(0, candles.length - position.entryIndex),
      tpHits: [...position.tpHits],
      closeReason: null,
      status: 'OPEN',
      grossPnl: position.grossPnl + floatingGross,
      fees: position.fees + estimatedExitFee,
      netPnl: netAtMark,
      initialRiskCash: position.initialRiskCash,
      rMultiple: position.initialRiskCash > 0 ? netAtMark / position.initialRiskCash : 0,
    };
  }

  const wins = trades.filter((t) => t.netPnl > 0).length;
  const losses = trades.filter((t) => t.netPnl < 0).length;
  const grossWins = trades.reduce((sum, t) => sum + Math.max(0, t.netPnl), 0);
  const grossLosses = trades.reduce((sum, t) => sum + Math.max(0, -t.netPnl), 0);
  const averageR = trades.length ? trades.reduce((sum, t) => sum + t.rMultiple, 0) / trades.length : 0;
  const openMarkedPnl = openPosition?.netPnl ?? 0;
  const endingEquity = equity + (position ? openMarkedPnl - position.netPnl : 0);
  const fees = trades.reduce((sum, t) => sum + t.fees, 0) + (openPosition ? openPosition.fees : 0);

  return {
    symbol,
    interval: '5m',
    dataSource: options.dataSource || 'Provided 5m OHLCV candles (simulation only)',
    startTime: candles[0]?.time ?? null,
    endTime: candles[candles.length - 1]?.closeTime ?? null,
    candles: candles.length,
    startingBalance,
    endingEquity,
    netPnl: endingEquity - startingBalance,
    returnPct: ((endingEquity / startingBalance) - 1) * 100,
    closedTrades: trades.length,
    wins,
    losses,
    winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
    averageR,
    expectancyR: averageR,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? null : 0,
    maxDrawdown,
    maxDrawdownPct,
    fees,
    stopExits: trades.filter((t) => t.closeReason === 'SL' || t.closeReason === 'SL_PARTIAL').length,
    tpHitCounts: {
      tp1: tpHitCounts[0], tp2: tpHitCounts[1], tp3: tpHitCounts[2], tp4: tpHitCounts[3], tp5: tpHitCounts[4],
    },
    openPosition,
    trades,
    assumptions: [
      `Fixed-range POC uses ${strategy.profileBins} bins and uniformly allocates each candle's volume across its OHLC range; trade-level volume-at-price is unavailable in klines.`,
      `Sweep and profile reference the ${strategy.lookbackBars} completed candles preceding the sweep candle.`,
      'Entries fill at the next candle open with adverse slippage; the stop is the sweep wick plus the configured ATR buffer.',
      'Taker fee and slippage are charged on entry and exits; defaults are 4 bps fee and 2 bps slippage per fill.',
      'Risk-based sizing compounds at 1% of current equity per trade by default; one position per symbol; no funding, liquidation, queue priority or market impact model.',
      'If a candle can touch both the current stop and a target, the starting stop is assumed first. After a target, the moved stop is checked against the full adverse candle range.',
      'An open trade at the end is marked to the final close with an estimated exit fee; it is not force-closed.',
    ],
  };
}

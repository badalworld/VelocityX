/**
 * Weekly stats table — direct port of the indicator's WEEKLY STATS widget.
 */
import { getSettings } from './settings';
import { allSignals, allTrades, Trade } from './store';

export function computeStats(): any {
  const s = getSettings();
  const cutoff = Date.now() - s.historyDays * 86400000;

  const signals = allSignals().filter((x) => x.time >= cutoff);
  const inWindow = (t: Trade) =>
    (t.status === 'OPEN' && t.openedAt >= cutoff) || (t.status === 'CLOSED' && (t.closedAt || 0) >= cutoff);
  const closed: Trade[] = allTrades().filter((t) => t.status === 'CLOSED' && (t.closedAt || 0) >= cutoff);
  const counted = allTrades().filter(inWindow);

  let tp1Count = 0, tp2Count = 0, tp3Count = 0, slCount = 0, winCount = 0, lossCount = 0;
  let netPnl = 0, totalFees = 0, totalFunding = 0;
  for (const t of counted) {
    if (t.tp1Filled) tp1Count++;
    if (t.tp2Filled) tp2Count++;
    if (t.tp3Filled) tp3Count++;
    if (t.closeReason === 'SL') slCount++;
    if (t.result === 'WIN') winCount++;
    else if (t.result === 'LOSS') lossCount++;
    // Only bot-owned trades exist in the store — external positions are never adopted.
    if (t.status === 'CLOSED') {
      netPnl += t.realizedPnl;
      totalFees += t.fees;
      totalFunding += t.funding ?? 0;
    } else {
      totalFees += t.fees;
      totalFunding += t.funding ?? 0;
    }
  }

  const totalSignals = signals.length;
  const totalClosed = winCount + lossCount;
  const overallWinRate = totalClosed > 0 ? (winCount / totalClosed) * 100 : 0;
  const tp1Pct = totalSignals ? (tp1Count / totalSignals) * 100 : 0;
  const tp2Pct = totalSignals ? (tp2Count / totalSignals) * 100 : 0;
  const tp3Pct = totalSignals ? (tp3Count / totalSignals) * 100 : 0;
  const slPct = totalSignals ? (slCount / totalSignals) * 100 : 0;

  const rrRatio = s.tpRrFactor;
  const breakevenRate = (1.0 / (1.0 + rrRatio)) * 100;
  const wr = overallWinRate / 100;
  const expectancy = (wr * rrRatio) - ((1.0 - wr) * 1.0);

  return {
    windowDays: s.historyDays,
    totalSignals,
    totalClosedTrades: closed.length,
    tp1Count, tp2Count, tp3Count, slCount,
    tp1Pct, tp2Pct, tp3Pct, slPct,
    winCount, lossCount,
    overallWinRate,
    rrRatio,
    breakevenRate,
    expectancy,
    netPnl,
    totalFees,
    totalFunding,
    openTrades: counted.filter((t) => t.status === 'OPEN').length,
  };
}

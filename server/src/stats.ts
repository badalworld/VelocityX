/** Rolling journal statistics. Payout/expectancy come from realised fills, not a binary-RR formula. */
import { getSettings } from './settings';
import { allSignals, allTrades, Trade, tpCountOf, tpFilledOf } from './store';

export function computeStats(): any {
  const s = getSettings();
  const cutoff = Date.now() - s.historyDays * 86400000;
  const signals = allSignals().filter((x) => x.time >= cutoff);
  const inWindow = (t: Trade) =>
    (t.status === 'OPEN' && t.openedAt >= cutoff) || (t.status === 'CLOSED' && (t.closedAt || 0) >= cutoff);
  const counted = allTrades().filter(inWindow);
  const closed = allTrades().filter((t) => t.status === 'CLOSED' && (t.closedAt || 0) >= cutoff);

  const tpCounts = [1, 2, 3, 4, 5].map((level) =>
    closed.filter((t) => level <= tpCountOf(t) && tpFilledOf(t, level)).length,
  );
  const tpPct = tpCounts.map((count) => closed.length ? (count / closed.length) * 100 : 0);
  const slCount = counted.filter((t) => t.closeReason === 'SL').length;
  const winCount = closed.filter((t) => t.realizedPnl > 0).length;
  const lossCount = closed.filter((t) => t.realizedPnl < 0).length;
  let netPnl = 0, totalFees = 0, totalFunding = 0;
  for (const t of counted) {
    if (t.status === 'CLOSED') netPnl += t.realizedPnl;
    totalFees += t.fees;
    totalFunding += t.funding ?? 0;
  }
  const totalSignals = signals.length;
  const overallWinRate = closed.length > 0 ? (winCount / closed.length) * 100 : 0;
  const rMultiples = closed.filter((t) => t.initialRisk > 0).map((t) => t.realizedPnl / t.initialRisk);
  const expectancy = rMultiples.length ? rMultiples.reduce((sum, value) => sum + value, 0) / rMultiples.length : 0;

  return {
    windowDays: s.historyDays,
    totalSignals,
    totalClosedTrades: closed.length,
    tp1Count: tpCounts[0], tp2Count: tpCounts[1], tp3Count: tpCounts[2], tp4Count: tpCounts[3], tp5Count: tpCounts[4],
    slCount,
    tp1Pct: tpPct[0], tp2Pct: tpPct[1], tp3Pct: tpPct[2], tp4Pct: tpPct[3], tp5Pct: tpPct[4],
    slPct: closed.length ? (slCount / closed.length) * 100 : 0,
    winCount,
    lossCount,
    overallWinRate,
    rrRatio: 5,
    // No single theoretical breakeven rate applies to a staged, trailing exit ladder.
    breakevenRate: 0,
    expectancy,
    netPnl,
    totalFees,
    totalFunding,
    openTrades: counted.filter((t) => t.status === 'OPEN').length,
  };
}

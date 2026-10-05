import { useMemo } from 'react';
import { Trade, Status } from './types';
import { equityCurve } from './motion/chart';
import type { PnlTradeBar } from './components/PnlChart';

/* ============================================================================
   PNL model — turns the trade log into an equity curve.
   ---------------------------------------------------------------------------
   The server stores raw trades only, so the curve is derived on the client:
     start equity = current equity − unrealised − Σ realised
   Each closed trade is a step in the curve; the open trade contributes a live
   unrealised tail. Because a bot log can be short, the sampled curve is
   smoothed (see motion/chart.equityCurve) so it always reads as a liquid line.
   ========================================================================== */

export type PnlRangeKey = '24h' | '7d' | '30d' | 'all';

export const PNL_RANGES: { key: PnlRangeKey; label: string; ms: number }[] = [
  { key: '24h', label: '24H', ms: 86_400_000 },
  { key: '7d', label: '7D', ms: 7 * 86_400_000 },
  { key: '30d', label: '30D', ms: 30 * 86_400_000 },
  { key: 'all', label: 'ALL', ms: Number.POSITIVE_INFINITY },
];

export interface PnlModel {
  rangeKey: PnlRangeKey;
  start: number;
  end: number;
  base: number;
  series: { t: number; v: number }[];
  bars: PnlTradeBar[];
  curve: number[];
  net: number;
  realized: number;
  unrealized: number;
  equity: number;
  changePct: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
  best: number;
  worst: number;
  maxDD: number;
  maxDDPct: number;
  peak: number;
  isLive: boolean;
  hasData: boolean;
}

export function buildPnl(
  trades: Trade[],
  opts: { equity: number; unrealized: number; rangeKey: PnlRangeKey; now?: number; fallbackBase?: number },
): PnlModel {
  const now = opts.now ?? Date.now();
  const range = PNL_RANGES.find((r) => r.key === opts.rangeKey) ?? PNL_RANGES[1];
  const closed = trades
    .filter((t) => t.status === 'CLOSED' && Number.isFinite(t.closedAt as number))
    .slice()
    .sort((a, b) => (a.closedAt as number) - (b.closedAt as number));

  const realizedAll = closed.reduce((s, t) => s + (Number.isFinite(t.realizedPnl) ? t.realizedPnl : 0), 0);
  const equity = Number.isFinite(opts.equity) && opts.equity > 0 ? opts.equity : (opts.fallbackBase ?? 1000) + realizedAll;
  const unrealized = Number.isFinite(opts.unrealized) ? opts.unrealized : 0;

  // equity before the very first recorded trade
  const base0 = equity - unrealized - realizedAll;

  const earliest = closed[0]?.closedAt ?? now - 3_600_000;
  const start = Number.isFinite(range.ms) ? Math.max(earliest - 3_600_000, now - range.ms) : earliest - 3_600_000;
  const end = now;

  const inWindow = closed.filter((t) => (t.closedAt as number) >= start);
  const beforeWindow = closed.filter((t) => (t.closedAt as number) < start);
  const realizedBefore = beforeWindow.reduce((s, t) => s + t.realizedPnl, 0);
  const base = base0 + realizedBefore;

  const series: { t: number; v: number }[] = [{ t: start, v: base }];
  let cum = base;
  for (const t of inWindow) {
    cum += Number.isFinite(t.realizedPnl) ? t.realizedPnl : 0;
    series.push({ t: t.closedAt as number, v: cum });
  }
  const isLive = Math.abs(unrealized) > 1e-9 || trades.some((t) => t.status === 'OPEN');
  series.push({ t: end, v: equity });

  const curve = equityCurve(series, { start, end, base, n: 124 });

  let peak = curve[0];
  let maxDD = 0;
  let maxDDPct = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    const dd = v - peak;
    if (dd < maxDD) maxDD = dd;
    const ddPct = peak !== 0 ? (dd / Math.abs(peak)) * 100 : 0;
    if (ddPct < maxDDPct) maxDDPct = ddPct;
  }

  const bars: PnlTradeBar[] = inWindow.map((t) => ({
    t: t.closedAt as number,
    pnl: Number.isFinite(t.realizedPnl) ? t.realizedPnl : 0,
    side: t.side,
  }));

  const wins = inWindow.filter((t) => t.realizedPnl > 0).length;
  const losses = inWindow.filter((t) => t.realizedPnl <= 0).length;
  const pnls = inWindow.map((t) => t.realizedPnl);
  const rs = inWindow.filter((t) => t.initialRisk > 0).map((t) => t.realizedPnl / t.initialRisk);
  const net = cum + unrealized - base;

  return {
    rangeKey: opts.rangeKey,
    start,
    end,
    base,
    series,
    bars,
    curve,
    net,
    realized: cum - base,
    unrealized,
    equity,
    changePct: base !== 0 ? (net / Math.abs(base)) * 100 : 0,
    trades: inWindow.length,
    wins,
    losses,
    winRate: inWindow.length ? (wins / inWindow.length) * 100 : 0,
    avgR: rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : 0,
    best: pnls.length ? Math.max(...pnls) : 0,
    worst: pnls.length ? Math.min(...pnls) : 0,
    maxDD,
    maxDDPct,
    peak,
    isLive,
    hasData: inWindow.length > 0,
  };
}

/** Range + live equity are the only inputs that need to recompute the model. */
export function usePnlModel(status: Status | null, trades: Trade[], rangeKey: PnlRangeKey): PnlModel {
  const equity = status?.balance?.total ?? 0;
  const unrealized = status?.openTrade?.unrealized ?? 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(
    () => buildPnl(trades, { equity, unrealized, rangeKey, fallbackBase: 1000 }),
    // trades identity changes on every refresh; length+last close is enough
    [trades, equity, unrealized, rangeKey],
  );
}

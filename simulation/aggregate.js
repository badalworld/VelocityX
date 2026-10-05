'use strict';
/**
 * Shared aggregation for the study: turns per-world/per-config rows into the
 * summary object used by report.js. Used by run.js and merge.js.
 */
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1));
}
function pct(a, p) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}
function correlation(xs, ys) {
  if (xs.length < 3) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}
function ols(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const beta = sxx > 0 ? sxy / sxx : 0;
  return { alpha: my - beta * mx, beta };
}

/**
 * @param {Array} results  rows: one per (world, config) with all engine metrics
 * @param {Array} configs  [{key,label,cfg}]
 * @param {object} meta    {generatedAt, mode, bars, yearsPerWorld, universeSize, runtimeSec, methodology, extra}
 */
function aggregate(results, configs, meta) {
  const byConfig = {};
  for (const conf of configs) {
    const rows = results.filter((r) => r.config === conf.key);
    if (!rows.length) continue;
    const rets = rows.map((r) => r.totalReturnPct);
    const mkts = rows.map((r) => r.marketReturnPct);
    const reg = ols(mkts, rets);
    byConfig[conf.key] = {
      key: conf.key,
      label: conf.label,
      cfg: conf.cfg,
      worlds: rows.length,
      meanReturnPct: mean(rets),
      medianReturnPct: median(rets),
      stdevReturnPct: stdev(rets),
      p05ReturnPct: pct(rets, 0.05),
      p95ReturnPct: pct(rets, 0.95),
      bestReturnPct: Math.max(...rets),
      worstReturnPct: Math.min(...rets),
      meanCagrPct: mean(rows.map((r) => r.cagrPct)),
      meanMaxDdPct: mean(rows.map((r) => r.maxDrawdownPct)),
      medianMaxDdPct: median(rows.map((r) => r.maxDrawdownPct)),
      meanSharpe: mean(rows.map((r) => r.sharpe)),
      medianSharpe: median(rows.map((r) => r.sharpe)),
      meanExpR: mean(rows.map((r) => r.expectancyR)),
      meanTradesPerMonth: mean(rows.map((r) => r.tradesPerMonth)),
      meanWinRate: mean(rows.map((r) => r.winRate)),
      meanTp1Rate: mean(rows.map((r) => r.tp1Rate)),
      meanTp3Rate: mean(rows.map((r) => r.tp3Rate)),
      meanExposurePct: mean(rows.map((r) => r.exposurePct)),
      meanHoldHours: mean(rows.map((r) => r.avgHoldHours)),
      meanFees: mean(rows.map((r) => r.feesPaid)),
      meanFeesPctOfStart: mean(rows.map((r) => (r.feesPaid / r.startEquity) * 100)),
      meanGrossPnl: mean(rows.map((r) => r.grossPnl)),
      totalLiquidations: rows.reduce((a, r) => a + r.liquidations, 0),
      totalBeStops: rows.reduce((a, r) => a + r.beStops, 0),
      profitableWorlds: rows.filter((r) => r.totalReturnPct > 0).length,
      ruinedWorlds: rows.filter((r) => r.ruined).length,
      capitalPreservedWorlds: rows.filter((r) => r.capitalPreserved).length,
      correlationWithMarket: correlation(mkts, rets),
      alphaVsMarket: reg.alpha,
      betaVsMarket: reg.beta,
      meanMaxConsecLosses: mean(rows.map((r) => r.maxConsecLosses)),
      meanSignalsPerMonth: mean(rows.map((r) => r.signals / (r.years * 12))),
      meanSignalsSkippedSlots: mean(rows.map((r) => r.signalsSkippedSlots)),
      meanSignalsSkippedGate: mean(rows.map((r) => r.signalsSkippedGate)),
    };
  }
  return {
    ...meta,
    worlds: meta.worlds,
    configs: byConfig,
  };
}

module.exports = { aggregate, mean, median, stdev, pct, correlation, ols };

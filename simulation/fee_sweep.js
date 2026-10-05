'use strict';
/**
 * VelocityX — fee-tier experiment (the study's most decision-relevant lever).
 *
 * The P&L of the shipped configuration is dominated by the taker fee, so we run
 * the identical default strategy on 8 worlds at six fee tiers, holding the
 * signals, sizing and exits fixed:
 *
 *   0.010 %/side  (market-maker rebate tier / institutional)
 *   0.020 %/side  (Binance VIP0 maker)
 *   0.030 %/side
 *   0.050 %/side  (Binance VIP0 taker — the repo default)
 *   0.070 %/side  (taker + BNB-less/regional uplift)
 *   0.100 %/side  (stress)
 *
 *   node simulation/fee_sweep.js
 */
const fs = require('fs');
const path = require('path');
const { generateWorld, mulberry32 } = require('./markets');
const { runBacktest } = require('./engine');

const outDir = path.resolve(__dirname, 'results');
const worlds = JSON.parse(fs.readFileSync(path.join(outDir, 'worlds.json'), 'utf8'));
const SAMPLE = [0, 2, 5, 7, 9, 11, 14, 17].filter((i) => worlds[i]);
const FEES = [0.0001, 0.0002, 0.0003, 0.0005, 0.0007, 0.001];

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const out = { sampleWorlds: SAMPLE, fees: FEES, rows: [], summary: {} };
for (const i of SAMPLE) {
  const w = worlds[i];
  const world = generateWorld({ seed: w.seed, bars: w.bars, worldType: w.worldType, worldVol: w.worldVol });
  const row = { world: i, worldType: w.worldType, worldVol: w.worldVol, results: {} };
  for (const fee of FEES) {
    const r = runBacktest(world, { feeRate: fee }, { rnd: mulberry32(w.seed ^ 0xabcdef) });
    row.results[fee] = {
      totalReturnPct: +r.totalReturnPct.toFixed(2),
      maxDrawdownPct: +r.maxDrawdownPct.toFixed(2),
      expectancyR: +r.expectancyR.toFixed(4),
      grossPnl: +r.grossPnl.toFixed(1),
      feesPaid: +r.feesPaid.toFixed(1),
      trades: r.trades,
    };
  }
  out.rows.push(row);
  console.log(`world ${i} (${w.worldType}): ` + FEES.map((f) => `${(f * 100).toFixed(2)}%→${row.results[f].totalReturnPct.toFixed(0)}%`).join('  '));
}

for (const fee of FEES) {
  const rs = out.rows.map((r) => r.results[fee]);
  out.summary[fee] = {
    feePctPerSide: fee * 100,
    meanReturnPct: mean(rs.map((x) => x.totalReturnPct)),
    medianReturnPct: median(rs.map((x) => x.totalReturnPct)),
    meanMaxDdPct: mean(rs.map((x) => x.maxDrawdownPct)),
    meanExpR: mean(rs.map((x) => x.expectancyR)),
    meanFeesPaid: mean(rs.map((x) => x.feesPaid)),
    meanGross: mean(rs.map((x) => x.grossPnl)),
    profitable: rs.filter((x) => x.totalReturnPct > 0).length,
    worlds: rs.length,
  };
}

fs.writeFileSync(path.join(outDir, 'fee-sweep.json'), JSON.stringify(out, null, 2));
console.log('\nfee/side   mean return   median   mean expR   mean fees   profitable');
for (const fee of FEES) {
  const s = out.summary[fee];
  console.log(`${(s.feePctPerSide).toFixed(3)}%    ${s.meanReturnPct >= 0 ? '+' : ''}${s.meanReturnPct.toFixed(1)}%       ${s.medianReturnPct >= 0 ? '+' : ''}${s.medianReturnPct.toFixed(1)}%    ${s.meanExpR.toFixed(3)}      ${s.meanFeesPaid.toFixed(0)}      ${s.profitable}/${s.worlds}`);
}
console.log('wrote', path.join(outDir, 'fee-sweep.json'));

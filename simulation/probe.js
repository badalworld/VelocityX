'use strict';
/**
 * VelocityX — "what should I actually run?" probe.
 *
 * The 20-world study tests one knob at a time. This probe combines the levers
 * that measured best (higher timeframe, maker fee, no reversal, fewer slots,
 * smaller margin) on 8 worlds (every world type, both vol regimes) to answer the
 * practical question: does any sane configuration of this bot have a positive
 * *median* one-year outcome?
 *
 *   node simulation/probe.js
 */
const fs = require('fs');
const path = require('path');
const { generateWorld, mulberry32 } = require('./markets');
const { runBacktest } = require('./engine');

const outDir = path.resolve(__dirname, 'results');
const worlds = JSON.parse(fs.readFileSync(path.join(outDir, 'worlds.json'), 'utf8'));
const SAMPLE = ([0, 3, 6, 9, 12, 17].filter((i) => worlds[i]));

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].split(',') : null;
})();

const PROBES = [
  { key: 'A_tf15_maker', label: '15m + maker fee', cfg: { signalTimeframe: '15m', feeRate: 0.0002 } },
  { key: 'B_tf15_maker_norev', label: '15m + maker + no reverse', cfg: { signalTimeframe: '15m', feeRate: 0.0002, noReverse: true } },
  { key: 'C_tf60_maker_defensive', label: '1h + maker + no reverse + 3 slots + 2 % margin', cfg: { signalTimeframe: '1h', feeRate: 0.0002, noReverse: true, maxPositions: 3, tradeSizePercent: 2 } },
  { key: 'D_default', label: 'shipped default (reference)', cfg: {} },
];

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const PROBES_TO_RUN = only ? PROBES.filter((p) => only.includes(p.key)) : PROBES;
const out = { sampleWorlds: SAMPLE, probes: [] };
for (const p of PROBES_TO_RUN) {
  const rows = [];
  for (const i of SAMPLE) {
    const w = worlds[i];
    const world = generateWorld({ seed: w.seed, bars: w.bars, worldType: w.worldType, worldVol: w.worldVol });
    const r = runBacktest(world, p.cfg, { rnd: mulberry32(w.seed ^ 0xabcdef) });
    rows.push({
      world: i, worldType: w.worldType,
      totalReturnPct: r.totalReturnPct, maxDrawdownPct: r.maxDrawdownPct,
      expectancyR: r.expectancyR, trades: r.trades, tradesPerMonth: r.tradesPerMonth,
      feesPaid: r.feesPaid, ruined: r.ruined, liquidations: r.liquidations,
    });
  }
  const rets = rows.map((x) => x.totalReturnPct);
  const entry = {
    key: p.key,
    label: p.label,
    cfg: p.cfg,
    worlds: rows.length,
    meanReturnPct: mean(rets),
    medianReturnPct: median(rets),
    bestReturnPct: Math.max(...rets),
    worstReturnPct: Math.min(...rets),
    meanMaxDdPct: mean(rows.map((x) => x.maxDrawdownPct)),
    meanExpR: mean(rows.map((x) => x.expectancyR)),
    meanTradesPerMonth: mean(rows.map((x) => x.tradesPerMonth)),
    meanFeesPctOfStart: mean(rows.map((x) => (x.feesPaid / 1000) * 100)),
    profitable: rows.filter((x) => x.totalReturnPct > 0).length,
    ruined: rows.filter((x) => x.ruined).length,
    rows,
  };
  out.probes.push(entry);
  console.log(`${p.key.padEnd(24)} mean ${entry.meanReturnPct.toFixed(0)}%  median ${entry.medianReturnPct.toFixed(0)}%  expR ${entry.meanExpR.toFixed(3)}  ${entry.profitable}/${entry.worlds} profitable, ${entry.ruined} ruined`);
}

const file = only && only.length === 1 ? `probe-${only[0]}.json` : 'probe.json';
fs.writeFileSync(path.join(outDir, file), JSON.stringify(out, null, 2));
console.log('wrote', path.join(outDir, file));

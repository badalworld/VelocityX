'use strict';
/**
 * VelocityX — equity-curve pass.
 *
 * Regenerates the SAME 20 worlds used by run.js (seed/type/vol taken from
 * results/worlds.json) and records the daily equity path for the headline
 * configurations plus an equal-weight buy-and-hold benchmark. Used by
 * report.js to draw the fan chart.
 *
 *   node simulation/curves.js [--configs default,tf15,tf60]
 */
const fs = require('fs');
const path = require('path');
const { generateWorld, mulberry32 } = require('./markets');
const { runBacktest } = require('./engine');

const outDir = path.resolve(__dirname, 'results');
const worlds = JSON.parse(fs.readFileSync(path.join(outDir, 'worlds.json'), 'utf8'));
const bars = worlds[0].bars;

const CONFIGS = {
  default: {},
  tf15: { signalTimeframe: '15m' },
  tf60: { signalTimeframe: '1h' },
};

const out = { bars, worlds: [] };
for (const w of worlds) {
  const world = generateWorld({ seed: w.seed, bars, worldType: w.worldType, worldVol: w.worldVol });
  const entry = { index: w.index, worldType: w.worldType, worldVol: w.worldVol, curves: {} };

  // benchmark: equal-weight buy & hold of every non-pegged symbol, 5m marks
  const syms = world.symbols.filter((s) => s.klass !== 'pegged');
  const n = world.bars;
  const bench = new Float64Array(n);
  for (const s of syms) {
    const base = s.close[0];
    for (let b = 0; b < n; b++) bench[b] += s.close[b] / base;
  }
  const benchDaily = [];
  for (let b = 0; b < n; b++) if ((b + 1) % 288 === 0) benchDaily.push((bench[b] / syms.length - 1) * 100);
  entry.benchmarkDailyPct = benchDaily.map((v) => +v.toFixed(3));

  for (const [key, cfg] of Object.entries(CONFIGS)) {
    const r = runBacktest(world, cfg, { rnd: mulberry32(w.seed ^ 0xabcdef) });
    entry.curves[key] = {
      dailyPct: Array.from(r.dailyEquity, (v) => +(((v / r.startEquity) - 1) * 100).toFixed(3)),
      finalPct: +r.totalReturnPct.toFixed(2),
      maxDdPct: +r.maxDrawdownPct.toFixed(2),
      trades: r.trades,
    };
  }
  out.worlds.push(entry);
  console.log(`curves world ${w.index + 1}/${worlds.length} ${w.worldType} — default ${entry.curves.default.finalPct}% tf15 ${entry.curves.tf15.finalPct}%`);
}

fs.writeFileSync(path.join(outDir, 'curves.json'), JSON.stringify(out));
console.log('wrote', path.join(outDir, 'curves.json'));

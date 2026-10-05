'use strict';
/**
 * Merge shard checkpoints (results/partial-*.jsonl) into the canonical study
 * artifacts: worlds.json, simulations.json, summary.json, trades-default.json.
 * Safe to run repeatedly; a single full run of run.js needs no merge.
 *
 *   node simulation/merge.js
 */
const fs = require('fs');
const path = require('path');
const { aggregate } = require('./aggregate');
const { CONFIGS, METHODOLOGY, buildWorldPlan } = require('./plan');

const outDir = path.resolve(__dirname, 'results');
const partials = fs.readdirSync(outDir).filter((f) => /^partial-.*\.jsonl$/.test(f)).sort();
if (!partials.length) {
  console.error('no results/partial-*.jsonl checkpoints found');
  process.exit(1);
}

const results = [];
const worldMeta = [];
const tradesDefault = [];
for (const file of partials) {
  let n = 0;
  for (const line of fs.readFileSync(path.join(outDir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    worldMeta.push(o.worldMeta);
    for (const r of o.rows) results.push(r);
    if (o.defaultTrades) tradesDefault.push(o.defaultTrades);
    n++;
  }
  console.log(`${file}: ${n} worlds`);
}
worldMeta.sort((a, b) => a.index - b.index);
tradesDefault.sort((a, b) => a.world - b.world);

const bars = worldMeta[0] ? worldMeta[0].bars : 105120;
const plan = buildWorldPlan(20);
const summary = aggregate(results, CONFIGS, {
  generatedAt: new Date().toISOString(),
  mode: 'synthetic-monte-carlo',
  dataDir: null,
  bars,
  worlds: worldMeta.length,
  yearsPerWorld: bars / (288 * 365),
  universeSize: 40,
  runtimeSec: null,
  worldMeta,
  methodology: METHODOLOGY,
  plannedWorlds: plan.length,
  shards: partials,
});

fs.writeFileSync(path.join(outDir, 'worlds.json'), JSON.stringify(worldMeta, null, 2));
fs.writeFileSync(path.join(outDir, 'simulations.json'), JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(outDir, 'trades-default.json'), JSON.stringify(tradesDefault));

const by = summary.configs;
console.log(`\nmerged ${worldMeta.length} worlds · ${results.length} config-runs`);
console.log('config'.padEnd(13), 'mean%'.padStart(8), 'median%'.padStart(8), 'maxDD%'.padStart(7), 'expR'.padStart(7), 'trades/mo'.padStart(9), 'fees%'.padStart(6), 'profitable');
for (const k of Object.keys(by)) {
  const c = by[k];
  console.log(k.padEnd(13), (c.meanReturnPct >= 0 ? '+' : '') + c.meanReturnPct.toFixed(1), (c.medianReturnPct >= 0 ? '+' : '') + c.medianReturnPct.toFixed(1), c.meanMaxDdPct.toFixed(1), c.meanExpR.toFixed(3), c.meanTradesPerMonth.toFixed(0), c.meanFeesPctOfStart.toFixed(0), `${c.profitableWorlds}/${c.worlds} (ruin ${c.ruinedWorlds})`);
}

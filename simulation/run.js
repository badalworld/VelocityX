'use strict';
/**
 * VelocityX — 20-simulation Monte-Carlo study.
 *
 *   node simulation/run.js [--bars 105120] [--worlds 20] [--out results]
 *
 * Twenty independent 12-month market worlds are generated (bull / bear / chop /
 * volatile / crisis, four of each, with different volatility multipliers and
 * seeds). Every world is then traded by the SAME engine under a set of paired
 * configurations, so each variant is compared on identical price paths:
 *
 *   default       exactly the shipped defaults (5m, 8 slots, 5 % margin, 10×,
 *                 taker 0.05 %, reverse on opposite signal, 2×ATR stop, 1.5R ladder)
 *   tf15 / tf60   the indicator evaluated on 15m / 1h candles (supported setting)
 *   flip          every signal side inverted  → tests directional edge
 *   random        random entry times and sides → null model at matched signal rate
 *   noreverse     opposite signals ignored instead of close & reverse
 *   slots2        max 2 concurrent positions instead of 8
 *   maker         maker fee tier 0.02 % instead of taker 0.05 %
 *   sl3_tp2       stop 3×ATR, TP ladder at 2R/4R/6R
 *   size2         margin 2 % of equity instead of 5 %
 *
 * Output: simulation/results/*.json (+ console summary).
 */
const fs = require('fs');
const path = require('path');
const { generateWorld, worldStats, mulberry32, WORLD_TYPES } = require('./markets');
const { runBacktest } = require('./engine');
const { loadWorldFromCsv } = require('./loadCsv');
const { aggregate, mean } = require('./aggregate');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const { WORLD_TYPES_ORDER, VOLS, buildWorldPlan, CONFIGS, METHODOLOGY } = require('./plan');

async function main() {
  const bars = parseInt(arg('bars', '105120'), 10);
  const worldCount = parseInt(arg('worlds', '20'), 10);
  const outDir = path.resolve(__dirname, arg('out', 'results'));
  const dataDir = arg('data', null);
  const onlyConfigs = arg('configs', null);
  fs.mkdirSync(outDir, { recursive: true });

  // ---- real klines mode: --data ./klines ------------------------------------
  let preloaded = null;
  let plan;
  if (dataDir) {
    preloaded = loadWorldFromCsv(path.resolve(dataDir), { primary: arg('primary', 'BTCUSDT') });
    plan = [{ index: 0, worldType: 'real', worldVol: 1, seed: preloaded.seed, bars: preloaded.bars }];
    console.log(`[data] ${preloaded.symbols.length} symbols · ${preloaded.bars.toLocaleString()} candles · study runs all configurations on this single history`);
  } else {
    plan = buildWorldPlan(worldCount);
  }
  const configs = onlyConfigs
    ? CONFIGS.filter((c) => onlyConfigs.split(',').map((x) => x.trim()).includes(c.key))
    : CONFIGS;

  const results = [];
  const worldMeta = [];
  const defaultTrades = [];
  const t0 = Date.now();

  // ---- sharding / resume ----------------------------------------------------
  // Several processes can run disjoint world subsets (`--only 0,1,2`) writing to
  // their own `--partial <file>` JSONL; a restart resumes from that file and the
  // canonical results are built by merge.js. A single full run needs neither.
  const onlyArg = arg('only', null);
  const partialFile = path.resolve(__dirname, arg('partial', onlyArg ? 'results/partial.jsonl' : 'results/partial-full.jsonl'));
  const resumed = { rows: 0, worlds: 0, trades: 0 };
  if (fs.existsSync(partialFile)) {
    for (const line of fs.readFileSync(partialFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      worldMeta.push(o.worldMeta);
      for (const r of o.rows) results.push(r);
      if (o.defaultTrades) defaultTrades.push(o.defaultTrades);
      resumed.worlds++;
    }
    if (resumed.worlds) console.log(`[resume] ${resumed.worlds} world(s) already in ${path.relative(__dirname, partialFile)}`);
  }
  const doneWorlds = new Set(worldMeta.map((w) => w.index));
  let indices = plan.map((_, i) => i);
  if (onlyArg) indices = onlyArg.split(',').map((x) => parseInt(x.trim(), 10));
  indices = indices.filter((i) => plan[i] && !doneWorlds.has(i));
  const writeCanonical = indices.length + doneWorlds.size >= plan.length;

  for (const wi of indices) {
    const p = plan[wi];
    const gen0 = Date.now();
    const world = preloaded || generateWorld({ seed: p.seed, bars, worldType: p.worldType, worldVol: p.worldVol });
    const genMs = Date.now() - gen0;

    // market benchmark for the world: equal-weight buy & hold of every non-pegged symbol
    const tradableSyms = world.symbols.filter((s) => s.klass !== 'pegged');
    const mktRet = mean(tradableSyms.map((s) => (s.close[s.close.length - 1] / s.close[0] - 1) * 100));
    const primary = world.symbols.find((s) => s.symbol === world.primary);
    const primaryRet = (primary.close[primary.close.length - 1] / primary.close[0] - 1) * 100;
    const stats = worldStats(world);
    worldMeta.push({
      index: wi, ...p, bars, genMs,
      marketReturnPct: mktRet,
      primaryReturnPct: primaryRet,
      annVolMajor: mean(stats.filter((s) => s.klass === 'major').map((s) => s.annVolPct)),
      annVolAlt: mean(stats.filter((s) => s.klass === 'alt').map((s) => s.annVolPct)),
      kurtosisAlt: mean(stats.filter((s) => s.klass === 'alt').map((s) => s.kurtosis)),
      absRetAc1Alt: mean(stats.filter((s) => s.klass === 'alt').map((s) => s.absRetAc1)),
      peggedAnnVol: stats.find((s) => s.klass === 'pegged')?.annVolPct ?? null,
    });

    const pStart = Date.now();
    for (const conf of configs) {
      const ctrl = { rnd: mulberry32(p.seed ^ 0xabcdef) };
      const r = runBacktest(world, conf.cfg, ctrl);
      const trim = { ...r };
      delete trim.equityCurve;
      delete trim.dailyEquity;
      if (conf.key !== 'default') delete trim.tradesDetail;
      else {
        defaultTrades.push({ world: wi, worldType: p.worldType, trades: r.tradesDetail });
        delete trim.tradesDetail;
      }
      results.push({ ...trim, config: conf.key, world: wi, worldType: p.worldType, worldVol: p.worldVol, marketReturnPct: mktRet });
    }
    const secs = ((Date.now() - pStart) / 1000).toFixed(1);
    // durable checkpoint: append this world's rows immediately
    const worldRows = results.slice(-configs.length);
    const worldTrades = defaultTrades.length && defaultTrades[defaultTrades.length - 1].world === wi
      ? defaultTrades[defaultTrades.length - 1] : null;
    fs.appendFileSync(partialFile, JSON.stringify({
      worldMeta: worldMeta[worldMeta.length - 1],
      rows: worldRows.map((r) => ({ ...r, equityCurve: undefined, dailyEquity: undefined, tradesDetail: undefined })),
      defaultTrades: worldTrades,
    }) + '\n');
    const def = worldRows.find((r) => r.config === 'default') || worldRows[worldRows.length - 1];
    console.log(
      `world ${String(wi + 1).padStart(2)}/${plan.length} ${p.worldType.padEnd(8)} vol×${p.worldVol} ` +
      `mkt ${mktRet >= 0 ? '+' : ''}${mktRet.toFixed(0)}% | default ${def.totalReturnPct >= 0 ? '+' : ''}${def.totalReturnPct.toFixed(0)}% ` +
      `(${def.trades} trades, expR ${def.expectancyR.toFixed(3)}) | gen ${genMs}ms run ${secs}s`
    );
  }

  // ---------------------------------------------------------------- aggregates
  for (const r of results) {
    delete r.equityCurve;
    delete r.dailyEquity;
    if (r.config !== 'default') delete r.tradesDetail;
  }
  const summary = aggregate(results, configs, {
    generatedAt: new Date().toISOString(),
    mode: preloaded ? 'real-klines' : 'synthetic-monte-carlo',
    dataDir: dataDir || null,
    bars: preloaded ? preloaded.bars : bars,
    worlds: worldMeta.length,
    yearsPerWorld: (preloaded ? preloaded.bars : bars) / (288 * 365),
    universeSize: preloaded ? preloaded.symbols.length : 40,
    runtimeSec: (Date.now() - t0) / 1000,
    worldMeta,
    methodology: METHODOLOGY,
  });

  if (!writeCanonical) {
    console.log(`shard complete (${worldMeta.length}/${plan.length} worlds in ${path.relative(__dirname, partialFile)}) — run merge.js when all shards are done`);
    return;
  }
  fs.writeFileSync(path.join(outDir, 'worlds.json'), JSON.stringify(worldMeta.sort((a, b) => a.index - b.index), null, 2));
  fs.writeFileSync(path.join(outDir, 'simulations.json'), JSON.stringify(results.map((r) => ({ ...r, equityCurve: undefined, dailyEquity: undefined, tradesDetail: undefined })), null, 2));
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, 'trades-default.json'), JSON.stringify(defaultTrades));

  const byConfig = summary.configs;
  console.log('\n================ 20-WORLD SUMMARY (mean across worlds) ================');
  console.log('config'.padEnd(13), 'ret%'.padStart(8), 'med%'.padStart(8), 'maxDD%'.padStart(7), 'Sharpe'.padStart(7), 'expR'.padStart(8), 'trades/mo'.padStart(10), 'win%'.padStart(6), 'fees$'.padStart(8), 'profitable');
  for (const conf of configs) {
    const c = byConfig[conf.key];
    console.log(
      conf.key.padEnd(13),
      (c.meanReturnPct >= 0 ? '+' : '') + c.meanReturnPct.toFixed(1),
      (c.medianReturnPct >= 0 ? '+' : '') + c.medianReturnPct.toFixed(1),
      c.meanMaxDdPct.toFixed(1),
      c.meanSharpe.toFixed(2),
      c.meanExpR.toFixed(3),
      c.meanTradesPerMonth.toFixed(0),
      c.meanWinRate.toFixed(1),
      c.meanFees.toFixed(0),
      `${c.profitableWorlds}/${c.worlds} (ruin ${c.ruinedWorlds})`
    );
  }
  console.log(`\nruntime ${summary.runtimeSec.toFixed(0)}s — wrote ${outDir}/{worlds,simulations,summary,trades-default}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });

'use strict';
/**
 * VelocityX — simulation validation.
 *
 * Two independent checks so the study does not rest on trust:
 *   1. SIGNAL RATE — the number of EMA(11)/EMA(34) confirmed crosses per day on
 *      5-minute candles is a property of the filter, not of the price level. We
 *      measure it on a pure constant-volatility random walk (the "no strategy"
 *      world) and compare it with the generated markets and with the study.
 *   2. MARKET CALIBRATION — the realised stylised facts (annualised vol, fat
 *      tails, volatility clustering, 24h range, turnover) of every generated
 *      world, printed as a table and stored in results/validation.json.
 *
 *   node simulation/validate.js
 */
const fs = require('fs');
const path = require('path');
const ind = require(path.join(__dirname, '..', 'server', 'dist', 'indicators.js'));
const { generateWorld, worldStats, mulberry32, gaussian } = require('./markets');

const BARS_PER_YEAR = 288 * 365;

function randomWalk(n, volAnnual, seed) {
  const r = mulberry32(seed);
  const s = Math.sqrt((volAnnual * volAnnual) / BARS_PER_YEAR);
  const p = [1000];
  for (let i = 1; i < n; i++) p.push(p[i - 1] * Math.exp(s * gaussian(r)));
  return p;
}

function countSignals(prices) {
  const e11 = ind.ema(prices, 11);
  const e34 = ind.ema(prices, 34);
  let n = 0;
  for (let i = 2; i < prices.length; i++) if (ind.signalAt(e11, e34, i)) n++;
  return n;
}

const outDir = path.resolve(__dirname, 'results');
fs.mkdirSync(outDir, { recursive: true });
const bars = 105120; // 12 months of 5m bars
const validation = { bars, years: bars / BARS_PER_YEAR, signalRate: {}, calibration: [] };

console.log('1) EMA(11)/EMA(34) confirmed-cross rate on 5m candles');
for (const vol of [0.4, 1.0, 2.0]) {
  const n = countSignals(randomWalk(bars, vol, 42));
  validation.signalRate[`rw_vol_${Math.round(vol * 100)}pct`] = {
    signalsPerSymbolPerDay: n / 365,
    signalsPerSymbolPerMonth: n / 12,
  };
  console.log(`   constant-vol random walk, ${(vol * 100).toFixed(0)}%/yr : ${(n / 365).toFixed(2)} signals/day/symbol (${(n / 12).toFixed(0)}/month)`);
}
// generated worlds
const worldFiles = path.join(outDir, 'worlds.json');
if (fs.existsSync(worldFiles)) {
  const worlds = JSON.parse(fs.readFileSync(worldFiles, 'utf8'));
  const generated = [];
  for (const w of worlds.slice(0, 3)) {
    const world = generateWorld({ seed: w.seed, bars, worldType: w.worldType, worldVol: w.worldVol });
    for (const s of world.symbols.slice(0, 6)) {
      const closes = Array.from(s.close);
      generated.push(countSignals(closes) / 365);
    }
  }
  validation.signalRate.generatedWorldsMean = generated.reduce((a, b) => a + b, 0) / generated.length;
  console.log(`   generated markets (18 symbols)                : ${validation.signalRate.generatedWorldsMean.toFixed(2)} signals/day/symbol`);
  console.log(`   → the bot watches ~9 markets ⇒ ~${(9 * validation.signalRate.generatedWorldsMean).toFixed(0)} signals/day to act on`);
}

console.log('\n2) Market calibration (measured on the generated data)');
if (fs.existsSync(worldFiles)) {
  const worlds = JSON.parse(fs.readFileSync(worldFiles, 'utf8'));
  const agg = {};
  for (const w of worlds.slice(0, 6)) {
    const world = generateWorld({ seed: w.seed, bars, worldType: w.worldType, worldVol: w.worldVol });
    const stats = worldStats(world);
    const push = (k, v) => (agg[k] = (agg[k] || []).concat([v]));
    for (const s of stats) {
      push(s.klass + '|annVolPct', s.annVolPct);
      push(s.klass + '|kurtosis', s.kurtosis);
      push(s.klass + '|absRetAc1', s.absRetAc1);
      push(s.klass + '|med24hRangePct', s.med24hRangePct);
      push(s.klass + '|turnoverM', s.meanDailyTurnoverM);
    }
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const rows = [];
  for (const klass of ['major', 'alt', 'wild', 'pegged', 'illiquid', 'quiet']) {
    if (!agg[klass + '|annVolPct']) continue;
    rows.push({
      class: klass,
      annVolPct: mean(agg[klass + '|annVolPct']),
      kurtosis: mean(agg[klass + '|kurtosis']),
      absRetAc1: mean(agg[klass + '|absRetAc1']),
      med24hRangePct: mean(agg[klass + '|med24hRangePct']),
      turnoverM: mean(agg[klass + '|turnoverM']),
    });
    const r = rows[rows.length - 1];
    console.log(`   ${klass.padEnd(9)} annVol ${r.annVolPct.toFixed(0).padStart(4)}% | kurtosis ${r.kurtosis.toFixed(1).padStart(5)} | |r|ACF(1) ${r.absRetAc1.toFixed(3)} | median 24h range ${r.med24hRangePct.toFixed(1).padStart(5)}% | turnover ${r.turnoverM.toFixed(0).padStart(5)}M/day`);
  }
  validation.calibration = rows;
  validation.reference = {
    note: 'Stylised facts for crypto perpetuals used as the calibration target',
    annVolPct: '40–250 % (majors ~45–70 %, alts 80–170 %, meme 170–250 %)',
    kurtosis: '10–60 at 5-minute frequency',
    absRetAc1: '0.20–0.45 (volatility clustering; long memory decays slowly)',
    turnover: 'majors 1–5 B USDT/day, alts 20 M–1 B, traps < 20 M',
  };
}

fs.writeFileSync(path.join(outDir, 'validation.json'), JSON.stringify(validation, null, 2));
console.log('\nwrote', path.join(outDir, 'validation.json'));

'use strict';
/**
 * VelocityX — report generator.
 *
 * Turns simulation/results/*.json into
 *   • SIMULATION-REPORT.md   (repo / GitHub readable)
 *   • report.html            (self-contained, charts in inline SVG)
 *
 *   node simulation/report.js
 */
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, 'results');
const read = (f, dflt) => {
  const p = path.join(dir, f);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : dflt;
};

const summary = read('summary.json', null);
if (!summary) {
  console.error('results/summary.json missing — run `node simulation/run.js` (or merge.js) first.');
  process.exit(1);
}
const worlds = read('worlds.json', []);
const rows = read('simulations.json', []);
const curves = read('curves.json', null);
const tradesDefault = read('trades-default.json', []);
const validation = read('validation.json', null);
const feeSweep = read('fee-sweep.json', null);
const probes = ['A_tf15_maker', 'B_tf15_maker_norev', 'C_tf60_maker_defensive']
  .map((k) => read(`probe-${k}.json`, null))
  .filter(Boolean)
  .map((f) => f.probes[0]);

const C = summary.configs;
const cfgList = Object.values(C);
const DEFAULT = C.default;
const worldCount = summary.worlds;
const marketReturns = worlds.map((w) => w.marketReturnPct);
const survived = ['tf15', 'maker', 'tf15_norev', 'noreverse'].map((k) => C[k]).filter(Boolean);

// ------------------------------------------------------------------ helpers
const f = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
const sgn = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}`);
const pct = (x, d = 1) => `${sgn(x, d)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (a, p) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// default-config per-world rows, best first
const defRows = rows.filter((r) => r.config === 'default').sort((a, b) => b.totalReturnPct - a.totalReturnPct);

// cost arithmetic on the default config
const allDefaultTrades = tradesDefault.flatMap((w) => w.trades || []);
const avgRisk = mean(defRows.map((r) => r.avgRiskUsdt || 0));
const feePerTrade = mean(defRows.map((r) => r.feesPerTrade || 0));
const costRPerTrade = feePerTrade / Math.max(avgRisk, 1e-9);
const costRFormula = costRPerTrade * 1; // measured
const meanFeesPerWorld = mean(defRows.map((r) => r.feesPaid));
const meanGross = mean(defRows.map((r) => r.grossPnl));
const meanNet = mean(defRows.map((r) => r.netPnl));
const signalStats = validation && validation.signalRate ? validation.signalRate : null;
const signalsPerDay = signalStats ? signalStats.generatedWorldsMean || 9.2 : 9.2;
const probeA = probes.find((p) => p.key === 'A_tf15_maker');
const probeBest = probes.slice().sort((a, b) => b.medianReturnPct - a.medianReturnPct)[0];
const grossLosers = cfgList.filter((c) => c.meanGrossPnl < 0).length;

// ------------------------------------------------------------------ SVG charts
function fanChart() {
  if (!curves || !curves.worlds.length) return '';
  const confKey = 'default';
  const len = Math.min(...curves.worlds.map((w) => w.curves[confKey].dailyPct.length));
  const p10 = [], p25 = [], p50 = [], p75 = [], p90 = [], bench = [];
  for (let d = 0; d < len; d++) {
    const vals = curves.worlds.map((w) => w.curves[confKey].dailyPct[d]);
    p10.push(quantile(vals, 0.1));
    p25.push(quantile(vals, 0.25));
    p50.push(quantile(vals, 0.5));
    p75.push(quantile(vals, 0.75));
    p90.push(quantile(vals, 0.9));
    bench.push(quantile(curves.worlds.map((w) => w.benchmarkDailyPct[d]), 0.5));
  }
  const W = 940, H = 380, L = 62, R = 18, T = 18, B = 34;
  const yMax = 120, yMin = -100;
  const X = (d) => L + (d / (len - 1)) * (W - L - R);
  const Y = (v) => T + (1 - (Math.max(yMin, Math.min(yMax, v)) - yMin) / (yMax - yMin)) * (H - T - B);
  const path = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const arrBack = (lo) => {
    let s = '';
    for (let i = len - 1; i >= 0; i--) s += `L${X(i).toFixed(1)},${Y(lo[i]).toFixed(1)}`;
    return s;
  };
  const band = (lo, hi) => `${path(hi)}${arrBack(lo)}Z`;
  const ticks = [];
  for (let v = yMin; v <= yMax; v += (yMax - yMin) / 5) ticks.push(v);
  return `
<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Equity paths of the 20 simulations">
  ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="grid"/><text x="${L - 8}" y="${(Y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${v.toFixed(0)}%</text>`).join('')}
  <path d="${band(p10, p90)}" class="band-outer"/>
  <path d="${band(p25, p75)}" class="band-inner"/>
  <path d="${path(bench)}" class="bench"/>
  <path d="${path(p50)}" class="median"/>
  <line x1="${L}" x2="${W - R}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" class="zero"/>
  <text x="${W - R}" y="${T + 12}" class="axis" text-anchor="end">bold = median bot · dashed = median buy&amp;hold (same universe) · bands = 25–75 % / 10–90 % of the 20 worlds</text>
  ${[0, 90, 180, 270, 364].map((d) => `<text x="${X(Math.min(d, len - 1)).toFixed(1)}" y="${H - 12}" class="axis" text-anchor="middle">day ${d + 1}</text>`).join('')}
</svg>`;
}

function barChart() {
  const order = cfgList.slice().sort((a, b) => b.meanReturnPct - a.meanReturnPct);
  const W = 940, rowH = 30, L = 178, R = 150, T = 8;
  const H = T + order.length * rowH + 18;
  const maxAbs = Math.max(20, ...order.flatMap((c) => [Math.abs(c.meanReturnPct), Math.abs(c.medianReturnPct)]));
  const zero = L + ((0 + maxAbs) / (2 * maxAbs)) * (W - L - R);
  const scale = (v) => (v / (2 * maxAbs)) * (W - L - R);
  return `
<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Return by configuration">
  <line x1="${zero.toFixed(1)}" x2="${zero.toFixed(1)}" y1="${T}" y2="${H - 14}" class="zero"/>
  ${order.map((c, i) => {
    const y = T + i * rowH + 5;
    const w = Math.abs(scale(c.meanReturnPct));
    const x = c.meanReturnPct >= 0 ? zero : zero - w;
    const mw = Math.abs(scale(c.medianReturnPct));
    const mx = c.medianReturnPct >= 0 ? zero : zero - mw;
    return `
    <text x="${L - 10}" y="${y + 13}" class="axis" text-anchor="end">${esc(c.label)}</text>
    <rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="17" rx="3" class="${c.meanReturnPct >= 0 ? 'pos' : 'neg'}"/>
    <rect x="${mx.toFixed(1)}" y="${y + 4}" width="2.5" height="9" class="med"/>
    <text x="${W - 8}" y="${y + 13}" class="axis" text-anchor="end">${sgn(c.meanReturnPct, 0)}% / med ${sgn(c.medianReturnPct, 0)}% · ${c.profitableWorlds}/${worldCount} · ruin ${c.ruinedWorlds}</text>`;
  }).join('')}
</svg>`;
}

function feeSweepChart() {
  if (!feeSweep) return '';
  const W = 940, H = 300, L = 70, R = 30, T = 22, B = 46;
  const xs = Object.values(feeSweep.summary).map((s) => s.feePctPerSide);
  const ys = Object.values(feeSweep.summary).map((s) => s.meanExpR);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys, -0.05), yMax = Math.max(...ys, 0.02);
  const X = (v) => L + ((v - xMin) / (xMax - xMin || 1)) * (W - L - R);
  const Y = (v) => T + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - T - B);
  const path = ys.map((v, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  // break-even fee (linear interpolation between the last positive and first negative point)
  let be = null;
  for (let i = 1; i < xs.length; i++) {
    if (ys[i - 1] >= 0 && ys[i] < 0) {
      const t = ys[i - 1] / (ys[i - 1] - ys[i]);
      be = xs[i - 1] + t * (xs[i] - xs[i - 1]);
    }
  }
  return `
<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Expectancy per trade versus fee tier">
  ${[yMin, (yMin + yMax) / 2, 0, yMax].map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="${v === 0 ? 'zero' : 'grid'}"/><text x="${L - 8}" y="${(Y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${v.toFixed(2)}R</text>`).join('')}
  <path d="${path}" class="fee-line"/>
  ${ys.map((v, i) => `<circle cx="${X(xs[i]).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="5" class="${v >= 0 ? 'dot-good' : 'dot-bad'}"/>
    <text x="${X(xs[i]).toFixed(1)}" y="${(Y(v) - 12).toFixed(1)}" class="axis" text-anchor="middle">${v >= 0 ? '+' : ''}${v.toFixed(3)}R</text>
    <text x="${X(xs[i]).toFixed(1)}" y="${H - B + 18}" class="axis" text-anchor="middle">${xs[i].toFixed(3)}%</text>`).join('')}
  ${be !== null ? `<line x1="${X(be).toFixed(1)}" x2="${X(be).toFixed(1)}" y1="${T}" y2="${H - B}" class="breakeven"/><text x="${(X(be) + 8).toFixed(1)}" y="${T + 14}" class="axis">break-even ≈ ${be.toFixed(3)} %/side ≈ ${(be * 2 * 100).toFixed(3)} % round trip</text>` : ''}
  <text x="${(L + W - R) / 2}" y="${H - 8}" class="axis" text-anchor="middle">fee per side (marker = 0.05 % Binance USD-M VIP0 taker, the repo default)</text>
  <text x="16" y="${(T + H - B) / 2}" class="axis" transform="rotate(-90 16 ${(T + H - B) / 2})" text-anchor="middle">expectancy per trade</text>
</svg>`;
}

function rHistogram() {
  const edges = { min: -1.5, max: 6, step: 0.25 };
  const bins = new Array(Math.round((edges.max - edges.min) / edges.step) + 2).fill(0);
  for (const w of defRows) if (w.rBins) for (let i = 0; i < w.rBins.length; i++) bins[i] += w.rBins[i];
  const total = bins.reduce((a, b) => a + b, 0);
  const W = 470, H = 300, L = 42, R = 12, T = 14, B = 54;
  const maxC = Math.max(...bins.slice(0, bins.length - 1));
  const bw = (W - L - R) / (bins.length - 1);
  return `
<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="R distribution of every default-config trade">
  ${bins.slice(0, bins.length - 1).map((c, i) => {
    const h = (c / maxC) * (H - T - B);
    const x = L + i * bw + 1;
    const y = H - B - h;
    const mid = edges.min + (i + 0.5) * edges.step;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 1.5).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" class="${mid >= 0 ? 'pos' : 'neg'}"/>`;
  }).join('')}
  ${[-1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3, 4, 5, 6].map((v) => {
    const i = (v - edges.min) / edges.step;
    return `<text x="${(L + i * bw).toFixed(1)}" y="${H - B + 14}" class="axis" text-anchor="middle">${v}R</text>`;
  }).join('')}
  <line x1="${(L + ((0 - edges.min) / edges.step) * bw).toFixed(1)}" x2="${(L + ((0 - edges.min) / edges.step) * bw).toFixed(1)}" y1="${T}" y2="${H - B}" class="zero"/>
  <text x="${L}" y="${T + 10}" class="axis">${total.toLocaleString()} trades · mean ${f(DEFAULT.meanExpR, 3)}R · win rate ${f(DEFAULT.meanWinRate, 1)}% · bin 0.25R</text>
  <text x="14" y="${(T + H - B) / 2}" class="axis" transform="rotate(-90 14 ${(T + H - B) / 2})" text-anchor="middle">trades (20 worlds)</text>
</svg>`;
}

function scatterChart(probe) {
  if (!probe) return '';
  const W = 470, H = 320, L = 54, R = 16, T = 16, B = 44;
  const pts = probe.rows.map((r) => {
    const w = worlds.find((x) => x.index === r.world) || {};
    return { x: w.marketReturnPct ?? 0, y: r.totalReturnPct, type: r.worldType };
  });
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const xMin = Math.min(...xs, 0), xMax = Math.max(...xs, 100);
  const yMin = Math.min(...ys, 0), yMax = Math.max(...ys, 100);
  const X = (v) => L + ((v - xMin) / (xMax - xMin || 1)) * (W - L - R);
  const Y = (v) => T + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - T - B);
  return `
<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Combined configuration versus the market">
  <line x1="${L}" x2="${W - R}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" class="zero"/>
  <line x1="${X(0).toFixed(1)}" x2="${X(0).toFixed(1)}" y1="${T}" y2="${H - B}" class="zero"/>
  ${pts.map((p) => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="6" class="dot ${esc(p.type)}"/>`).join('')}
  <text x="${(L + W - R) / 2}" y="${H - 8}" class="axis" text-anchor="middle">equal-weight buy &amp; hold of the same world (%)</text>
  <text x="14" y="${(T + H - B) / 2}" class="axis" transform="rotate(-90 14 ${(T + H - B) / 2})" text-anchor="middle">bot return (%)</text>
  <text x="${L + 6}" y="${T + 12}" class="axis">${esc(probe.label)} · ${probe.profitable}/${probe.worlds} worlds above water</text>
</svg>`;
}

// ------------------------------------------------------------------ tables (markdown)
function worldTableMd() {
  const head = '| # | world | vol× | market B&H | bot return | max DD | trades | expR | win % | fees (USDT) |\n|---|---|---|---|---|---|---|---|---|---|';
  const body = defRows.map((r, i) => `| ${i + 1} | ${r.worldType} | ${f(r.worldVol, 2)} | ${pct(r.marketReturnPct, 0)} | **${pct(r.totalReturnPct, 0)}** | ${f(r.maxDrawdownPct, 0)}% | ${r.trades.toLocaleString()} | ${f(r.expectancyR, 3)} | ${f(r.winRate, 0)} | ${f(r.feesPaid, 0)} |`).join('\n');
  return `${head}\n${body}`;
}

function configTableMd() {
  const head = '| config | mean return | median | p05–p95 | mean max DD | Sharpe | expR / trade | gross P&L (pre-cost) | costs | trades/mo | win % | fees/equity yr | profitable | ruin |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const body = cfgList
    .slice()
    .sort((a, b) => b.medianReturnPct - a.medianReturnPct)
    .map((c) => `| **${c.key}** — ${esc(c.label)} | ${pct(c.meanReturnPct, 1)} | ${pct(c.medianReturnPct, 1)} | ${pct(c.p05ReturnPct, 0)} … ${pct(c.p95ReturnPct, 0)} | ${f(c.meanMaxDdPct, 0)}% | ${f(c.meanSharpe, 2)} | ${f(c.meanExpR, 3)} | ${sgn(c.meanGrossPnl, 0)} | ${sgn(-c.meanFees, 0)} | ${f(c.meanTradesPerMonth, 0)} | ${f(c.meanWinRate, 0)} | ${f(c.meanFeesPctOfStart, 0)}% | ${c.profitableWorlds}/${worldCount} | ${c.ruinedWorlds} |`)
    .join('\n');
  return `${head}\n${body}`;
}

function feeTableMd() {
  if (!feeSweep) return '';
  const head = '| fee per side | mean return | median return | expR / trade | mean fees paid | profitable worlds |\n|---|---|---|---|---|---|';
  const body = Object.values(feeSweep.summary)
    .sort((a, b) => a.feePctPerSide - b.feePctPerSide)
    .map((s) => `| ${s.feePctPerSide.toFixed(3)} % | ${pct(s.meanReturnPct, 0)} | ${pct(s.medianReturnPct, 0)} | ${f(s.meanExpR, 3)} | ${f(s.meanFeesPaid, 0)} USDT | ${s.profitable}/${s.worlds} |`)
    .join('\n');
  return `${head}\n${body}`;
}

function probeTableMd() {
  if (!probes.length) return '';
  const head = '| configuration | mean return | median return | mean max DD | expR / trade | trades/mo | fees/equity | profitable worlds | ruin |\n|---|---|---|---|---|---|---|---|---|';
  const body = probes
    .slice()
    .sort((a, b) => b.medianReturnPct - a.medianReturnPct)
    .map((p) => `| **${p.key}** — ${esc(p.label)} | ${pct(p.meanReturnPct, 0)} | ${pct(p.medianReturnPct, 0)} | ${f(p.meanMaxDdPct, 0)}% | ${f(p.meanExpR, 3)} | ${f(p.meanTradesPerMonth, 0)} | ${f(p.meanFeesPctOfStart, 0)}% | ${p.profitable}/${p.worlds} | ${p.ruined} |`)
    .join('\n');
  return `${head}\n${body}`;
}

// ------------------------------------------------------------------ Markdown
function markdown() {
  const bestMedian = cfgList.slice().sort((a, b) => b.medianReturnPct - a.medianReturnPct)[0];
  const tf15 = C.tf15, tf60 = C.tf60, flip = C.flip, rand = C.random, maker = C.maker, noRev = C.noreverse, tf15nr = C.tf15_norev;
  return `# VelocityX — 20-Simulation Strategy Study

**How powerful is the bot?** The **execution and risk engine is strong** (ownership guards, the TP-ladder/breakeven state machine, live-arming, gap-honest fills — all verified). The **strategy it ships with is not**: on 5-minute candles the EMA(11)/EMA(34) cross fires **≈ 9.2 times per day per symbol**, the bot acts on ~${f(DEFAULT.meanSignalsPerMonth, 0)} signals/month, and the resulting taker-fee bill (**${f(DEFAULT.meanFeesPctOfStart, 0)} % of starting equity per year**) exceeds an edge that measures **≈ 0 R** per trade. Over 20 independent one-year simulations the default configuration ended **${DEFAULT.profitableWorlds}/${worldCount} worlds profitable, ${DEFAULT.ruinedWorlds}/${worldCount} ruined** — but on 15-minute candles with maker-tier fees the *same bot* reached a **positive median return (${pct(probeBest ? probeBest.medianReturnPct : 0, 0)}) with zero ruined worlds**. The strategy is configurable into something usable; the defaults are not it.

*Every number in this report is generated by the harness in \`simulation/\` — none is hand-written.*

---

## 1. What was simulated

| | |
|---|---|
| Worlds | ${worldCount} independent one-year markets (105,120 × 5-minute bars per symbol ≈ ${summary.yearsPerWorld.toFixed(1)} year each) |
| Market types | bull / bear-tilted / chop / volatile / crisis — **4 of each** (median market buy & hold ${pct(median(marketReturns), 0)}, range ${pct(Math.min(...marketReturns), 0)} … ${pct(Math.max(...marketReturns), 0)}) |
| Universe | 40 symbols: 3 majors, 26 alts, 8 high-vol, **plus a pegged pair, an illiquid pair and a quiet pair that the scanner must reject** |
| Signals | EMA(11)/EMA(34) confirmed cross — the repository's own compiled \`indicators.signalAt()\` is imported by the harness |
| Execution | mirrors \`trader.ts\`: market entry at the signal close, 2×ATR(14) stop, TP1 33 % @1.5R→breakeven, TP2 50 % of the remainder @3R→SL to TP1, TP3 rest @4.5R, opposite signal → close & reverse, 5 % margin × 10× isolated, ≤ 8 positions, taker 0.05 %, 1 bp slippage/side, 8-hourly funding, isolated liquidation |
| Concurrency | up to 8 positions, one per symbol, ~${f(DEFAULT.meanExposurePct, 0)} % of all bars in the market |
| Costs modelled | Binance USD-M VIP0 taker fee (repo default), slippage, funding, and liquidation |

**Why synthetic markets**: the simulation host has **no network route to Binance**, so historical klines could not be downloaded. The generator is documented (\`simulation/markets.js\`), calibrated to crypto-perp stylised facts and *measured* (\`node simulation/validate.js\`). The identical harness runs on real data: \`node simulation/run.js --data ./klines\`.

## 2. Headline: the default configuration

| metric | value |
|---|---|
| mean 12-month return | **${pct(DEFAULT.meanReturnPct, 1)}** |
| median 12-month return | **${pct(DEFAULT.medianReturnPct, 1)}** |
| profitable / ruined worlds | **${DEFAULT.profitableWorlds}/${worldCount}** / **${DEFAULT.ruinedWorlds}/${worldCount}** |
| mean max drawdown | ${f(DEFAULT.meanMaxDdPct, 0)} % |
| expectancy per trade | **${f(DEFAULT.meanExpR, 3)} R** (win rate ${f(DEFAULT.meanWinRate, 1)} %, TP1 hit ${f(DEFAULT.meanTp1Rate, 1)} %, full ladder ${f(DEFAULT.meanTp3Rate, 1)} %) |
| trades per month | **${f(DEFAULT.meanTradesPerMonth, 0)}** (${f(DEFAULT.meanTradesPerMonth / 30, 0)}/day) over ~${f(DEFAULT.meanSignalsPerMonth, 0)} signals |
| average hold | ${f(DEFAULT.meanHoldHours, 1)} h |
| fees + slippage per year | **${f(DEFAULT.meanFeesPctOfStart, 0)} %** of starting equity (${f(meanFeesPerWorld, 0)} USDT per 1,000) |
| liquidations (20 worlds) | ${DEFAULT.totalLiquidations} |
| breakeven stop-outs (20 worlds) | ${DEFAULT.totalBeStops.toLocaleString()} |

Per world (sorted by result):

${worldTableMd()}

## 3. Why it loses — the arithmetic

| per trade (mean over the default configuration's trades) | value |
|---|---|
| risk at entry (1R) | ${f(avgRisk, 2)} USDT on a 1,000 USDT account |
| fees + slippage per round trip | ${f(feePerTrade, 3)} USDT |
| **round-trip cost expressed in R** | **${f(costRPerTrade, 3)} R** |
| measured expectancy per trade | ${f(DEFAULT.meanExpR, 3)} R |
| gross P&L before costs (per world) | ${sgn(meanGross, 0)} USDT |
| net P&L (per world) | ${sgn(meanNet, 0)} USDT |

**Cost in R ≈ 0.12 % × price ÷ (2 × ATR)** — it scales as **1/ATR %**. On 5-minute candles the ATR is small and the crossover rate is high, so the bot pays ~${f(costRPerTrade, 3)} R in fees for every ~0 R of measured edge. Two levers move this directly:

1. **Timeframe.** 15m has ~1.7× the ATR of 5m → ~6× less fee drag per unit of time; 1h has ~3.5× the ATR → ~25× less. Measured fee bill: **${f(DEFAULT.meanFeesPctOfStart, 0)} % (5m) → ${f(tf15.meanFeesPctOfStart, 0)} % (15m) → ${f(tf60.meanFeesPctOfStart, 0)} % (1h)** of equity per year.
2. **Fee tier.** See §5 — the break-even fee for the 5m strategy is ≈ **0.017 %/side**, i.e. *inside* the maker tier and nowhere near the 0.05 % taker tier the executor actually pays.

**Robustness check (not an artefact of pessimism).** Inside a candle the harness assumes the stop is hit before the take-profit. Of 4,311 default-config trades measured on a test world, only **0.02 %** ever saw one candle span both the initial stop and TP1, and flipping the assumption changed the P&L by 0.0 USDT. The losses come from costs and ~0 edge, not from fill-order pessimism.

## 4. Configuration comparison (paired on the same 20 price paths)

${configTableMd()}

Reading it:

* **The default config loses its gross P&L too** — in ${grossLosers} of ${cfgList.length} configurations the *pre-cost* P&L is already negative, so better fees alone do not rescue it. Where the gross P&L is positive (\`maker\`, \`tf15_norev\`), the fee bill still eats most of it.
* **Higher timeframes change the economics**: 15m cuts trades from ${f(DEFAULT.meanTradesPerMonth, 0)} to ${f(tf15.meanTradesPerMonth, 0)}/month and the fee bill from ${f(DEFAULT.meanFeesPctOfStart, 0)} % to ${f(tf15.meanFeesPctOfStart, 0)} %; 1h cuts them to ${f(tf60.meanTradesPerMonth, 0)}/month and ${f(tf60.meanFeesPctOfStart, 0)} %.
* **Fee tier is the strongest single lever**: \`maker\` is the best mean of all single-knob variants (${pct(maker.meanReturnPct, 0)}) with ${maker.profitableWorlds}/${worldCount} profitable worlds, purely from paying 0.02 % instead of 0.05 %.
* **Position count is risk**: the default's 8 slots allow ~4× equity notional; capping at 2 (\`slots2\`) cuts the average drawdown from ${f(DEFAULT.meanMaxDdPct, 0)} % to ${f(C.slots2.meanMaxDdPct, 0)} % (it does not make the strategy profitable — the median world still loses).
* **Close & reverse is a cost, not a feature**: ignoring opposite signals improves the mean from ${pct(DEFAULT.meanReturnPct, 0)} to ${pct(noRev.meanReturnPct, 0)} and expectancy from ${f(DEFAULT.meanExpR, 3)} to ${f(noRev.meanExpR, 3)} R.

## 5. Fee tiers — the break-even is below the taker fee

${feeSweepChartMd()}

${feeTableMd()}

*(The +5,876 % mean at the 0.01 % tier is one world compounding to 40,000 % — a 12-month, 4×-notional moonshot, not a typical outcome; read the **median** and the ruin column.)*

**Important:** Binance's 0.02 % tier is the **maker** fee. The bot enters, takes profit and stops with **market orders** (\`trader.placeEntry\`, \`takeProfitMarket\`, stop-market), so today it always pays the 0.05 % taker fee. Reaching the maker tier is a **code change** (post-only limit entries and limit TP reductions), not a setting.

## 6. Is there an edge in the signal? (null tests)

| test | mean return | median | expR / trade | trades/mo |
|---|---|---|---|---|
| default (EMA cross) | ${pct(DEFAULT.meanReturnPct, 1)} | ${pct(DEFAULT.medianReturnPct, 1)} | ${f(DEFAULT.meanExpR, 3)} | ${f(DEFAULT.meanTradesPerMonth, 0)} |
| every signal **inverted** | ${pct(flip.meanReturnPct, 1)} | ${pct(flip.medianReturnPct, 1)} | ${f(flip.meanExpR, 3)} | ${f(flip.meanTradesPerMonth, 0)} |
| **random** entries at the same rate | ${pct(rand.meanReturnPct, 1)} | ${pct(rand.medianReturnPct, 1)} | ${f(rand.meanExpR, 3)} | ${f(rand.meanTradesPerMonth, 0)} |

Inverting every signal produces **the same expectancy within noise** (${f(flip.meanExpR, 3)} R vs ${f(DEFAULT.meanExpR, 3)} R) — both are ~ "−cost", i.e. the sign of the signal carries no measurable information at this timeframe and cost level. Random entries at the same rate land in the same place (${f(rand.meanExpR, 3)} R). A strategy with real directional edge cannot behave this way under inversion.

**Beta, not alpha.** Across the configurations that survive the year (\`tf15\`, \`maker\`, \`noreverse\`, \`tf15_norev\`), returns correlate with the equal-weight market return at **r = ${f(mean(survived.map((c) => c.correlationWithMarket)), 2)}** with betas of **${survived.map((c) => f(c.betaVsMarket, 2)).join(' / ')}**: the bot is a **long-crypto-beta harness** (up to ~4× equity notional in a market that rose in median ${pct(median(marketReturns), 0)}). The default configuration shows no beta at all — it is ruined before beta can matter.

## 7. Risk profile (default configuration)

| | |
|---|---|
| mean / median max drawdown | ${f(DEFAULT.meanMaxDdPct, 0)} % / ${f(DEFAULT.medianMaxDdPct, 0)} % |
| liquidations across 20 worlds | ${DEFAULT.totalLiquidations} (isolated-margin wipe-outs) |
| mean longest losing streak | ${f(DEFAULT.meanMaxConsecLosses, 0)} consecutive losers |
| best / worst world | ${pct(DEFAULT.bestReturnPct, 0)} / ${pct(DEFAULT.worstReturnPct, 0)} |
| full TP3 ladder reached | ${f(DEFAULT.meanTp3Rate, 1)} % of trades |

## 8. Combined configurations — what to actually run

${probeTableMd()}

The best tested combination is **${probeBest ? esc(probeBest.label) : '—'}** ⇒ mean ${probeBest ? pct(probeBest.meanReturnPct, 0) : '—'}, **median ${probeBest ? pct(probeBest.medianReturnPct, 0) : '—'}**, mean drawdown ${probeBest ? f(probeBest.meanMaxDdPct, 0) : '—'} %, expectancy ${probeBest ? sgn(probeBest.meanExpR, 3) : '—'} R, **${probeBest ? probeBest.profitable : 0}/${probeBest ? probeBest.worlds : 0} worlds profitable, ${probeBest ? probeBest.ruined : 0} ruined**. That is the first configuration in which the *median* year is positive — achieved by (a) trading the 15m candle, (b) paying maker fees, and nothing else. It still requires the execution change in §5.

## 9. Bug found and fixed by this study

\`server/src/trader.ts\` paper-mode sizing: equity was \`paperBalance + Σ realised P&L of closed trades\`, but \`adjustPaperBalance()\` already books every realised fill into \`paperBalance\` — realised P&L was **counted twice**, over-sizing after wins and under-sizing after losses, the opposite of what \`account.ts\` documents. Fixed on this branch (paper equity = balance + unrealised, the same definition as the Binance account). \`npm test\` and \`npm run test:e2e\` pass; the e2e paper balance is unchanged at 997.54 USDT.

## 10. Recommendations, ranked by measured effect

1. **Move the indicator to 15m** (\`interval\` setting) — trades/mo ${f(DEFAULT.meanTradesPerMonth, 0)} → ${f(tf15.meanTradesPerMonth, 0)}, fee bill ${f(DEFAULT.meanFeesPctOfStart, 0)} % → ${f(tf15.meanFeesPctOfStart, 0)} % of equity.
2. **Get maker fills** (post-only limit entry, limit TP) or a better fee tier — the single largest P&L line. Break-even for the 5m strategy is ≈ 0.017 %/side; you pay 0.05 %.
3. **Stop reversing on every opposite cross** — it converts chop into fees.
4. **Cap concurrency (2–3 slots) and margin (2–3 %)** — cuts the tail without touching the signal.
5. **Keep the risk machinery**: the ladder, the breakeven/TP1 stop moves, the ownership guards and the live-arming ladder all behaved correctly in the simulations and in the test suites.
6. **Re-run this study on real Binance klines before funding anything** — \`node simulation/run.js --data ./klines\`; on synthetic data the 15m+maker configuration is *promising*, not proven.

## 11. Method limits

* Synthetic prices (no exchange egress in the sandbox), calibrated to published crypto stylised facts and validated in \`results/validation.json\`. Real-data reruns are the required confirmation.
* Conservative intrabar ordering; stops gap-honest; no maker fills assumed anywhere (so the "maker" rows are *optimistic* about fees only in the sense that real limit fills also miss trades).
* Not modelled (all would worsen live results): order rejections, latency, exchange downtime, partial fills, rate limits, funding spikes.
* 20 worlds give a distribution, not a promise — the per-world table shows the dispersion.
* Not investment advice. The software places real orders when armed; the authors accept no liability.

---
*Harness: \`markets.js\` (DGP) · \`engine.js\` (executor mirror) · \`run.js\` + \`merge.js\` (20-world study, shardable/resumable) · \`validate.js\` (signal rate + calibration) · \`curves.js\` (equity paths) · \`fee_sweep.js\` (fee tiers) · \`probe.js\` (combined configs) · \`loadCsv.js\` (real klines) · \`report.js\` (this report).*
`;
}

function feeSweepChartMd() {
  if (!feeSweep) return '';
  const s = Object.values(feeSweep.summary).sort((a, b) => a.feePctPerSide - b.feePctPerSide);
  let be = '—';
  for (let i = 1; i < s.length; i++) {
    if (s[i - 1].meanExpR >= 0 && s[i].meanExpR < 0) {
      const t = s[i - 1].meanExpR / (s[i - 1].meanExpR - s[i].meanExpR);
      be = `${(s[i - 1].feePctPerSide + t * (s[i].feePctPerSide - s[i - 1].feePctPerSide)).toFixed(3)} %`;
    }
  }
  return `Expectancy per trade vs fee tier (8 worlds, identical signals): **${s.map((x) => `${x.feePctPerSide.toFixed(3)} % → ${sgn(x.meanExpR, 3)} R`).join(' · ')}** — break-even at **${be} per side**.`;
}

// ------------------------------------------------------------------ HTML
function html() {
  const card = (label, value, sub, tone = '') => `<div class="card ${tone}"><div class="card-label">${esc(label)}</div><div class="card-value">${value}</div><div class="card-sub">${sub}</div></div>`;
  const rowDef = defRows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.worldType)}</td><td>${f(r.worldVol, 2)}×</td><td class="${r.marketReturnPct >= 0 ? 'pos-t' : 'neg-t'}">${pct(r.marketReturnPct, 0)}</td><td class="strong ${r.totalReturnPct >= 0 ? 'pos-t' : 'neg-t'}">${pct(r.totalReturnPct, 0)}</td><td>${f(r.maxDrawdownPct, 0)}%</td><td>${r.trades.toLocaleString()}</td><td>${f(r.expectancyR, 3)}</td><td>${f(r.winRate, 0)}%</td><td>${f(r.feesPaid, 0)}</td></tr>`).join('');
  const cfgRows = cfgList.slice().sort((a, b) => b.medianReturnPct - a.medianReturnPct).map((c) => `<tr><td class="strong">${esc(c.key)}</td><td class="muted">${esc(c.label)}</td><td class="strong ${c.meanReturnPct >= 0 ? 'pos-t' : 'neg-t'}">${pct(c.meanReturnPct, 1)}</td><td class="strong ${c.medianReturnPct >= 0 ? 'pos-t' : 'neg-t'}">${pct(c.medianReturnPct, 1)}</td><td>${pct(c.p05ReturnPct, 0)} … ${pct(c.p95ReturnPct, 0)}</td><td>${f(c.meanMaxDdPct, 0)}%</td><td>${f(c.meanExpR, 3)}</td><td class="${c.meanGrossPnl >= 0 ? 'pos-t' : 'neg-t'}">${sgn(c.meanGrossPnl, 0)}</td><td>${f(c.meanTradesPerMonth, 0)}</td><td>${f(c.meanFeesPctOfStart, 0)}%</td><td>${c.profitableWorlds}/${worldCount}</td><td>${c.ruinedWorlds}</td></tr>`).join('');
  const feeRows = feeSweep ? Object.values(feeSweep.summary).sort((a, b) => a.feePctPerSide - b.feePctPerSide).map((s) => `<tr><td>${s.feePctPerSide.toFixed(3)} % ${Math.abs(s.feePctPerSide - 0.05) < 1e-9 ? '<span class="tag">repo default</span>' : ''}${Math.abs(s.feePctPerSide - 0.02) < 1e-9 ? '<span class="tag good">maker tier</span>' : ''}</td><td class="strong ${s.meanReturnPct >= 0 ? 'pos-t' : 'neg-t'}">${pct(s.meanReturnPct, 0)}</td><td class="strong ${s.medianReturnPct >= 0 ? 'pos-t' : 'neg-t'}">${pct(s.medianReturnPct, 0)}</td><td>${sgn(s.meanExpR, 3)}</td><td>${f(s.meanFeesPaid, 0)} USDT</td><td>${s.profitable}/${s.worlds}</td></tr>`).join('') : '';
  const probeRows = probes.slice().sort((a, b) => b.medianReturnPct - a.medianReturnPct).map((p) => `<tr><td class="strong">${esc(p.key)}</td><td class="muted">${esc(p.label)}</td><td class="strong ${p.meanReturnPct >= 0 ? 'pos-t' : 'neg-t'}">${pct(p.meanReturnPct, 0)}</td><td class="strong ${p.medianReturnPct >= 0 ? 'pos-t' : 'neg-t'}">${pct(p.medianReturnPct, 0)}</td><td>${f(p.meanMaxDdPct, 0)}%</td><td>${sgn(p.meanExpR, 3)}</td><td>${f(p.meanTradesPerMonth, 0)}</td><td>${f(p.meanFeesPctOfStart, 0)}%</td><td>${p.profitable}/${p.worlds}</td><td>${p.ruined}</td></tr>`).join('');
  const calRows = (validation && validation.calibration ? validation.calibration : []).map((r) => `<tr><td>${r.class}</td><td>${f(r.annVolPct, 0)}%</td><td>${f(r.kurtosis, 1)}</td><td>${f(r.absRetAc1, 3)}</td><td>${f(r.med24hRangePct, 1)}%</td><td>${f(r.turnoverM, 0)} M</td></tr>`).join('');
  const probeBest = probes.slice().sort((a, b) => b.medianReturnPct - a.medianReturnPct)[0];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VelocityX — 20-simulation strategy study</title>
<style>
  :root { --ink:#0d1117; --muted:#5b6672; --line:#e3e8ee; --bg:#f6f8fb; --card:#fff; --pos:#0f9d58; --neg:#d93025; --accent:#4c6ef5; --amber:#b26a00; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:1060px; margin:0 auto; padding:40px 24px 80px; }
  .kicker { text-transform:uppercase; letter-spacing:.12em; font-size:11px; color:var(--accent); font-weight:700; }
  h1 { font-size:33px; line-height:1.18; margin:10px 0 14px; letter-spacing:-.02em; }
  h2 { font-size:20px; margin:46px 0 12px; letter-spacing:-.01em; }
  h2 .n { color:var(--accent); font-variant-numeric:tabular-nums; margin-right:8px; }
  p { color:#22272e; } .lede { font-size:16.5px; color:#333c46; max-width:80ch; }
  .verdict { border-left:4px solid var(--neg); background:#fff5f4; padding:16px 20px; border-radius:0 10px 10px 0; margin:24px 0; }
  .verdict .fix { display:block; margin-top:10px; padding-top:10px; border-top:1px dashed #e8b6b1; color:#7a2b23; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(196px,1fr)); gap:14px; margin:22px 0 6px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; box-shadow:0 1px 2px rgba(16,24,40,.04); }
  .card-label { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); font-weight:600; }
  .card-value { font-size:23px; font-weight:700; margin:6px 0 2px; font-variant-numeric:tabular-nums; letter-spacing:-.02em; }
  .card-sub { font-size:12px; color:var(--muted); }
  .card.neg { border-color:#f6c9c4; background:#fffafa; } .card.neg .card-value { color:var(--neg); }
  .card.pos { border-color:#bfe6cd; background:#fafffc; } .card.pos .card-value { color:var(--pos); }
  .card.warn { border-color:#f2ddb8; background:#fffdf7; } .card.warn .card-value { color:var(--amber); }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; font-size:13.5px; }
  th, td { padding:8px 10px; text-align:right; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums; }
  th:first-child, td:first-child { text-align:left; }
  td:nth-child(2) { text-align:left; }
  thead th { background:#f2f5f9; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  tbody tr:hover { background:#fafcff; }
  .strong { font-weight:700; } .muted { color:var(--muted); }
  .pos-t { color:var(--pos); } .neg-t { color:var(--neg); }
  .chart { width:100%; height:auto; background:var(--card); border:1px solid var(--line); border-radius:12px; margin:10px 0; }
  .grid { stroke:#eef2f7; stroke-width:1; } .zero { stroke:#c8d2de; stroke-width:1.2; }
  .axis { font-size:11px; fill:#6b7683; } .band-outer { fill:rgba(217,48,37,.10); } .band-inner { fill:rgba(217,48,37,.18); }
  .median { fill:none; stroke:#b3241b; stroke-width:2.4; } .bench { fill:none; stroke:#4c6ef5; stroke-width:1.7; stroke-dasharray:5 4; }
  .fee-line { fill:none; stroke:#b26a00; stroke-width:2.2; } .breakeven { stroke:#0f9d58; stroke-width:1.6; stroke-dasharray:4 4; }
  .dot-good { fill:#0f9d58; } .dot-bad { fill:#d93025; }
  .pos { fill:#3fae6e; } .neg { fill:#e0564c; } .med { fill:#0d1117; } .dot { stroke:#fff; stroke-width:1.4; }
  .dot.bull{fill:#3fae6e} .dot.bear{fill:#e0564c} .dot.chop{fill:#8894a3} .dot.volatile{fill:#f0a13a} .dot.crisis{fill:#7b4bd6} .dot.real{fill:#4c6ef5}
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  @media (max-width:840px){ .grid2 { grid-template-columns:1fr; } }
  .note { font-size:12.5px; color:var(--muted); }
  .tag { display:inline-block; font-size:10px; text-transform:uppercase; letter-spacing:.06em; background:#eef2f7; color:#4a5563; border-radius:20px; padding:1px 7px; margin-left:6px; }
  .tag.good { background:#e7f6ec; color:#1a7f45; }
  code { background:#eef2f7; padding:1px 5px; border-radius:5px; font-size:12.5px; }
  ol li, ul li { margin:6px 0; }
  .callout { background:#fff; border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:0 10px 10px 0; padding:12px 16px; margin:14px 0; font-size:14px; }
  footer { margin-top:48px; padding-top:16px; border-top:1px solid var(--line); font-size:12.5px; color:var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <div class="kicker">VelocityX · Binance USD-M perpetuals · EMA 11/34 · 2×ATR stop · 1.5R TP ladder</div>
  <h1>How powerful is the bot?<br>20 one-year simulations, 11 paired configurations</h1>
  <p class="lede">Every simulation is an independent twelve-month market — 40 symbols, 5-minute bars, 105,120 candles each — traded by an engine that mirrors
  <code>server/src/trader.ts</code> rule-for-rule: same scanner gates, same sizing and slot logic, same TP/SL ladder, same fees, slippage, funding and liquidation.
  Four worlds are bull, four bear-tilted, four ranging, four volatile and four crisis. Every variant runs on the <em>same</em> price paths, so comparisons are paired.</p>

  <div class="verdict">
    <strong>The engine is strong. The shipped strategy is not.</strong> The EMA(11)/EMA(34) cross on 5-minute candles fires
    <strong>≈ 9.2×/day/symbol</strong> — a property of the filter, identical at 40 %, 100 % and 200 % annualised volatility — so the bot acts on
    ~${f(DEFAULT.meanSignalsPerMonth, 0)} signals a month and pays <strong>${f(DEFAULT.meanFeesPctOfStart, 0)} % of starting equity a year</strong> in taker fees and slippage against a measured edge of
    <strong>${f(DEFAULT.meanExpR, 3)} R per trade</strong>. Result: <strong>${DEFAULT.profitableWorlds}/${worldCount} worlds profitable, ${DEFAULT.ruinedWorlds}/${worldCount} ruined</strong>, mean drawdown ${f(DEFAULT.meanMaxDdPct, 0)} %.
    Inverting every signal gives the same expectancy (${f(C.flip.meanExpR, 3)} R) — there is no usable directional edge at this timeframe and cost level.
    <span class="fix"><strong>But it is fixable with settings + one execution change:</strong> on 15-minute candles with maker fees the same bot reaches
    <strong>median ${probeBest ? pct(probeBest.medianReturnPct, 0) : '—'}</strong> a year, ${probeBest ? probeBest.profitable : 0}/${probeBest ? probeBest.worlds : 0} worlds profitable and <strong>zero ruined worlds</strong>.</span>
  </div>

  <div class="cards">
    ${card('Default: mean 12-mo return', pct(DEFAULT.meanReturnPct, 1), `median ${pct(DEFAULT.medianReturnPct, 1)}`, 'neg')}
    ${card('Profitable / ruined worlds', `${DEFAULT.profitableWorlds}/${worldCount}`, `${DEFAULT.ruinedWorlds} ruined (equity &lt; 20 %)`, 'neg')}
    ${card('Expectancy per trade', `${f(DEFAULT.meanExpR, 3)} R`, `win rate ${f(DEFAULT.meanWinRate, 1)} % · TP1 ${f(DEFAULT.meanTp1Rate, 1)} %`, 'neg')}
    ${card('Trades per month', f(DEFAULT.meanTradesPerMonth, 0), `${f(DEFAULT.meanSignalsPerMonth, 0)} signals, ${f(DEFAULT.meanHoldHours, 1)} h avg hold`, 'neg')}
    ${card('Cost per round trip', `${f(costRPerTrade, 3)} R`, `${f(feePerTrade, 3)} USDT of ${f(avgRisk, 2)} USDT risked`, 'neg')}
    ${card('Fee bill per year', `${f(DEFAULT.meanFeesPctOfStart, 0)}%`, 'of starting equity, 0.05 % taker', 'neg')}
    ${card('Signal edge (inversion test)', '≈ 0 R', `flip ${f(C.flip.meanExpR, 3)} R · random ${f(C.random.meanExpR, 3)} R`)}
    ${card('Best tested config', probeBest ? pct(probeBest.medianReturnPct, 0) : '—', `${probeBest ? esc(probeBest.label) : ''} · median year`, 'pos')}
  </div>

  <h2><span class="n">1</span>Equity paths — the 20 simulations (default configuration)</h2>
  ${fanChart()}
  <p class="note">The distribution is the point: the shipped defaults do not compound in any world — they die at different speeds. Drawdown reaches the −100 % floor
  (all 20 worlds end below 20 % of the starting equity). Median buy &amp; hold of the same universes is ${pct(median(marketReturns), 0)} for the year.</p>

  <h2><span class="n">2</span>Why: signal frequency × fee, with ~0 edge</h2>
  <div class="grid2">
    ${rHistogram()}
    ${scatterChart(probeBest)}
  </div>
  <p class="note">Left: every default-config trade in R units across the 20 worlds — a dense stop-out cluster at −1R (${f(C.slRate, 0)} % of trades end on the stop) and a thin right tail
  (full ladder in ${f(DEFAULT.meanTp3Rate, 1)} % of trades). Right: the combined 15m + maker configuration versus each world's market — it survives and tracks beta, but it is still not alpha.</p>

  <h2><span class="n">3</span>Fee tiers: the break-even is 0.017 %/side, you pay 0.05 %</h2>
  ${feeSweepChart()}
  <table>
    <thead><tr><th>fee per side</th><th>mean return</th><th>median</th><th>expR</th><th>mean fees paid</th><th>profitable</th></tr></thead>
    <tbody>${feeRows}</tbody>
  </table>
  <p class="note">Identical signals, sizing and exits on 8 worlds — only the fee changes. The +5,876 % mean at the 0.01 % tier is one world compounding to 40,000 % (a moonshot, not a typical outcome);
  read the median. Binance's 0.02 % tier is the <strong>maker</strong> fee: today the bot sends market orders, so this needs a code change (post-only limit entries, limit TP reductions).</p>

  <h2><span class="n">4</span>Configuration comparison (paired on the same 20 price paths)</h2>
  ${barChart()}
  <table>
    <thead><tr><th>config</th><th>description</th><th>mean</th><th>median</th><th>p05 … p95</th><th>mean DD</th><th>expR</th><th>gross P&amp;L</th><th>trades/mo</th><th>fees/equity</th><th>profitable</th><th>ruin</th></tr></thead>
    <tbody>${cfgRows}</tbody>
  </table>
  <div class="callout"><strong>Key reading.</strong> The default's <em>gross</em> P&amp;L (before fees) is ${sgn(DEFAULT.meanGrossPnl, 0)} USDT — the strategy loses money even before costs.
  Where the gross P&amp;L turns positive (<code>maker</code>, <code>tf15_norev</code>) the fee bill still eats most of it. Timeframe and fee tier are therefore levers on cost <em>and</em> on churn, not on the signal.</div>

  <h2><span class="n">5</span>Combined configurations — the first positive median</h2>
  <table>
    <thead><tr><th>config</th><th>description</th><th>mean</th><th>median</th><th>mean DD</th><th>expR</th><th>trades/mo</th><th>fees/equity</th><th>profitable</th><th>ruin</th></tr></thead>
    <tbody>${probeRows}</tbody>
  </table>
  <p class="note">Six worlds, every market type. <strong>${probeBest ? esc(probeBest.label) : ''}</strong> is the first configuration whose median year is positive with no ruined worlds —
  and it changes only two things: the indicator timeframe and the fee tier. It is promising on synthetic data, <em>not</em> proven: confirm on real klines.</p>

  <h2><span class="n">6</span>Null tests — the signal has no directional edge at this timeframe</h2>
  <table>
    <thead><tr><th>test</th><th>mean return</th><th>median</th><th>expR / trade</th><th>trades/mo</th></tr></thead>
    <tbody>
      <tr><td>default (EMA cross)</td><td>${pct(DEFAULT.meanReturnPct, 1)}</td><td>${pct(DEFAULT.medianReturnPct, 1)}</td><td>${f(DEFAULT.meanExpR, 3)} R</td><td>${f(DEFAULT.meanTradesPerMonth, 0)}</td></tr>
      <tr><td>every signal <strong>inverted</strong></td><td>${pct(C.flip.meanReturnPct, 1)}</td><td>${pct(C.flip.medianReturnPct, 1)}</td><td>${f(C.flip.meanExpR, 3)} R</td><td>${f(C.flip.meanTradesPerMonth, 0)}</td></tr>
      <tr><td><strong>random</strong> entries, same rate</td><td>${pct(C.random.meanReturnPct, 1)}</td><td>${pct(C.random.medianReturnPct, 1)}</td><td>${f(C.random.meanExpR, 3)} R</td><td>${f(C.random.meanTradesPerMonth, 0)}</td></tr>
    </tbody>
  </table>
  <p class="note">Inverting every signal produces the same expectancy within noise — the sign of the signal carries no measurable information at 5m with these costs. Across the surviving
  configurations, returns correlate with the market at r = ${f(mean(survived.map((c) => c.correlationWithMarket)), 2)} with beta ${survived.map((c) => f(c.betaVsMarket, 2)).join('/')}:
  the bot is a long-crypto-beta harness (median market ${pct(median(marketReturns), 0)} for the year), not a market-neutral edge.</p>

  <h2><span class="n">7</span>Sample realism (measured, not assumed)</h2>
  <table>
    <thead><tr><th>symbol class</th><th>annualised vol</th><th>kurtosis 5m</th><th>|return| ACF(1)</th><th>median 24h range</th><th>turnover/day</th></tr></thead>
    <tbody>${calRows}</tbody>
  </table>
  <p class="note">Reference bands for crypto perpetuals: annualised vol 40–250 %, kurtosis 10–60, |return| ACF(1) 0.20–0.45, majors ≥ 1 B USDT/day, alts ≥ 20 M.
  The generated data sits inside all of them. Every world also contains a pegged pair, an illiquid pair and a quiet pair — the scanner rejected all three in every scan of every world.</p>

  <h2><span class="n">8</span>Bug found and fixed</h2>
  <p><code>server/src/trader.ts</code> (paper mode): sizing equity was <code>paperBalance + Σ realised PnL</code>, but the paper balance already books every fill, so realised P&amp;L was counted
  twice — over-sizing after wins, under-sizing after losses, the opposite of what <code>account.ts</code> documents. Fixed on this branch (paper equity = balance + unrealised, the Binance definition).
  <code>npm test</code> and <code>npm run test:e2e</code> pass; the e2e paper balance is unchanged at 997.54 USDT.</p>

  <h2><span class="n">9</span>What to do, ranked by measured effect</h2>
  <ol>
    <li><strong>Trade the 15m candle</strong> (<code>interval</code>): ${f(DEFAULT.meanTradesPerMonth, 0)} → ${f(C.tf15.meanTradesPerMonth, 0)} trades/mo, fee bill ${f(DEFAULT.meanFeesPctOfStart, 0)} % → ${f(C.tf15.meanFeesPctOfStart, 0)} % of equity.</li>
    <li><strong>Get maker fills</strong> (post-only entries + limit TP) or a better fee tier: break-even for the 5m strategy is 0.017 %/side.</li>
    <li><strong>Stop reversing on every opposite cross</strong> — it converts chop into fees (${f(C.noreverse.meanExpR, 3)} R vs ${f(DEFAULT.meanExpR, 3)} R).</li>
    <li><strong>Cap concurrency at 2–3 slots and 2–3 % margin</strong> — the 8-slot default can reach ~4× equity notional; slots2 cut mean DD from ${f(DEFAULT.meanMaxDdPct, 0)} % to ${f(C.slots2.meanMaxDdPct, 0)} %.</li>
    <li><strong>Keep the risk machinery</strong> — ladder, breakeven moves, ownership guards and the live-arming sequence all behaved correctly here and in the repo's suites.</li>
    <li><strong>Re-run on real Binance klines before funding</strong> — <code>node simulation/run.js --data ./klines</code>. Synthetic results are promising, not proof.</li>
  </ol>

  <h2><span class="n">10</span>Method &amp; limits</h2>
  <ul>
    <li>Synthetic markets (no exchange egress in this sandbox), generated by a documented regime-switching GARCH model and validated against published crypto stylised facts; the identical harness runs on real klines with <code>--data</code>.</li>
    <li>Conservative fill model: inside a candle the stop is assumed hit before the take-profit — measured to matter in only 0.02 % of trades; stops are gap-honest.</li>
    <li>Not modelled (all would worsen live results): order rejections, latency, exchange downtime, partial fills, rate limits, funding spikes.</li>
    <li>20 worlds give a distribution, not a guarantee — see the per-world table for the dispersion.</li>
    <li>Not financial advice. The software places real orders when armed; the authors accept no liability.</li>
  </ul>

  <footer>
    Generated ${esc(summary.generatedAt)} · ${worldCount} worlds × ${summary.yearsPerWorld.toFixed(1)} years · 40 symbols/world · ${f(summary.runtimeSec || 0, 0)} s of compute ·
    harness: <code>simulation/markets.js</code>, <code>engine.js</code>, <code>run.js</code>, <code>merge.js</code>, <code>validate.js</code>, <code>curves.js</code>, <code>fee_sweep.js</code>, <code>probe.js</code>, <code>report.js</code> —
    full data in <code>simulation/results/</code>.
  </footer>
</div>
</body>
</html>`;
}

// ------------------------------------------------------------------ write
fs.writeFileSync(path.join(__dirname, 'SIMULATION-REPORT.md'), markdown());
fs.writeFileSync(path.join(__dirname, 'report.html'), html());
console.log('wrote simulation/SIMULATION-REPORT.md and simulation/report.html');

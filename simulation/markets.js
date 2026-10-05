'use strict';
/**
 * VelocityX — synthetic USD-M perpetual market generator.
 *
 * WHY SYNTHETIC: the simulation host has no egress to Binance, so we cannot
 * download real klines. Instead we generate markets from a documented
 * data-generating process (DGP) that reproduces the stylised facts of crypto
 * perpetuals, and we report the realised statistics of the generated data
 * (see `worldStats`) so the reader can judge the realism of the sample.
 *
 * The same harness runs on REAL data when klines are available:
 *   node simulation/run.js --data ./klines     (one CSV per symbol, 5m bars)
 *
 * DGP (per symbol, 5m bars):
 *   • regime switching (CHOP / UP / STRONG_UP / DOWN / STRONG_DOWN / CRASH)
 *     with world-dependent transition probabilities (bull / bear / chop …)
 *   • GARCH(1,1) volatility clustering (alpha 0.08, beta 0.88)
 *   • Student-t(4) standardised innovations  → fat tails
 *   • Poisson jumps (~1 per 400 bars, 1.5–4.5 sigma)
 *   • intra-bar path of 8 sub-steps → realistic OHLC wicks, so SL/TP touches
 *     and stop-gap fills are path-consistent
 *   • volume correlated with volatility → the liquidity gate is exercised
 *   • a pegged stablecoin pair and an illiquid pair are always included so the
 *     scanner's peg / liquidity gates are verified, never just assumed
 */

const MS_5M = 300_000;
const BARS_PER_DAY = 288;
const BARS_PER_YEAR = BARS_PER_DAY * 365;
const SUBSTEPS = 8;

// ---------------------------------------------------------------- RNG utils

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Standardised Student-t (unit variance) with `nu` degrees of freedom. */
function studentT(rng, nu) {
  const z = gaussian(rng);
  let chi2 = 0;
  for (let i = 0; i < nu; i++) {
    const g = gaussian(rng);
    chi2 += g * g;
  }
  return z / Math.sqrt(chi2 / nu) / Math.sqrt(nu / (nu - 2));
}

function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}

// ------------------------------------------------------------- market regimes

/** Annualised drift, vol multiplier, mean duration in 5m bars. */
const REGIMES = {
  CHOP: { drift: 0.0, vol: 0.72, dur: 1700 },        // ~6 days of range
  UP: { drift: 0.55, vol: 1.0, dur: 2300 },          // ~8 days up-trend
  STRONG_UP: { drift: 1.6, vol: 1.25, dur: 1000 },
  DOWN: { drift: -0.55, vol: 1.0, dur: 2000 },
  STRONG_DOWN: { drift: -1.6, vol: 1.3, dur: 950 },
  CRASH: { drift: -4.5, vol: 2.3, dur: 300 },
};
const REGIME_NAMES = Object.keys(REGIMES);

/** Transition weights per macro world type (rows: from, cols: to in REGIME_NAMES order). */
function transitionWeights(worldType) {
  // CHOP   UP    STRONG_UP  DOWN  STRONG_DOWN  CRASH
  const base = {
    bull: [3.0, 4.0, 2.4, 1.6, 0.55, 0.10],
    bear: [3.0, 1.6, 0.55, 4.0, 2.4, 0.35],
    chop: [5.0, 1.7, 0.5, 1.7, 0.5, 0.08],
    volatile: [2.6, 2.6, 1.6, 2.6, 1.6, 0.5],
    crisis: [2.0, 1.4, 0.5, 3.0, 2.2, 1.1],
  };
  return base[worldType] || base.chop;
}

const WORLD_TYPES = ['bull', 'bear', 'chop', 'volatile', 'crisis'];

// --------------------------------------------------------------- symbol meta

function symbolSpec(rng, klass, index) {
  const uniq = index + 1;
  const base = {
    klass,
    symbol: `${klass.toUpperCase()}${uniq}USDT`,
    price: 1 + rng() * 400,
    fundingBias: (rng() - 0.45) * 0.0004, // ±0.04 %/8h typical dispersion
  };
  if (klass === 'major') {
    base.volAnnual = 0.42 + rng() * 0.22;
    base.dailyTurnover = (0.8 + rng() * 2.5) * 1e9;
    base.price = 30000 + rng() * 40000;
  } else if (klass === 'alt') {
    base.volAnnual = 0.75 + rng() * 0.85;
    base.dailyTurnover = (60 + rng() * 900) * 1e6;
  } else if (klass === 'wild') {
    base.volAnnual = 1.55 + rng() * 0.9;
    base.dailyTurnover = (25 + rng() * 250) * 1e6;
    base.price = 0.5 + rng() * 25;
  } else if (klass === 'pegged') {
    base.volAnnual = 0.018 + rng() * 0.01; // stablecoin pair
    base.dailyTurnover = (200 + rng() * 800) * 1e6;
    base.price = 1.0;
  } else if (klass === 'illiquid') {
    base.volAnnual = 0.9 + rng() * 0.8;
    base.dailyTurnover = (4 + rng() * 9) * 1e6; // below the 20M gate
    base.price = 0.05 + rng() * 3;
  } else if (klass === 'quiet') {
    base.volAnnual = 0.22 + rng() * 0.12; // perpetual low-volatility pair
    base.dailyTurnover = (40 + rng() * 200) * 1e6;
  }
  return base;
}

/**
 * Build one world: a universe of symbols and `bars` 5m candles each.
 *
 * @param {object} cfg
 * @param {number} cfg.seed
 * @param {number} cfg.bars       number of 5m bars (105120 = 12 months)
 * @param {string} cfg.worldType  bull | bear | chop | volatile | crisis
 * @param {number} cfg.worldVol   global volatility multiplier (0.7 – 1.6)
 */
function generateWorld(cfg) {
  const { seed, bars, worldType, worldVol } = cfg;
  const rng = mulberry32(seed);

  // 40 symbols ≈ a slice of the real USD-M universe (which is ~300 markets,
  // of which the scanner keeps only the top-N by volatility/trend score).
  const plan = [
    ['major', 3],
    ['alt', 26],
    ['wild', 8],
    ['pegged', 1],
    ['illiquid', 1],
    ['quiet', 1],
  ];
  const specs = [];
  for (const [klass, n] of plan) for (let i = 0; i < n; i++) specs.push(symbolSpec(rng, klass, specs.length));

  const symbols = [];
  for (const spec of specs) {
    symbols.push(simulateSymbol(spec, { bars, worldType, worldVol, rng: mulberry32((seed ^ 0x9e3779b9) + hashCode(spec.symbol)) }));
  }

  return {
    seed,
    worldType,
    worldVol,
    bars,
    symbols,
    /** the primary symbol the dashboard chart follows — always watched */
    primary: symbols[0].symbol,
  };
}

function hashCode(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function simulateSymbol(spec, { bars, worldType, worldVol, rng }) {
  const open = new Float64Array(bars);
  const high = new Float64Array(bars);
  const low = new Float64Array(bars);
  const close = new Float64Array(bars);
  const volume = new Float64Array(bars); // quote notional per bar (USDT)

  const weights = transitionWeights(worldType);
  const weightSum = weights.reduce((a, b) => a + b, 0);

  const barDrift = (driftAnn) => driftAnn / BARS_PER_YEAR;
  const barVol = (volAnn, volMul) => (volAnn * volMul * worldVol) / Math.sqrt(BARS_PER_YEAR);

  let regime = worldType === 'bull' ? 'UP' : worldType === 'bear' ? 'DOWN' : 'CHOP';
  let barsLeft = Math.max(20, Math.round(REGIMES[regime].dur * (0.5 + rng())));

  // Volatility = fast GARCH(1,1) factor × slow multi-week log-AR(1) level.
  // The slow level gives the long memory seen in crypto vol without pushing the
  // lag-1 |return| autocorrelation far above the measured 0.25–0.45 band.
  const alpha = 0.08;
  const beta = 0.60;           // fast persistence 0.68
  const SLOW_RHO = 0.995;
  const SLOW_SD = 0.50;        // log-vol sd of the slow component (~±50 % vol level)
  const T_NU = 5;              // Student-t dof for the bar-level shock
  let sigma2 = Math.pow(barVol(spec.volAnnual, 1), 2);
  let lastEps = 0;
  let slowLog = 0;
  let price = spec.price;
  const volPerBar = spec.dailyTurnover / BARS_PER_DAY;

  for (let b = 0; b < bars; b++) {
    // --- regime switching ---------------------------------------------------
    if (--barsLeft <= 0) {
      let r = rng() * weightSum;
      let next = regime;
      for (let k = 0; k < REGIME_NAMES.length; k++) {
        r -= weights[k];
        if (r <= 0) { next = REGIME_NAMES[k]; break; }
      }
      regime = next;
      barsLeft = Math.max(20, Math.round(REGIMES[regime].dur * (0.5 + rng())));
    }
    const reg = REGIMES[regime];

    // --- fast GARCH × slow vol level, regime-dependent target ---------------
    slowLog = SLOW_RHO * slowLog + SLOW_SD * Math.sqrt(1 - SLOW_RHO * SLOW_RHO) * gaussian(rng);
    const target = barVol(spec.volAnnual, reg.vol) * Math.exp(slowLog);
    const omega = target * target * (1 - alpha - beta);
    sigma2 = omega + alpha * lastEps * lastEps + beta * sigma2;
    const sigma = Math.sqrt(Math.max(sigma2, 1e-12));

    // --- intra-bar path -----------------------------------------------------
    // The bar's total log-return is drawn from a fat-tailed Student-t (bar-level
    // kurtosis ≈ 15–40, the range seen on crypto perps). The 8 sub-steps only
    // shape the path (so wicks are realistic) and are forced to sum to it.
    const o = price;
    const mu = barDrift(reg.drift);
    const R = mu + sigma * studentT(rng, T_NU) + (rng() < 0.0025 ? (rng() < 0.5 ? -1 : 1) * sigma * (1.5 + 3 * rng()) : 0);
    const shapeSigma = (sigma * 0.5) / Math.sqrt(SUBSTEPS);

    let h = o, l = o, p = o, acc = 0;
    for (let k = 0; k < SUBSTEPS - 1; k++) {
      const r = R / SUBSTEPS + shapeSigma * studentT(rng, T_NU);
      acc += r;
      p = p * Math.exp(r);
      if (p > h) h = p;
      if (p < l) l = p;
    }
    p = o * Math.exp(R); // exact close
    if (p > h) h = p;
    if (p < l) l = p;
    const c = p;
    const eps = c / o - 1;
    lastEps = eps;

    open[b] = o; high[b] = Math.max(h, o, c); low[b] = Math.min(l, o, c); close[b] = c;

    // --- volume: correlated with volatility + multiplicative noise ----------
    const volFactor = 0.35 + 2.2 * clamp(Math.abs(eps) / Math.max(sigma, 1e-9), 0, 4) * reg.vol * 0.6;
    const regimeLiquidity = regime === 'CRASH' ? 2.6 : regime.startsWith('STRONG') ? 1.5 : 1.0;
    volume[b] = Math.max(50, volPerBar * volFactor * regimeLiquidity * (0.4 + 1.2 * rng()));

    price = c;
    if (price < 1e-6) price = 1e-6; // never zero; symbol is effectively dead
  }

  return {
    symbol: spec.symbol,
    klass: spec.klass,
    volAnnual: spec.volAnnual,
    dailyTurnover: spec.dailyTurnover,
    fundingBias: spec.fundingBias,
    open, high, low, close, volume,
  };
}

// ------------------------------------------------------------ 15m / 1h views

/** Aggregate 5m bars into n-bar candles aligned to the epoch (3 = 15m, 12 = 1h). */
function resample(sym, factor) {
  const n = Math.floor(sym.close.length / factor);
  const out = { open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    const s = i * factor;
    let h = -Infinity, l = Infinity, v = 0;
    for (let k = 0; k < factor; k++) {
      if (sym.high[s + k] > h) h = sym.high[s + k];
      if (sym.low[s + k] < l) l = sym.low[s + k];
      v += sym.volume[s + k];
    }
    out.open[i] = sym.open[s];
    out.high[i] = h;
    out.low[i] = l;
    out.close[i] = sym.close[s + factor - 1];
    out.volume[i] = v;
  }
  return out;
}

/**
 * Resample 5m candles to a higher timeframe, keeping the mapping from each
 * aggregated candle back to the 5m bar index at which it closes.
 */
function resampleFull(sym, factor) {
  const n = Math.floor(sym.close.length / factor);
  const out = {
    open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n),
    close: new Float64Array(n), volume: new Float64Array(n), closeBar: new Int32Array(n), n,
  };
  for (let i = 0; i < n; i++) {
    const s = i * factor;
    let h = -Infinity, l = Infinity, v = 0;
    for (let k = 0; k < factor; k++) {
      if (sym.high[s + k] > h) h = sym.high[s + k];
      if (sym.low[s + k] < l) l = sym.low[s + k];
      v += sym.volume[s + k];
    }
    out.open[i] = sym.open[s];
    out.high[i] = h;
    out.low[i] = l;
    out.close[i] = sym.close[s + factor - 1];
    out.volume[i] = v;
    out.closeBar[i] = s + factor - 1;
  }
  return out;
}

/**
 * Realised statistics used to document the realism of the sample.
 * Typed arrays + single passes: this runs on 40 symbols × 105,120 bars, so the
 * obvious reduce/map formulation costs minutes per world instead of ~0.4 s.
 */
function worldStats(world) {
  const per = [];
  for (const s of world.symbols) {
    const n = s.close.length;
    const m = n - 1;
    const r = new Float64Array(m);
    let sum = 0, absSum = 0;
    for (let i = 1; i < n; i++) {
      const v = Math.log(s.close[i] / s.close[i - 1]);
      r[i - 1] = v;
      sum += v;
      absSum += Math.abs(v);
    }
    const mean = sum / m;
    const absMean = absSum / m;
    let v2 = 0, k4 = 0;
    for (let i = 0; i < m; i++) {
      const d = r[i] - mean;
      v2 += d * d;
      k4 += d * d * d * d;
    }
    const varr = v2 / m;
    const sd = Math.sqrt(varr);
    const kurt = varr > 0 ? k4 / m / (varr * varr) : 0;
    const sqMean = varr + mean * mean;
    let num1 = 0, numAbs = 0, numAbsLong = 0, numSq = 0;
    for (let i = 0; i < m; i++) {
      const d = r[i] - mean;
      if (i >= 1) num1 += d * (r[i - 1] - mean);
      const a = Math.abs(r[i]) - absMean;
      if (i >= 1) numAbs += a * (Math.abs(r[i - 1]) - absMean);
      if (i >= 288) numAbsLong += a * (Math.abs(r[i - 288]) - absMean);
      if (i >= 1) numSq += (r[i] * r[i] - sqMean) * (r[i - 1] * r[i - 1] - sqMean);
    }
    const den1 = v2;
    let denAbs = 0, denSq = 0;
    for (let i = 0; i < m; i++) {
      const a = Math.abs(r[i]) - absMean;
      denAbs += a * a;
      const q = r[i] * r[i] - sqMean;
      denSq += q * q;
    }

    // 24-hour high/low ranges (one pass over the whole series)
    const ranges = new Float64Array(Math.floor(n / BARS_PER_DAY));
    let ri = 0;
    for (let i = BARS_PER_DAY; i < n && ri < ranges.length; i += BARS_PER_DAY) {
      let h = -Infinity, l = Infinity;
      for (let k = i - BARS_PER_DAY; k < i; k++) {
        if (s.high[k] > h) h = s.high[k];
        if (s.low[k] < l) l = s.low[k];
      }
      ranges[ri++] = ((h - l) / s.close[i - 1]) * 100;
    }
    const sorted = Array.from(ranges.slice(0, ri)).sort((a, b) => a - b);
    const volSum = s.volume.reduce((a, b) => a + b, 0);

    per.push({
      symbol: s.symbol,
      klass: s.klass,
      annVolPct: sd * Math.sqrt(BARS_PER_YEAR) * 100,
      kurtosis: kurt,
      retAc1: den1 > 0 ? num1 / den1 : 0,
      absRetAc1: denAbs > 0 ? numAbs / denAbs : 0,
      absRetAc288: denAbs > 0 ? numAbsLong / denAbs : 0,
      sqRetAc1: denSq > 0 ? numSq / denSq : 0,
      med24hRangePct: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
      p90_24hRangePct: sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 0,
      meanDailyTurnoverM: volSum / (n / BARS_PER_DAY) / 1e6,
    });
  }
  return per;
}

module.exports = {
  generateWorld, worldStats, resample, resampleFull, REGIMES, WORLD_TYPES,
  BARS_PER_DAY, BARS_PER_YEAR, MS_5M, SUBSTEPS, mulberry32, gaussian, studentT, clamp,
};

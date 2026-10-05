'use strict';
/**
 * VelocityX — candle-level backtest engine that mirrors the live executor.
 *
 * It deliberately mirrors `server/src/trader.ts` + `server/src/engine.ts` +
 * `server/src/scanner.ts`:
 *   • signals : EMA(11)/EMA(34) confirmed cross, evaluated at the closed 5m bar
 *               with `signalAt()` — the SAME compiled function the bot runs
 *   • entry   : market at the signal candle close (+ slippage)
 *   • stop    : 2 × ATR(14) → 1R
 *   • ladder  : TP1 1.5R closes 33 %, SL→breakeven; TP2 3R closes 50 % of the
 *               remainder, SL→TP1; TP3 4.5R closes the rest
 *   • reverse : opposite signal while open → close at market, then re-enter
 *   • sizing  : margin = 5 % of equity, 10× isolated leverage, ≤ 8 positions,
 *               one per symbol, entry refused when the symbol is not in the
 *               scanner's tradable top-N or a slot is unavailable
 *   • scanner : the repo's real gates (24h quote volume, 24h range, 15m ATR %,
 *               15m ADX, 15m/1h trend alignment, pegged detection) evaluated
 *               hourly from the generated candles — not assumed
 *   • fills   : gap-honest — a stop that gapped through fills at the open,
 *               never better than the stop; within a bar the adverse exit is
 *               assumed to happen BEFORE the favourable one
 *   • costs   : taker fee 0.05 % per side + 1 bp slippage per side + funding
 *   • liq     : isolated-margin liquidation is modelled (10× ⇒ ~ −9.5 %)
 *
 * NOT modelled: exchange downtime, partial fills, order rejection, API rate
 * limits, latency. All of those would make the results worse, not better.
 */
const path = require('path');
const ind = require(path.join(__dirname, '..', 'server', 'dist', 'indicators.js'));
const { BARS_PER_DAY, clamp, resampleFull } = require('./markets');

const { ema, atr, adx, signalAt } = ind;

// ------------------------------------------------------------------ helpers

function roundQty(qty, step) {
  if (step <= 0) return qty;
  return Math.floor(qty / step + 1e-9) * step;
}

/** Monotonic deque for rolling max/min over a fixed window. */
class Rolling {
  constructor(window, cmp) {
    this.window = window;
    this.cmp = cmp; // comparator: (a, b) => a.v >= b.v for max
    this.dq = [];
    this.i = 0;
  }
  push(v) {
    const dq = this.dq;
    while (dq.length && this.cmp(dq[dq.length - 1].v, v)) dq.pop();
    dq.push({ v, i: this.i });
    while (dq[0].i <= this.i - this.window) dq.shift();
    this.i++;
  }
  get value() {
    return this.dq.length ? this.dq[0].v : NaN;
  }
}

// ------------------------------------------------------------------- engine

function prepareSymbol(sym, cfg, seed) {
  const n = sym.close.length;
  const closes = Array.from(sym.close);
  const c5 = Array.from({ length: n }, (_, i) => ({
    time: i, closeTime: i, open: sym.open[i], high: sym.high[i], low: sym.low[i], close: sym.close[i], volume: sym.volume[i],
  }));
  const emaFast = ema(closes, 11);
  const emaSlow = ema(closes, 34);
  const atrSeries = atr(c5, 14);

  // Higher-timeframe views, precomputed once so a gate check is O(1).
  const build = (factor) => {
    const r = resampleFull(sym, factor);
    const cl = Array.from(r.close);
    const candles = Array.from({ length: r.n }, (_, i) => ({
      time: i, closeTime: i, open: r.open[i], high: r.high[i], low: r.low[i], close: r.close[i], volume: r.volume[i],
    }));
    return {
      factor, n: r.n, closeBar: r.closeBar, close: cl,
      emaFast: ema(cl, 11), emaSlow: ema(cl, 34), atr: atr(candles, 14), adx: adx(candles, 14),
    };
  };
  const tf15 = build(3);
  const tf60 = build(12);

  let f = (seed ^ 0x85ebca6b) >>> 0;
  const frand = () => {
    f = (f + 0x6d2b79f5) | 0;
    let t = Math.imul(f ^ (f >>> 15), 1 | f);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    symbol: sym.symbol,
    klass: sym.klass,
    step: sym.close[0] >= 1000 ? 0.001 : sym.close[0] >= 100 ? 0.01 : sym.close[0] >= 1 ? 0.1 : 1,
    minNotional: sym.close[0] >= 1000 ? 100 : 5,
    open: sym.open, high: sym.high, low: sym.low, close: sym.close, volume: sym.volume,
    emaFast, emaSlow, atrSeries, tf15, tf60, n,
    fundingBias: sym.fundingBias,
    frand,
    hi24: new Rolling(288, (a, b) => a <= b),
    lo24: new Rolling(288, (a, b) => a >= b),
    vol24: 0,
    volRing: new Float64Array(288),
    volIdx: 0,
    tradable: false, score: 0, gateInfo: null, watched: false,
  };
}

/** index of the higher-timeframe candle that has just closed at 5m bar b */
function tfIndex(b, factor) {
  return Math.floor((b + 1) / factor) - 1;
}

function pushCandles(state, b) {
  state.hi24.push(state.high[b]);
  state.lo24.push(state.low[b]);
  const old = state.volRing[state.volIdx];
  state.volRing[state.volIdx] = state.volume[b];
  state.vol24 += state.volume[b] - old;
  state.volIdx = (state.volIdx + 1) % 288;
}

/** Scanner gates for one symbol at the current closed bar (mirrors analyse()). */
function evaluateGate(state, b, gate) {
  const price = state.close[b];
  const hi = state.hi24.value, lo = state.lo24.value;
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || state.vol24 <= 0) return null;
  const i15 = tfIndex(b, 3);
  const i60 = tfIndex(b, 12);
  if (i15 < 35 || i60 < 35) return null; // not enough higher-timeframe history yet
  const range24hPct = ((hi - lo) / price) * 100;
  const atr15 = state.tf15.atr[i15];
  const atrPct = price > 0 && Number.isFinite(atr15) ? (atr15 / price) * 100 : 0;
  const adxVal = Number.isFinite(state.tf15.adx[i15]) ? state.tf15.adx[i15] : 0;
  const f15 = state.tf15.emaFast[i15], s15 = state.tf15.emaSlow[i15];
  const f1h = state.tf60.emaFast[i60], s1h = state.tf60.emaSlow[i60];
  if (![f15, s15, f1h, s1h].every(Number.isFinite)) return null;
  const change24hPct = b >= 288 ? ((price - state.close[b - 288]) / state.close[b - 288]) * 100 : 0;

  const trend = s15 < f15 && price > s15 ? 'UP' : 'DOWN';
  const trend1h = s1h < f1h ? 'UP' : 'DOWN';
  const alignment = trend === trend1h ? 1 : 0.55;
  const volatility = 0.4 * clamp(range24hPct / 25, 0, 1) * 100 + 0.35 * clamp(atrPct / 3, 0, 1) * 100 + 0.25 * clamp(Math.abs(change24hPct) / 15, 0, 1) * 100;
  const trendScore = clamp(adxVal / 45, 0, 1) * 100 * alignment;
  const liquidityScore = clamp(Math.log10(Math.max(1, state.vol24) / 1e6) / 2.5, 0, 1) * 100;
  const score = 0.45 * volatility + 0.3 * trendScore + 0.25 * liquidityScore;

  let tradable = true;
  let reason = 'tradable';
  if (state.klass === 'pegged') { tradable = false; reason = 'pegged'; }
  else if (state.vol24 < gate.minQuoteVolume24h) { tradable = false; reason = 'volume'; }
  else if (range24hPct < 1.5 || atrPct < 0.15) { tradable = false; reason = 'pegged-behaviour'; }
  else if (range24hPct < gate.minRange24hPct) { tradable = false; reason = 'range'; }
  else if (atrPct < gate.minAtrPct) { tradable = false; reason = 'atr'; }
  else if (adxVal < gate.minAdx) { tradable = false; reason = 'adx'; }
  else if (trend !== trend1h) { tradable = false; reason = 'trend-mismatch'; }

  state.gateInfo = { range24hPct, atrPct, adx: adxVal, score, tradable, reason, volatility, trendScore, liquidityScore, quoteVolume24h: state.vol24 };
  return state.gateInfo;
}

function lastFinite(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return arr[i];
  return NaN;
}

/**
 * Run one simulation.
 * @param {object} world   output of markets.generateWorld (or CSV loader)
 * @param {object} cfg     strategy / execution configuration
 * @param {object} [ctrl]  { signalPlan } for paired random-entry baselines
 */
function runBacktest(world, cfg, ctrl) {
  const c = Object.assign(
    {
      startEquity: 1000,
      tradeSizePercent: 5,
      leverage: 10,
      maxPositions: 8,
      atrSlMultiplier: 2,
      tpRrFactor: 1.5,
      tp1ClosePct: 33,
      tp2ClosePct: 50,
      feeRate: 0.0005,
      slippage: 0.0001,
      funding: true,
      liquidation: true,
      maintMarginRate: 0.005,
      signalSource: 'ema', // 'ema' | 'random' | 'flip'
      signalTimeframe: '5m', // '5m' | '15m' | '1h' — the candles the indicator runs on
      barOrder: 'adverse', // within a bar: 'adverse' = SL before TP (conservative), 'favourable' = TP ladder first
      noReverse: false,    // variant: ignore opposite signals instead of close & reverse
      randomSignalRate: 0.01,
      cooldownBars: 0, // extra bars after a close before re-entry on a symbol
      minHoldBars: 0,
      scannerEnabled: true,
      maxAtEntryAtrPct: 100, // risk filter: skip signals when 15m ATR% is extreme
      trailing: false,
      scanner: { minQuoteVolume24h: 20e6, minRange24hPct: 3, minAtrPct: 0.6, minAdx: 18 },
      gateRefreshBars: 12,
      warmupBars: 420,
    },
    cfg || {}
  );
  const n = world.bars;
  const states = world.symbols.map((s, i) => prepareSymbol(s, c, (world.seed * 7919 + i * 104729) >>> 0));

  const rnd = ctrl && ctrl.rnd ? ctrl.rnd : Math.random;
  const positions = new Map(); // symbol -> trade
  const trades = [];
  let cash = c.startEquity;
  let peak = c.startEquity;
  let maxDD = 0;
  let maxDDbars = 0;
  let exposureBars = 0;
  let fundingPaid = 0;
  let feesPaid = 0;
  let signals = 0;
  let signalsActed = 0;
  let signalsSkippedSlots = 0;
  let signalsSkippedGate = 0;
  let liquidations = 0;
  let barsInPositions = 0;
  const gateStats = { refreshes: 0, watchers: 0, tradable: 0, evaluated: 0, reasons: {} };
  const equityCurve = new Float64Array(n);
  const dailyEquity = [];
  let lastFundingBar = 0;
  let totalMarginUsed = 0;
  let marginBars = 0;
  const cooldown = new Map();
  let maxConcurrent = 0;

  const marginOf = (symbol) => {
    const t = positions.get(symbol);
    return t ? t.margin : 0;
  };
  const marginUsed = () => {
    let m = 0;
    for (const t of positions.values()) m += t.margin;
    return m;
  };
  const unrealized = () => {
    let u = 0;
    for (const t of positions.values()) {
      const px = t.lastPrice;
      u += (px - t.entry) * (t.side === 'LONG' ? 1 : -1) * t.qtyRemaining;
    }
    return u;
  };
  const equityNow = () => cash + unrealized();

  const closeTradePart = (t, qty, price, reason, atBar) => {
    const dir = t.side === 'LONG' ? 1 : -1;
    const gross = (price - t.entry) * dir * qty;
    const fee = price * qty * c.feeRate;
    cash += gross - fee;
    t.fees += fee;
    feesPaid += fee;
    t.qtyRemaining -= qty;
    t.realized += gross - fee;
  };

  const finalize = (t, reason, atBar) => {
    t.exitBar = atBar;
    t.exitReason = reason;
    t.holdBars = atBar - t.entryBar;
    t.returnPct = ((t.exitEquity - t.margin) / t.margin) * 100;
    t.result = t.realized > 0 ? 'WIN' : 'LOSS';
    positions.delete(t.symbol);
    cooldown.set(t.symbol, atBar + c.cooldownBars);
    trades.push(t);
  };

  // ------------------------------------------------------------------ main loop
  for (let b = 0; b < n; b++) {
    for (const st of states) pushCandles(st, b);

    // ---- hourly scanner refresh (mirrors a 60 s scan cycle closely enough) --
    if (b % c.gateRefreshBars === 0 && b >= c.warmupBars * 0.5) {
      const rows = [];
      for (const st of states) {
        const g = evaluateGate(st, b, c.scanner);
        st.tradable = c.scannerEnabled && !!(g && g.tradable);
        st.score = g ? g.score : 0;
        if (g) rows.push(st);
      }
      rows.sort((a, z) => z.score - a.score);
      gateStats.refreshes++;
      gateStats.evaluated += states.length;
      gateStats.tradable += rows.filter((r) => r.tradable).length;
      for (const st of states) {
        const reason = st.gateInfo ? (st.gateInfo.tradable ? 'tradable' : st.gateInfo.reason) : 'no-history';
        gateStats.reasons[reason] = (gateStats.reasons[reason] || 0) + 1;
      }
      const watch = new Set(rows.filter((r) => r.tradable).slice(0, c.maxPositions).map((r) => r.symbol));
      gateStats.watchers += watch.size;
      if (world.primary) watch.add(world.primary); // engine always watches the primary symbol
      for (const st of states) st.watched = watch.has(st.symbol);
    }

    // ---- manage open positions on THIS bar --------------------------------
    for (const st of states) {
      const t = positions.get(st.symbol);
      if (!t) continue;
      const dir = t.side === 'LONG' ? 1 : -1;
      const o = st.open[b], hi = st.high[b], lo = st.low[b], cl = st.close[b];

      // excursions in R units (for the post-mortem analysis)
      const mfe = dir > 0 ? hi - t.entry : t.entry - lo;
      const mae = dir > 0 ? t.entry - lo : hi - t.entry;
      if (mfe / t.riskPerUnit > t.mfeR) t.mfeR = mfe / t.riskPerUnit;
      if (mae / t.riskPerUnit > t.maeR) t.maeR = mae / t.riskPerUnit;

      // liquidation (isolated): adverse move ≈ 1/leverage − maintenance margin
      if (c.liquidation) {
        const liq = dir > 0 ? t.entry * (1 - 1 / t.leverage + c.maintMarginRate) : t.entry * (1 + 1 / t.leverage - c.maintMarginRate);
        const breached = dir > 0 ? Math.min(o, lo) <= liq : Math.max(o, hi) >= liq;
        if (breached) {
          const px = dir > 0 ? Math.min(o, lo, liq) : Math.max(o, hi, liq);
          const gross = (px - t.entry) * dir * t.qtyRemaining;
          cash += gross; // isolated: margin already committed; loss ≈ margin
          t.realized += gross;
          t.qtyRemaining = 0;
          t.liquidated = true;
          liquidations++;
          t.exitEquity = cash + unrealized();
          finalize(t, 'LIQUIDATION', b);
          continue;
        }
      }

      const checkStop = () => {
        const slTouched = dir > 0 ? Math.min(o, lo) <= t.slCur : Math.max(o, hi) >= t.slCur;
        if (!slTouched) return false;
        const px = dir > 0 ? Math.min(t.slCur, o) : Math.max(t.slCur, o);
        const fill = px * (1 - dir * c.slippage);
        closeTradePart(t, t.qtyRemaining, fill, 'SL', b);
        t.exitPrice = fill;
        t.exitEquity = cash + unrealized();
        finalize(t, t.tp1Filled || t.tp2Filled ? 'SL_PARTIAL' : 'SL', b);
        return true;
      };
      // conservative default: the adverse exit is assumed to happen FIRST
      if (c.barOrder === 'adverse' && checkStop()) continue;

      // take profits ladder (TP1 → BE stop → TP2 → TP1 stop → TP3)
      const touch = (lvl) => (dir > 0 ? hi >= lvl : lo <= lvl);
      const fillPx = (lvl) => (dir > 0 ? Math.max(lvl, o) : Math.min(lvl, o)) * (1 + dir * c.slippage);
      let stillOpen = true;
      if (!t.tp1Filled && touch(t.tp1) && t.q1 > 0) {
        closeTradePart(t, t.q1, fillPx(t.tp1), 'TP1', b);
        t.tp1Filled = true;
        t.slCur = t.entry; // SL → breakeven
        // worst-case: the same bar can come back and stop the remainder at BE
        if (dir > 0 ? lo <= t.slCur : hi >= t.slCur) {
          closeTradePart(t, t.qtyRemaining, t.slCur * (1 - dir * c.slippage), 'BE_STOP', b);
          t.exitPrice = t.slCur;
          t.exitEquity = cash + unrealized();
          finalize(t, 'SL_PARTIAL', b);
          stillOpen = false;
        }
      }
      if (stillOpen && t.tp1Filled && !t.tp2Filled && touch(t.tp2) && t.q2 > 0) {
        closeTradePart(t, t.q2, fillPx(t.tp2), 'TP2', b);
        t.tp2Filled = true;
        t.slCur = t.tp1; // SL → TP1
        if (dir > 0 ? lo <= t.slCur : hi >= t.slCur) {
          closeTradePart(t, t.qtyRemaining, t.slCur * (1 - dir * c.slippage), 'TP1_STOP', b);
          t.exitPrice = t.slCur;
          t.exitEquity = cash + unrealized();
          finalize(t, 'SL_PARTIAL', b);
          stillOpen = false;
        }
      }
      if (stillOpen && t.tp2Filled && !t.tp3Filled && touch(t.tp3) && t.qtyRemaining > 0) {
        closeTradePart(t, t.qtyRemaining, fillPx(t.tp3), 'TP3', b);
        t.tp3Filled = true;
        t.exitPrice = t.tp3;
        t.exitEquity = cash + unrealized();
        finalize(t, 'TP3', b);
        stillOpen = false;
      }

      // optimistic ordering only: the stop (possibly moved by the ladder) is
      // evaluated after the take-profit levels
      if (stillOpen && c.barOrder === 'favourable' && checkStop()) continue;

      // optional trailing stop variant (sensitivity studies only)
      if (stillOpen && c.trailing) {
        const fav = dir > 0 ? hi : lo;
        t.peak = dir > 0 ? Math.max(t.peak, fav) : Math.min(t.peak, fav);
        const trailLevel = t.peak - dir * t.riskPerUnit * c.trailingR;
        if (dir > 0 ? trailLevel > t.slCur : trailLevel < t.slCur) t.slCur = trailLevel;
      }

      const t2 = positions.get(st.symbol);
      if (t2) t2.lastPrice = cl;
    }

    // funding every 8h (96 bars)
    if (c.funding && b - lastFundingBar >= 96) {
      lastFundingBar = b;
      for (const t of positions.values()) {
        const st = states.find((s) => s.symbol === t.symbol);
        const rate = clamp(st.fundingBias + (st.frand() - 0.5) * 0.0006, -0.0075, 0.0075);
        const dir = t.side === 'LONG' ? 1 : -1;
        const cost = t.notional * rate * dir; // long pays a positive rate
        cash -= cost;
        t.fundingCost += cost;
        fundingPaid += cost;
      }
    }

    // ---- signals at the close of bar b ------------------------------------
    if (b >= c.warmupBars) {
      for (const st of states) {
        if (!st.watched) continue;
        // ---- indicator timeframe -------------------------------------------
        let fast = st.emaFast, slow = st.emaSlow, atrVal, sigIdx;
        if (c.signalTimeframe === '15m') {
          if ((b + 1) % 3 !== 0) continue;
          sigIdx = tfIndex(b, 3);
          if (sigIdx < 35) continue;
          fast = st.tf15.emaFast; slow = st.tf15.emaSlow; atrVal = st.tf15.atr[sigIdx];
        } else if (c.signalTimeframe === '1h') {
          if ((b + 1) % 12 !== 0) continue;
          sigIdx = tfIndex(b, 12);
          if (sigIdx < 35) continue;
          fast = st.tf60.emaFast; slow = st.tf60.emaSlow; atrVal = st.tf60.atr[sigIdx];
        } else {
          sigIdx = b;
          atrVal = st.atrSeries[b];
        }
        let side = null;
        if (c.signalSource === 'random') {
          if (rnd() < c.randomSignalRate) side = rnd() < 0.5 ? 'LONG' : 'SHORT';
        } else {
          side = signalAt(fast, slow, sigIdx);
          if (side && c.signalSource === 'flip') side = side === 'LONG' ? 'SHORT' : 'LONG';
        }
        if (!side) continue;
        if (!Number.isFinite(atrVal) || atrVal <= 0) continue;

        const open = positions.get(st.symbol);
        if (open) {
          const opposite = (side === 'LONG' && open.side === 'SHORT') || (side === 'SHORT' && open.side === 'LONG');
          if (!opposite) continue;
        }

        signals++;
        if (b - (cooldown.get(st.symbol) ?? -1e9) < 0) continue;

        // the primary symbol is exempt from the scanner gate (mirrors trader.ts)
        const gateOk = st.symbol === world.primary || !c.scannerEnabled || st.tradable;
        const atrPctNow = (atrVal / st.close[b]) * 100;
        if (!gateOk || atrPctNow > c.maxAtEntryAtrPct) { signalsSkippedGate++; continue; }
        if (open && c.noReverse) continue;
        if (open) {
          // close & reverse — always allowed for a held symbol
          const dir = open.side === 'LONG' ? 1 : -1;
          const px = st.close[b] * (1 - dir * c.slippage);
          closeTradePart(open, open.qtyRemaining, px, 'REVERSE', b);
          open.exitPrice = px;
          open.exitEquity = cash + unrealized();
          finalize(open, 'REVERSE', b);
        }
        if (positions.size >= c.maxPositions) { signalsSkippedSlots++; continue; }

        // ---- sizing exactly like trader.placeEntry ---------------------------
        const equity = equityNow();
        const mu = marginUsed();
        const available = Math.max(0, equity - mu);
        const perTrade = (equity * c.tradeSizePercent) / 100;
        const freeSlots = Math.max(0, c.maxPositions - positions.size);
        const freeUsable = Math.max(0, Math.min(available, equity) * 0.95 - mu);
        const reserved = Math.max(0, freeSlots - 1) * perTrade * 0.5;
        const usable = Math.max(0, freeUsable - reserved);
        let margin = Math.max(0, Math.min(perTrade, usable > 0 ? usable : freeUsable));
        if (margin <= 0) { signalsSkippedSlots++; continue; }

        const entry = st.close[b] * (1 + (side === 'LONG' ? 1 : -1) * c.slippage);
        let qty = roundQty((margin * c.leverage) / entry, st.step);
        const minQty = st.minNotional / entry;
        if (qty < minQty) qty = Math.ceil(minQty / st.step - 1e-9) * st.step;
        if (qty <= 0) { signalsSkippedSlots++; continue; }
        const notional = qty * entry;
        margin = notional / c.leverage;
        if (margin > available) { signalsSkippedSlots++; continue; }

        const slDist = atrVal * c.atrSlMultiplier;
        const dir = side === 'LONG' ? 1 : -1;
        const { q1, q2, q3 } = splitQty(qty, st.step, c.tp1ClosePct, c.tp2ClosePct);

        const t = {
          symbol: st.symbol,
          side,
          entry,
          entryBar: b,
          qty,
          q1, q2, q3,
          qtyRemaining: qty,
          riskPerUnit: slDist,
          initialRisk: slDist * qty,
          slCur: entry - dir * slDist,
          tp1: entry + dir * slDist * c.tpRrFactor,
          tp2: entry + dir * slDist * c.tpRrFactor * 2,
          tp3: entry + dir * slDist * c.tpRrFactor * 3,
          notional,
          margin,
          leverage: c.leverage,
          realized: 0,
          fees: 0,
          fundingCost: 0,
          tp1Filled: false,
          tp2Filled: false,
          tp3Filled: false,
          liquidated: false,
          mfeR: 0,
          maeR: 0,
          lastPrice: entry,
          peak: entry,
          atrPctAtEntry: (atrVal / entry) * 100,
        };
        // entry taker fee, booked like the live/paper executor
        const entryFee = notional * c.feeRate;
        cash -= entryFee;
        t.fees += entryFee;
        feesPaid += entryFee;
        t.realized -= entryFee;
        positions.set(st.symbol, t);
        signalsActed++;
      }
    }

    // ---- mark to market ---------------------------------------------------
    let u = 0, mu2 = 0;
    for (const t of positions.values()) {
      const st = states.find((s) => s.symbol === t.symbol);
      t.lastPrice = st.close[b];
      u += (t.lastPrice - t.entry) * (t.side === 'LONG' ? 1 : -1) * t.qtyRemaining;
      mu2 += t.margin;
    }
    if (positions.size > maxConcurrent) maxConcurrent = positions.size;
    if (positions.size > 0) { barsInPositions += 1; }
    totalMarginUsed += mu2;
    marginBars += 1;
    const eq = cash + u;
    equityCurve[b] = eq;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
    if ((b + 1) % BARS_PER_DAY === 0) dailyEquity.push(eq);
    if (positions.size > 0) exposureBars++;
  }

  // finalise anything still open at the end of the sample
  for (const t of Array.from(positions.values())) {
    const st = states.find((s) => s.symbol === t.symbol);
    const dir = t.side === 'LONG' ? 1 : -1;
    closeTradePart(t, t.qtyRemaining, st.close[n - 1] * (1 - dir * c.slippage), 'EOD', n - 1);
    t.exitPrice = st.close[n - 1];
    t.exitEquity = cash;
    finalize(t, 'EOD', n - 1);
  }

  // ------------------------------------------------------------------ metrics
  const closed = trades.filter((t) => t.exitReason !== 'EOD' || true);
  const netPnl = cash - c.startEquity;
  const wins = closed.filter((t) => t.realized > 0);
  const losses = closed.filter((t) => t.realized <= 0);
  const grossWin = wins.reduce((a, t) => a + t.realized, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.realized, 0));
  const rMultiples = closed.map((t) => t.realized / t.initialRisk);
  // R histogram (0.25R bins from −1.5R to +6R, plus overflow) so the report can
  // show the distribution without shipping hundreds of thousands of trades.
  const R_MIN = -1.5, R_MAX = 6, R_STEP = 0.25;
  const rBins = new Array(Math.round((R_MAX - R_MIN) / R_STEP) + 2).fill(0);
  for (const x of rMultiples) {
    if (x < R_MIN) rBins[0]++;
    else if (x >= R_MAX) rBins[rBins.length - 1]++;
    else rBins[1 + Math.floor((x - R_MIN) / R_STEP)]++;
  }
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const std = (arr) => {
    if (arr.length < 2) return 0;
    const m = avg(arr);
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1));
  };

  // daily returns → Sharpe / Sortino
  const dailyRet = [];
  for (let i = 1; i < dailyEquity.length; i++) dailyRet.push(dailyEquity[i] / dailyEquity[i - 1] - 1);
  const dMean = avg(dailyRet);
  const dStd = std(dailyRet);
  const downside = std(dailyRet.filter((r) => r < 0));
  const years = n / (BARS_PER_DAY * 365);
  const cagr = c.startEquity > 0 && cash > 0 ? Math.pow(cash / c.startEquity, 1 / Math.max(years, 1e-9)) - 1 : -1;

  let maxConsecLosses = 0, cur = 0;
  for (const t of closed) {
    if (t.realized <= 0) { cur++; maxConsecLosses = Math.max(maxConsecLosses, cur); } else cur = 0;
  }
  const longTrades = closed.filter((t) => t.side === 'LONG');
  const shortTrades = closed.filter((t) => t.side === 'SHORT');
  const sum = (f) => (arr) => arr.reduce((a, t) => a + f(t), 0);
  const tp1Rate = closed.length ? closed.filter((t) => t.tp1Filled).length / closed.length : 0;
  const tp2Rate = closed.length ? closed.filter((t) => t.tp2Filled).length / closed.length : 0;
  const tp3Rate = closed.length ? closed.filter((t) => t.tp3Filled).length / closed.length : 0;

  return {
    worldType: world.worldType,
    seed: world.seed,
    bars: n,
    years,
    startEquity: c.startEquity,
    finalEquity: cash,
    netPnl,
    totalReturnPct: (cash / c.startEquity - 1) * 100,
    cagrPct: cagr * 100,
    maxDrawdownPct: maxDD,
    sharpe: dStd > 0 ? (dMean / dStd) * Math.sqrt(365) : 0,
    sortino: downside > 0 ? (dMean / downside) * Math.sqrt(365) : 0,
    calmar: maxDD > 0 ? (cagr * 100) / maxDD : 0,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancyR: avg(rMultiples),
    expectancyRStd: std(rMultiples),
    trades: closed.length,
    tradesPerMonth: closed.length / Math.max(years * 12, 1e-9),
    avgHoldBars: avg(closed.map((t) => t.holdBars)),
    avgHoldHours: avg(closed.map((t) => t.holdBars)) / 12,
    exposurePct: (exposureBars / n) * 100,
    avgMarginUsed: totalMarginUsed / Math.max(marginBars, 1),
    maxConcurrent,
    tp1Rate: tp1Rate * 100,
    tp2Rate: tp2Rate * 100,
    tp3Rate: tp3Rate * 100,
    slRate: closed.length ? (closed.filter((t) => t.exitReason === 'SL').length / closed.length) * 100 : 0,
    reverseRate: closed.length ? (closed.filter((t) => t.exitReason === 'REVERSE').length / closed.length) * 100 : 0,
    beStops: closed.filter((t) => t.exitReason === 'SL_PARTIAL').length,
    liquidations,
    feesPaid,
    fundingPaid,
    totalCosts: feesPaid + fundingPaid,
    grossPnl: netPnl + feesPaid + fundingPaid, // P&L before fees/funding — the "signal + ladder" edge
    costsPctOfStart: ((feesPaid + fundingPaid) / c.startEquity) * 100,
    bestTradeR: rMultiples.length ? Math.max(...rMultiples) : 0,
    worstTradeR: rMultiples.length ? Math.min(...rMultiples) : 0,
    bestTradeUsdt: closed.length ? Math.max(...closed.map((t) => t.realized)) : 0,
    worstTradeUsdt: closed.length ? Math.min(...closed.map((t) => t.realized)) : 0,
    maxConsecLosses,
    avgWinR: avg(wins.map((t) => t.realized / t.initialRisk)),
    avgLossR: avg(losses.map((t) => t.realized / t.initialRisk)),
    winRateLong: longTrades.length ? (longTrades.filter((t) => t.realized > 0).length / longTrades.length) * 100 : 0,
    winRateShort: shortTrades.length ? (shortTrades.filter((t) => t.realized > 0).length / shortTrades.length) * 100 : 0,
    expRLong: avg(longTrades.map((t) => t.realized / t.initialRisk)),
    expRShort: avg(shortTrades.map((t) => t.realized / t.initialRisk)),
    nLong: longTrades.length,
    nShort: shortTrades.length,
    mfeR: avg(closed.map((t) => t.mfeR)),
    maeR: avg(closed.map((t) => t.maeR)),
    rBins,
    rBinEdges: { min: R_MIN, max: R_MAX, step: R_STEP },
    avgRiskUsdt: avg(closed.map((t) => t.initialRisk)),
    feesPerTrade: closed.length ? feesPaid / closed.length : 0,
    monthlyReturnsPct: monthlyReturns(dailyEquity),
    dailyEquity,
    equityCurve,
    gateStats,
    signals,
    signalsActed,
    signalsSkippedSlots,
    signalsSkippedGate,
    ruined: cash < c.startEquity * 0.2,
    capitalPreserved: cash >= c.startEquity,
    // sampled trade journal: every Nth trade (keeps the artifact small)
    tradesDetail: closed.filter((_, i) => i % Math.max(1, Math.floor(closed.length / 400)) === 0).map((t) => ({
      symbol: t.symbol, side: t.side, entryBar: t.entryBar, exitBar: t.exitBar,
      realized: +t.realized.toFixed(4), r: +(t.realized / t.initialRisk).toFixed(3),
      reason: t.exitReason, mfeR: +t.mfeR.toFixed(2), maeR: +t.maeR.toFixed(2),
      holdBars: t.holdBars, atrPct: +t.atrPctAtEntry.toFixed(3),
    })),
  };
}

function monthlyReturns(dailyEquity) {
  const out = [];
  if (!dailyEquity.length) return out;
  let monthStart = dailyEquity[0];
  let day = 0;
  for (let i = 1; i < dailyEquity.length; i++) {
    day++;
    if (day >= 30) {
      out.push((dailyEquity[i] / monthStart - 1) * 100);
      monthStart = dailyEquity[i];
      day = 0;
    }
  }
  if (day > 0) out.push((dailyEquity[dailyEquity.length - 1] / monthStart - 1) * 100);
  return out;
}

/** Mirror of trader.splitQty(). */
function splitQty(qty, step, p1, p2) {
  if (step <= 0 || qty < 3 * step - 1e-12) return { q1: 0, q2: 0, q3: qty };
  const floor = (v) => Math.floor(v / step + 1e-9) * step;
  let q1 = floor(qty * (p1 / 100));
  if (q1 < step) q1 = step;
  let rem = qty - q1;
  if (rem < 2 * step) { q1 -= step; rem = qty - q1; }
  let q2 = floor(rem * (p2 / 100));
  if (q2 < step) q2 = step;
  if (rem - q2 < step) q2 = rem - step;
  const q3 = rem - q2;
  if (q3 < step || q2 < step || q1 < step) return { q1: 0, q2: 0, q3: qty };
  return { q1, q2, q3 };
}

module.exports = { runBacktest, splitQty, evaluateGate, prepareSymbol, pushCandles, Rolling, lastFinite };

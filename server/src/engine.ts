/**
 * Signal engine — multi-symbol.
 *
 * Watches every symbol the market scanner selected (top high-volatility
 * trending markets, ≤ maxPositions) plus the primary chart symbol, and fires
 * signals from the indicator's non-repaint rule (EMA11/EMA34 confirmed cross)
 * on closed 5m candles.
 *
 * Only candles that CLOSE AFTER a symbol was first watched are acted on — no
 * backfill, no repainting, no acting on historical crossovers.
 */
import { api, feedNow } from './binance';
import { computeSnapshot, signalAt, SignalSide, Candle, ema } from './indicators';
import { getSettings } from './settings';
import { saveSignal, SignalRecord, allSignals, openTradeOn } from './store';
import { trader, OpenSignal } from './trader';
import { scanner } from './scanner';
import { candleStore } from './candles';
import { emit } from './broadcast';

function rndId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export interface IndicatorState {
  symbol: string;
  interval: string;
  lastPrice: number;
  atr: number;
  ribbonBull: boolean;
  emas: number[];
  emaExtra: number;
  lastSignal: SignalRecord | null;
  lastClosedCandleTime: number;
  engineStartedAt: number;
  tradable?: boolean;
}

class Engine {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private startedAt = Date.now();
  private lastProcessed = new Map<string, number>();
  private baselined = new Set<string>();
  private lastOffline: boolean | null = null;
  private klines: Candle[] = [];
  private snapshot: ReturnType<typeof computeSnapshot> | null = null;
  private lastSignalRec: SignalRecord | null = null;
  private lastTickAt = 0;

  start(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    void this.tick(true);
    this.timer = setInterval(() => void this.tick(), 2000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Symbols under the engine's watch right now. */
  activeSymbols(): string[] {
    const s = getSettings();
    const set = new Set<string>([s.symbol]);
    if (s.autoScan) for (const sym of scanner.activeSymbols()) set.add(sym);
    for (const sym of trader.managedSymbols()) set.add(sym); // never lose sight of an open position
    return [...set];
  }

  lastTick(): number {
    return this.lastTickAt;
  }

  private async tick(first = false): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const s = getSettings();
      const symbols = this.activeSymbols();
      this.lastTickAt = Date.now();

      // Feed mode flip (live <-> offline demo): re-baseline, never act on a splice.
      const off = api.isOffline();
      if (this.lastOffline !== null && this.lastOffline !== off) {
        this.baselined.clear();
        this.lastProcessed.clear();
        emit('log', { level: 'info', msg: 'Feed mode changed — engine re-baselined (no action on transition candles)' });
      }
      this.lastOffline = off;

      for (const symbol of symbols) {
        try {
          await candleStore.ensure(symbol, s.interval, 500);
        } catch (e: any) {
          console.error('[engine] candles', symbol, e?.message || e);
          continue;
        }
        const candles = candleStore.get(symbol, s.interval);
        if (candles.length < 60) continue;

        const snap = computeSnapshot(candles, s.emaLengths, s.emaExtraLength, s.atrLength);

        const now = feedNow();
        let idx = candles.length - 1;
        if (candles[idx].closeTime > now) idx -= 1;
        if (idx < 5) continue;
        const closed = candles[idx];

        if (!this.baselined.has(symbol)) {
          this.baselined.add(symbol);
          this.lastProcessed.set(symbol, closed.time);
          if (first) console.log(`[engine] ${symbol}: baseline candle ${new Date(closed.time).toISOString()} — waiting for next close`);
          continue;
        }
        const prev = this.lastProcessed.get(symbol) ?? 0;
        if (closed.time <= prev) continue;
        this.lastProcessed.set(symbol, closed.time);

        // primary symbol keeps the chart snapshot
        if (symbol === s.symbol) {
          this.klines = candles;
          this.snapshot = snap;
        }

        const sig: SignalSide | null = signalAt(snap.emas[1], snap.emas[7], idx);
        const atrVal = snap.atrSeries[idx];
        if (!sig || !Number.isFinite(atrVal)) continue;

        const record: SignalRecord = {
          id: rndId(),
          symbol,
          time: closed.time,
          detectedAt: Date.now(),
          side: sig,
          price: closed.close,
          atr: atrVal,
          acted: false,
          tradeId: null,
        };
        saveSignal(record);
        if (symbol === s.symbol) this.lastSignalRec = record;
        console.log(`[engine] SIGNAL ${sig} ${symbol} @ ${closed.close} (ATR ${atrVal.toFixed(4)}) candle=${new Date(closed.time).toISOString()}`);
        emit('signal', { signal: record });
        emit('log', {
          level: sig === 'LONG' ? 'win' : 'loss',
          msg: `${symbol} signal ${sig} @ ${closed.close} — ATR ${atrVal.toFixed(4)}`,
        });

        await trader.onSignal({ record, side: sig, price: closed.close, atr: atrVal } as OpenSignal);
      }
    } catch (e: any) {
      console.error('[engine]', e?.message || e);
      emit('error', { message: `Engine: ${e?.message || e}` });
    } finally {
      this.running = false;
    }
  }

  /** Indicator state for a symbol (defaults to the primary chart symbol). */
  state(symbol?: string): IndicatorState | null {
    const s = getSettings();
    const sym = symbol ?? s.symbol;
    const candles = candleStore.get(sym, s.interval);
    if (candles.length < 2) return null;
    const snap = computeSnapshot(candles, s.emaLengths, s.emaExtraLength, s.atrLength);
    const i = candles.length - 1;
    const last = candles[i];
    const vals = snap.emas.map((a) => a[i]);
    const bull = vals[7] < vals[1];
    return {
      symbol: sym,
      interval: s.interval,
      lastPrice: last.close,
      atr: Number.isFinite(snap.atrSeries[i]) ? snap.atrSeries[i] : snap.atrSeries[i - 1] || 0,
      ribbonBull: bull,
      emas: vals,
      emaExtra: snap.emaExtra[i],
      lastSignal: this.lastSignalRec && this.lastSignalRec.symbol === sym ? this.lastSignalRec : null,
      lastClosedCandleTime: candleStore.closed(sym, s.interval).slice(-1)[0]?.time ?? 0,
      engineStartedAt: this.startedAt,
      tradable: scanner.result() ? scanner.isTradable(sym) : undefined,
    };
  }

  /** Indicator state for every watched symbol (dashboard + scanner). */
  states(): Record<string, IndicatorState> {
    const out: Record<string, IndicatorState> = {};
    for (const sym of this.activeSymbols()) {
      const st = this.state(sym);
      if (st) out[sym] = st;
    }
    return out;
  }

  /** Chart payload: candles + ribbon + trade levels (aligned arrays). */
  chart(limit = 300, symbol?: string): any {
    const s = getSettings();
    const sym = symbol ?? s.symbol;
    const all = symbol && symbol !== s.symbol ? candleStore.get(sym, s.interval) : this.klines.length ? this.klines : candleStore.get(sym, s.interval);
    const candles = all.slice(-limit);
    if (!candles.length) return { symbol: sym, candles: [], emas: [], emaExtra: [], signals: [], trade: null, trades: [] };
    const snap = computeSnapshot(all, s.emaLengths, s.emaExtraLength, s.atrLength);
    const start = all.length - candles.length;
    const ribbon = snap.emas.map((arr) => arr.slice(start));
    const extra = snap.emaExtra.slice(start);
    const times = new Set(candles.map((c) => c.time));
    const signals = allSignals()
      .filter((x) => x.symbol === sym && times.has(x.time))
      .map((x) => ({ time: x.time, side: x.side, price: x.price, id: x.id, acted: x.acted }));
    const t = openTradeOn(sym);
    return {
      symbol: sym,
      candles: candles.map((c) => ({
        time: Math.floor(c.time / 1000),
        open: c.open, high: c.high, low: c.low, close: c.close,
      })),
      emas: ribbon.map((arr) =>
        arr.map((v, k) => ({ time: Math.floor(candles[k].time / 1000), value: Number.isFinite(v) ? v : null })).filter((p) => p.value !== null),
      ),
      emaExtra: extra.map((v, k) => ({ time: Math.floor(candles[k].time / 1000), value: Number.isFinite(v) ? v : null })).filter((p) => p.value !== null),
      signals,
      trade: t ? {
        side: t.side, entry: t.entryPrice, sl: t.slCurrent, slStage: t.slStage,
        tp1: t.tp1, tp2: t.tp2, tp3: t.tp3, status: t.status,
        tp1Filled: t.tp1Filled, tp2Filled: t.tp2Filled, tp3Filled: t.tp3Filled,
      } : null,
    };
  }
}

export const engine = new Engine();

// ---------------------------------------------------------------------------
// MTF dashboard (cached, budget-friendly)
// ---------------------------------------------------------------------------

let mtfCache: { at: number; data: any } | null = null;

/** Port of the indicator's TREND ANALYSIS dashboard. */
export async function mtfDashboard(symbol?: string): Promise<any> {
  const s = getSettings();
  const sym = symbol ?? s.symbol;
  const cacheKey = `${sym}`;
  if (mtfCache && mtfCache.data?.symbol === cacheKey && Date.now() - mtfCache.at < 30_000) return mtfCache.data;
  const tfs = s.dashboardTimeframes;
  const out: any = { symbol: sym, timeframes: [], atr: 0, ribbonBull: false, overall: '—' };
  const st = engine.state(sym);
  if (st) {
    out.atr = st.atr;
    out.ribbonBull = st.ribbonBull;
  }
  let bull = 0;
  for (const tf of tfs) {
    let isBull = false;
    try {
      const ks = await api.klines(sym, tfToInterval(tf), 300, 30_000);
      const closes = ks.map((c) => c.close);
      const f = ema(closes, s.emaLengths[1]);
      const sl = ema(closes, s.emaLengths[7]);
      const i = ks.length - 1;
      isBull = Number.isFinite(f[i]) && Number.isFinite(sl[i]) && sl[i] < f[i];
    } catch { isBull = false; }
    if (isBull) bull += 1;
    out.timeframes.push({ tf: labelTf(tf), bull: isBull });
  }
  out.bullCount = bull;
  out.overall = bull >= Math.ceil(tfs.length / 2) ? 'BULLISH' : 'BEARISH';
  mtfCache = { at: Date.now(), data: out };
  return out;
}

function tfToInterval(tf: string): string {
  switch (tf) {
    case '5': return '5m';
    case '15': return '15m';
    case '30': return '30m';
    case '60': return '1h';
    case '240': return '4h';
    case 'D': return '1d';
    default: return '5m';
  }
}
function labelTf(tf: string): string {
  switch (tf) {
    case '5': return '5m';
    case '15': return '15m';
    case '30': return '30m';
    case '60': return '1h';
    case '240': return '4h';
    case 'D': return '1D';
    default: return tf + 'm';
  }
}

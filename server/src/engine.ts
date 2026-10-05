/**
 * Signal engine — syncs closed 5m candles from Binance and fires signals using
 * the indicator's non-repaint rule (EMA2/EMA8 = EMA(11)/EMA(34) confirmed values).
 *
 * Only candles that CLOSE AFTER the engine starts are acted on — no backfill,
 * no repainting, no acting on historical crossovers.
 */
import { api, feedNow } from './binance';
import { computeSnapshot, signalAt, SignalSide, Candle, screenerState } from './indicators';
import { getSettings } from './settings';
import { saveSignal, SignalRecord, allSignals, activeTrade } from './store';
import { trader, OpenSignal } from './trader';
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
  emas: number[]; // current ribbon values
  emaExtra: number;
  lastSignal: SignalRecord | null;
  lastClosedCandleTime: number;
  engineStartedAt: number;
}

class Engine {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastProcessedOpen = 0;
  private startedAt = Date.now();
  private klines: Candle[] = [];
  private snapshot: ReturnType<typeof computeSnapshot> | null = null;
  private lastSignalRec: SignalRecord | null = null;
  private started = false;
  private lastOffline: boolean | null = null;

  start(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    void this.tick(true);
    this.timer = setInterval(() => void this.tick(), 3000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(first = false): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const s = getSettings();
      const candles = await api.klines(s.symbol, s.interval, 500, 2500);
      if (candles.length < 60) return;

      // Feed mode flip (live <-> offline demo): re-baseline, never act on a splice.
      const off = api.isOffline();
      if (this.lastOffline !== null && this.lastOffline !== off) {
        this.started = false;
        emit('log', { level: 'info', msg: 'Feed mode changed — engine re-baselined (no action on transition candles)' });
      }
      this.lastOffline = off;

      this.klines = candles;
      const snap = computeSnapshot(candles, s.emaLengths, s.emaExtraLength, s.atrLength);
      this.snapshot = snap;

      // latest *closed* candle (REST includes the currently-forming bar last)
      const now = feedNow();
      let idx = candles.length - 1;
      if (candles[idx].closeTime > now) idx -= 1;
      if (idx < 5) return;
      const closed = candles[idx];

      if (!this.started) {
        // first run: baseline — never act on candles that closed before start
        this.lastProcessedOpen = closed.time;
        this.started = true;
        if (first) console.log(`[engine] baseline candle ${new Date(closed.time).toISOString()} — waiting for next close`);
        return;
      }
      if (closed.time <= this.lastProcessedOpen) return;
      this.lastProcessedOpen = closed.time;

      // --- non-repaint signal evaluation on the newly closed bar ---
      const fast = snap.emas[1]; // EMA 11
      const slow = snap.emas[7]; // EMA 34
      const sig: SignalSide | null = signalAt(fast, slow, idx);
      const atrVal = snap.atrSeries[idx];
      if (!sig || !Number.isFinite(atrVal)) return;

      const record: SignalRecord = {
        id: rndId(),
        symbol: s.symbol,
        time: closed.time,
        detectedAt: Date.now(),
        side: sig,
        price: closed.close,
        atr: atrVal,
        acted: false,
        tradeId: null,
      };
      saveSignal(record);
      this.lastSignalRec = record;
      console.log(`[engine] SIGNAL ${sig} @ ${closed.close} (ATR ${atrVal.toFixed(4)}) candle=${new Date(closed.time).toISOString()}`);
      emit('signal', { signal: record });
      emit('log', {
        level: sig === 'LONG' ? 'win' : 'loss',
        msg: `Signal ${sig} @ ${closed.close} — ATR ${atrVal.toFixed(4)}`,
      });

      await trader.onSignal({ record, side: sig, price: closed.close, atr: atrVal } as OpenSignal);
    } catch (e: any) {
      console.error('[engine]', e?.message || e);
      emit('error', { message: `Engine: ${e?.message || e}` });
    } finally {
      this.running = false;
    }
  }

  state(): IndicatorState | null {
    if (!this.snapshot || this.klines.length === 0) return null;
    const s = getSettings();
    const snap = this.snapshot;
    const i = this.klines.length - 1;
    const last = this.klines[i];
    const emas = snap.emas.map((a) => a[i]);
    const bull = emas[7] < emas[1]; // ribbonDir: ema8 < ema2
    return {
      symbol: s.symbol,
      interval: s.interval,
      lastPrice: last.close,
      atr: Number.isFinite(snap.atrSeries[i]) ? snap.atrSeries[i] : snap.atrSeries[i - 1] || 0,
      ribbonBull: bull,
      emas,
      emaExtra: snap.emaExtra[i],
      lastSignal: this.lastSignalRec,
      lastClosedCandleTime: this.klines.length && this.klines[this.klines.length - 1].closeTime <= feedNow()
        ? this.klines[this.klines.length - 1].time
        : this.klines.length > 1 ? this.klines[this.klines.length - 2].time : 0,
      engineStartedAt: this.startedAt,
    };
  }

  /** Chart payload: candles + ribbon + trade levels (aligned arrays). */
  chart(limit = 300): any {
    const s = getSettings();
    const candles = this.klines.slice(-limit);
    if (!this.snapshot) return { candles: [], emas: [], emaExtra: [], signals: [], trade: null };
    const start = this.klines.length - candles.length;
    const ribbon = this.snapshot.emas.map((arr) => arr.slice(start));
    const extra = this.snapshot.emaExtra.slice(start);
    const times = new Set(candles.map((c) => c.time));
    const signals = allSignals()
      .filter((x) => x.symbol === s.symbol && times.has(x.time))
      .map((x) => ({ time: x.time, side: x.side, price: x.price, id: x.id, acted: x.acted }));
    const t = activeTrade();
    return {
      candles: candles.map((c) => ({
        time: Math.floor(c.time / 1000),
        open: c.open, high: c.high, low: c.low, close: c.close,
      })),
      emas: ribbon.map((arr) =>
        arr.map((v, k) => ({ time: Math.floor(candles[k].time / 1000), value: Number.isFinite(v) ? v : null })).filter((p) => p.value !== null),
      ),
      emaExtra: extra.map((v, k) => ({ time: Math.floor(candles[k].time / 1000), value: Number.isFinite(v) ? v : null })).filter((p) => p.value !== null),
      signals,
      trade: t && t.symbol === s.symbol ? {
        side: t.side, entry: t.entryPrice, sl: t.slCurrent, slStage: t.slStage,
        tp1: t.tp1, tp2: t.tp2, tp3: t.tp3, status: t.status,
        tp1Filled: t.tp1Filled, tp2Filled: t.tp2Filled, tp3Filled: t.tp3Filled,
      } : null,
    };
  }
}

export const engine = new Engine();

// ---------------------------------------------------------------------------
// MTF dashboard + screener (cached, best-effort)
// ---------------------------------------------------------------------------

let mtfCache: { at: number; data: any } | null = null;
let screenerCache: { at: number; data: any } | null = null;

/** Port of the indicator's TREND ANALYSIS dashboard. */
export async function mtfDashboard(): Promise<any> {
  const s = getSettings();
  if (mtfCache && Date.now() - mtfCache.at < 30000) return mtfCache.data;
  const tfs = s.dashboardTimeframes;
  const out: any = { timeframes: [], atr: 0, ribbonBull: false, overall: '—' };
  const st = engine.state();
  if (st) {
    out.atr = st.atr;
    out.ribbonBull = st.ribbonBull;
  }
  let bull = 0;
  for (const tf of tfs) {
    let isBull = false;
    try {
      const ks = await api.klines(s.symbol, tfToInterval(tf), 300, 30000);
      const closes = ks.map((c) => c.close);
      const { ema } = await import('./indicators');
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

/** Port of the SCREENER table — Binance perps instead of NSE symbols. */
export async function screener(): Promise<any> {
  const s = getSettings();
  if (screenerCache && Date.now() - screenerCache.at < 45000) return screenerCache.data;
  const rows: any[] = [];
  const syms = s.screenerSymbols.slice(0, 9);
  for (const sym of syms) {
    try {
      const ks = await api.klines(sym, '5m', 300, 30000);
      const state = screenerState(ks, s.emaLengths[1], s.emaLengths[7]);
      rows.push({ symbol: sym.replace(/USDT$/, ''), state });
    } catch {
      rows.push({ symbol: sym.replace(/USDT$/, ''), state: '—' });
    }
  }
  const data = { rows };
  screenerCache = { at: Date.now(), data };
  return data;
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

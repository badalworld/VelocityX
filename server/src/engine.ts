/**
 * Per-symbol signal engine for the closed-candle 5m liquidity-sweep / POC-retest strategy.
 *
 * Watches retained liquid scanner symbols, the primary symbol and every
 * bot-managed position. On first watch/restart it primes pending setup state
 * from historical closed bars but never executes a historical signal. New
 * setup signals require a prior 30-bar sweep, locked approximate POC reclaim,
 * and a later directional retest/rejection. The EMA ribbon is dashboard-only.
 */
import { api } from './binance';
import { computeSnapshot, ema } from './indicators';
import { LiquiditySweepStrategy } from './liquidityStrategy';
import { getSettings } from './settings';
import { saveSignal, SignalRecord } from './store';
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
  /** Current continuous watch session. Leaving and later re-entering a zone must
   * establish a new baseline, never replay a signal that happened away. */
  private watched = new Set<string>();
  private lastSignalRec: SignalRecord | null = null;
  private liquidity = new LiquiditySweepStrategy();
  private lastTickAt = 0;
  /** Throttle candle-fetch errors per symbol during exchange outages. */
  private lastCandleErrorAt = new Map<string, number>();

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
    for (const sym of trader.managedSymbols()) set.add(sym);
    return [...set];
  }

  lastTick(): number {
    return this.lastTickAt;
  }

  /** Rebaseline all watchers after strategy parameters change; never replay an old entry. */
  resetStrategy(): void {
    this.liquidity.reset();
    this.baselined.clear();
    this.lastProcessed.clear();
    this.lastSignalRec = null;
  }

  private async tick(first = false): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const s = getSettings();
      const symbols = this.activeSymbols();
      const nextWatched = new Set(symbols);
      for (const symbol of this.watched) {
        if (!nextWatched.has(symbol)) {
          this.baselined.delete(symbol);
          this.lastProcessed.delete(symbol);
          this.liquidity.reset(symbol);
        }
      }
      this.watched = nextWatched;
      this.lastTickAt = Date.now();

      for (const symbol of symbols) {
        try {
          await candleStore.ensure(symbol, s.interval, 500);
          this.lastCandleErrorAt.delete(symbol);
        } catch (e: any) {
          const now = Date.now();
          if (now - (this.lastCandleErrorAt.get(symbol) ?? 0) > 60_000) {
            this.lastCandleErrorAt.set(symbol, now);
            console.warn(`[engine] candles ${symbol} unavailable (${e?.message || e}) — retrying every tick`);
          }
          continue;
        }

        const allCandles = candleStore.get(symbol, s.interval);
        const closed = candleStore.closed(symbol, s.interval);
        if (closed.length < Math.max(60, s.strategy.lookbackBars + 2)) continue;
        // The EMA ribbon remains a dashboard-only indicator. It no longer
        // generates trade entries; those come exclusively from the POC strategy.
        computeSnapshot(allCandles, s.emaLengths, s.emaExtraLength, s.atrLength);

        if (!this.baselined.has(symbol)) {
          this.baselined.add(symbol);
          this.liquidity.prime(symbol, closed, s.strategy, s.atrLength);
          this.lastProcessed.set(symbol, closed[closed.length - 1].time);
          if (first) console.log(`[engine] ${symbol}: strategy state restored from closed 5m candles — waiting for a fresh retest`);
          continue;
        }

        const lastProcessed = this.lastProcessed.get(symbol) ?? 0;
        const firstNew = closed.findIndex((c) => c.time > lastProcessed);
        if (firstNew < 0) continue;

        // Process newly closed bars in order to keep setup state correct across
        // delayed ticks, but never execute a stale retest after an outage.
        for (let i = firstNew; i < closed.length; i++) {
          const bar = closed[i];
          const hit = this.liquidity.process(symbol, closed, i, s.strategy, s.atrLength);
          this.lastProcessed.set(symbol, bar.time);
          if (!hit) continue;

          const record: SignalRecord = {
            id: rndId(), symbol, time: bar.time, detectedAt: Date.now(), side: hit.side,
            price: hit.entryPrice, atr: hit.atr, acted: false, tradeId: null,
            strategy: 'LIQUIDITY_SWEEP_POC_RETEST', pocPrice: hit.pocPrice,
            sweptLevel: hit.sweptLevel, sweepExtreme: hit.sweepExtreme,
            stopPrice: hit.stopPrice, riskDistance: hit.riskDistance, sweepTime: hit.sweepTime,
          };
          saveSignal(record);
          if (symbol === s.symbol) this.lastSignalRec = record;
          console.log(`[engine] SIGNAL ${hit.side} ${symbol} @ ${hit.entryPrice} · POC ${hit.pocPrice} · stop ${hit.stopPrice} · retest=${new Date(bar.time).toISOString()}`);
          emit('signal', { signal: record });
          emit('log', {
            level: hit.side === 'LONG' ? 'win' : 'loss',
            msg: `${symbol} ${hit.side} POC retest @ ${hit.entryPrice} · POC ${hit.pocPrice} · sweep ${hit.sweptLevel}`,
          });

          const ageMs = Date.now() - bar.closeTime;
          if (ageMs > 120_000) {
            emit('log', { level: 'info', msg: `${symbol} POC retest was ${Math.round(ageMs / 1000)}s old — recorded, not executed` });
            continue;
          }
          // Auto-scan requires a live monitor zone; manual mode watches the
          // primary symbol without needing a scanner zone.
          const zoneEligible = s.autoScan && scanner.isExecutionEligible(symbol, hit.side);
          if (s.autoScan && !zoneEligible && !trader.managedSymbols().includes(symbol)) continue;

          await trader.onSignal({ record, side: hit.side, price: hit.entryPrice, atr: hit.atr, stopPrice: hit.stopPrice } as OpenSignal);
          if (zoneEligible) scanner.markSignal(symbol, hit.side, record.id, record.tradeId);
        }
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
    const fastIndex = s.emaLengths.indexOf(11);
    const slowIndex = s.emaLengths.indexOf(34);
    const bull = fastIndex >= 0 && slowIndex >= 0 && vals[slowIndex] < vals[fastIndex];
    return {
      symbol: sym, interval: s.interval, lastPrice: last.close,
      atr: Number.isFinite(snap.atrSeries[i]) ? snap.atrSeries[i] : snap.atrSeries[i - 1] || 0,
      ribbonBull: bull, emas: vals, emaExtra: snap.emaExtra[i],
      lastSignal: this.lastSignalRec && this.lastSignalRec.symbol === sym ? this.lastSignalRec : null,
      lastClosedCandleTime: candleStore.closed(sym, s.interval).slice(-1)[0]?.time ?? 0,
      engineStartedAt: this.startedAt,
      tradable: scanner.result() ? scanner.isTradable(sym) : undefined,
    };
  }
}

export const engine = new Engine();

// ---------------------------------------------------------------------------
// MTF dashboard (cached, budget-friendly)
// ---------------------------------------------------------------------------

let mtfCache: { at: number; data: any } | null = null;

/** Port of the indicator's TREND ANALYSIS dashboard; informational only, not a strategy entry gate. */
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
      const f = ema(closes, 11);
      const sl = ema(closes, 34);
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

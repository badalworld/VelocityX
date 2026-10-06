/**
 * Candle store — the single source of truth for OHLCV used by the engine and
 * the dashboard.
 *
 * Priority of realtime data:
 *   1. Binance WebSocket `<symbol>@kline_<interval>` streams (weight-free,
 *      sub-second, pushed straight into this store).
 *   2. REST /fapi/v1/klines only to seed history (and as a fallback when a
 *      stream is down) — always scheduled through the 95% weight budget.
 */
import { Candle } from './indicators';
import { api } from './binance';

const MAX_BARS = 1500;

function merge(existing: Candle[], incoming: Candle[]): Candle[] {
  if (!existing.length) return incoming.slice(-MAX_BARS);
  const map = new Map<number, Candle>();
  for (const c of existing) map.set(c.time, c);
  for (const c of incoming) map.set(c.time, c);
  return [...map.values()].sort((a, b) => a.time - b.time).slice(-MAX_BARS);
}

class CandleStore {
  private map = new Map<string, Candle[]>();
  private seededAt = new Map<string, number>();
  private wsAt = new Map<string, number>();
  private inflight = new Map<string, Promise<Candle[]>>();

  private static key(symbol: string, interval: string): string {
    return `${symbol}|${interval}`;
  }

  /** Candles including the currently-forming bar. */
  get(symbol: string, interval: string): Candle[] {
    return this.map.get(CandleStore.key(symbol, interval)) ?? [];
  }

  /** Candles with the forming bar removed (what the signal engine may act on). */
  closed(symbol: string, interval: string, now = Date.now()): Candle[] {
    const all = this.get(symbol, interval);
    if (!all.length) return all;
    const last = all[all.length - 1];
    return last.closeTime <= now ? all : all.slice(0, -1);
  }

  lastClosed(symbol: string, interval: string, now = Date.now()): Candle | null {
    const arr = this.closed(symbol, interval, now);
    return arr.length ? arr[arr.length - 1] : null;
  }

  isFresh(symbol: string, interval: string, maxAgeMs = 90_000): boolean {
    const t = this.wsAt.get(CandleStore.key(symbol, interval)) ?? this.seededAt.get(CandleStore.key(symbol, interval)) ?? 0;
    return Date.now() - t < maxAgeMs;
  }

  /**
   * Seed history that another subsystem already fetched. The 50-asset scanner
   * uses this for its 5m batch, so promoting an opportunity never causes a
   * second REST burst before the realtime monitor can start.
   */
  seed(symbol: string, interval: string, candles: Candle[]): Candle[] {
    const key = CandleStore.key(symbol, interval);
    const merged = merge(this.map.get(key) ?? [], candles);
    this.map.set(key, merged);
    this.seededAt.set(key, Date.now());
    return merged;
  }

  /** Seed/refresh history over REST when the store is empty or stale. */
  async ensure(symbol: string, interval: string, limit = 500): Promise<Candle[]> {
    const key = CandleStore.key(symbol, interval);
    const cur = this.map.get(key);
    const seeded = this.seededAt.get(key) ?? 0;
    const ws = this.wsAt.get(key) ?? 0;
    const hasRecentWs = Date.now() - ws < 60_000;
    if (cur?.length && (hasRecentWs || Date.now() - seeded < 20_000)) return cur;

    const running = this.inflight.get(key);
    if (running) return running;

    const p = api
      .klines(symbol, interval, limit, 2000)
      .then((data) => {
        const merged = merge(cur ?? [], data);
        this.map.set(key, merged);
        this.seededAt.set(key, Date.now());
        return merged;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Feed a WebSocket kline payload into the store. */
  applyKline(payload: any): Candle | null {
    const symbol = String(payload?.s || '');
    const interval = String(payload?.i || '');
    const k = payload?.k;
    if (!symbol || !interval || !k) return null;
    const key = CandleStore.key(symbol, interval);
    const candle: Candle = {
      time: Number(k.t),
      closeTime: Number(k.T),
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      volume: Number(k.v),
    };
    const arr = this.map.get(key) ?? [];
    const last = arr[arr.length - 1];
    if (last && last.time === candle.time) arr[arr.length - 1] = candle;
    else if (!last || candle.time > last.time) arr.push(candle);
    else {
      const idx = arr.findIndex((c) => c.time === candle.time);
      if (idx >= 0) arr[idx] = candle;
      else arr.push(candle);
    }
    if (arr.length > MAX_BARS) arr.splice(0, arr.length - MAX_BARS);
    this.map.set(key, arr);
    this.wsAt.set(key, Date.now());
    return candle;
  }

  stats(): { symbols: number; series: number; bars: number; lastWsAt: number } {
    let bars = 0;
    let lastWsAt = 0;
    for (const arr of this.map.values()) bars += arr.length;
    for (const t of this.wsAt.values()) lastWsAt = Math.max(lastWsAt, t);
    const symbols = new Set([...this.map.keys()].map((k) => k.split('|')[0]));
    return { symbols: symbols.size, series: this.map.size, bars, lastWsAt };
  }
}

export const candleStore = new CandleStore();

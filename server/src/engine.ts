/**
 * Strategy-free market-data engine.
 *
 * It keeps the selected symbol supplied with fresh candles, prices and a
 * heartbeat. It deliberately contains no signal
 * generation, entry conditions or strategy state.
 */
import { api } from './binance';
import { candleStore, Candle } from './candles';
import { emit } from './broadcast';
import { priceOf } from './prices';
import { getSettings } from './settings';
import { latestStrategy, type StrategySignal } from './strategy';

export interface MarketState {
  symbol: string;
  interval: string;
  lastPrice: number;
  lastClosedCandleTime: number;
  engineStartedAt: number;
}

class Engine {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private startedAt = Date.now();
  private lastTickAt = 0;
  private lastCandleErrorAt = new Map<string, number>();

  start(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 5000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    console.log('[engine] market-data heartbeat started; no strategy is installed and new entries are disabled');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The single selected market for the read-only dashboard. */
  activeSymbols(): string[] {
    return [getSettings().symbol];
  }

  lastTick(): number {
    return this.lastTickAt;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.lastTickAt = Date.now();
    try {
      const { interval } = getSettings();
      for (const symbol of this.activeSymbols()) {
        try {
          await candleStore.ensure(symbol, interval, 500);
          this.lastCandleErrorAt.delete(symbol);
        } catch (e: any) {
          const now = Date.now();
          if (now - (this.lastCandleErrorAt.get(symbol) ?? 0) > 60_000) {
            this.lastCandleErrorAt.set(symbol, now);
            console.warn(`[engine] candle data for ${symbol} unavailable (${e?.message || e}) — retrying`);
          }
        }
      }
    } catch (e: any) {
      console.error('[engine]', e?.message || e);
      emit('error', { message: `Market data: ${e?.message || e}` });
    } finally {
      this.running = false;
    }
  }

  strategy(symbol?: string): { point: ReturnType<typeof latestStrategy>['point']; signal: StrategySignal | null; settings: ReturnType<typeof latestStrategy>['settings'] } {
    const settings = getSettings();
    const selected = symbol ?? settings.symbol;
    return latestStrategy(candleStore.closed(selected, settings.interval), undefined);
  }

  state(symbol?: string): MarketState | null {
    const settings = getSettings();
    const selected = symbol ?? settings.symbol;
    const candles: Candle[] = candleStore.get(selected, settings.interval);
    const latest = candles[candles.length - 1];
    if (!latest && !priceOf(selected)) return null;
    return {
      symbol: selected,
      interval: settings.interval,
      lastPrice: priceOf(selected) || latest?.close || 0,
      lastClosedCandleTime: candleStore.closed(selected, settings.interval).slice(-1)[0]?.time ?? 0,
      engineStartedAt: this.startedAt,
    };
  }
}

export const engine = new Engine();

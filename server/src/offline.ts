/**
 * OFFLINE DEMO FEED — synthetic USD-M market data used ONLY when the real
 * Binance API is unreachable (e.g. sandboxed/offline deployments).
 *
 * - Clearly labeled everywhere as "offline demo".
 * - Regime-switching random walk so EMA crosses / signals actually occur.
 * - Simulated clock runs at 10× so 5m candles close every 30s of wall time,
 *   letting the full bot lifecycle be demonstrated quickly.
 * - In any environment with Binance access this module is never used.
 */
import { Candle } from './indicators';

const BASE_PRICES: Record<string, number> = {
  BTCUSDT: 68000, ETHUSDT: 3500, SOLUSDT: 180, BNBUSDT: 700, XRPUSDT: 0.6,
  DOGEUSDT: 0.15, ADAUSDT: 0.45, LINKUSDT: 14, AVAXUSDT: 28, BCCUSDT: 100,
};

const SPEED = 10; // simulated time multiplier
const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000,
  '12h': 43_200_000, '1d': 86_400_000,
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Series {
  symbol: string;
  interval: string;
  stepMs: number;
  candles: Candle[];
  rand: () => number;
  drift: number; // per-bar drift
  barsLeft: number; // bars until next regime switch
  lastPrice: number;
}

class OfflineFeed {
  private originWall = Date.now();
  private originSim = Math.floor(Date.now() / 300_000) * 300_000;
  private series = new Map<string, Series>();
  active = false;

  /** Simulated "now" (10× wall clock, aligned to 5m grid at start). */
  now(): number {
    return this.originSim + (Date.now() - this.originWall) * SPEED;
  }

  activate(): void {
    this.active = true;
    this.originWall = Date.now();
    // realign sim clock to wall clock on each activation
    this.originSim = Math.floor(Date.now() / 300_000) * 300_000;
    this.series.clear();
  }

  deactivate(): void {
    this.active = false;
  }

  base(symbol: string): number {
    return BASE_PRICES[symbol] ?? 100;
  }

  private getSeries(symbol: string, interval: string): Series {
    const key = `${symbol}|${interval}`;
    let s = this.series.get(key);
    if (!s) {
      const stepMs = INTERVAL_MS[interval] || 300_000;
      const rand = mulberry32(hash(key));
      s = {
        symbol, interval, stepMs, candles: [], rand,
        drift: (rand() < 0.5 ? -1 : 1) * (0.0020 + rand() * 0.0045),
        barsLeft: 4 + Math.floor(rand() * 8),
        lastPrice: this.base(symbol),
      };
      this.series.set(key, s);
      this.build(s, 600);
    }
    return s;
  }

  /** Generate history up to the current sim time, then keep the forming bar alive. */
  private build(s: Series, bars: number): void {
    const now = this.now();
    const lastClosedIdx = Math.floor((now - 0) / s.stepMs);
    const startIdx = lastClosedIdx - bars;
    let price = this.base(s.symbol);
    // warm-up walk (deterministic from seed) so history looks organic
    const initRand = mulberry32(hash(`${s.symbol}|${s.interval}|hist`) ^ 0x9e3779b9);
    for (let i = startIdx; i <= lastClosedIdx; i++) {
      const open = price;
      if (s.barsLeft <= 0) {
        s.barsLeft = 4 + Math.floor(initRand() * 8);
        s.drift = (initRand() < 0.5 ? -1 : 1) * (0.0020 + initRand() * 0.0045);
      }
      s.barsLeft--;
      const noise = (initRand() - 0.5) * 0.009;
      const close = open * (1 + s.drift + noise);
      const wick = open * (0.0018 + initRand() * 0.0055);
      const high = Math.max(open, close) + wick * initRand();
      const low = Math.min(open, close) - wick * initRand();
      s.candles.push({
        time: i * s.stepMs,
        closeTime: i * s.stepMs + s.stepMs - 1,
        open, high, low, close,
        volume: 100 + initRand() * 900,
      });
      price = close;
    }
    s.lastPrice = price;
    if (s.candles.length > 1200) s.candles.splice(0, s.candles.length - 1200);
  }

  /** Advance the forming candle with fresh ticks (call ~1Hz). Returns new price. */
  tick(symbol: string, interval = '5m'): number {
    const s = this.getSeries(symbol, interval);
    const now = this.now();
    const idx = Math.floor(now / s.stepMs);
    const openIdx = Math.floor((s.candles[s.candles.length - 1]?.time ?? 0) / s.stepMs);

    // new bar boundary crossed → close current & open next
    if (idx > openIdx) {
      const rand = s.rand;
      if (s.barsLeft <= 0) {
        s.barsLeft = 4 + Math.floor(rand() * 8);
        s.drift = (rand() < 0.5 ? -1 : 1) * (0.0020 + rand() * 0.0045);
      }
      s.barsLeft--;
      let price = s.lastPrice;
      for (let i = openIdx + 1; i <= idx; i++) {
        const open = price;
        const noise = (rand() - 0.5) * 0.0075;
        const close = open * (1 + s.drift + noise);
        const wick = open * 0.0026;
        s.candles.push({
          time: i * s.stepMs,
          closeTime: i * s.stepMs + s.stepMs - 1,
          open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick,
          close, volume: 100 + rand() * 900,
        });
        price = close;
      }
      if (s.candles.length > 1200) s.candles.shift();
      s.lastPrice = price;
      return price;
    }

    // update forming candle
    const forming = s.candles[s.candles.length - 1];
    if (forming && forming.closeTime > now) {
      const noise = (s.rand() - 0.5) * 0.0012;
      const p = Math.max(1e-8, forming.close * (1 + s.drift / 60 + noise));
      s.lastPrice = p;
      forming.close = p;
      forming.high = Math.max(forming.high, p);
      forming.low = Math.min(forming.low, p);
      forming.volume += 5 + s.rand() * 30;
      return p;
    }
    return s.lastPrice;
  }

  candles(symbol: string, interval: string, limit: number): Candle[] {
    const s = this.getSeries(symbol, interval);
    // make sure we're current
    this.tick(symbol, interval);
    return s.candles.slice(-limit);
  }

  price(symbol: string): number {
    const s = this.getSeries(symbol, '5m');
    this.tick(symbol, '5m');
    return s.lastPrice;
  }

  /** Synthetic perpetual universe so the scanner still ranks in offline demo mode. */
  universe(): {
    symbol: string; baseAsset: string; quoteAsset: string; contractType: string; status: string;
    pricePrecision: number; quantityPrecision: number; stepSize: number; tickSize: number; minQty: number; minNotional: number;
  }[] {
    return Object.keys(BASE_PRICES).map((symbol) => {
      const info = this.exchangeInfo(symbol);
      return {
        symbol,
        baseAsset: symbol.replace(/USDT$/, ''),
        quoteAsset: 'USDT',
        contractType: 'PERPETUAL',
        status: 'TRADING',
        pricePrecision: 2,
        quantityPrecision: 3,
        stepSize: info.stepSize,
        tickSize: info.tickSize,
        minQty: info.minQty,
        minNotional: info.minNotional,
      };
    });
  }

  /** Synthetic 24h tickers so the scanner still ranks in offline demo mode. */
  tickers(): {
    symbol: string; lastPrice: number; priceChangePercent: number;
    highPrice: number; lowPrice: number; quoteVolume: number; volume: number;
  }[] {
    return Object.keys(BASE_PRICES).map((symbol) => {
      const s = this.getSeries(symbol, '5m');
      this.tick(symbol, '5m');
      const candles = s.candles.slice(-288); // 24h of 5m bars
      const last = s.lastPrice;
      const high = Math.max(last, ...candles.map((c) => c.high));
      const low = Math.min(last, ...candles.map((c) => c.low));
      const open24 = candles[0]?.open ?? last;
      const volume = candles.reduce((a, c) => a + c.volume, 0);
      return {
        symbol,
        lastPrice: last,
        priceChangePercent: open24 > 0 ? ((last - open24) / open24) * 100 : 0,
        highPrice: high,
        lowPrice: low,
        quoteVolume: last * volume * 120,
        volume: volume * 120,
      };
    });
  }

  exchangeInfo(symbol: string) {
    const base = this.base(symbol);
    const step = base >= 1000 ? 0.001 : base >= 1 ? 0.01 : 0.1;
    const tick = base >= 1000 ? 0.1 : base >= 1 ? 0.01 : 0.0001;
    const dec = (x: number) => {
      const str = String(x);
      return str.includes('.') ? str.split('.')[1].replace(/0+$/, '').length : 0;
    };
    return {
      symbol,
      stepSize: step,
      tickSize: tick,
      minQty: step,
      minNotional: 100,
      stepDecimals: dec(step),
      tickDecimals: dec(tick),
    };
  }
}

export const offlineFeed = new OfflineFeed();

/**
 * WebSocket streams — the realtime backbone of the dashboard.
 *
 *  market : Binance split its USD-M WebSocket in 2026, so market data arrives
 *           over TWO sockets that are managed as one stream:
 *             /public/stream  <symbol>@bookTicker → live prices (PnL, dashboard)
 *             /market/stream  <symbol>@kline_5m   → candles into the candle store
 *           for every symbol the engine watches (scanner picks + open trades).
 *           Re-subscribed automatically when the watched set changes. The
 *           stream only counts as connected when BOTH sockets are up, and as
 *           fresh when the quieter one is.
 *
 *  user   : listenKey user-data stream (testnet/live) →
 *             ORDER_TRADE_UPDATE → market entry / exit fills, commission, PnL
 *             ALGO_UPDATE        → stop-loss / take-profit trigger results
 *             ACCOUNT_UPDATE     → realtime equity / margin balance
 *             MARGIN_CALL / listenKey expiry handled with backoff + keepalive.
 */
import WebSocket from 'ws';
import { api, MarketChannel, marketStreamUrl, userStreamUrls } from './binance';
import { getSettings } from './settings';
import { trader } from './trader';
import { accountService } from './account';
import { candleStore } from './candles';
import { emit } from './broadcast';

/** A connected market socket that stays silent this long is rebuilt. */
const MARKET_SILENCE_MS = 45_000;
/** Binance pings user-data sockets every few minutes; ten silent minutes means a dead link. */
const USER_SILENCE_MS = 10 * 60_000;
const LISTEN_KEY_KEEPALIVE_MS = 25 * 60_000;

/**
 * Detach a socket for good. A no-op 'error' listener is attached on purpose:
 * closing a socket that is still CONNECTING makes `ws` emit an 'error' on the
 * next tick, and with no listener that is an uncaught exception — which this
 * process turns into a shutdown.
 */
function discard(ws: WebSocket | null): void {
  if (!ws) return;
  try {
    ws.removeAllListeners();
    ws.on('error', () => {});
    ws.close();
  } catch { /* ignore */ }
}

interface Feed {
  channel: MarketChannel;
  ws: WebSocket | null;
  connected: boolean;
  openedAt: number;
  lastMessageAt: number;
  backoff: number;
  retry: NodeJS.Timeout | null;
  lastWarnAt: number;
}

const newFeed = (channel: MarketChannel): Feed => ({
  channel,
  ws: null,
  connected: false,
  openedAt: 0,
  lastMessageAt: 0,
  backoff: 1000,
  retry: null,
  lastWarnAt: 0,
});

export class MarketStream {
  private symbolsKey = '';
  private symbols: string[] = [];
  private interval = '5m';
  private stopped = false;
  /** Rejects delayed reconnect timers from an obsolete subscription set. */
  private generation = 0;
  private feeds: Record<MarketChannel, Feed> = { public: newFeed('public'), market: newFeed('market') };
  private watchdog: NodeJS.Timeout | null = null;
  private announced = false;
  private prices = new Map<string, number>();
  private lastEmit = new Map<string, number>();

  /** Both sockets are up. */
  get isConnected(): boolean {
    return this.feeds.public.connected && this.feeds.market.connected;
  }
  /** Last frame time of the QUIETER socket (0 until both have spoken). */
  lastMessage(): number {
    const a = this.feeds.public.lastMessageAt;
    const b = this.feeds.market.lastMessageAt;
    return a && b ? Math.min(a, b) : 0;
  }
  price(symbol: string): number {
    return this.prices.get(symbol) ?? 0;
  }

  /** (Re)subscribe to the given symbol set. No-op when unchanged. */
  subscribe(symbols: string[]): void {
    const interval = getSettings().interval;
    const key = `${interval}:${[...symbols].sort().join(',')}`;
    if (key === this.symbolsKey && (this.feeds.public.ws || this.feeds.market.ws)) return;
    this.symbolsKey = key;
    this.symbols = [...symbols];
    this.interval = interval;
    this.stopped = false;
    const generation = ++this.generation;
    for (const f of Object.values(this.feeds)) {
      this.closeFeed(f);
      f.lastMessageAt = 0;
      f.backoff = 1000;
    }
    this.syncState();
    this.startWatchdog();
    for (const f of Object.values(this.feeds)) this.connect(f, generation);
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    for (const f of Object.values(this.feeds)) {
      this.closeFeed(f);
      f.lastMessageAt = 0;
    }
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.syncState();
  }

  private closeFeed(f: Feed): void {
    if (f.retry) clearTimeout(f.retry);
    f.retry = null;
    f.connected = false;
    const ws = f.ws;
    f.ws = null;
    discard(ws);
  }

  /** Tell the dashboard when the combined state flips (not once per socket). */
  private syncState(): void {
    const up = this.isConnected;
    if (up === this.announced) return;
    this.announced = up;
    emit('stream', up ? { market: true, symbols: this.symbols } : { market: false });
  }

  private scheduleRetry(f: Feed, generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    if (f.retry) clearTimeout(f.retry);
    f.backoff = Math.min(f.backoff * 2, 15_000);
    f.retry = setTimeout(() => {
      f.retry = null;
      this.connect(f, generation);
    }, f.backoff);
  }

  /** A half-open TCP connection never errors by itself — rebuild silent sockets. */
  private startWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      const now = Date.now();
      for (const f of Object.values(this.feeds)) {
        if (!f.connected || !f.ws) continue;
        const quietFor = now - (f.lastMessageAt || f.openedAt);
        if (quietFor > MARKET_SILENCE_MS) {
          console.warn(`[ws] market ${f.channel} socket silent for ${Math.round(quietFor / 1000)}s — reconnecting`);
          try { f.ws.terminate(); } catch { /* ignore */ } // 'close' → backoff → reconnect
        }
      }
    }, 15_000);
    if (typeof this.watchdog.unref === 'function') this.watchdog.unref();
  }

  private connect(f: Feed, generation: number): void {
    if (this.stopped || generation !== this.generation || !this.symbols.length) return;
    this.closeFeed(f);
    let ws: WebSocket;
    try {
      ws = new WebSocket(marketStreamUrl(f.channel, this.symbols, this.interval));
    } catch (e: any) {
      console.warn(`[ws] market ${f.channel} connect failed`, e?.message);
      this.scheduleRetry(f, generation);
      return;
    }
    f.ws = ws;
    ws.on('open', () => {
      if (generation !== this.generation) return ws.close();
      f.backoff = 1000;
      f.connected = true;
      f.openedAt = Date.now();
      console.log(`[ws] market ${f.channel} stream connected: ${this.symbols.length} symbols`);
      this.syncState();
    });
    ws.on('message', (raw) => {
      if (generation !== this.generation) return;
      try {
        const m = JSON.parse(String(raw));
        const d = m?.data ?? m;
        f.lastMessageAt = Date.now();
        api.telemetry.wsLastMessageAt = f.lastMessageAt;
        if (d?.e === 'bookTicker') {
          const symbol = String(d.s);
          const price = Number(d.b) || Number(d.a);
          if (Number.isFinite(price) && price > 0) {
            this.prices.set(symbol, price);
            trader.onPrice(price, symbol);
            const now = Date.now();
            if (now - (this.lastEmit.get(symbol) ?? 0) > 400) {
              this.lastEmit.set(symbol, now);
              emit('price', { symbol, price });
            }
            emit('prices', { symbol, price, t: now });
          }
        } else if (d?.e === 'kline') {
          candleStore.applyKline(d);
        }
      } catch { /* ignore malformed frame */ }
    });
    ws.on('close', () => {
      if (generation !== this.generation) return;
      if (f.ws === ws) f.ws = null;
      f.connected = false;
      this.syncState();
      this.scheduleRetry(f, generation);
    });
    ws.on('error', (err: Error) => {
      // Say WHY at most once a minute (e.g. "Unexpected server response: 404" means the
      // endpoint moved) — the readiness gate alone only reports "disconnected".
      if (Date.now() - f.lastWarnAt > 60_000) {
        f.lastWarnAt = Date.now();
        console.warn(`[ws] market ${f.channel} socket error: ${err?.message}`);
      }
      try { ws.close(); } catch { /* ignore */ }
    });
  }
}

export class UserDataStream {
  private ws: WebSocket | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = true;
  private backoff = 2000;
  /** Environment + API key being streamed — a new key or mode needs a new stream. */
  private identity = '';
  /** Which candidate URL form of userStreamUrls() is currently being tried. */
  private urlIndex = 0;
  /** Connection attempts in a row that never reached 'open' (candidate discovery). */
  private refusals = 0;
  private connected = false;
  private lastMessageAt = 0;
  private lastActivityAt = 0;
  /** Invalidates callbacks/retries belonging to old credentials or mode. */
  private generation = 0;

  get isConnected(): boolean {
    return this.connected;
  }
  lastMessage(): number {
    return this.lastMessageAt;
  }

  start(): void {
    const s = getSettings();
    const creds = s.keys[s.mode];
    if (!creds.key || !creds.secret) { this.stop(); return; }
    const identity = `${s.mode}:${creds.key}`;
    // Already connecting / connected / backing off for this very account.
    if (!this.stopped && this.identity === identity) return;
    this.stop();
    this.stopped = false;
    this.identity = identity;
    this.urlIndex = 0;
    this.refusals = 0;
    this.backoff = 2000;
    void this.connect(this.generation);
  }

  stop(): void {
    this.stopped = true;
    this.identity = '';
    this.generation += 1;
    this.connected = false;
    this.lastMessageAt = 0;
    this.clearTimers();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    discard(ws);
  }

  private clearTimers(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    if (this.watchdog) clearInterval(this.watchdog);
    this.keepalive = null;
    this.watchdog = null;
  }

  /** `discovery`: the last URL form was refused — try the next one quickly, no backoff. */
  private scheduleReconnect(generation: number, discovery = false): void {
    if (this.stopped || generation !== this.generation) return;
    if (this.retry) clearTimeout(this.retry);
    const delay = discovery ? 1000 : this.backoff;
    if (!discovery) this.backoff = Math.min(this.backoff * 2, 30_000);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect(generation);
    }, delay);
  }

  private armTimers(generation: number, ws: WebSocket): void {
    this.clearTimers();
    this.keepalive = setInterval(() => {
      if (generation !== this.generation) return;
      api.keepAliveListenKey().catch((e: any) => {
        // A rejected keep-alive means the key is dead (-1125) — the feed would
        // go silently quiet. Rebuild the stream with a fresh key.
        console.warn('[ws] listenKey keep-alive failed — rebuilding the user stream:', e?.message);
        try { ws.terminate(); } catch { /* ignore */ }
      });
    }, LISTEN_KEY_KEEPALIVE_MS);
    this.watchdog = setInterval(() => {
      if (generation !== this.generation) return;
      if (Date.now() - this.lastActivityAt > USER_SILENCE_MS) {
        console.warn('[ws] user stream silent (no frames or server pings) — reconnecting');
        try { ws.terminate(); } catch { /* ignore */ }
      }
    }, 60_000);
    if (typeof this.keepalive.unref === 'function') this.keepalive.unref();
    if (typeof this.watchdog.unref === 'function') this.watchdog.unref();
  }

  private async connect(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return;
    try {
      const mode = getSettings().mode;
      const listenKey = await api.createListenKey();
      if (this.stopped || generation !== this.generation || mode !== getSettings().mode) return;
      const urls = userStreamUrls(mode, listenKey);
      const index = this.urlIndex % urls.length;
      const ws = new WebSocket(urls[index]);
      this.ws = ws;
      let opened = false;
      ws.on('open', () => {
        if (this.stopped || generation !== this.generation) return ws.close();
        opened = true;
        this.urlIndex = index; // remember the form that works
        this.refusals = 0;
        this.backoff = 2000;
        this.connected = true;
        this.lastActivityAt = Date.now();
        console.log(`[ws] user stream connected (${mode})`);
        emit('stream', { user: true, mode });
        this.armTimers(generation, ws);
        // Fills may have happened while the socket was down — settle every open trade now.
        void trader.reconcile().catch(() => {});
      });
      ws.on('ping', () => { this.lastActivityAt = Date.now(); });
      ws.on('message', (raw) => {
        if (this.stopped || generation !== this.generation) return;
        try {
          const parsed = JSON.parse(String(raw));
          // the `/stream` form wraps every event as {stream, data}
          const m = parsed?.data && parsed?.stream ? parsed.data : parsed;
          this.lastMessageAt = this.lastActivityAt = Date.now();
          switch (m.e) {
            case 'ORDER_TRADE_UPDATE':
              trader.onOrderUpdate(m);
              break;
            case 'ALGO_UPDATE':
              // a stop-loss / take-profit conditional order fired (or died)
              trader.onAlgoUpdate(m);
              break;
            case 'ACCOUNT_UPDATE':
              // realtime wallet balance / unrealised PnL straight from Binance
              accountService.onUserStreamAccount(m);
              break;
            case 'listenKeyExpired':
              this.log('listenKey expired — reconnecting');
              this.stop();
              this.start();
              break;
            case 'MARGIN_CALL':
              emit('log', { level: 'error', msg: 'MARGIN_CALL received — check your positions!' });
              break;
            default:
              break;
          }
        } catch { /* ignore */ }
      });
      ws.on('close', () => {
        if (generation !== this.generation) return;
        if (this.ws === ws) this.ws = null;
        this.connected = false;
        this.clearTimers();
        emit('stream', { user: false });
        let discovery = false;
        if (!opened) {
          // This URL form was refused — rotate to the next documented candidate.
          this.urlIndex = index + 1;
          // First pass over the candidates is quick; after a full round, back off.
          discovery = (this.refusals += 1) < urls.length;
          console.warn(`[ws] user stream endpoint form ${index + 1}/${urls.length} refused — trying the next`);
        }
        this.scheduleReconnect(generation, discovery);
      });
      ws.on('error', (err: Error) => {
        if (!opened) console.warn('[ws] user stream error:', err?.message);
        try { ws.close(); } catch { /* ignore */ }
      });
    } catch (e: any) {
      if (generation !== this.generation) return;
      console.warn('[ws] user stream failed:', e?.message);
      this.scheduleReconnect(generation);
    }
  }

  private log(msg: string): void {
    emit('log', { level: 'info', msg: `[user-stream] ${msg}` });
  }
}

export const marketStream = new MarketStream();
export const userStream = new UserDataStream();

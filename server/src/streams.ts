/**
 * WebSocket streams — the realtime backbone of the dashboard.
 *
 *  market : one combined Binance USD-M stream carrying
 *             <symbol>@bookTicker   → live prices (position PnL, dashboard)
 *             <symbol>@kline_5m     → candles straight into the candle store
 *           for every symbol the engine watches (scanner picks + open trades).
 *           Re-subscribed automatically when the watched set changes.
 *
 *  user   : listenKey user-data stream (testnet/live) →
 *             ORDER_TRADE_UPDATE → fills, Binance commission + realised PnL
 *             ACCOUNT_UPDATE     → realtime equity / margin balance
 *             MARGIN_CALL / listenKey expiry handled with backoff + keepalive.
 */
import WebSocket from 'ws';
import { wsBase, api } from './binance';
import { getSettings } from './settings';
import { trader } from './trader';
import { accountService } from './account';
import { candleStore } from './candles';
import { engine } from './engine';
import { emit } from './broadcast';

export class MarketStream {
  private ws: WebSocket | null = null;
  private symbolsKey = '';
  private backoff = 1000;
  private stopped = false;
  private connected = false;
  private lastMessageAt = 0;
  private prices = new Map<string, number>();
  private lastEmit = new Map<string, number>();

  get isConnected(): boolean {
    return this.connected;
  }
  lastMessage(): number {
    return this.lastMessageAt;
  }
  price(symbol: string): number {
    return this.prices.get(symbol) ?? 0;
  }

  /** (Re)subscribe to the given symbol set. No-op when unchanged. */
  subscribe(symbols: string[]): void {
    const interval = getSettings().interval;
    const key = `${interval}:${[...symbols].sort().join(',')}`;
    if (key === this.symbolsKey && this.ws) return;
    this.symbolsKey = key;
    this.stopped = false;
    this.close();
    this.connect(symbols, interval);
  }

  /** Back-compat helper used by the boot path. */
  start(_symbol?: string): void {
    this.subscribe(engine.activeSymbols());
  }

  stop(): void {
    this.stopped = true;
    this.close();
  }

  private close(): void {
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private connect(symbols: string[], interval: string): void {
    if (this.stopped || !symbols.length) return;
    this.close();
    const url = api.marketStreamUrl(symbols, interval);
    try {
      this.ws = new WebSocket(url);
    } catch (e: any) {
      console.warn('[ws] market connect failed', e?.message);
      setTimeout(() => this.connect(symbols, interval), this.backoff);
      return;
    }
    this.ws.on('open', () => {
      this.backoff = 1000;
      this.connected = true;
      console.log(`[ws] market stream connected: ${symbols.length} symbols`);
      emit('stream', { market: true, symbols });
    });
    this.ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw));
        const d = m?.data ?? m;
        const ev = d?.e;
        this.lastMessageAt = Date.now();
        api.telemetry.wsLastMessageAt = this.lastMessageAt;
        if (ev === 'bookTicker') {
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
        } else if (ev === 'kline') {
          candleStore.applyKline(d);
        }
      } catch { /* ignore malformed frame */ }
    });
    this.ws.on('close', () => {
      this.connected = false;
      emit('stream', { market: false });
      if (!this.stopped) setTimeout(() => this.connect(symbols, interval), (this.backoff = Math.min(this.backoff * 2, 15000)));
    });
    this.ws.on('error', () => {
      try { this.ws?.close(); } catch { /* ignore */ }
    });
  }
}

export class UserDataStream {
  private ws: WebSocket | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private stopped = true;
  private backoff = 2000;
  private mode: string = '';
  private connected = false;
  private lastMessageAt = 0;

  get isConnected(): boolean {
    return this.connected;
  }
  lastMessage(): number {
    return this.lastMessageAt;
  }

  start(): void {
    const s = getSettings();
    if (!s.keys[s.mode].key || !s.keys[s.mode].secret) { this.stop(); return; }
    if (this.mode === s.mode && this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.stop();
    this.stopped = false;
    this.mode = s.mode;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const s = getSettings();
      const listenKey = await api.createListenKey();
      const url = `${wsBase(s.mode)}/ws/${listenKey}`;
      this.ws = new WebSocket(url);
      this.ws.on('open', () => {
        this.backoff = 2000;
        this.connected = true;
        console.log(`[ws] user stream connected (${s.mode})`);
        emit('stream', { user: true, mode: s.mode });
        if (this.keepalive) clearInterval(this.keepalive);
        this.keepalive = setInterval(() => {
          api.keepAliveListenKey().catch(() => {});
        }, 25 * 60 * 1000);
      });
      this.ws.on('message', (raw) => {
        try {
          const m = JSON.parse(String(raw));
          this.lastMessageAt = Date.now();
          switch (m.e) {
            case 'ORDER_TRADE_UPDATE':
              trader.onOrderUpdate(m);
              break;
            case 'ACCOUNT_UPDATE':
              // realtime wallet balance / unrealised PnL straight from Binance
              accountService.onUserStreamAccount(m);
              break;
            case 'listenKeyExpired':
              this.log('listenKey expired — reconnecting');
              this.stop();
              this.stopped = false;
              void this.connect();
              break;
            case 'MARGIN_CALL':
              emit('log', { level: 'error', msg: 'MARGIN_CALL received — check your positions!' });
              break;
            default:
              break;
          }
        } catch { /* ignore */ }
      });
      this.ws.on('close', () => {
        this.connected = false;
        emit('stream', { user: false });
        if (!this.stopped) setTimeout(() => void this.connect(), (this.backoff = Math.min(this.backoff * 2, 30000)));
      });
      this.ws.on('error', () => { try { this.ws?.close(); } catch { /* ignore */ } });
    } catch (e: any) {
      console.warn('[ws] user stream failed:', e?.message);
      if (!this.stopped) setTimeout(() => void this.connect(), (this.backoff = Math.min(this.backoff * 2, 30000)));
    }
  }

  private log(msg: string): void {
    emit('log', { level: 'info', msg: `[user-stream] ${msg}` });
  }
}

export const marketStream = new MarketStream();
export const userStream = new UserDataStream();

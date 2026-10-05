/**
 * WebSocket streams:
 *  - market:   Binance bookTicker on the active symbol (paper fills + UI price)
 *  - userData: ORDER_TRADE_UPDATE for testnet/live fill detection
 */
import WebSocket from 'ws';
import { wsBase, api } from './binance';
import { getSettings } from './settings';
import { trader } from './trader';
import { emit } from './broadcast';

export class MarketStream {
  private ws: WebSocket | null = null;
  private symbol = '';
  private backoff = 1000;
  private stopped = false;
  onPrice: (p: number) => void = () => {};

  start(symbol: string): void {
    if (this.symbol !== symbol) {
      this.symbol = symbol;
      this.close();
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.close();
  }

  private close(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopped || !this.symbol) return;
    this.close();
    if (api.isOffline()) {
      // offline demo feed drives prices instead — retry real stream later
      emit('stream', { market: false, offline: true });
      setTimeout(() => this.connect(), 30_000);
      return;
    }
    const url = `wss://fstream.binance.com/ws/${this.symbol.toLowerCase()}@bookTicker`;
    let lastPush = 0;
    try {
      this.ws = new WebSocket(url);
    } catch (e: any) {
      console.warn('[ws] market connect failed', e?.message);
      setTimeout(() => this.connect(), this.backoff);
      return;
    }
    this.ws.on('open', () => {
      this.backoff = 1000;
      console.log(`[ws] market stream connected: ${this.symbol}`);
      emit('stream', { market: true, symbol: this.symbol });
    });
    this.ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw));
        const price = Number(m.b); // best bid — continuous, reliable
        if (Number.isFinite(price) && price > 0) {
          const now = Date.now();
          trader.onPrice(price);
          if (now - lastPush > 400) {
            lastPush = now;
            emit('price', { symbol: this.symbol, price });
          }
        }
      } catch { /* ignore */ }
    });
    this.ws.on('close', () => {
      emit('stream', { market: false });
      if (!this.stopped) setTimeout(() => this.connect(), this.backoff = Math.min(this.backoff * 2, 15000));
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

  start(): void {
    const s = getSettings();
    if (s.mode === 'paper') { this.stop(); return; }
    if (this.mode === s.mode && this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.stop();
    this.stopped = false;
    this.mode = s.mode;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const s = getSettings();
      const { api } = await import('./binance');
      const listenKey = await api.createListenKey();
      const url = `${wsBase(s.mode)}/ws/${listenKey}`;
      this.ws = new WebSocket(url);
      this.ws.on('open', () => {
        this.backoff = 2000;
        console.log(`[ws] user stream connected (${s.mode})`);
        emit('stream', { user: true, mode: s.mode });
        if (this.keepalive) clearInterval(this.keepalive);
        this.keepalive = setInterval(() => {
          api.keepAliveListenKey().catch(() => {});
        }, 30 * 60 * 1000);
      });
      this.ws.on('message', (raw) => {
        try {
          const m = JSON.parse(String(raw));
          if (m.e === 'ORDER_TRADE_UPDATE') trader.onOrderUpdate(m);
          if (m.e === 'MARGIN_CALL') emit('log', { level: 'error', msg: 'MARGIN_CALL received — check your position!' });
        } catch { /* ignore */ }
      });
      this.ws.on('close', () => {
        emit('stream', { user: false });
        if (!this.stopped) setTimeout(() => void this.connect(), this.backoff = Math.min(this.backoff * 2, 30000));
      });
      this.ws.on('error', () => { try { this.ws?.close(); } catch { /* ignore */ } });
    } catch (e: any) {
      console.warn('[ws] user stream failed:', e?.message);
      if (!this.stopped) setTimeout(() => void this.connect(), this.backoff = Math.min(this.backoff * 2, 30000));
    }
  }
}

export const marketStream = new MarketStream();
export const userStream = new UserDataStream();

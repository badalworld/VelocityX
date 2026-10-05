/**
 * Binance USD-M Futures API client.
 *  - Market data ALWAYS from mainnet (fapi.binance.com) — real prices for paper & UI.
 *  - Orders/balance go to the selected environment (testnet or live mainnet).
 */
import crypto from 'crypto';
import { Candle } from './indicators';
import { getSettings, Mode } from './settings';
import { offlineFeed } from './offline';
import { emit } from './broadcast';

export const MAINNET_REST = 'https://fapi.binance.com';
export const TESTNET_REST = 'https://testnet.binancefuture.com';
export const MAINNET_WS = 'wss://fstream.binance.com';
export const TESTNET_WS = 'wss://stream.testnet.binancefuture.com';

/** Current feed time: simulated clock in offline-demo mode, wall clock otherwise. */
export function feedNow(): number {
  return offlineFeed.active ? offlineFeed.now() : Date.now();
}

export function restBase(mode: Mode): string {
  return mode === 'testnet' ? TESTNET_REST : MAINNET_REST;
}
export function wsBase(mode: Mode): string {
  return mode === 'testnet' ? TESTNET_WS : MAINNET_WS;
}

export interface SymbolInfo {
  symbol: string;
  stepSize: number;
  tickSize: number;
  minQty: number;
  minNotional: number;
  stepDecimals: number;
  tickDecimals: number;
}

function decimalsOf(step: string): number {
  const s = step.includes('.') ? step.replace(/0+$/, '') : step;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1 + (s.endsWith('.') ? 1 : 0);
}
function fixDec(step: string): number {
  if (!step.includes('.')) return 0;
  const frac = step.split('.')[1] || '';
  return frac.replace(/0+$/, '').length || frac.length;
}

export class BinanceApi {
  private symbolCache = new Map<string, { info: SymbolInfo; at: number }>();
  private klineCache = new Map<string, { at: number; data: Candle[] }>();
  private inFlight = new Map<string, Promise<any>>();
  private lastLiveTry = 0;

  /** True while the offline demo feed is serving synthetic candles. */
  isOffline(): boolean {
    return offlineFeed.active;
  }

  private goOffline(): void {
    if (!offlineFeed.active) {
      offlineFeed.activate();
      this.klineCache.clear();
      console.warn('[binance] unreachable — OFFLINE DEMO feed engaged (synthetic data,10x clock)');
      emit('log', { level: 'error', msg: '⚠ Binance API unreachable — OFFLINE DEMO feed engaged (simulated data)' });
      emit('feed', { feed: 'offline-demo' });
    }
  }

  private goOnline(): void {
    if (offlineFeed.active) {
      offlineFeed.deactivate();
      this.klineCache.clear();
      console.log('[binance] connection restored — real Binance feed');
      emit('log', { level: 'win', msg: '✓ Binance API reachable again — real market feed restored' });
      emit('feed', { feed: 'binance' });
    }
  }

  /** Keys for the *order* environment (never for market data). */
  private keys(): { key: string; secret: string } {
    const s = getSettings();
    return s.mode === 'live' ? s.keys.live : s.keys.testnet;
  }

  orderMode(): Exclude<Mode, 'paper'> {
    return getSettings().mode === 'live' ? 'live' : 'testnet';
  }

  // ---------------- market data (mainnet public) ----------------

  async klines(symbol: string, interval: string, limit = 500, cacheMs = 2500): Promise<Candle[]> {
    const ck = `${symbol}|${interval}|${limit}`;
    const hit = this.klineCache.get(ck);
    if (hit && Date.now() - hit.at < cacheMs) return hit.data;

    // Offline: serve synthetic candles; retry the real API at most every 60s.
    if (offlineFeed.active && Date.now() - this.lastLiveTry < 60_000) {
      const data = offlineFeed.candles(symbol, interval, limit);
      this.klineCache.set(ck, { at: Date.now(), data });
      return data;
    }
    this.lastLiveTry = Date.now();

    try {
      const p = this.throttle(ck, () =>
        this.publicGet('/fapi/v1/klines', { symbol, interval, limit: Math.min(limit, 1500) }),
      );
      const raw = (await p) as any[];
      const data: Candle[] = raw.map((k) => ({
        time: Number(k[0]),
        closeTime: Number(k[6]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      }));
      this.goOnline();
      this.klineCache.set(ck, { at: Date.now(), data });
      return data;
    } catch (e) {
      this.goOffline();
      const data = offlineFeed.candles(symbol, interval, limit);
      this.klineCache.set(ck, { at: Date.now(), data });
      return data;
    }
  }

  async price(symbol: string): Promise<number> {
    if (offlineFeed.active) return offlineFeed.price(symbol);
    try {
      const d = (await this.publicGet('/fapi/v1/ticker/price', { symbol })) as any;
      return Number(d.price);
    } catch (e) {
      this.goOffline();
      return offlineFeed.price(symbol);
    }
  }

  async exchangeInfo(symbol: string): Promise<SymbolInfo> {
    const hit = this.symbolCache.get(symbol);
    if (hit && Date.now() - hit.at < 3600_000) return hit.info;
    if (offlineFeed.active) {
      const info = offlineFeed.exchangeInfo(symbol) as SymbolInfo;
      this.symbolCache.set(symbol, { info, at: Date.now() });
      return info;
    }
    let info: any;
    try {
      info = (await this.publicGet('/fapi/v1/exchangeInfo', {})) as any;
    } catch (e) {
      this.goOffline();
      const oi = offlineFeed.exchangeInfo(symbol) as SymbolInfo;
      this.symbolCache.set(symbol, { info: oi, at: Date.now() });
      return oi;
    }
    const s = (info.symbols || []).find((x: any) => x.symbol === symbol);
    if (!s) throw new Error(`Symbol ${symbol} not found on Binance Futures`);
    let stepSize = 0.001, tickSize = 0.01, minQty = 0.001, minNotional = 100;
    for (const f of s.filters) {
      if (f.filterType === 'LOT_SIZE' || f.filterType === 'MARKET_LOT_SIZE') {
        if (f.filterType === 'LOT_SIZE' || Number(f.stepSize) > 0) {
          stepSize = Number(f.stepSize) || stepSize;
          minQty = Number(f.minQty) || minQty;
        }
      }
      if (f.filterType === 'PRICE_FILTER') tickSize = Number(f.tickSize) || tickSize;
      if (f.filterType === 'MIN_NOTIONAL') minNotional = Number(f.minNotional) || minNotional;
    }
    const info2: SymbolInfo = {
      symbol,
      stepSize,
      tickSize,
      minQty,
      minNotional,
      stepDecimals: fixDec(String(stepSize)),
      tickDecimals: fixDec(String(tickSize)),
    };
    this.symbolCache.set(symbol, { info: info2, at: Date.now() });
    return info2;
  }

  private async publicGet(path: string, params: Record<string, any>): Promise<any> {
    const qs = new URLSearchParams(params as any).toString();
    const url = `${MAINNET_REST}${path}${qs ? '?' + qs : ''}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Binance ${path} HTTP ${r.status}: ${body.slice(0, 300)}`);
    }
    return r.json();
  }

  private throttle<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const p = fn().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p as any);
    return p;
  }

  // ---------------- signed (order) endpoints ----------------

  private async signed(method: string, path: string, params: Record<string, any> = {}): Promise<any> {
    const { key, secret } = this.keys();
    if (!key || !secret) throw new Error(`No API keys configured for ${this.orderMode()} mode`);
    const base = restBase(this.orderMode());
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) q.append(k, String(v));
    }
    q.append('timestamp', String(Date.now()));
    q.append('recvWindow', '5000');
    const query = q.toString();
    const sig = crypto.createHmac('sha256', secret).update(query).digest('hex');
    const url = `${base}${path}?${query}&signature=${sig}`;
    const r = await fetch(url, {
      method,
      headers: { 'X-MBX-APIKEY': key },
    });
    const body = await r.text();
    let json: any;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(`Binance ${path} bad response: ${body.slice(0, 300)}`);
    }
    if (!r.ok || json.code) {
      const msg = json.msg || body;
      throw new Error(`Binance ${path} error ${json.code ?? r.status}: ${msg}`);
    }
    return json;
  }

  async balanceUSDT(): Promise<{ total: number; available: number }> {
    const rows = (await this.signed('GET', '/fapi/v2/balance', {})) as any[];
    const usdt = rows.find((r) => r.asset === 'USDT');
    if (!usdt) return { total: 0, available: 0 };
    return { total: Number(usdt.balance), available: Number(usdt.availableBalance ?? usdt.balance) };
  }

  async positionAmount(symbol: string): Promise<number> {
    const rows = (await this.signed('GET', '/fapi/v2/positionRisk', { symbol })) as any[];
    const r = rows.find((x) => x.symbol === symbol);
    return r ? Number(r.positionAmt) : 0;
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    try {
      await this.signed('POST', '/fapi/v1/leverage', { symbol, leverage });
    } catch (e: any) {
      if (!/NO_NEED_TO_CHANGE/i.test(String(e?.message))) throw e;
    }
  }

  async setIsolated(symbol: string): Promise<void> {
    try {
      await this.signed('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' });
    } catch (e: any) {
      if (!/No need to change|already/i.test(String(e?.message))) {
        // non-fatal: cross mode still works
        console.warn('[binance] marginType:', e?.message);
      }
    }
  }

  /** Hedge-mode detection (positionSide). Cached per process. */
  private dualSide: boolean | null = null;
  async isDualSide(): Promise<boolean> {
    if (this.dualSide !== null) return this.dualSide;
    try {
      const d = await this.signed('GET', '/fapi/v1/positionSide/dual', {});
      this.dualSide = !!d.dualSidePosition;
    } catch {
      this.dualSide = false;
    }
    return this.dualSide;
  }

  async newOrder(order: Record<string, any>): Promise<any> {
    const dual = await this.isDualSide();
    const params: Record<string, any> = { ...order };
    if (dual && !params.positionSide) {
      const isClose = !!(order.closePosition || order.reduceOnly || order.closePosition === 'true');
      // close orders: positionSide is the side of the position being closed
      params.positionSide = isClose
        ? order.side === 'SELL' ? 'LONG' : 'SHORT'
        : order.side === 'BUY' ? 'LONG' : 'SHORT';
    }
    return this.signed('POST', '/fapi/v1/order', params);
  }

  async cancelOrder(symbol: string, orderId?: string, origClientOrderId?: string): Promise<any> {
    const p: any = { symbol };
    if (orderId) p.orderId = orderId;
    if (origClientOrderId) p.origClientOrderId = origClientOrderId;
    try {
      return await this.signed('DELETE', '/fapi/v1/order', p);
    } catch (e: any) {
      if (-2011 === extractCode(e) || /Unknown order/i.test(String(e?.message))) return null; // already gone
      throw e;
    }
  }

  async openOrders(symbol: string): Promise<any[]> {
    return (await this.signed('GET', '/fapi/v1/openOrders', { symbol })) as any[];
  }

  async marketOrder(symbol: string, side: 'BUY' | 'SELL', qty: number, opts: { reduceOnly?: boolean; positionSide?: string; newClientOrderId?: string } = {}): Promise<any> {
    const p: any = { symbol, side, type: 'MARKET', quantity: fmtQty(qty) };
    if (opts.reduceOnly) p.reduceOnly = 'true';
    if (opts.newClientOrderId) p.newClientOrderId = opts.newClientOrderId;
    if (opts.positionSide) p.positionSide = opts.positionSide;
    return this.newOrder(p);
  }

  async stopMarket(symbol: string, side: 'BUY' | 'SELL', stopPrice: number, opts: { closePosition?: boolean; qty?: number; reduceOnly?: boolean; newClientOrderId?: string; positionSide?: string } = {}): Promise<any> {
    const p: any = { symbol, side, type: 'STOP_MARKET', stopPrice: fmtPrice(stopPrice) };
    if (opts.closePosition) p.closePosition = 'true';
    if (opts.reduceOnly) p.reduceOnly = 'true';
    if (opts.qty) p.quantity = fmtQty(opts.qty);
    if (opts.newClientOrderId) p.newClientOrderId = opts.newClientOrderId;
    if (opts.positionSide) p.positionSide = opts.positionSide;
    return this.newOrder(p);
  }

  async takeProfitMarket(symbol: string, side: 'BUY' | 'SELL', stopPrice: number, qty: number, opts: { newClientOrderId?: string; positionSide?: string } = {}): Promise<any> {
    const p: any = {
      symbol, side, type: 'TAKE_PROFIT_MARKET',
      stopPrice: fmtPrice(stopPrice),
      quantity: fmtQty(qty),
      reduceOnly: 'true',
    };
    if (opts.newClientOrderId) p.newClientOrderId = opts.newClientOrderId;
    if (opts.positionSide) p.positionSide = opts.positionSide;
    return this.newOrder(p);
  }

  // ---------------- user data stream ----------------

  async createListenKey(): Promise<string> {
    const { key } = this.keys();
    if (!key) throw new Error('No API key');
    const base = restBase(this.orderMode());
    const r = await fetch(`${base}/fapi/v1/listenKey`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': key },
    });
    const j = await r.json();
    if (!j.listenKey) throw new Error('listenKey failed: ' + JSON.stringify(j));
    return j.listenKey;
  }

  async keepAliveListenKey(): Promise<void> {
    const { key } = this.keys();
    if (!key) return;
    const base = restBase(this.orderMode());
    await fetch(`${base}/fapi/v1/listenKey`, { method: 'PUT', headers: { 'X-MBX-APIKEY': key } });
  }
}

function extractCode(e: any): number {
  const m = /error (-?\d+)/.exec(String(e?.message || ''));
  return m ? Number(m[1]) : NaN;
}

export function fmtQty(q: number): string {
  // trim float noise
  return String(Number(q.toFixed(8)));
}
export function fmtPrice(p: number): string {
  return String(Number(p.toFixed(8)));
}

/** Round DOWN to a lot step (decimal-safe enough for exchange steps). */
export function floorToStep(v: number, step: number): number {
  if (step <= 0) return v;
  const n = Math.floor(v / step + 1e-9);
  return Number((n * step).toFixed(8));
}

/** Round price to tick size. */
export function roundToTick(v: number, tick: number): number {
  if (tick <= 0) return v;
  return Number((Math.round(v / tick) * tick).toFixed(8));
}

export const api = new BinanceApi();

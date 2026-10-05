/**
 * Binance USD-M Futures API client.
 *
 *  • Market data ALWAYS from mainnet (fapi.binance.com) — real prices, candles,
 *    funding and 24h stats for the dashboard, the scanner and the engine.
 *  • Orders / balance / income go to the selected environment (testnet | live).
 *  • Every request is scheduled through the 95% weight budget in ratelimit.ts,
 *    inside its own work area, so realtime data keeps flowing while the
 *    scanner, the executor and the account poller all work at the same time.
 */
import crypto from 'crypto';
import { Candle } from './indicators';
import { getSettings, Mode } from './settings';
import { offlineFeed } from './offline';
import { emit } from './broadcast';
import { Area, ENDPOINT_WEIGHT, klineWeight, limiter } from './ratelimit';

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

export interface ExchangeSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  contractType: string;
  status: string;
  pricePrecision: number;
  quantityPrecision: number;
  stepSize: number;
  tickSize: number;
  minQty: number;
  minNotional: number;
}

export interface AccountSnapshot {
  /** totalMarginBalance (wallet + unrealised) — the real Binance equity */
  equity: number;
  walletBalance: number;
  unrealizedPnl: number;
  availableBalance: number;
  initialMargin: number;
  maintMargin: number;
  crossWalletBalance: number;
  openOrderInitialMargin: number;
  /** unrealised PnL ÷ margin in use */
  roiPct: number;
  /** unrealised PnL ÷ wallet balance */
  roiOnWalletPct: number;
  /** Binance "can trade" flag from the API key permissions */
  canTrade: boolean;
  at: number;
}

export interface RawPosition {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unRealizedProfit: number;
  liquidationPrice: number;
  leverage: number;
  marginType: string;
  isolatedMargin: number;
  positionInitialMargin: number;
  notional: number;
  updateTime: number;
}

export interface IncomeRecord {
  symbol: string;
  incomeType: string;
  income: number;
  asset: string;
  time: number;
  tranId?: number | string;
  info?: string;
}

function fixDec(step: string): number {
  if (!step.includes('.')) return 0;
  const frac = step.split('.')[1] || '';
  return frac.replace(/0+$/, '').length || frac.length;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export class BinanceApi {
  private symbolCache = new Map<string, { info: SymbolInfo; at: number }>();
  private exchangeCache: { list: ExchangeSymbol[]; at: number } | null = null;
  private klineCache = new Map<string, { at: number; data: Candle[] }>();
  private inFlight = new Map<string, Promise<any>>();
  private lastLiveTry = 0;

  /** Connection telemetry — surfaced in /api/diagnostics so the UI can prove the feed is real. */
  telemetry = {
    lastRestOkAt: 0,
    lastRestErrorAt: 0,
    lastRestError: '',
    lastLatencyMs: 0,
    avgLatencyMs: 0,
    requests: 0,
    errors: 0,
    serverTimeOffsetMs: 0,
    wsLastMessageAt: 0,
  };

  /** True while the offline demo feed is serving synthetic candles. */
  isOffline(): boolean {
    return offlineFeed.active;
  }

  /** Nothing synthetic is ever served unless the operator opts in explicitly. */
  demoAllowed(): boolean {
    return process.env.VX_OFFLINE_DEMO === '1';
  }

  /** `null` while unknown (first request not finished yet). */
  reachable: boolean | null = null;

  private goOffline(): void {
    if (this.reachable !== false) {
      this.reachable = false;
      emit('feed', { feed: 'binance-unreachable' });
    }
    if (this.demoAllowed() && !offlineFeed.active) {
      offlineFeed.activate();
      this.klineCache.clear();
      console.warn('[binance] unreachable — OFFLINE DEMO feed engaged (VX_OFFLINE_DEMO=1, synthetic data)');
      emit('log', { level: 'error', msg: '⚠ Binance API unreachable — OFFLINE DEMO feed engaged (simulated data, NOT Binance)' });
      emit('feed', { feed: 'offline-demo' });
    } else if (this.demoAllowed()) {
      /* already active */
    } else if (this.lastLiveTry) {
      emit('log', { level: 'error', msg: 'Binance API unreachable from this host — no market data available (demo feed disabled)' });
    }
  }

  private goOnline(): void {
    const wasDown = this.reachable === false;
    const wasDemo = offlineFeed.active;
    this.reachable = true;
    if (wasDemo) {
      offlineFeed.deactivate();
      this.klineCache.clear();
      console.log('[binance] connection restored — real Binance feed');
      emit('log', { level: 'win', msg: '✓ Binance API reachable again — real market feed restored' });
    }
    if (wasDown || wasDemo) emit('feed', { feed: 'binance' });
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
        this.publicGet('/fapi/v1/klines', { symbol, interval, limit: Math.min(limit, 1500) }, 'market', klineWeight(Math.min(limit, 1500))),
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
      if (!offlineFeed.active) throw e; // no synthetic data unless explicitly enabled
      const data = offlineFeed.candles(symbol, interval, limit);
      this.klineCache.set(ck, { at: Date.now(), data });
      return data;
    }
  }

  /** One call for the whole universe: 24h stats (weight 40) — scanner step 1. */
  async ticker24hrAll(): Promise<
    { symbol: string; lastPrice: number; priceChangePercent: number; highPrice: number; lowPrice: number; quoteVolume: number; volume: number }[]
  > {
    if (offlineFeed.active) return offlineFeed.tickers();
    let raw: any[];
    try {
      raw = (await this.publicGet('/fapi/v1/ticker/24hr', {}, 'scanner', ENDPOINT_WEIGHT.ticker24All)) as any[];
      this.goOnline();
    } catch (e) {
      this.goOffline();
      if (offlineFeed.active) return offlineFeed.tickers();
      throw e;
    }
    return raw.map((r) => ({
      symbol: String(r.symbol),
      lastPrice: num(r.lastPrice),
      priceChangePercent: num(r.priceChangePercent),
      highPrice: num(r.highPrice),
      lowPrice: num(r.lowPrice),
      quoteVolume: num(r.quoteVolume),
      volume: num(r.volume),
    }));
  }

  /** Funding rates for the whole universe (weight 10) — scanner step 1b. */
  async premiumIndexAll(): Promise<{ symbol: string; markPrice: number; lastFundingRate: number; nextFundingTime: number }[]> {
    if (offlineFeed.active) return [];
    try {
      const raw = (await this.publicGet('/fapi/v1/premiumIndex', {}, 'scanner', ENDPOINT_WEIGHT.premiumIndexAll)) as any[];
      return raw.map((r) => ({
        symbol: String(r.symbol),
        markPrice: num(r.markPrice),
        lastFundingRate: num(r.lastFundingRate),
        nextFundingTime: num(r.nextFundingTime),
      }));
    } catch {
      return [];
    }
  }

  /** Signed account snapshot — equity, unrealised PnL, margin, ROI. */
  async accountSnapshot(): Promise<AccountSnapshot> {
    const a = (await this.signed('GET', '/fapi/v2/account', {}, 'account', ENDPOINT_WEIGHT.account)) as any;
    const walletBalance = num(a.totalWalletBalance);
    const unrealizedPnl = num(a.totalUnrealizedProfit);
    const equity = num(a.totalMarginBalance, walletBalance + unrealizedPnl);
    const initialMargin = num(a.totalPositionInitialMargin) + num(a.totalOpenOrderInitialMargin);
    return {
      equity,
      walletBalance,
      unrealizedPnl,
      availableBalance: num(a.availableBalance),
      initialMargin,
      maintMargin: num(a.totalMaintMargin),
      crossWalletBalance: num(a.crossWalletBalance),
      openOrderInitialMargin: num(a.totalOpenOrderInitialMargin),
      roiPct: initialMargin > 0 ? (unrealizedPnl / initialMargin) * 100 : 0,
      roiOnWalletPct: walletBalance > 0 ? (unrealizedPnl / walletBalance) * 100 : 0,
      canTrade: !!a.canTrade,
      at: Date.now(),
    };
  }

  async positionRisk(symbol?: string): Promise<RawPosition[]> {
    const rows = (await this.signed('GET', '/fapi/v2/positionRisk', symbol ? { symbol } : {}, 'account', ENDPOINT_WEIGHT.positionRisk)) as any[];
    return (rows || [])
      .map((r) => ({
        symbol: String(r.symbol),
        positionAmt: num(r.positionAmt),
        entryPrice: num(r.entryPrice),
        markPrice: num(r.markPrice),
        unRealizedProfit: num(r.unRealizedProfit),
        liquidationPrice: num(r.liquidationPrice),
        leverage: num(r.leverage, 1),
        marginType: String(r.marginType || ''),
        isolatedMargin: num(r.isolatedMargin),
        positionInitialMargin: num(r.positionInitialMargin),
        notional: num(r.notional),
        updateTime: num(r.updateTime),
      }))
      .filter((r) => r.positionAmt !== 0);
  }

  /**
   * Income history — the real source of Binance fees, funding and realised PnL.
   * incomeType: REALIZED_PNL | COMMISSION | FUNDING_FEE | INSURANCE_CLEAR | TRANSFER
   */
  async incomeHistory(opts: { symbol?: string; incomeType?: string; startTime?: number; endTime?: number; limit?: number } = {}): Promise<IncomeRecord[]> {
    const params: Record<string, any> = { limit: Math.min(opts.limit ?? 1000, 1000) };
    if (opts.symbol) params.symbol = opts.symbol;
    if (opts.incomeType) params.incomeType = opts.incomeType;
    if (opts.startTime) params.startTime = opts.startTime;
    if (opts.endTime) params.endTime = opts.endTime;
    const rows = (await this.signed('GET', '/fapi/v1/income', params, 'account', ENDPOINT_WEIGHT.income)) as any[];
    return (rows || []).map((r) => ({
      symbol: String(r.symbol || ''),
      incomeType: String(r.incomeType || ''),
      income: num(r.income),
      asset: String(r.asset || 'USDT'),
      time: num(r.time),
      tranId: r.tranId,
      info: r.info,
    }));
  }

  async userTrades(symbol: string, opts: { startTime?: number; limit?: number } = {}): Promise<any[]> {
    const params: Record<string, any> = { symbol, limit: Math.min(opts.limit ?? 500, 1000) };
    if (opts.startTime) params.startTime = opts.startTime;
    return (await this.signed('GET', '/fapi/v1/userTrades', params, 'account', ENDPOINT_WEIGHT.userTrades)) as any[];
  }

  async allOrders(symbol: string, opts: { startTime?: number; limit?: number } = {}): Promise<any[]> {
    const params: Record<string, any> = { symbol, limit: Math.min(opts.limit ?? 200, 1000) };
    if (opts.startTime) params.startTime = opts.startTime;
    return (await this.signed('GET', '/fapi/v1/allOrders', params, 'account', ENDPOINT_WEIGHT.allOrders)) as any[];
  }

  /** Latency + clock-drift probe used by the dashboard's "Binance live" badge. */
  async ping(): Promise<{ ok: boolean; latencyMs: number; serverTimeOffsetMs: number; error?: string }> {
    const t0 = Date.now();
    try {
      const j = (await this.publicGet('/fapi/v1/time', {}, 'market', ENDPOINT_WEIGHT.time)) as any;
      const latencyMs = Date.now() - t0;
      const serverTimeOffsetMs = num(j.serverTime) - Date.now();
      this.telemetry.lastLatencyMs = latencyMs;
      this.telemetry.avgLatencyMs = this.telemetry.avgLatencyMs
        ? Math.round(this.telemetry.avgLatencyMs * 0.7 + latencyMs * 0.3)
        : latencyMs;
      this.telemetry.serverTimeOffsetMs = serverTimeOffsetMs;
      return { ok: true, latencyMs, serverTimeOffsetMs };
    } catch (e: any) {
      return { ok: false, latencyMs: Date.now() - t0, serverTimeOffsetMs: 0, error: e?.message || String(e) };
    }
  }

  async positionAmount(symbol: string): Promise<number> {
    const rows = (await this.signed('GET', '/fapi/v2/positionRisk', { symbol }, 'account', ENDPOINT_WEIGHT.positionRisk)) as any[];
    const r = rows.find((x) => x.symbol === symbol);
    return r ? num(r.positionAmt) : 0;
  }

  /**
   * Max leverage the exchange allows for a symbol (leverage brackets).
   * Cached for 1h. Used to clamp the configured leverage BEFORE the entry so a
   * 10× setting on a 5× market is downgraded instead of failing the trade.
   */
  private bracketCache: { at: number; list: Map<string, number> } | null = null;
  async maxLeverage(symbol: string): Promise<number> {
    if (this.bracketCache && Date.now() - this.bracketCache.at < 3600_000) {
      return this.bracketCache.list.get(symbol) ?? 0;
    }
    try {
      const rows = (await this.signed('GET', '/fapi/v1/leverageBracket', {}, 'account', ENDPOINT_WEIGHT.leverageBracket)) as any[];
      const list = new Map<string, number>();
      for (const r of rows || []) {
        const max = Math.max(1, ...(r?.brackets || []).map((b: any) => num(b?.initialLeverage)));
        if (r?.symbol) list.set(String(r.symbol), max);
      }
      this.bracketCache = { at: Date.now(), list };
      return list.get(symbol) ?? 0;
    } catch {
      // Bracket lookup is best-effort: without it we keep the operator's value
      // and let the exchange reject an out-of-range leverage explicitly.
      return 0;
    }
  }

  /** Full exchange metadata (cached 1h) — the scanner universe comes from here. */
  async exchangeInfoAll(): Promise<ExchangeSymbol[]> {
    if (this.exchangeCache && Date.now() - this.exchangeCache.at < 3600_000) return this.exchangeCache.list;
    if (offlineFeed.active) {
      const list = offlineFeed.universe() as ExchangeSymbol[];
      this.exchangeCache = { list, at: Date.now() };
      return list;
    }
    const info = (await this.publicGet('/fapi/v1/exchangeInfo', {}, 'scanner', ENDPOINT_WEIGHT.exchangeInfo)) as any;
    const list: ExchangeSymbol[] = (info.symbols || [])
      .filter((s: any) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
      .map((s: any) => {
        let stepSize = 0.001, tickSize = 0.01, minQty = 0.001, minNotional = 5;
        for (const f of s.filters || []) {
          if (f.filterType === 'LOT_SIZE') {
            stepSize = num(f.stepSize, stepSize);
            minQty = num(f.minQty, minQty);
          }
          if (f.filterType === 'PRICE_FILTER') tickSize = num(f.tickSize, tickSize);
          if (f.filterType === 'MIN_NOTIONAL') minNotional = num(f.minNotional, minNotional);
        }
        return {
          symbol: String(s.symbol),
          baseAsset: String(s.baseAsset),
          quoteAsset: String(s.quoteAsset),
          contractType: String(s.contractType),
          status: String(s.status),
          pricePrecision: num(s.pricePrecision),
          quantityPrecision: num(s.quantityPrecision),
          stepSize,
          tickSize,
          minQty,
          minNotional,
        };
      });
    this.exchangeCache = { list, at: Date.now() };
    return list;
  }

  async exchangeInfo(symbol: string): Promise<SymbolInfo> {
    const hit = this.symbolCache.get(symbol);
    if (hit && Date.now() - hit.at < 3600_000) return hit.info;
    if (offlineFeed.active) {
      const info = offlineFeed.exchangeInfo(symbol) as SymbolInfo;
      this.symbolCache.set(symbol, { info, at: Date.now() });
      return info;
    }
    let list: ExchangeSymbol[];
    try {
      list = await this.exchangeInfoAll();
    } catch (e) {
      this.goOffline();
      if (!offlineFeed.active) throw e;
      const oi = offlineFeed.exchangeInfo(symbol) as SymbolInfo;
      this.symbolCache.set(symbol, { info: oi, at: Date.now() });
      return oi;
    }
    const s = list.find((x) => x.symbol === symbol);
    if (!s) throw new Error(`Symbol ${symbol} not found on Binance Futures`);
    const info2: SymbolInfo = {
      symbol,
      stepSize: s.stepSize,
      tickSize: s.tickSize,
      minQty: s.minQty,
      minNotional: s.minNotional,
      stepDecimals: fixDec(String(s.stepSize)),
      tickDecimals: fixDec(String(s.tickSize)),
    };
    this.symbolCache.set(symbol, { info: info2, at: Date.now() });
    return info2;
  }

  // ---------------- transport ----------------

  private async publicGet(path: string, params: Record<string, any>, area: Area = 'market', weight = 1): Promise<any> {
    return this.request({ method: 'GET', base: MAINNET_REST, path, params, area, weight, signedReq: false });
  }

  private async request(opts: {
    method: string;
    base: string;
    path: string;
    params: Record<string, any>;
    area: Area;
    weight: number;
    signedReq: boolean;
    retries?: number;
  }): Promise<any> {
    const { method, base, path, params, area, weight, signedReq } = opts;
    const retries = opts.retries ?? 1;
    const isOrder = area === 'orders' && (method === 'POST' || method === 'DELETE');

    await limiter.acquire(area, weight, isOrder ? 0 : area === 'scanner' ? 7 : area === 'market' ? 4 : 3);
    if (isOrder) await limiter.acquireOrderSlot(0);

    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) q.append(k, String(v));
    }
    let headers: Record<string, string> = {};
    if (signedReq) {
      const { key, secret } = this.keys();
      if (!key || !secret) throw new Error(`No API keys configured for ${this.orderMode()} mode`);
      q.append('timestamp', String(Date.now()));
      q.append('recvWindow', '5000');
      const query = q.toString();
      const sig = crypto.createHmac('sha256', secret).update(query).digest('hex');
      q.append('signature', sig);
      headers = { 'X-MBX-APIKEY': key };
    }
    const qs = q.toString();
    const url = `${base}${path}${qs ? '?' + qs : ''}`;

    this.telemetry.requests += 1;
    const t0 = Date.now();
    let r: Response;
    try {
      r = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(method === 'POST' || method === 'DELETE' ? 10_000 : 8_000),
      });
    } catch (e: any) {
      this.telemetry.errors += 1;
      this.telemetry.lastRestError = e?.message || String(e);
      this.telemetry.lastRestErrorAt = Date.now();
      throw e;
    }
    limiter.observeHeaders(r.headers);
    const body = await r.text();

    if (r.status === 429 || r.status === 418) {
      const retryAfter = Number(r.headers.get('retry-after') || 0);
      limiter.penalize(r.status === 418 ? '418' : '429', retryAfter || undefined);
      emit('log', { level: 'error', msg: `Binance rate limit (${r.status}) — scheduler cooling down ${retryAfter || 60}s` });
      if (retries > 0) return this.request({ ...opts, retries: retries - 1 });
      throw new Error(`Binance ${path} rate limited (${r.status})`);
    }

    if (!r.ok) {
      this.telemetry.errors += 1;
      this.telemetry.lastRestError = `HTTP ${r.status}: ${body.slice(0, 200)}`;
      this.telemetry.lastRestErrorAt = Date.now();
      // -1021 = timestamp out of recvWindow — resync the clock and retry once.
      if (/-1021/.test(body) && retries > 0) {
        const ping = await this.ping().catch(() => null);
        if (ping?.ok) {
          await new Promise((res) => setTimeout(res, 250));
          return this.request({ ...opts, retries: retries - 1 });
        }
      }
      throw new Error(`Binance ${path} HTTP ${r.status}: ${body.slice(0, 300)}`);
    }

    this.telemetry.lastRestOkAt = Date.now();
    this.telemetry.lastLatencyMs = Date.now() - t0;
    this.telemetry.avgLatencyMs = this.telemetry.avgLatencyMs
      ? Math.round(this.telemetry.avgLatencyMs * 0.7 + this.telemetry.lastLatencyMs * 0.3)
      : this.telemetry.lastLatencyMs;
    this.goOnline();

    let json: any;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(`Binance ${path} bad response: ${body.slice(0, 300)}`);
    }
    if (json && json.code) {
      const msg = json.msg || body;
      throw new Error(`Binance ${path} error ${json.code}: ${msg}`);
    }
    return json;
  }

  private throttle<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const p = fn().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p as any);
    return p;
  }

  // ---------------- signed (account / order) endpoints ----------------

  private async signed(method: string, path: string, params: Record<string, any> = {}, area: Area = 'account', weight = 1): Promise<any> {
    return this.request({
      method,
      base: restBase(this.orderMode()),
      path,
      params,
      area,
      weight,
      signedReq: true,
      retries: method === 'GET' ? 1 : 0,
    });
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    try {
      await this.signed('POST', '/fapi/v1/leverage', { symbol, leverage }, 'orders', ENDPOINT_WEIGHT.leverage);
    } catch (e: any) {
      if (!/NO_NEED_TO_CHANGE/i.test(String(e?.message))) throw e;
    }
  }

  async setIsolated(symbol: string): Promise<void> {
    try {
      await this.signed('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' }, 'orders', 1);
    } catch (e: any) {
      if (!/No need to change|already/i.test(String(e?.message))) {
        console.warn('[binance] marginType:', e?.message);
      }
    }
  }

  /** Hedge-mode detection (positionSide). Cached per process. */
  private dualSide: boolean | null = null;
  async isDualSide(): Promise<boolean> {
    if (this.dualSide !== null) return this.dualSide;
    try {
      const d = await this.signed('GET', '/fapi/v1/positionSide/dual', {}, 'account', 1);
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
      params.positionSide = isClose
        ? order.side === 'SELL' ? 'LONG' : 'SHORT'
        : order.side === 'BUY' ? 'LONG' : 'SHORT';
    }
    return this.signed('POST', '/fapi/v1/order', params, 'orders', ENDPOINT_WEIGHT.order);
  }

  async cancelOrder(symbol: string, orderId?: string, origClientOrderId?: string): Promise<any> {
    const p: any = { symbol };
    if (orderId) p.orderId = orderId;
    if (origClientOrderId) p.origClientOrderId = origClientOrderId;
    try {
      return await this.signed('DELETE', '/fapi/v1/order', p, 'orders', ENDPOINT_WEIGHT.order);
    } catch (e: any) {
      if (/Unknown order|-2011/.test(String(e?.message))) return null;
      throw e;
    }
  }

  async openOrders(symbol: string): Promise<any[]> {
    return (await this.signed('GET', '/fapi/v1/openOrders', { symbol }, 'account', ENDPOINT_WEIGHT.openOrders)) as any[];
  }

  async marketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    qty: number,
    opts: { reduceOnly?: boolean; positionSide?: string; newClientOrderId?: string } = {},
  ): Promise<any> {
    const p: any = { symbol, side, type: 'MARKET', quantity: fmtQty(qty) };
    if (opts.reduceOnly) p.reduceOnly = 'true';
    if (opts.newClientOrderId) p.newClientOrderId = opts.newClientOrderId;
    if (opts.positionSide) p.positionSide = opts.positionSide;
    return this.newOrder(p);
  }

  /**
   * STOP_MARKET protective order.
   *
   * The executor always sends an explicit `quantity` with `reduceOnly` (one-way
   * mode) so the stop can only ever shrink OUR position — it can never exceed
   * the bot's own size and therefore can never touch a manual/external
   * position that happens to live on the same symbol. Hedge mode uses
   * `positionSide` for the same guarantee (Binance forbids reduceOnly there).
   */
  async stopMarket(
    symbol: string,
    side: 'BUY' | 'SELL',
    stopPrice: number,
    opts: { closePosition?: boolean; qty?: number; reduceOnly?: boolean; newClientOrderId?: string; positionSide?: string } = {},
  ): Promise<any> {
    const p: any = { symbol, side, type: 'STOP_MARKET', stopPrice: fmtPrice(stopPrice) };
    if (opts.closePosition) p.closePosition = 'true';
    if (opts.reduceOnly && !opts.closePosition) p.reduceOnly = 'true';
    if (opts.qty && opts.qty > 0) p.quantity = fmtQty(opts.qty);
    if (opts.newClientOrderId) p.newClientOrderId = opts.newClientOrderId;
    if (opts.positionSide) p.positionSide = opts.positionSide;
    return this.newOrder(p);
  }

  /** Protective STOP_MARKET for `qty` of the bot position — never close-all. */
  async protectiveStop(
    symbol: string,
    closeSide: 'BUY' | 'SELL',
    stopPrice: number,
    qty: number,
    newClientOrderId: string,
  ): Promise<any> {
    const dual = await this.isDualSide();
    return this.stopMarket(symbol, closeSide, stopPrice, {
      qty,
      // Hedge mode: positionSide (inferred in newOrder) scopes the stop to the
      // bot's own side, which is the strongest guarantee Binance offers there.
      reduceOnly: !dual,
      positionSide: dual ? (closeSide === 'SELL' ? 'LONG' : 'SHORT') : undefined,
      newClientOrderId,
    });
  }

  async takeProfitMarket(
    symbol: string,
    side: 'BUY' | 'SELL',
    stopPrice: number,
    qty: number,
    opts: { newClientOrderId?: string; positionSide?: string } = {},
  ): Promise<any> {
    const p: any = {
      symbol,
      side,
      type: 'TAKE_PROFIT_MARKET',
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
    await limiter.acquire('stream', ENDPOINT_WEIGHT.listenKey, 2);
    const r = await fetch(`${base}/fapi/v1/listenKey`, { method: 'POST', headers: { 'X-MBX-APIKEY': key } });
    limiter.observeHeaders(r.headers);
    const j = await r.json();
    if (!j.listenKey) throw new Error('listenKey failed: ' + JSON.stringify(j));
    return j.listenKey;
  }

  async keepAliveListenKey(): Promise<void> {
    const { key } = this.keys();
    if (!key) return;
    const base = restBase(this.orderMode());
    await limiter.acquire('stream', ENDPOINT_WEIGHT.listenKey, 2);
    await fetch(`${base}/fapi/v1/listenKey`, { method: 'PUT', headers: { 'X-MBX-APIKEY': key } });
  }

  /** Combined market-data stream URL (bookTicker + kline per active symbol). */
  marketStreamUrl(symbols: string[], interval = '5m'): string {
    const streams = symbols.flatMap((s) => [`${s.toLowerCase()}@bookTicker`, `${s.toLowerCase()}@kline_${interval}`]);
    return `${MAINNET_WS}/stream?streams=${streams.join('/')}`;
  }
}

export function fmtQty(q: number): string {
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

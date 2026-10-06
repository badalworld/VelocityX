/** Read-only Binance USD-M market and account data client. */
import crypto from 'crypto';
import type { Candle } from './candles';
import { getSettings, Mode } from './settings';
import { emit } from './broadcast';
import { Area, ENDPOINT_WEIGHT, klineWeight, limiter } from './ratelimit';

const MAINNET_REST = 'https://fapi.binance.com';
const MAINNET_WS = 'wss://fstream.binance.com';
const DEFAULT_TESTNET_REST = 'https://demo-fapi.binance.com';
const DEFAULT_TESTNET_WS = 'wss://demo-fstream.binance.com';
const LEGACY_TESTNET_WS = 'wss://fstream.binancefuture.com';
const trimSlash = (url: string) => url.replace(/\/+$/, '');

export function restBase(mode: Mode): string {
  if (mode !== 'testnet') return MAINNET_REST;
  return trimSlash(process.env.BINANCE_TESTNET_REST || DEFAULT_TESTNET_REST);
}

export type MarketChannel = 'public' | 'market';
export function marketStreamUrl(channel: MarketChannel, symbols: string[], interval = '5m'): string {
  const streams = symbols.map((symbol) =>
    channel === 'public' ? `${symbol.toLowerCase()}@bookTicker` : `${symbol.toLowerCase()}@kline_${interval}`,
  );
  return `${MAINNET_WS}/${channel}/stream?streams=${streams.join('/')}`;
}

/** Candidate read-only account-stream URLs for Binance Demo and LIVE. */
export function userStreamUrls(mode: Mode, listenKey: string): string[] {
  const events = 'ACCOUNT_UPDATE/MARGIN_CALL/listenKeyExpired';
  const forms = (base: string) => ({
    privateWs: `${base}/private/ws/${listenKey}`,
    privateEvents: `${base}/private/ws?listenKey=${listenKey}&events=${events}`,
    privateStream: `${base}/private/stream?listenKey=${listenKey}&events=${events}`,
    legacy: `${base}/ws/${listenKey}`,
  });
  if (mode !== 'testnet') {
    const main = forms(MAINNET_WS);
    return [main.privateWs, main.privateEvents, main.privateStream, main.legacy];
  }
  const pinned = process.env.BINANCE_TESTNET_WS;
  if (pinned) {
    const urls = forms(trimSlash(pinned));
    return [urls.privateWs, urls.privateEvents, urls.privateStream, urls.legacy];
  }
  const demo = forms(DEFAULT_TESTNET_WS);
  const old = forms(LEGACY_TESTNET_WS);
  return [demo.privateWs, demo.privateEvents, old.legacy, old.privateWs, demo.privateStream, demo.legacy, old.privateEvents];
}

export interface AccountSnapshot {
  equity: number;
  walletBalance: number;
  unrealizedPnl: number;
  availableBalance: number;
  initialMargin: number;
  maintMargin: number;
  roiPct: number;
  roiOnWalletPct: number;
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

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export class BinanceApi {
  private klineCache = new Map<string, { at: number; data: Candle[] }>();
  private inFlight = new Map<string, Promise<any>>();

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
  reachable: boolean | null = null;

  private keys(): { key: string; secret: string } {
    const settings = getSettings();
    return settings.mode === 'live' ? settings.keys.live : settings.keys.testnet;
  }

  private mode(): Mode {
    return getSettings().mode;
  }

  private markUnreachable(): void {
    if (this.reachable === false) return;
    this.reachable = false;
    console.warn('[binance] unreachable — live exchange data is temporarily unavailable');
    emit('log', { level: 'error', msg: 'Binance API unreachable — exchange data is unavailable (no simulation)' });
    emit('feed', { feed: 'binance-unreachable' });
  }

  private goOnline(): void {
    const recovered = this.reachable === false;
    this.reachable = true;
    if (!recovered) return;
    console.log('[binance] connection restored — real Binance feed');
    emit('log', { level: 'info', msg: 'Binance API reachable again — real exchange data restored' });
    emit('feed', { feed: 'binance' });
  }

  /** Binance public market klines (mainnet only). */
  async klines(symbol: string, interval: string, limit = 500, cacheMs = 2500, area: Area = 'market'): Promise<Candle[]> {
    const cacheKey = `${symbol}|${interval}|${limit}`;
    const cached = this.klineCache.get(cacheKey);
    if (cached && Date.now() - cached.at < cacheMs) return cached.data;
    try {
      const raw = await this.throttle(cacheKey, () => this.publicGet(
        '/fapi/v1/klines',
        { symbol, interval, limit: Math.min(limit, 1500) },
        area,
        klineWeight(Math.min(limit, 1500)),
      )) as any[];
      const data = raw.map((row) => ({
        time: num(row[0]),
        closeTime: num(row[6]),
        open: num(row[1]),
        high: num(row[2]),
        low: num(row[3]),
        close: num(row[4]),
        volume: num(row[5]),
      }));
      this.goOnline();
      this.klineCache.set(cacheKey, { at: Date.now(), data });
      return data;
    } catch (error) {
      this.markUnreachable();
      throw error;
    }
  }

  async accountSnapshot(): Promise<AccountSnapshot> {
    const account = await this.signedGet('/fapi/v2/account', {}, 'account', ENDPOINT_WEIGHT.account);
    const walletBalance = num(account.totalWalletBalance);
    const unrealizedPnl = num(account.totalUnrealizedProfit);
    const equity = num(account.totalMarginBalance, walletBalance + unrealizedPnl);
    const initialMargin = num(account.totalPositionInitialMargin) + num(account.totalOpenOrderInitialMargin);
    return {
      equity,
      walletBalance,
      unrealizedPnl,
      availableBalance: num(account.availableBalance),
      initialMargin,
      maintMargin: num(account.totalMaintMargin),
      roiPct: initialMargin > 0 ? (unrealizedPnl / initialMargin) * 100 : 0,
      roiOnWalletPct: walletBalance > 0 ? (unrealizedPnl / walletBalance) * 100 : 0,
      canTrade: !!account.canTrade,
      at: Date.now(),
    };
  }

  async positionRisk(symbol?: string): Promise<RawPosition[]> {
    const rows = await this.signedGet('/fapi/v2/positionRisk', symbol ? { symbol } : {}, 'account', ENDPOINT_WEIGHT.positionRisk) as any[];
    return (rows || []).map((row) => ({
      symbol: String(row.symbol || ''),
      positionAmt: num(row.positionAmt),
      entryPrice: num(row.entryPrice),
      markPrice: num(row.markPrice),
      unRealizedProfit: num(row.unRealizedProfit),
      liquidationPrice: num(row.liquidationPrice),
      leverage: num(row.leverage, 1),
      marginType: String(row.marginType || ''),
      isolatedMargin: num(row.isolatedMargin),
      positionInitialMargin: num(row.positionInitialMargin),
      notional: num(row.notional),
      updateTime: num(row.updateTime),
    })).filter((position) => position.positionAmt !== 0);
  }

  async incomeHistory(opts: { symbol?: string; incomeType?: string; startTime?: number; endTime?: number; limit?: number } = {}): Promise<IncomeRecord[]> {
    const params: Record<string, any> = { limit: Math.min(opts.limit ?? 1000, 1000) };
    if (opts.symbol) params.symbol = opts.symbol;
    if (opts.incomeType) params.incomeType = opts.incomeType;
    if (opts.startTime) params.startTime = opts.startTime;
    if (opts.endTime) params.endTime = opts.endTime;
    const rows = await this.signedGet('/fapi/v1/income', params, 'account', ENDPOINT_WEIGHT.income) as any[];
    return (rows || []).map((row) => ({
      symbol: String(row.symbol || ''),
      incomeType: String(row.incomeType || ''),
      income: num(row.income),
      asset: String(row.asset || 'USDT'),
      time: num(row.time),
      tranId: row.tranId,
      info: row.info,
    }));
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; serverTimeOffsetMs: number; error?: string }> {
    const startedAt = Date.now();
    try {
      const response = await this.publicGet('/fapi/v1/time', {}, 'market', ENDPOINT_WEIGHT.time);
      const receivedAt = Date.now();
      const latencyMs = receivedAt - startedAt;
      const serverTimeOffsetMs = num(response.serverTime) - Math.round((startedAt + receivedAt) / 2);
      this.telemetry.lastLatencyMs = latencyMs;
      this.telemetry.avgLatencyMs = this.telemetry.avgLatencyMs
        ? Math.round(this.telemetry.avgLatencyMs * 0.7 + latencyMs * 0.3)
        : latencyMs;
      this.telemetry.serverTimeOffsetMs = serverTimeOffsetMs;
      return { ok: true, latencyMs, serverTimeOffsetMs };
    } catch (error: any) {
      return { ok: false, latencyMs: Date.now() - startedAt, serverTimeOffsetMs: 0, error: error?.message || String(error) };
    }
  }

  private async publicGet(pathname: string, params: Record<string, any>, area: Area, weight: number): Promise<any> {
    return this.request({ method: 'GET', base: MAINNET_REST, pathname, params, area, weight, signed: false });
  }

  private async signedGet(pathname: string, params: Record<string, any>, area: Area, weight: number): Promise<any> {
    return this.request({ method: 'GET', base: restBase(this.mode()), pathname, params, area, weight, signed: true });
  }

  private async request(options: {
    method: 'GET';
    base: string;
    pathname: string;
    params: Record<string, any>;
    area: Area;
    weight: number;
    signed: boolean;
    retries?: number;
  }): Promise<any> {
    const retries = options.retries ?? 1;
    await limiter.acquire(options.area, options.weight, options.area === 'market' ? 4 : 3);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.params)) {
      if (value !== undefined && value !== null) query.append(key, String(value));
    }
    const headers: Record<string, string> = {};
    if (options.signed) {
      const { key, secret } = this.keys();
      if (!key || !secret) throw new Error(`No API keys configured for ${this.mode()} mode`);
      query.append('timestamp', String(Date.now() + this.telemetry.serverTimeOffsetMs));
      query.append('recvWindow', '5000');
      const signature = crypto.createHmac('sha256', secret).update(query.toString()).digest('hex');
      query.append('signature', signature);
      headers['X-MBX-APIKEY'] = key;
    }
    const suffix = query.toString();
    const url = `${options.base}${options.pathname}${suffix ? `?${suffix}` : ''}`;
    this.telemetry.requests += 1;
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(8_000) });
    } catch (error: any) {
      this.telemetry.errors += 1;
      this.telemetry.lastRestError = error?.message || String(error);
      this.telemetry.lastRestErrorAt = Date.now();
      if (options.base === MAINNET_REST) this.markUnreachable();
      throw error;
    }
    limiter.observeHeaders(response.headers);
    const body = await response.text();
    if (response.status === 429 || response.status === 418) {
      const retryAfter = Number(response.headers.get('retry-after') || 0);
      limiter.penalize(response.status === 418 ? '418' : '429', retryAfter || undefined);
      emit('log', { level: 'error', msg: `Binance read rate limit (${response.status}); request scheduler cooling down` });
      if (retries > 0) return this.request({ ...options, retries: retries - 1 });
      throw new Error(`Binance ${options.pathname} rate limited (${response.status})`);
    }
    if (!response.ok) {
      this.telemetry.errors += 1;
      this.telemetry.lastRestError = `HTTP ${response.status}: ${body.slice(0, 200)}`;
      this.telemetry.lastRestErrorAt = Date.now();
      if (/-1021/.test(body)) {
        const ping = await this.ping().catch(() => null);
        if (ping?.ok && retries > 0) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return this.request({ ...options, retries: retries - 1 });
        }
      }
      throw new Error(`Binance ${options.pathname} HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    this.updateSuccessTelemetry(startedAt);
    this.goOnline();
    let result: any;
    try { result = JSON.parse(body); }
    catch { throw new Error(`Binance ${options.pathname} returned invalid JSON: ${body.slice(0, 200)}`); }
    if (result && typeof result === 'object' && !Array.isArray(result) && result.code !== undefined) {
      const code = Number(result.code);
      if (Number.isFinite(code) && code !== 0 && code !== 200) {
        throw new Error(`Binance ${options.pathname} error ${result.code}: ${result.msg || body}`);
      }
    }
    return result;
  }

  private updateSuccessTelemetry(startedAt: number): void {
    this.telemetry.lastRestOkAt = Date.now();
    this.telemetry.lastLatencyMs = Date.now() - startedAt;
    this.telemetry.avgLatencyMs = this.telemetry.avgLatencyMs
      ? Math.round(this.telemetry.avgLatencyMs * 0.7 + this.telemetry.lastLatencyMs * 0.3)
      : this.telemetry.lastLatencyMs;
  }

  private throttle<T>(key: string, run: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;
    const request = run().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private async listenKeyRequest(method: 'POST' | 'PUT'): Promise<any> {
    const { key } = this.keys();
    if (!key) throw new Error('No API key configured');
    const base = restBase(this.mode());
    await limiter.acquire('stream', ENDPOINT_WEIGHT.listenKey, 2);
    const startedAt = Date.now();
    const response = await fetch(`${base}/fapi/v1/listenKey`, {
      method,
      headers: { 'X-MBX-APIKEY': key },
      signal: AbortSignal.timeout(10_000),
    });
    limiter.observeHeaders(response.headers);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.telemetry.errors += 1;
      this.telemetry.lastRestError = `HTTP ${response.status}: ${body.slice(0, 200)}`;
      this.telemetry.lastRestErrorAt = Date.now();
      throw new Error(`Binance listenKey ${method} HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    this.updateSuccessTelemetry(startedAt);
    const body = await response.json().catch(() => ({}));
    this.goOnline();
    return body;
  }

  async createListenKey(): Promise<string> {
    const result = await this.listenKeyRequest('POST');
    if (!result.listenKey) throw new Error(`listenKey failed: ${JSON.stringify(result)}`);
    return String(result.listenKey);
  }

  async keepAliveListenKey(): Promise<void> {
    await this.listenKeyRequest('PUT');
  }
}

export const api = new BinanceApi();

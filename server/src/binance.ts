/**
 * Binance USD-M Futures API client.
 *
 *  • Market data ALWAYS from mainnet (fapi.binance.com) — real prices, candles,
 *    funding and 24h stats for the dashboard, the scanner and the engine.
 *  • Orders / balance / income go to the selected environment (testnet | live).
 *  • Every request is scheduled through the 95% weight budget in ratelimit.ts,
 *    inside its own work area, so realtime data keeps flowing while the
 *    scanner, the executor and the account poller all work at the same time.
 *  • There is no synthetic fallback: when Binance is unreachable the client
 *    reports `reachable: false`, callers surface the error and nothing is
 *    fabricated anywhere.
 */
import crypto from 'crypto';
import { Candle } from './indicators';
import { getSettings, Mode } from './settings';
import { emit } from './broadcast';
import { Area, ENDPOINT_WEIGHT, klineWeight, limiter } from './ratelimit';

const MAINNET_REST = 'https://fapi.binance.com';
const MAINNET_WS = 'wss://fstream.binance.com';
/**
 * Binance replaced the old futures testnet with "demo trading". The REST host
 * is documented consistently (demo-fapi.binance.com). For the WebSocket, two
 * documents disagree — the USDⓈ-M docs list wss://demo-fstream.binance.com,
 * the demo-trading announcement says the old wss://fstream.binancefuture.com
 * is unchanged — so the user-data stream tries both. Either can be pinned
 * without a code change: BINANCE_TESTNET_REST / BINANCE_TESTNET_WS (read
 * lazily, after dotenv).
 */
const DEFAULT_TESTNET_REST = 'https://demo-fapi.binance.com';
const DEFAULT_TESTNET_WS = 'wss://demo-fstream.binance.com';
const LEGACY_TESTNET_WS = 'wss://fstream.binancefuture.com';

const trimSlash = (u: string) => u.replace(/\/+$/, '');

export function restBase(mode: Mode): string {
  if (mode !== 'testnet') return MAINNET_REST;
  return trimSlash(process.env.BINANCE_TESTNET_REST || DEFAULT_TESTNET_REST);
}

/**
 * Binance split the USDⓈ-M WebSocket into /public (bookTicker, depth),
 * /market (kline, markPrice, aggTrade…) and /private (user data). The legacy
 * `/ws` and `/stream` roots were decommissioned on 2026-04-23.
 * Market data always comes from mainnet, so these never depend on the mode.
 */
export type MarketChannel = 'public' | 'market';
export function marketStreamUrl(channel: MarketChannel, symbols: string[], interval = '5m'): string {
  const streams = symbols.map((s) =>
    channel === 'public' ? `${s.toLowerCase()}@bookTicker` : `${s.toLowerCase()}@kline_${interval}`,
  );
  return `${MAINNET_WS}/${channel}/stream?streams=${streams.join('/')}`;
}

/**
 * Candidate user-data stream URLs, best first. The official "User Data Streams
 * Connect" page documents `<base>/private/ws/<listenKey>`; the 2026 change
 * notice documents the `?listenKey=&events=` form. The stream tries them in
 * turn when one is refused, so a wording difference in the docs can never
 * leave the bot without its execution feed. (`scripts/preflight.js` probes the
 * same list with a real listenKey and reports which form the host accepts.)
 */
export function userStreamUrls(mode: Mode, listenKey: string): string[] {
  const events = 'ORDER_TRADE_UPDATE/ACCOUNT_UPDATE/ALGO_UPDATE/MARGIN_CALL/listenKeyExpired';
  const forms = (base: string) => ({
    priv: `${base}/private/ws/${listenKey}`,
    privEvents: `${base}/private/ws?listenKey=${listenKey}&events=${events}`,
    privStream: `${base}/private/stream?listenKey=${listenKey}&events=${events}`,
    legacy: `${base}/ws/${listenKey}`, // decommissioned on mainnet, last resort
  });
  if (mode !== 'testnet') {
    const f = forms(MAINNET_WS);
    return [f.priv, f.privEvents, f.privStream, f.legacy];
  }
  const pinned = process.env.BINANCE_TESTNET_WS;
  if (pinned) {
    const f = forms(trimSlash(pinned));
    return [f.priv, f.privEvents, f.privStream, f.legacy];
  }
  const demo = forms(DEFAULT_TESTNET_WS);
  const old = forms(LEGACY_TESTNET_WS);
  return [demo.priv, demo.privEvents, old.legacy, old.priv, demo.privStream, demo.legacy, old.privEvents];
}

/** Order types Binance only accepts through the Algo Service (POST /fapi/v1/algoOrder). */
const CONDITIONAL_TYPES = new Set(['STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP_MARKET']);

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
}

export interface AccountSnapshot {
  /** totalMarginBalance (wallet + unrealised) — the real Binance equity */
  equity: number;
  walletBalance: number;
  unrealizedPnl: number;
  availableBalance: number;
  initialMargin: number;
  maintMargin: number;
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

/** Outcome of one conditional leg — see BinanceApi.algoLegState(). */
export interface AlgoLegState {
  state: 'alive' | 'filled' | 'gone' | 'unknown';
  avgPrice?: number;
  executedQty?: number;
  orderId?: string;
}

/**
 * Binance's "this order does not exist" family (-2011 unknown order, -2013 order
 * does not exist). Deliberately NOT a generic "not found": an HTTP 404 from a
 * proxy, or from an environment without the Algo endpoints, says nothing about
 * the order and must stay "unknown" (never acted upon).
 */
function isUnknownOrder(e: unknown): boolean {
  return /-2011|-2013|unknown order|order does not exist/i.test(String((e as any)?.message ?? e));
}

export class BinanceApi {
  private symbolCache = new Map<string, { info: SymbolInfo; at: number }>();
  private exchangeCache: { list: ExchangeSymbol[]; at: number } | null = null;
  private klineCache = new Map<string, { at: number; data: Candle[] }>();
  private inFlight = new Map<string, Promise<any>>();

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

  /** `null` while unknown (first request not finished yet). */
  reachable: boolean | null = null;

  /**
   * Mark the exchange unreachable. No data is invented: callers get the real
   * error, the feed badge flips to `binance-unreachable` and the bot simply
   * waits for the connection to come back.
   */
  private markUnreachable(): void {
    if (this.reachable !== false) {
      this.reachable = false;
      console.warn('[binance] unreachable — no market data available until the connection returns');
      emit('log', { level: 'error', msg: '⚠ Binance API unreachable — no market data (nothing is simulated)' });
      emit('feed', { feed: 'binance-unreachable' });
    }
  }

  private goOnline(): void {
    const wasDown = this.reachable === false;
    this.reachable = true;
    if (wasDown) {
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

  orderMode(): Mode {
    return getSettings().mode;
  }

  // ---------------- market data (mainnet public) ----------------

  async klines(
    symbol: string,
    interval: string,
    limit = 500,
    cacheMs = 2500,
    area: Area = 'market',
  ): Promise<Candle[]> {
    const ck = `${symbol}|${interval}|${limit}`;
    const hit = this.klineCache.get(ck);
    if (hit && Date.now() - hit.at < cacheMs) return hit.data;

    try {
      const p = this.throttle(ck, () =>
        this.publicGet(
          '/fapi/v1/klines',
          { symbol, interval, limit: Math.min(limit, 1500) },
          area,
          klineWeight(Math.min(limit, 1500)),
        ),
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
      this.markUnreachable();
      throw e;
    }
  }

  /** Historical public candles for isolated backtests; never sends an order. */
  async historicalKlines(
    symbol: string,
    interval: string,
    startTime: number,
    endTime: number,
    limit = 1500,
  ): Promise<Candle[]> {
    const safeLimit = Math.max(1, Math.min(1500, Math.floor(limit)));
    try {
      const raw = (await this.publicGet(
        '/fapi/v1/klines',
        { symbol, interval, startTime, endTime, limit: safeLimit },
        'market',
        klineWeight(safeLimit),
      )) as any[];
      this.goOnline();
      return raw.map((k) => ({
        time: Number(k[0]),
        closeTime: Number(k[6]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      }));
    } catch (e) {
      this.markUnreachable();
      throw e;
    }
  }

  /** One call for the whole universe: 24h stats (weight 40) — scanner step 1. */
  async ticker24hrAll(): Promise<
    { symbol: string; lastPrice: number; priceChangePercent: number; highPrice: number; lowPrice: number; quoteVolume: number; volume: number }[]
  > {
    let raw: any[];
    try {
      raw = (await this.publicGet('/fapi/v1/ticker/24hr', {}, 'scanner', ENDPOINT_WEIGHT.ticker24All)) as any[];
      this.goOnline();
    } catch (e) {
      this.markUnreachable();
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
      const receivedAt = Date.now();
      const latencyMs = receivedAt - t0;
      const serverTimeOffsetMs = num(j.serverTime) - Math.round((t0 + receivedAt) / 2);
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

  async positionAmount(symbol: string, positionSide?: 'LONG' | 'SHORT'): Promise<number> {
    const rows = (await this.signed('GET', '/fapi/v2/positionRisk', { symbol }, 'account', ENDPOINT_WEIGHT.positionRisk)) as any[];
    const matches = (rows || []).filter((x) => x.symbol === symbol);
    if (positionSide) {
      const exact = matches.find((x) => String(x.positionSide || 'BOTH') === positionSide);
      const oneWay = matches.find((x) => String(x.positionSide || 'BOTH') === 'BOTH');
      return num((exact || oneWay)?.positionAmt);
    }
    // Ownership checks must notice either hedge-mode leg. A net sum could hide
    // equal LONG/SHORT positions, so return the largest absolute leg instead.
    return matches.reduce((largest, r) => {
      const amount = num(r.positionAmt);
      return Math.abs(amount) > Math.abs(largest) ? amount : largest;
    }, 0);
  }

  /**
   * Max leverage the exchange allows for a symbol (leverage brackets).
   * Cached for 1h. Used to clamp the configured leverage BEFORE the entry so a
   * 10× setting on a 5× market is downgraded instead of failing the trade.
   */
  private bracketCache: { at: number; accountKey: string; list: Map<string, number> } | null = null;
  async maxLeverage(symbol: string): Promise<number> {
    const { key } = this.keys();
    const accountKey = `${this.orderMode()}:${key}`;
    if (
      this.bracketCache?.accountKey === accountKey &&
      Date.now() - this.bracketCache.at < 3600_000
    ) {
      return this.bracketCache.list.get(symbol) ?? 0;
    }
    try {
      const rows = (await this.signed('GET', '/fapi/v1/leverageBracket', {}, 'account', ENDPOINT_WEIGHT.leverageBracket)) as any[];
      const list = new Map<string, number>();
      for (const r of rows || []) {
        const max = Math.max(1, ...(r?.brackets || []).map((b: any) => num(b?.initialLeverage)));
        if (r?.symbol) list.set(String(r.symbol), max);
      }
      this.bracketCache = { at: Date.now(), accountKey, list };
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
    const info = (await this.publicGet('/fapi/v1/exchangeInfo', {}, 'scanner', ENDPOINT_WEIGHT.exchangeInfo)) as any;
    const list: ExchangeSymbol[] = (info.symbols || [])
      .filter((s: any) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
      .map((s: any) => {
        let stepSize = 0.001, tickSize = 0.01, minQty = 0.001;
        for (const f of s.filters || []) {
          if (f.filterType === 'LOT_SIZE') {
            stepSize = num(f.stepSize, stepSize);
            minQty = num(f.minQty, minQty);
          }
          if (f.filterType === 'PRICE_FILTER') tickSize = num(f.tickSize, tickSize);
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
        };
      });
    this.exchangeCache = { list, at: Date.now() };
    return list;
  }

  async exchangeInfo(symbol: string): Promise<SymbolInfo> {
    // Order filters must come from the environment that will receive the order.
    // Testnet and mainnet do not necessarily list the same symbols/lot steps;
    // the scanner intentionally uses mainnet public data, but execution cannot.
    const mode = this.orderMode();
    const cacheKey = `${mode}:${symbol}`;
    const hit = this.symbolCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 3600_000) return hit.info;
    let raw: any;
    try {
      raw = await this.request({
        method: 'GET',
        base: restBase(mode),
        path: '/fapi/v1/exchangeInfo',
        params: { symbol },
        area: 'market',
        weight: ENDPOINT_WEIGHT.exchangeInfo,
        signedReq: false,
      });
    } catch (e) {
      this.markUnreachable();
      throw e;
    }
    const s = (raw?.symbols || []).find((x: any) => String(x.symbol) === symbol);
    if (!s) throw new Error(`Symbol ${symbol} not found on Binance Futures ${mode}`);
    let stepSize = 0.001, tickSize = 0.01, minQty = 0.001, minNotional = 5;
    for (const f of s.filters || []) {
      if (f.filterType === 'LOT_SIZE') {
        stepSize = num(f.stepSize, stepSize);
        minQty = num(f.minQty, minQty);
      }
      if (f.filterType === 'PRICE_FILTER') tickSize = num(f.tickSize, tickSize);
      if (f.filterType === 'MIN_NOTIONAL') minNotional = num(f.notional ?? f.minNotional, minNotional);
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
    this.symbolCache.set(cacheKey, { info: info2, at: Date.now() });
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
      // Keep signed requests aligned with Binance time: ping() (at boot, every few
      // minutes, and after any -1021) maintains this offset. POSTs are never blindly retried.
      q.append('timestamp', String(Date.now() + this.telemetry.serverTimeOffsetMs));
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
      // A transport failure on the public mainnet feed means the market data
      // the engine needs is simply not available right now (never invented).
      if (base === MAINNET_REST) this.markUnreachable();
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
      // -1021 = timestamp out of recvWindow. Always resync the clock so the NEXT
      // request is signed with Binance time; only requests that are safe to
      // repeat (retries > 0: GETs) are retried right away. A rejected POST is
      // never replayed blindly.
      if (/-1021/.test(body)) {
        const ping = await this.ping().catch(() => null);
        if (ping?.ok && retries > 0) {
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
    // Binance reports failures with a negative `code`. Some SUCCESS replies carry
    // a code too — marginType → {"code":200,"msg":"success"}, DELETE algoOrder →
    // {"code":"200",…} — so a bare truthiness test would turn a confirmed change
    // into a thrown error (and abort the entry that triggered it).
    if (json && typeof json === 'object' && !Array.isArray(json) && json.code !== undefined) {
      const code = Number(json.code);
      if (Number.isFinite(code) && code !== 200 && code !== 0) {
        throw new Error(`Binance ${path} error ${json.code}: ${json.msg || body}`);
      }
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
      if (/No need to change|already/i.test(String(e?.message))) return;
      // Entry sizing assumes isolated margin. Do not silently place a cross-
      // margin trade when this precondition could not be confirmed.
      throw e;
    }
  }

  /** Hedge-mode detection, scoped to the active environment + API account. */
  private dualSide: { accountKey: string; value: boolean } | null = null;
  async isDualSide(): Promise<boolean> {
    const { key } = this.keys();
    const accountKey = `${this.orderMode()}:${key}`;
    if (this.dualSide?.accountKey === accountKey) return this.dualSide.value;
    // Fail closed: guessing one-way mode on a transient error can make Binance
    // reject every protective hedge-mode order after an entry.
    const d = await this.signed('GET', '/fapi/v1/positionSide/dual', {}, 'account', 1);
    const value = !!d.dualSidePosition;
    this.dualSide = { accountKey, value };
    return value;
  }

  /**
   * Regular order: MARKET entries and reduceOnly MARKET exits.
   *
   * Conditional types (STOP_MARKET, TAKE_PROFIT_MARKET, …) are refused here on
   * purpose — since 2025-12-09 Binance rejects them on this endpoint with
   * -4120 STOP_ORDER_SWITCH_ALGO. They go through newAlgoOrder().
   */
  async newOrder(order: Record<string, any>): Promise<any> {
    if (CONDITIONAL_TYPES.has(String(order.type))) {
      throw new Error(`${order.type} is a conditional order — it must be placed with newAlgoOrder() (Binance Algo Service)`);
    }
    const dual = await this.isDualSide();
    const params: Record<string, any> = { ...order };
    if (dual && !params.positionSide) {
      params.positionSide = order.reduceOnly
        ? order.side === 'SELL' ? 'LONG' : 'SHORT'
        : order.side === 'BUY' ? 'LONG' : 'SHORT';
    }
    return this.signed('POST', '/fapi/v1/order', params, 'orders', ENDPOINT_WEIGHT.order);
  }

  /** Resolve an uncertain POST by the idempotent client order id. */
  async queryOrder(symbol: string, origClientOrderId: string): Promise<any> {
    return this.signed('GET', '/fapi/v1/order', { symbol, origClientOrderId }, 'orders', ENDPOINT_WEIGHT.order);
  }

  /** A matching-engine order by its numeric id (e.g. the order an algo trigger produced). */
  async orderById(symbol: string, orderId: string | number): Promise<any> {
    return this.signed('GET', '/fapi/v1/order', { symbol, orderId }, 'account', ENDPOINT_WEIGHT.order);
  }

  async marketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    qty: number,
    opts: { reduceOnly?: boolean; positionSide?: string; newClientOrderId?: string } = {},
  ): Promise<any> {
    // RESULT returns the actual terminal MARKET status/fill instead of an ACK
    // that merely says Binance accepted the request.
    const p: any = { symbol, side, type: 'MARKET', quantity: fmtQty(qty), newOrderRespType: 'RESULT' };
    if (opts.reduceOnly) p.reduceOnly = 'true';
    if (opts.newClientOrderId) p.newClientOrderId = opts.newClientOrderId;
    if (opts.positionSide) p.positionSide = opts.positionSide;
    return this.newOrder(p);
  }

  // ---------------- conditional (Algo Service) orders ----------------
  //
  // Stops and take-profits live in Binance's Algo Service: POST/DELETE/GET
  // /fapi/v1/algoOrder, GET /fapi/v1/openAlgoOrders, and ALGO_UPDATE on the
  // user stream. Differences from the old /fapi/v1/order path: `triggerPrice`
  // (not stopPrice), `clientAlgoId` (not newClientOrderId), `algoId` in the
  // reply, and a separate matching-engine order once the trigger fires.

  async newAlgoOrder(params: Record<string, any>): Promise<any> {
    const body: Record<string, any> = {
      algoType: 'CONDITIONAL',
      workingType: 'CONTRACT_PRICE',
      newOrderRespType: 'ACK',
      ...params,
    };
    try {
      return await this.signed('POST', '/fapi/v1/algoOrder', body, 'orders', ENDPOINT_WEIGHT.algoOrder);
    } catch (e) {
      // A POST that failed in transit may still have been accepted. Resolve it
      // by its unique client id so a lost response is never treated as a
      // missing protective leg (and POSTs are still never blindly repeated).
      const cid = body.clientAlgoId;
      if (cid) {
        try {
          const found = await this.queryAlgoOrder(String(cid), 'orders');
          const status = String(found?.algoStatus || '').toUpperCase();
          if (found && status && !['CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(status)) return found;
        } catch { /* not found — the original error stands */ }
      }
      throw e;
    }
  }

  async queryAlgoOrder(clientAlgoId: string, area: Area = 'account'): Promise<any> {
    return this.signed('GET', '/fapi/v1/algoOrder', { clientAlgoId }, area, ENDPOINT_WEIGHT.algoQuery);
  }

  /** Conditional orders that are still waiting for their trigger (status NEW). */
  async openAlgoOrders(symbol: string): Promise<any[]> {
    const rows = await this.signed('GET', '/fapi/v1/openAlgoOrders', { symbol }, 'account', ENDPOINT_WEIGHT.openAlgoOrders);
    return Array.isArray(rows) ? rows : Array.isArray(rows?.orders) ? rows.orders : [];
  }

  /**
   * Cancel ONE conditional order by its client id. Deliberately never uses
   * DELETE /fapi/v1/algoOpenOrders — that cancels every algo order on the
   * symbol, including a manual one the bot must not touch.
   */
  async cancelAlgoOrder(symbol: string, clientAlgoId: string): Promise<any | null> {
    try {
      return await this.signed('DELETE', '/fapi/v1/algoOrder', { symbol, clientAlgoId }, 'orders', ENDPOINT_WEIGHT.algoCancel);
    } catch (e: any) {
      if (isUnknownOrder(e)) return null;
      throw e;
    }
  }

  /**
   * What became of one conditional leg? `alive` = still waiting for its
   * trigger, `filled` = it fired and the resulting order executed, `gone` =
   * cancelled / expired / rejected / never existed, `unknown` = the exchange
   * could not tell us right now (never acted upon — the next pass retries).
   */
  async algoLegState(symbol: string, clientAlgoId: string): Promise<AlgoLegState> {
    let a: any;
    try {
      a = await this.queryAlgoOrder(clientAlgoId);
    } catch (e: any) {
      return isUnknownOrder(e) ? { state: 'gone' } : { state: 'unknown' };
    }
    const status = String(a?.algoStatus || '').toUpperCase();
    if (status === 'NEW') return { state: 'alive' };
    if (['CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(status)) return { state: 'gone' };
    // TRIGGERING | TRIGGERED | FINISHED — the trigger fired. Confirm that the
    // matching-engine order it produced really executed before calling it a fill.
    const orderId = String(a?.actualOrderId || '');
    if (!orderId) return { state: 'unknown' };
    try {
      const o = await this.orderById(symbol, orderId);
      const executedQty = num(o?.executedQty);
      const orderStatus = String(o?.status || '').toUpperCase();
      const avgPrice = num(o?.avgPrice) || num(a?.actualPrice);
      if (orderStatus === 'FILLED' || (['CANCELED', 'EXPIRED'].includes(orderStatus) && executedQty > 0)) {
        return { state: 'filled', avgPrice, executedQty, orderId };
      }
      if (['CANCELED', 'EXPIRED', 'REJECTED'].includes(orderStatus)) return { state: 'gone' };
      return { state: 'unknown' };
    } catch {
      return { state: 'unknown' };
    }
  }

  /**
   * One reduce-only conditional MARKET leg for the bot's OWN quantity — never
   * close-all. One-way mode: `reduceOnly` + explicit quantity, so a leg can
   * only shrink our position. Hedge mode: `positionSide` (Binance forbids
   * reduceOnly there) scopes the leg to the bot's side.
   */
  private async conditionalLeg(
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET',
    symbol: string,
    side: 'BUY' | 'SELL',
    triggerPrice: number,
    qty: number,
    clientAlgoId?: string,
    positionSide?: string,
  ): Promise<any> {
    const dual = await this.isDualSide();
    const p: Record<string, any> = { symbol, side, type, triggerPrice: fmtPrice(triggerPrice), quantity: fmtQty(qty) };
    if (dual) p.positionSide = positionSide ?? (side === 'SELL' ? 'LONG' : 'SHORT');
    else p.reduceOnly = 'true';
    if (clientAlgoId) p.clientAlgoId = clientAlgoId;
    return this.newAlgoOrder(p);
  }

  /** Protective STOP_MARKET for `qty` of the bot position. */
  async protectiveStop(
    symbol: string,
    closeSide: 'BUY' | 'SELL',
    stopPrice: number,
    qty: number,
    clientAlgoId: string,
  ): Promise<any> {
    return this.conditionalLeg('STOP_MARKET', symbol, closeSide, stopPrice, qty, clientAlgoId);
  }

  /** Take-profit leg for the bot's own quantity. */
  async takeProfitMarket(
    symbol: string,
    side: 'BUY' | 'SELL',
    triggerPrice: number,
    qty: number,
    opts: { clientAlgoId?: string; positionSide?: string } = {},
  ): Promise<any> {
    return this.conditionalLeg('TAKE_PROFIT_MARKET', symbol, side, triggerPrice, qty, opts.clientAlgoId, opts.positionSide);
  }

  // ---------------- user data stream ----------------

  async createListenKey(): Promise<string> {
    const { key } = this.keys();
    if (!key) throw new Error('No API key');
    const base = restBase(this.orderMode());
    await limiter.acquire('stream', ENDPOINT_WEIGHT.listenKey, 2);
    const r = await fetch(`${base}/fapi/v1/listenKey`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': key },
      // A hung request must never wedge the user-data stream forever.
      signal: AbortSignal.timeout(10_000),
    });
    limiter.observeHeaders(r.headers);
    const j = await r.json().catch(() => ({}));
    if (!j.listenKey) throw new Error('listenKey failed: ' + JSON.stringify(j));
    return j.listenKey;
  }

  async keepAliveListenKey(): Promise<void> {
    const { key } = this.keys();
    if (!key) return;
    const base = restBase(this.orderMode());
    await limiter.acquire('stream', ENDPOINT_WEIGHT.listenKey, 2);
    const r = await fetch(`${base}/fapi/v1/listenKey`, {
      method: 'PUT',
      headers: { 'X-MBX-APIKEY': key },
      signal: AbortSignal.timeout(10_000),
    });
    limiter.observeHeaders(r.headers);
    // A rejected keep-alive (-1125 "this listenKey does not exist") means the
    // key is dead and the execution feed has silently stopped: the caller must
    // see it and rebuild the stream with a fresh key.
    if (!r.ok) throw new Error(`listenKey keep-alive HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  }
}

/** Plain decimal string (never exponent form), trailing zeros trimmed, 8 dp max. */
function plainDecimal(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`cannot format ${n} as an order number`);
  const fixed = n.toFixed(8);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}
export const fmtQty = plainDecimal;
export const fmtPrice = plainDecimal;

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

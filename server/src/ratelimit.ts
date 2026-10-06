/**
 * Binance USD-M Futures request-budget scheduler.
 *
 * Rules implemented here (all data comes from Binance, so the bot must stay
 * well inside the exchange limits to keep the feed realtime):
 *
 *   • Binance IP weight limit for USD-M Futures = 2400 weight / minute.
 *   • VelocityX plans at most **95%** of it  →  2280 weight / minute.
 *   • The budget is **distributed across work areas** (market data, scanner,
 *     account/PnL, order execution, stream housekeeping). Every area has a
 *     reserved floor so no single job can starve the others; idle capacity is
 *     shared dynamically, but the *global* ceiling never exceeds 95%.
 *   • Order-rate limits (order endpoints only) are tracked separately:
 *     300 orders / 10 s  and  1200 orders / minute  → planned at 95%.
 *   • 429 / 418 responses trigger a cooldown (and 418 a temporary budget
 *     reduction), and the `X-MBX-USED-WEIGHT-1M` header is folded back into
 *     the local accounting so the scheduler never drifts from the exchange.
 *
 * Nothing in this file invents data — it only rations *real* Binance calls.
 */

export type Area = 'market' | 'scanner' | 'account' | 'orders' | 'stream';

export interface AreaStat {
  area: Area;
  sharePct: number;
  weightUsed: number;
  weightCap: number;
  calls: number;
  waiting: number;
  avgWaitMs: number;
}

interface Entry {
  t: number;
  w: number;
  area: Area | 'external';
}

interface Waiter {
  area: Area;
  weight: number;
  priority: number;
  queuedAt: number;
  resolve: () => void;
}

interface OrderWaiter {
  priority: number;
  queuedAt: number;
  resolve: () => void;
}

/** Hard exchange limits (USD-M Futures, per IP). */
export const EXCHANGE_WEIGHT_LIMIT_1M = 2400;
export const EXCHANGE_ORDER_LIMIT_1M = 1200;
export const EXCHANGE_ORDER_LIMIT_10S = 300;
/** We never plan above 95% of any exchange limit. */
export const UTILIZATION = 0.95;

export const WEIGHT_BUDGET_1M = Math.floor(EXCHANGE_WEIGHT_LIMIT_1M * UTILIZATION); // 2280
export const ORDER_BUDGET_1M = Math.floor(EXCHANGE_ORDER_LIMIT_1M * UTILIZATION); // 1140
export const ORDER_BUDGET_10S = Math.floor(EXCHANGE_ORDER_LIMIT_10S * UTILIZATION); // 285

/**
 * Reserved share of the 95% budget per work area. The shares sum to 1.0 and
 * are the *floor* each area can always use; areas may borrow up to 2× their
 * share while the global pool is lightly loaded.
 */
export const AREA_SHARE: Record<Area, number> = {
  scanner: 0.4, // 912/min — volatility scan over the whole perp universe
  market: 0.25, // 570/min — candles/prices for the dashboard + engine seeds
  account: 0.2, // 456/min — equity, positions, income (fees & funding), PnL
  orders: 0.1, // 228/min — order entry / SL / TP placement + cancels
  stream: 0.05, // 114/min — listenKey create / keepalive
};

const WINDOW_MS = 60_000;
const TICK_MS = 200;

class BinanceLimiter {
  private entries: Entry[] = [];
  private orderStamps: number[] = []; // ms timestamps of order-endpoint calls
  private waiters: Waiter[] = [];
  private orderWaiters: OrderWaiter[] = [];
  private cooldownUntil = 0;
  private cooldownReason = '';
  private budgetScale = 1; // reduced after a 418 (IP ban warning)
  private scaleUntil = 0;
  private headerUsedWeight = 0;
  private headerAt = 0;
  private headerUsedOrders = 0;
  private headerOrdersAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private perArea = new Map<Area, { calls: number; waitMs: number; maxWaitMs: number }>();
  private totals = { calls: 0, waitMs: 0, maxWaitMs: 0, throttled: 0, rejected429: 0 };

  constructor() {
    for (const a of Object.keys(AREA_SHARE) as Area[]) this.perArea.set(a, { calls: 0, waitMs: 0, maxWaitMs: 0 });
  }

  /** Effective 1-minute weight ceiling (≤ 95% of Binance's limit, adaptively). */
  weightCap(): number {
    if (Date.now() < this.scaleUntil) return Math.floor(WEIGHT_BUDGET_1M * this.budgetScale);
    return WEIGHT_BUDGET_1M;
  }

  private prune(now: number): void {
    const cut = now - WINDOW_MS;
    if (this.entries.length && this.entries[0].t < cut) {
      this.entries = this.entries.filter((e) => e.t >= cut);
    }
    if (this.orderStamps.length && this.orderStamps[0] < cut) {
      this.orderStamps = this.orderStamps.filter((t) => t >= cut);
    }
  }

  private usedWeight(now: number, area?: Area): number {
    let sum = 0;
    for (const e of this.entries) {
      if (area && e.area !== area) continue;
      sum += e.w;
    }
    // Fold in the exchange-reported figure when it is higher than our estimate.
    if (!area && now - this.headerAt < WINDOW_MS) sum = Math.max(sum, this.headerUsedWeight);
    return sum;
  }

  /** Orders counted in the last minute (local stamps + the exchange header). */
  private usedOrders1m(now: number): number {
    const local = this.orderStamps.filter((t) => now - t < WINDOW_MS).length;
    if (now - this.headerOrdersAt < WINDOW_MS) return Math.max(local, this.headerUsedOrders);
    return local;
  }

  private areaCap(area: Area, globalUsed: number): number {
    const cap = this.weightCap();
    const share = AREA_SHARE[area];
    // borrow up to 2× own share while the global pool is below 60% utilisation
    const borrow = globalUsed < cap * 0.6 ? 2 : 1;
    return Math.min(cap, Math.max(share * cap * borrow, 20));
  }

  private pump(): void {
    if (!this.waiters.length && !this.orderWaiters.length) return;
    this.prune(Date.now());
    // --- order-rate waiters (strictest first) ---
    if (this.orderWaiters.length) {
      const now = Date.now();
      while (this.orderWaiters.length) {
        const w = this.orderWaiters.sort((a, b) => a.priority - b.priority || a.queuedAt - b.queuedAt)[0];
        if (!this.orderSlotFree(now, 0)) break;
        this.orderWaiters.splice(this.orderWaiters.indexOf(w), 1);
        this.orderStamps.push(now); // one stamp serves both the 10s and 1m window
        w.resolve();
      }
    }
    // --- weight waiters ---
    if (!this.waiters.length) return;
    const now = Date.now();
    if (now < this.cooldownUntil) return;
    this.waiters.sort((a, b) => a.priority - b.priority || a.queuedAt - b.queuedAt);
    for (let i = 0; i < this.waiters.length; ) {
      const w = this.waiters[i];
      const globalUsed = this.usedWeight(now);
      const areaUsed = this.usedWeight(now, w.area);
      const cap = this.weightCap();
      if (globalUsed + w.weight > cap || areaUsed + w.weight > this.areaCap(w.area, globalUsed)) {
        i += 1;
        continue;
      }
      this.waiters.splice(i, 1);
      this.entries.push({ t: now, w: w.weight, area: w.area });
      const st = this.perArea.get(w.area)!;
      const waited = now - w.queuedAt;
      st.calls += 1;
      st.waitMs += waited;
      st.maxWaitMs = Math.max(st.maxWaitMs, waited);
      this.totals.calls += 1;
      this.totals.waitMs += waited;
      this.totals.maxWaitMs = Math.max(this.totals.maxWaitMs, waited);
      w.resolve();
    }
  }

  private orderSlotFree(now: number, pad = 0): boolean {
    const in10 = this.orderStamps.filter((t) => now - t < 10_000).length + pad;
    // The 1-minute figure also honours X-MBX-ORDER-COUNT-1M, so orders placed by
    // another process sharing the same IP can never push us past the limit.
    const in60 = this.usedOrders1m(now) + pad;
    return in10 < ORDER_BUDGET_10S && in60 < ORDER_BUDGET_1M;
  }

  /**
   * Reserve `weight` for an API call inside `area`. Resolves when the call may
   * go out. Lower `priority` = more urgent (0 = order-critical).
   */
  acquire(area: Area, weight = 1, priority = 5): Promise<void> {
    const w = Math.max(1, Math.ceil(weight));
    // fast path — capacity available right now
    const now = Date.now();
    this.prune(now);
    if (now >= this.cooldownUntil) {
      const globalUsed = this.usedWeight(now);
      const areaUsed = this.usedWeight(now, area);
      if (globalUsed + w <= this.weightCap() && areaUsed + w <= this.areaCap(area, globalUsed)) {
        this.entries.push({ t: now, w, area });
        const st = this.perArea.get(area)!;
        st.calls += 1;
        this.totals.calls += 1;
        return Promise.resolve();
      }
    }
    this.totals.throttled += 1;
    return new Promise<void>((resolve) => {
      this.waiters.push({ area, weight: w, priority, queuedAt: Date.now(), resolve });
      this.ensureTimer();
    });
  }

  /** Order-endpoint rate limiter (300/10s, 1200/min — planned at 95%). */
  acquireOrderSlot(priority = 0): Promise<void> {
    const now = Date.now();
    this.prune(now);
    if (this.orderSlotFree(now)) {
      this.orderStamps.push(now); // one stamp serves both the 10s and 1m window
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.orderWaiters.push({ priority, queuedAt: Date.now(), resolve });
      this.ensureTimer();
    });
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pump();
      if (!this.waiters.length && !this.orderWaiters.length) {
        clearInterval(this.timer as NodeJS.Timeout);
        this.timer = null;
      }
    }, TICK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Fold exchange response headers back into local accounting. */
  observeHeaders(headers: Headers | Record<string, unknown>): void {
    try {
      const get = (name: string): string | null => {
        if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
        const rec = headers as Record<string, unknown>;
        const k = Object.keys(rec).find((x) => x.toLowerCase() === name);
        return k ? String(rec[k]) : null;
      };
      const w = get('x-mbx-used-weight-1m');
      if (w) {
        const used = Number(w);
        if (Number.isFinite(used)) {
          this.headerUsedWeight = used;
          this.headerAt = Date.now();
        }
      }
      const o = get('x-mbx-order-count-1m');
      if (o) {
        const used = Number(o);
        if (Number.isFinite(used)) {
          this.headerUsedOrders = used;
          this.headerOrdersAt = Date.now();
        }
      }
    } catch {
      /* header accounting is best-effort */
    }
  }

  /** 429 / 418 handling: pause everything, then back off proportionally. */
  penalize(kind: '429' | '418', retryAfterSec?: number): void {
    const now = Date.now();
    this.totals.rejected429 += 1;
    if (kind === '418') {
      // IP ban warning — stand down for 2 minutes and run at 60% for 5 more.
      this.cooldownUntil = Math.max(this.cooldownUntil, now + (retryAfterSec ? retryAfterSec * 1000 : 120_000));
      this.budgetScale = 0.6;
      this.scaleUntil = now + 5 * 60_000;
      this.cooldownReason = 'IP ban warning (418) — budget reduced to 60%';
    } else {
      this.cooldownUntil = Math.max(this.cooldownUntil, now + (retryAfterSec ? retryAfterSec * 1000 : 60_000));
      this.cooldownReason = 'rate limit (429) — cooling down';
    }
  }

  status(): {
    weightLimitPerMin: number;
    plannedLimitPerMin: number;
    utilizationPct: number;
    usedWeight: number;
    usedPct: number;
    usedOrders1m: number;
    orderLimitPerMin: number;
    usedOrders10s: number;
    orderLimit10s: number;
    cooldownMsLeft: number;
    cooldownReason: string;
    areas: AreaStat[];
    totals: { calls: number; avgWaitMs: number; maxWaitMs: number; throttled: number; rejected429: number };
  } {
    const now = Date.now();
    this.prune(now);
    const used = this.usedWeight(now);
    const cap = this.weightCap();
    const areas: AreaStat[] = (Object.keys(AREA_SHARE) as Area[]).map((area) => {
      const st = this.perArea.get(area)!;
      const globalUsed = used;
      return {
        area,
        sharePct: Number((AREA_SHARE[area] * 100).toFixed(1)),
        weightUsed: this.usedWeight(now, area),
        weightCap: Math.round(this.areaCap(area, globalUsed)),
        calls: st.calls,
        waiting: this.waiters.filter((w) => w.area === area).length,
        avgWaitMs: st.calls ? Math.round(st.waitMs / st.calls) : 0,
      };
    });
    return {
      weightLimitPerMin: EXCHANGE_WEIGHT_LIMIT_1M,
      plannedLimitPerMin: cap,
      utilizationPct: Number(((cap / EXCHANGE_WEIGHT_LIMIT_1M) * 100).toFixed(1)),
      usedWeight: used,
      usedPct: Number(((used / EXCHANGE_WEIGHT_LIMIT_1M) * 100).toFixed(1)),
      usedOrders1m: this.usedOrders1m(now),
      orderLimitPerMin: ORDER_BUDGET_1M,
      usedOrders10s: this.orderStamps.filter((t) => now - t < 10_000).length,
      orderLimit10s: ORDER_BUDGET_10S,
      cooldownMsLeft: Math.max(0, this.cooldownUntil - now),
      cooldownReason: now < this.cooldownUntil ? this.cooldownReason : '',
      areas,
      totals: {
        calls: this.totals.calls,
        avgWaitMs: this.totals.calls ? Math.round(this.totals.waitMs / this.totals.calls) : 0,
        maxWaitMs: this.totals.maxWaitMs,
        throttled: this.totals.throttled,
        rejected429: this.totals.rejected429,
      },
    };
  }
}

export const limiter = new BinanceLimiter();

/** Weights of the USD-M endpoints VelocityX uses (per Binance docs). */
export function klineWeight(limit: number): number {
  if (limit < 100) return 1;
  if (limit < 500) return 2;
  if (limit <= 1000) return 5;
  return 10;
}

export const ENDPOINT_WEIGHT = {
  time: 1, // /fapi/v1/time
  exchangeInfo: 1, // /fapi/v1/exchangeInfo
  ticker24All: 40, // all symbols — scanner workhorse
  premiumIndexAll: 10,
  account: 5, // /fapi/v2/account
  positionRisk: 5, // /fapi/v2/positionRisk
  leverageBracket: 1, // /fapi/v1/leverageBracket
  income: 30, // /fapi/v1/income (fees, funding, realised PnL)
  userTrades: 5, // /fapi/v1/userTrades
  allOrders: 5, // /fapi/v1/allOrders
  order: 1, // POST/GET /fapi/v1/order
  // Algo Service (STOP_MARKET / TAKE_PROFIT_MARKET). POST /fapi/v1/algoOrder has
  // IP weight 0 but still counts against the 10 s / 1 min ORDER limits (which the
  // order-slot gate enforces); a weight of 1 is the conservative budget.
  algoOrder: 1,
  algoCancel: 1, // DELETE /fapi/v1/algoOrder
  algoQuery: 1, // GET /fapi/v1/algoOrder
  openAlgoOrders: 1, // GET /fapi/v1/openAlgoOrders (single symbol)
  leverage: 1,
  listenKey: 1,
} as const;

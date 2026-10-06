/** Conservative Binance USD-M request-weight scheduler for dashboard reads. */

export type Area = 'market' | 'account' | 'stream';

export interface AreaStat {
  area: Area;
  sharePct: number;
  weightUsed: number;
  weightCap: number;
  calls: number;
  waiting: number;
  avgWaitMs: number;
}

interface Entry { at: number; weight: number; area: Area | 'external' }
interface Waiter { area: Area; weight: number; priority: number; queuedAt: number; resolve: () => void }

export const EXCHANGE_WEIGHT_LIMIT_1M = 2400;
export const UTILIZATION = 0.95;
export const WEIGHT_BUDGET_1M = Math.floor(EXCHANGE_WEIGHT_LIMIT_1M * UTILIZATION);
export const AREA_SHARE: Record<Area, number> = { market: 0.5, account: 0.45, stream: 0.05 };
const WINDOW_MS = 60_000;
const TICK_MS = 200;

class BinanceLimiter {
  private entries: Entry[] = [];
  private waiters: Waiter[] = [];
  private cooldownUntil = 0;
  private cooldownReason = '';
  private budgetScale = 1;
  private scaleUntil = 0;
  private headerUsedWeight = 0;
  private headerAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private perArea = new Map<Area, { calls: number; waitMs: number; maxWaitMs: number }>();
  private totals = { calls: 0, waitMs: 0, maxWaitMs: 0, throttled: 0, rejected429: 0 };

  constructor() {
    for (const area of Object.keys(AREA_SHARE) as Area[]) {
      this.perArea.set(area, { calls: 0, waitMs: 0, maxWaitMs: 0 });
    }
  }

  weightCap(): number {
    return Date.now() < this.scaleUntil ? Math.floor(WEIGHT_BUDGET_1M * this.budgetScale) : WEIGHT_BUDGET_1M;
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    if (this.entries.length && this.entries[0].at < cutoff) {
      this.entries = this.entries.filter((entry) => entry.at >= cutoff);
    }
  }

  private usedWeight(now: number, area?: Area): number {
    let sum = 0;
    for (const entry of this.entries) {
      if (area && entry.area !== area) continue;
      sum += entry.weight;
    }
    if (!area && now - this.headerAt < WINDOW_MS) sum = Math.max(sum, this.headerUsedWeight);
    return sum;
  }

  private areaCap(area: Area, globalUsed: number): number {
    const cap = this.weightCap();
    const borrowing = globalUsed < cap * 0.6 ? 2 : 1;
    return Math.min(cap, Math.max(AREA_SHARE[area] * cap * borrowing, 20));
  }

  private grant(waiter: Waiter, now: number): void {
    this.entries.push({ at: now, weight: waiter.weight, area: waiter.area });
    const stat = this.perArea.get(waiter.area)!;
    const waitMs = now - waiter.queuedAt;
    stat.calls += 1;
    stat.waitMs += waitMs;
    stat.maxWaitMs = Math.max(stat.maxWaitMs, waitMs);
    this.totals.calls += 1;
    this.totals.waitMs += waitMs;
    this.totals.maxWaitMs = Math.max(this.totals.maxWaitMs, waitMs);
    waiter.resolve();
  }

  private pump(): void {
    if (!this.waiters.length) return;
    const now = Date.now();
    this.prune(now);
    if (now < this.cooldownUntil) return;
    this.waiters.sort((a, b) => a.priority - b.priority || a.queuedAt - b.queuedAt);
    for (let i = 0; i < this.waiters.length;) {
      const waiter = this.waiters[i];
      const globalUsed = this.usedWeight(now);
      const areaUsed = this.usedWeight(now, waiter.area);
      if (
        globalUsed + waiter.weight > this.weightCap() ||
        areaUsed + waiter.weight > this.areaCap(waiter.area, globalUsed)
      ) {
        i += 1;
        continue;
      }
      this.waiters.splice(i, 1);
      this.grant(waiter, now);
    }
  }

  acquire(area: Area, weight = 1, priority = 5): Promise<void> {
    const requestedWeight = Math.max(1, Math.ceil(weight));
    const now = Date.now();
    this.prune(now);
    if (now >= this.cooldownUntil) {
      const globalUsed = this.usedWeight(now);
      const areaUsed = this.usedWeight(now, area);
      if (
        globalUsed + requestedWeight <= this.weightCap() &&
        areaUsed + requestedWeight <= this.areaCap(area, globalUsed)
      ) {
        this.grant({ area, weight: requestedWeight, priority, queuedAt: now, resolve: () => {} }, now);
        return Promise.resolve();
      }
    }
    this.totals.throttled += 1;
    return new Promise<void>((resolve) => {
      this.waiters.push({ area, weight: requestedWeight, priority, queuedAt: Date.now(), resolve });
      this.ensureTimer();
    });
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pump();
      if (!this.waiters.length) {
        clearInterval(this.timer as NodeJS.Timeout);
        this.timer = null;
      }
    }, TICK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  observeHeaders(headers: Headers | Record<string, unknown>): void {
    try {
      const get = (name: string): string | null => {
        if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
        const record = headers as Record<string, unknown>;
        const key = Object.keys(record).find((item) => item.toLowerCase() === name);
        return key ? String(record[key]) : null;
      };
      const header = get('x-mbx-used-weight-1m');
      if (header === null) return;
      const used = Number(header);
      if (Number.isFinite(used)) {
        this.headerUsedWeight = used;
        this.headerAt = Date.now();
      }
    } catch { /* response-header accounting is best effort */ }
  }

  penalize(kind: '429' | '418', retryAfterSec?: number): void {
    const now = Date.now();
    this.totals.rejected429 += 1;
    if (kind === '418') {
      this.cooldownUntil = Math.max(this.cooldownUntil, now + (retryAfterSec ? retryAfterSec * 1000 : 120_000));
      this.budgetScale = 0.6;
      this.scaleUntil = now + 5 * 60_000;
      this.cooldownReason = 'Binance IP warning (418); request budget reduced temporarily';
    } else {
      this.cooldownUntil = Math.max(this.cooldownUntil, now + (retryAfterSec ? retryAfterSec * 1000 : 60_000));
      this.cooldownReason = 'Binance rate limit (429); cooling down';
    }
    this.ensureTimer();
  }

  status(): {
    weightLimitPerMin: number;
    plannedLimitPerMin: number;
    utilizationPct: number;
    usedWeight: number;
    usedPct: number;
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
      const stats = this.perArea.get(area)!;
      return {
        area,
        sharePct: Number((AREA_SHARE[area] * 100).toFixed(1)),
        weightUsed: this.usedWeight(now, area),
        weightCap: Math.round(this.areaCap(area, used)),
        calls: stats.calls,
        waiting: this.waiters.filter((waiter) => waiter.area === area).length,
        avgWaitMs: stats.calls ? Math.round(stats.waitMs / stats.calls) : 0,
      };
    });
    return {
      weightLimitPerMin: EXCHANGE_WEIGHT_LIMIT_1M,
      plannedLimitPerMin: cap,
      utilizationPct: Number(((cap / EXCHANGE_WEIGHT_LIMIT_1M) * 100).toFixed(1)),
      usedWeight: used,
      usedPct: Number(((used / EXCHANGE_WEIGHT_LIMIT_1M) * 100).toFixed(1)),
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

export function klineWeight(limit: number): number {
  if (limit < 100) return 1;
  if (limit < 500) return 2;
  if (limit <= 1000) return 5;
  return 10;
}

export const ENDPOINT_WEIGHT = {
  time: 1,
  account: 5,
  positionRisk: 5,
  income: 30,
  listenKey: 1,
} as const;

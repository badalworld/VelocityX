/**
 * Continuous 50-asset market scanner + opportunity-zone queue.
 *
 * A scan cycle does two jobs without mixing their lifetimes:
 *   1. rank liquid/active USD-M markets and analyse `candidates` (50 by default)
 *      in a bounded parallel batch; and
 *   2. retain eligible symbols in a direction-agnostic monitor queue for the
 *      engine's closed-candle liquidity-sweep / POC-retest strategy.
 *
 * Retained zones do not consume places in the next scan batch. The scanner can
 * therefore keep moving through fifty assets while the engine continues to
 * watch earlier opportunities for a confirmed, non-repainting candle signal.
 * Every request still goes through the shared 95% Binance weight scheduler.
 */
import { api, ExchangeSymbol } from './binance';
import { adx, atr, Candle, ema, lastFinite } from './indicators';
import { getSettings, MAX_POSITIONS_CAP } from './settings';
import { emit } from './broadcast';
import { candleStore } from './candles';

export type MarketType = 'TRENDING' | 'RANGING' | 'QUIET' | 'PEGGED';
export type OpportunityState = 'MONITORING' | 'TRIGGERED' | 'EXECUTED';
export type OpportunitySide = 'LONG' | 'SHORT' | 'BOTH';

export interface ScanProgress {
  id: string;
  running: boolean;
  target: number;
  completed: number;
  failed: number;
  startedAt: number;
  updatedAt: number;
}

export interface ScanRow {
  symbol: string;
  base: string;
  price: number;
  change24hPct: number;
  range24hPct: number;
  quoteVolume24h: number;
  atrPct: number; // ATR(14) on 15m, % of price
  atrPct5m: number; // ATR(14) on 5m, % of price
  adx: number; // ADX(14) on 15m
  emaFast: number;
  emaSlow: number;
  emaFast5m: number;
  emaSlow5m: number;
  trend: 'UP' | 'DOWN';
  alignment: number; // 1.0 = 15m trend agrees with 1h trend
  fundingRate: number;
  nextFundingTime: number;
  volatility: number; // 0..100 — primary ranking key (descending)
  trendScore: number; // 0..100
  liquidityScore: number; // 0..100
  score: number; // combined market rank score
  setupScore: number; // deterministic setup quality, not a win probability
  emaGapPct: number;
  emaGapAtr: number;
  approachAtr: number;
  opportunity: boolean; // passed the pre-signal opportunity rules this cycle
  inOpportunityZone: boolean; // retained by the dedicated monitor
  opportunitySide: OpportunitySide;
  marketType: MarketType;
  tradable: boolean;
  reason: string;
  opportunityReason: string;
  updatedAt: number;
}

export interface OpportunityZone {
  symbol: string;
  base: string;
  side: OpportunitySide;
  state: OpportunityState;
  score: number;
  rank: number;
  price: number;
  adx: number;
  atrPct: number;
  atrPct5m: number;
  emaGapPct: number;
  emaGapAtr: number;
  enteredAt: number;
  lastQualifiedAt: number;
  updatedAt: number;
  expiresAt: number;
  signalId: string | null;
  signalAt: number | null;
  tradeId: string | null;
  reason: string;
}

export interface ScanResult {
  at: number;
  durationMs: number;
  universe: number;
  target: number;
  analysed: number;
  rows: ScanRow[];
  /** Symbols under the dedicated 5m opportunity monitor. */
  selected: string[];
  opportunities: OpportunityZone[];
  progress: ScanProgress;
  gate: {
    minQuoteVolume24h: number;
    minRange24hPct: number;
    minAtrPct: number;
    minAdx: number;
    minOpportunityScore: number;
    maxEmaGapAtr: number;
    zoneRetentionMin: number;
    maxOpportunityZones: number;
    maxPositions: number;
  };
}

/** Pegged / staked / wrapped / index bases: never directional trade targets. */
const PEGGED_BASES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDD', 'PYUSD', 'USDE', 'USDS', 'SUSDE', 'SUSDS',
  'USDF', 'USDG', 'USD1', 'XUSD', 'USTC', 'UST', 'BFUSD', 'LDUSDT', 'SUSD', 'GUSD', 'FRAX', 'MIM', 'EUR', 'EURI', 'AEUR',
  'USDY', 'USDR', 'USDB', 'DOLA', 'CRVUSD', 'GHO', 'USDX', 'VAI', 'ALUSD',
  'BIDR', 'IDRT', 'TRY', 'BRL', 'ARS', 'JPY', 'GBP', 'AUD', 'RUB', 'NGN', 'ZAR', 'PLN', 'RON', 'CZK', 'UAH', 'MXN',
  'COP', 'PEN', 'PHP', 'INR',
  'WBTC', 'WBETH', 'WETH', 'BNSOL', 'BETH', 'CBBTC', 'SOLVBTC', 'STETH', 'WSTETH', 'RETH', 'JITOSOL', 'MSOL',
  'SFRXETH', 'EZETH', 'RSETH', 'ANKRETH',
  'PAXG', 'XAUT', 'BTCDOM', 'DEFI', 'ALT', '1000BTCDOM',
]);

export function isPeggedSymbol(sym: ExchangeSymbol): boolean {
  const base = sym.baseAsset.toUpperCase();
  if (PEGGED_BASES.has(base)) return true;
  if (/DOM$/.test(sym.symbol) || /^DEFIUSDT$/.test(sym.symbol)) return true;
  if (/^USD|USD$/.test(base) && base !== 'USDE') return true;
  return false;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, d = 2) => Number(v.toFixed(d));
const newId = () => Math.random().toString(36).slice(2, 10);

/** Bounded parallel map: concurrent enough for a 50-asset batch, never a 150-call burst. */
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<(R | undefined)[]> {
  const out = new Array<R | undefined>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        out[index] = await fn(items[index], index);
      } catch {
        out[index] = undefined;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

interface OpportunityAssessment {
  setupScore: number;
  emaFast5m: number;
  emaSlow5m: number;
  atrPct5m: number;
  emaGapPct: number;
  emaGapAtr: number;
  approachAtr: number;
  side: OpportunitySide;
  opportunity: boolean;
  reason: string;
}

/**
 * The scanner now selects liquid markets to monitor; it does not predict a
 * direction or gate entries with the retired EMA-crossover strategy. The
 * per-symbol engine owns sweep/POC/retest state and may signal either side.
 */
export function assessOpportunity(row: ScanRow, k5: Candle[], now = Date.now()): OpportunityAssessment {
  const config = getSettings().strategy;
  const closed = k5.filter((c) => c.closeTime <= now);
  const enoughBars = closed.length >= config.lookbackBars + 2;
  const bars = enoughBars ? closed : k5.slice(0, Math.max(0, k5.length - 1));
  const atr5 = bars.length >= 2 ? lastFinite(atr(bars, getSettings().atrLength)) : NaN;
  const price = bars[bars.length - 1]?.close || row.price;
  const atrPct5m = Number.isFinite(atr5) && price > 0 ? (atr5 / price) * 100 : 0;
  const opportunity = row.tradable && enoughBars;
  const reason = !row.tradable
    ? row.reason
    : !enoughBars
      ? `need ${config.lookbackBars + 2} closed 5m bars to monitor sweeps`
      : 'liquid 5m market · monitoring both directions for a 30-bar sweep and POC retest';
  return {
    setupScore: row.tradable ? round(row.score) : 0,
    emaFast5m: 0,
    emaSlow5m: 0,
    atrPct5m: round(atrPct5m, 4),
    emaGapPct: 0,
    emaGapAtr: 0,
    approachAtr: 0,
    side: 'BOTH',
    opportunity,
    reason,
  };
}

class MarketScanner {
  private timer: NodeJS.Timeout | null = null;
  private loopActive = false;
  private loopVersion = 0;
  private inflight: Promise<ScanResult | null> | null = null;
  private rescanRequested = false;
  private last: ScanResult | null = null;
  private zones = new Map<string, OpportunityZone>();
  private listeners = new Set<(r: ScanResult) => void>();
  private scanProgress: ScanProgress = {
    id: '', running: false, target: 0, completed: 0, failed: 0, startedAt: 0, updatedAt: 0,
  };

  start(): void {
    if (this.loopActive) return;
    if (!getSettings().scanner.enabled) return;
    this.loopActive = true;
    const version = ++this.loopVersion;
    const loop = async () => {
      await this.scan();
      if (version !== this.loopVersion || !getSettings().scanner.enabled) return;
      const delay = Math.max(30, getSettings().scanner.intervalSec) * 1000;
      this.timer = setTimeout(() => {
        this.timer = null;
        void loop();
      }, delay);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    };
    void loop();
  }

  stop(): void {
    this.loopVersion += 1;
    this.loopActive = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  restart(): void {
    this.stop();
    // A settings update can arrive while a 50-asset batch is still running.
    // Let that shared request finish, then immediately run one clean batch with
    // the new thresholds instead of waiting a full scan interval.
    if (this.inflight) this.rescanRequested = true;
    this.start();
  }

  result(): ScanResult | null {
    return this.last;
  }

  progress(): ScanProgress {
    return { ...this.scanProgress };
  }

  opportunities(): OpportunityZone[] {
    this.pruneExpiredZones();
    return [...this.zones.values()].sort((a, b) => {
      const stateOrder = (x: OpportunityState) => (x === 'MONITORING' ? 0 : x === 'TRIGGERED' ? 1 : 2);
      return stateOrder(a.state) - stateOrder(b.state) || b.score - a.score || a.enteredAt - b.enteredAt;
    });
  }

  /** Symbols the signal engine monitors independently from the next 50-asset scan. */
  activeSymbols(): string[] {
    this.pruneExpiredZones();
    return this.opportunities()
      .filter((z) => z.state === 'MONITORING')
      .map((z) => z.symbol);
  }

  /** Strict auto-scan entry gate: only a live zone and its intended side pass. */
  isExecutionEligible(symbol: string, side?: OpportunitySide): boolean {
    this.pruneExpiredZones();
    const z = this.zones.get(symbol);
    if (!z || z.state !== 'MONITORING' || z.expiresAt <= Date.now()) return false;
    if (side && z.side !== 'BOTH' && z.side !== side) return false;
    const s = getSettings();
    const maxScanAge = Math.max(180_000, s.scanner.intervalSec * 3_000);
    return !!this.last && Date.now() - this.last.at <= maxScanAge;
  }

  /** Compatibility surface used by the engine dashboard. */
  isTradable(symbol: string): boolean {
    return this.isExecutionEligible(symbol);
  }

  clearOpportunities(): void {
    if (!this.zones.size) return;
    this.zones.clear();
    this.syncLastAndNotify();
  }

  /** Move a monitored zone to TRIGGERED/EXECUTED after the engine handles its signal. */
  markSignal(symbol: string, side: OpportunitySide, signalId: string, tradeId: string | null): void {
    const z = this.zones.get(symbol);
    if (!z || (z.side !== 'BOTH' && z.side !== side)) return;
    const now = Date.now();
    z.state = tradeId ? 'EXECUTED' : 'TRIGGERED';
    z.signalId = signalId;
    z.signalAt = now;
    z.tradeId = tradeId;
    z.updatedAt = now;
    // A missed/disarmed signal is never executed retroactively. Keep it in the
    // UI briefly, while removing it from the active monitor until a fresh setup.
    if (!tradeId) z.expiresAt = Math.min(z.expiresAt, now + 5 * 60_000);
    this.syncLastAndNotify();
  }

  onChange(fn: (r: ScanResult) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Concurrent callers (scheduled + manual rescan) share one real scan. */
  scan(): Promise<ScanResult | null> {
    if (this.inflight) return this.inflight;
    this.inflight = this.runScan().finally(() => {
      this.inflight = null;
      if (this.rescanRequested) {
        this.rescanRequested = false;
        if (getSettings().scanner.enabled) queueMicrotask(() => void this.scan());
      }
    });
    return this.inflight;
  }

  private async runScan(): Promise<ScanResult | null> {
    const t0 = Date.now();
    const s = getSettings();
    const scanId = newId();
    this.scanProgress = {
      id: scanId, running: true, target: 0, completed: 0, failed: 0, startedAt: t0, updatedAt: t0,
    };
    this.emitProgress();

    try {
      const gate: ScanResult['gate'] = {
        minQuoteVolume24h: s.scanner.minQuoteVolume24h,
        minRange24hPct: s.scanner.minRange24hPct,
        minAtrPct: s.scanner.minAtrPct,
        minAdx: s.scanner.minAdx,
        minOpportunityScore: s.scanner.minOpportunityScore,
        maxEmaGapAtr: s.scanner.maxEmaGapAtr,
        zoneRetentionMin: s.scanner.zoneRetentionMin,
        maxOpportunityZones: s.scanner.topN,
        maxPositions: Math.min(s.maxPositions, MAX_POSITIONS_CAP),
      };

      const [info, tickers, premium] = await Promise.all([
        api.exchangeInfoAll(),
        api.ticker24hrAll(),
        api.premiumIndexAll(),
      ]);
      const universe = info.filter((x) => x.status === 'TRADING' && x.contractType === 'PERPETUAL');
      const tickerMap = new Map(tickers.map((t) => [t.symbol, t]));
      const fundMap = new Map(premium.map((p) => [p.symbol, p]));

      type Candidate = { sym: ExchangeSymbol; t: (typeof tickers)[number]; rangePct: number; volScore: number };
      const candidates: Candidate[] = [];
      const liquidityFallback: Candidate[] = [];
      for (const sym of universe) {
        if (isPeggedSymbol(sym)) continue;
        const t = tickerMap.get(sym.symbol);
        if (!t || t.lastPrice <= 0 || t.highPrice <= 0 || t.lowPrice <= 0) continue;
        const rangePct = ((t.highPrice - t.lowPrice) / t.lastPrice) * 100;
        if (rangePct < Math.max(1.5, gate.minRange24hPct * 0.5)) continue;
        const volScore = 0.6 * clamp(rangePct / 25, 0, 1) + 0.4 * clamp(Math.abs(t.priceChangePercent) / 15, 0, 1);
        const candidate = { sym, t, rangePct, volScore };
        if (t.quoteVolume >= gate.minQuoteVolume24h) candidates.push(candidate);
        else liquidityFallback.push(candidate);
      }
      candidates.sort((a, b) => b.volScore - a.volScore);
      liquidityFallback.sort((a, b) => b.volScore - a.volScore);
      // Prefer liquid leaders, but backfill the batch when needed so "50 assets"
      // remains a real analysis target; backfilled rows still fail the strict
      // liquidity gate and can never enter an opportunity zone.
      const shortlist = [
        ...candidates.slice(0, s.scanner.candidates),
        ...liquidityFallback.slice(0, Math.max(0, s.scanner.candidates - candidates.length)),
      ].slice(0, s.scanner.candidates);
      this.scanProgress.target = shortlist.length;
      this.scanProgress.updatedAt = Date.now();
      this.emitProgress();

      const analysed = await mapConcurrent(shortlist, 8, async (c) => {
        try {
          const [k15, k1h, k5] = await Promise.all([
            api.klines(c.sym.symbol, '15m', 120, 20_000, 'scanner'),
            api.klines(c.sym.symbol, '1h', 120, 60_000, 'scanner'),
            api.klines(c.sym.symbol, '5m', 120, 10_000, 'scanner'),
          ]);
          // Reuse the already-paid 5m history when the symbol enters a zone.
          candleStore.seed(c.sym.symbol, '5m', k5);
          const now = Date.now();
          const closed15 = k15.filter((bar) => bar.closeTime <= now);
          const closed1h = k1h.filter((bar) => bar.closeTime <= now);
          const row = analyse(
            c.sym,
            c.t,
            closed15.length >= 60 ? closed15 : k15.slice(0, -1),
            closed1h.length >= 60 ? closed1h : k1h.slice(0, -1),
            fundMap.get(c.sym.symbol),
            gate,
          );
          const setup = assessOpportunity(row, k5, now);
          Object.assign(row, {
            setupScore: setup.setupScore,
            emaFast5m: setup.emaFast5m,
            emaSlow5m: setup.emaSlow5m,
            atrPct5m: setup.atrPct5m,
            emaGapPct: setup.emaGapPct,
            emaGapAtr: setup.emaGapAtr,
            approachAtr: setup.approachAtr,
            opportunity: setup.opportunity,
            opportunitySide: setup.side,
            opportunityReason: setup.reason,
          });
          this.bumpProgress(false);
          return row;
        } catch {
          this.bumpProgress(true);
          throw new Error('symbol analysis failed');
        }
      });

      const rows = analysed.filter((r): r is ScanRow => !!r);
      rows.sort((a, b) => b.volatility - a.volatility || b.score - a.score);
      const latestSettings = getSettings();
      if (!this.rescanRequested && latestSettings.scanner.enabled && latestSettings.autoScan) {
        this.reconcileZones(rows);
      } else if (!latestSettings.scanner.enabled || !latestSettings.autoScan) {
        this.zones.clear();
      }
      // A superseded batch may still update diagnostics/progress, but it can
      // never grant execution eligibility under settings it did not analyse.
      const monitored = new Set(this.activeSymbols());
      for (const row of rows) row.inOpportunityZone = monitored.has(row.symbol);

      this.scanProgress = { ...this.scanProgress, running: false, updatedAt: Date.now() };
      const result: ScanResult = {
        at: Date.now(),
        durationMs: Date.now() - t0,
        universe: universe.length,
        target: shortlist.length,
        analysed: rows.length,
        rows,
        selected: [...monitored],
        opportunities: this.opportunities(),
        progress: this.progress(),
        gate,
      };
      const previousSelected = new Set(this.last?.selected ?? []);
      const changed = result.selected.length !== previousSelected.size || result.selected.some((x) => !previousSelected.has(x));
      this.last = result;
      this.emitProgress();
      this.notify(result);

      if (changed || !previousSelected.size) {
        emit('log', {
          level: 'info',
          msg: `Scanner: ${rows.length}/${shortlist.length} assets analysed · ${result.selected.length} opportunity zone${result.selected.length === 1 ? '' : 's'} under dedicated monitor`,
        });
      }
      return result;
    } catch (e: any) {
      this.scanProgress = { ...this.scanProgress, running: false, updatedAt: Date.now() };
      this.emitProgress();
      emit('log', { level: 'error', msg: `Scanner error: ${e?.message || e}` });
      return this.last;
    }
  }

  private bumpProgress(failed: boolean): void {
    this.scanProgress.completed += 1;
    if (failed) this.scanProgress.failed += 1;
    this.scanProgress.updatedAt = Date.now();
    if (
      this.scanProgress.completed === this.scanProgress.target ||
      this.scanProgress.completed % 5 === 0
    ) this.emitProgress();
  }

  private emitProgress(): void {
    emit('scanner-progress', this.progress());
  }

  private reconcileZones(rows: ScanRow[]): void {
    const now = Date.now();
    const s = getSettings();
    const ttl = s.scanner.zoneRetentionMin * 60_000;
    const bySymbol = new Map(rows.map((r, i) => [r.symbol, { row: r, rank: i + 1 }]));

    // Hard invalidation: a refreshed market that loses the activity/liquidity
    // gate must not remain eligible merely because its TTL lives.
    for (const [symbol, zone] of this.zones) {
      const hit = bySymbol.get(symbol);
      if (this.holdsPosition(symbol)) {
        zone.state = 'EXECUTED';
        zone.updatedAt = now;
        continue;
      }
      if (hit && !hit.row.tradable) {
        this.zones.delete(symbol);
        continue;
      }
      if (zone.expiresAt <= now) this.zones.delete(symbol);
    }

    const candidates = rows
      .map((row, index) => ({ row, rank: index + 1 }))
      .filter(({ row }) => row.opportunity)
      .sort((a, b) => b.row.setupScore - a.row.setupScore || a.rank - b.rank);

    for (const { row, rank } of candidates) {
      const existing = this.zones.get(row.symbol);
      // A just-triggered setup cannot be re-armed by the same scan snapshot.
      if (existing?.signalAt && now - existing.signalAt < 5 * 60_000 && !this.holdsPosition(row.symbol)) continue;
      const zone: OpportunityZone = {
        symbol: row.symbol,
        base: row.base,
        side: row.opportunitySide,
        state: this.holdsPosition(row.symbol) ? 'EXECUTED' : 'MONITORING',
        score: row.setupScore,
        rank,
        price: row.price,
        adx: row.adx,
        atrPct: row.atrPct,
        atrPct5m: row.atrPct5m,
        emaGapPct: row.emaGapPct,
        emaGapAtr: row.emaGapAtr,
        enteredAt: existing?.enteredAt ?? now,
        lastQualifiedAt: now,
        updatedAt: now,
        expiresAt: now + ttl,
        signalId: existing?.signalId ?? null,
        signalAt: existing?.signalAt ?? null,
        tradeId: existing?.tradeId ?? null,
        reason: row.opportunityReason,
      };
      this.zones.set(row.symbol, zone);
    }

    // The monitor cap applies to waiting zones only. Executed positions remain
    // visible but are watched by the trader independently of this queue.
    const waiting = [...this.zones.values()]
      .filter((z) => z.state !== 'EXECUTED')
      .sort((a, b) => b.score - a.score || b.lastQualifiedAt - a.lastQualifiedAt);
    const allowed = new Set(waiting.slice(0, s.scanner.topN).map((z) => z.symbol));
    for (const z of waiting) if (!allowed.has(z.symbol)) this.zones.delete(z.symbol);
  }

  private pruneExpiredZones(): void {
    const now = Date.now();
    for (const [symbol, z] of this.zones) {
      if (this.holdsPosition(symbol)) continue;
      if (z.expiresAt <= now) this.zones.delete(symbol);
    }
  }

  private syncLastAndNotify(): void {
    if (!this.last) return;
    const selected = this.activeSymbols();
    const monitored = new Set(selected);
    for (const row of this.last.rows) row.inOpportunityZone = monitored.has(row.symbol);
    this.last = {
      ...this.last,
      selected,
      opportunities: this.opportunities(),
      progress: this.progress(),
    };
    this.notify(this.last);
  }

  private notify(result: ScanResult): void {
    for (const fn of this.listeners) {
      try {
        fn(result);
      } catch {
        /* listener errors must not kill the scan */
      }
    }
  }

  /** Late-bound hook so the scanner can keep bot-owned positions visible. */
  holdsPosition: (symbol: string) => boolean = () => false;
}

function trendOf(emaFast: number, emaSlow: number, price: number): 'UP' | 'DOWN' {
  return emaSlow < emaFast && price > emaSlow ? 'UP' : 'DOWN';
}

export function analyse(
  sym: ExchangeSymbol,
  t: { lastPrice: number; priceChangePercent: number; highPrice: number; lowPrice: number; quoteVolume: number },
  k15: Candle[],
  k1h: Candle[],
  fund: { lastFundingRate: number; nextFundingTime: number } | undefined,
  gate: Pick<ScanResult['gate'], 'minQuoteVolume24h' | 'minRange24hPct' | 'minAtrPct' | 'minAdx'>,
): ScanRow {
  const s = getSettings();
  const price = k15[k15.length - 1]?.close ?? t.lastPrice;
  const range24hPct = ((t.highPrice - t.lowPrice) / t.lastPrice) * 100;
  const atr15 = lastFinite(atr(k15, s.atrLength));
  const atrPct = price > 0 && Number.isFinite(atr15) ? (atr15 / price) * 100 : 0;
  const adx15 = lastFinite(adx(k15, 14));
  const adxVal = Number.isFinite(adx15) ? adx15 : 0;

  const closes15 = k15.map((c) => c.close);
  const f15 = lastFinite(ema(closes15, 11));
  const s15 = lastFinite(ema(closes15, 34));
  const closes1h = k1h.map((c) => c.close);
  const f1h = lastFinite(ema(closes1h, 11));
  const s1h = lastFinite(ema(closes1h, 34));

  const trend = trendOf(f15, s15, price);
  const trend1h: 'UP' | 'DOWN' = s1h < f1h ? 'UP' : 'DOWN';
  const alignment = trend === trend1h ? 1 : 0.55;
  const volatility =
    0.4 * clamp(range24hPct / 25, 0, 1) * 100 +
    0.35 * clamp(atrPct / 3, 0, 1) * 100 +
    0.25 * clamp(Math.abs(t.priceChangePercent) / 15, 0, 1) * 100;
  const trendScore = clamp(adxVal / 45, 0, 1) * 100 * alignment;
  const liquidityScore = clamp(Math.log10(Math.max(1, t.quoteVolume) / 1e6) / 2.5, 0, 1) * 100;
  const score = 0.45 * volatility + 0.3 * trendScore + 0.25 * liquidityScore;

  let marketType: MarketType;
  if (range24hPct < 1.5 || atrPct < 0.15) marketType = 'PEGGED';
  else if (adxVal >= gate.minAdx && trendScore >= 18) marketType = 'TRENDING';
  else if (range24hPct >= gate.minRange24hPct && atrPct >= gate.minAtrPct) marketType = 'RANGING';
  else marketType = 'QUIET';

  let tradable = true;
  let reason = 'liquid, active market · watching 5m liquidity sweeps';
  if (isPeggedSymbol(sym)) {
    tradable = false;
    reason = 'pegged / stable / staked market — never traded';
  } else if (t.quoteVolume < gate.minQuoteVolume24h) {
    tradable = false;
    reason = `24h volume ${(t.quoteVolume / 1e6).toFixed(0)}M < ${(gate.minQuoteVolume24h / 1e6).toFixed(0)}M`;
  } else if (marketType === 'PEGGED') {
    tradable = false;
    reason = 'no directional movement (pegged/quiet)';
  } else if (range24hPct < gate.minRange24hPct) {
    tradable = false;
    reason = `24h range ${range24hPct.toFixed(1)}% < ${gate.minRange24hPct}%`;
  } else if (atrPct < gate.minAtrPct) {
    tradable = false;
    reason = `ATR ${atrPct.toFixed(2)}% < ${gate.minAtrPct}%`;
  }

  return {
    symbol: sym.symbol,
    base: sym.baseAsset,
    price,
    change24hPct: t.priceChangePercent,
    range24hPct,
    quoteVolume24h: t.quoteVolume,
    atrPct,
    atrPct5m: 0,
    adx: adxVal,
    emaFast: f15,
    emaSlow: s15,
    emaFast5m: 0,
    emaSlow5m: 0,
    trend,
    alignment,
    fundingRate: fund?.lastFundingRate ?? 0,
    nextFundingTime: fund?.nextFundingTime ?? 0,
    volatility: round(volatility),
    trendScore: round(trendScore),
    liquidityScore: round(liquidityScore),
    score: round(score),
    setupScore: 0,
    emaGapPct: 0,
    emaGapAtr: 999,
    approachAtr: 0,
    opportunity: false,
    inOpportunityZone: false,
    opportunitySide: 'BOTH',
    marketType,
    tradable,
    reason,
    opportunityReason: '5m setup not analysed',
    updatedAt: Date.now(),
  };
}

/** Test surface (unit checks in scripts/verify-realtime.js). */
export const __scanInternals = { isPeggedSymbol, analyse, assessOpportunity, mapConcurrent };

export const scanner = new MarketScanner();

/**
 * Market Scanner — ranks the complete Binance USD-M perpetual universe by
 * volatility, highest to lowest, and keeps only markets that are *trending*.
 *
 *   Step 1 (1 call,  weight 40): /fapi/v1/ticker/24hr  → whole universe
 *   Step 1b (1 call, weight 10): /fapi/v1/premiumIndex → funding rates
 *   Step 2 (per symbol, weight 2-6): klines for 15m + 1h (+5m for the leaders)
 *
 * Every request goes through the shared 95% weight scheduler in its own
 * 'scanner' area, so scanning never starves the engine, the account poller or
 * the executor — and the scanner never breaks the exchange limit.
 *
 * Market-type gates (your rules):
 *   • NEVER trade pegged / stable / staked / wrapped / index markets
 *     ("copy or stack markets" are rejected by name and by behaviour: a pair
 *     whose 24h range collapses is treated as pegged regardless of ticker).
 *   • ONLY trending markets: EMA structure + ADX(14) must agree on 15m & 1h.
 *   • High volatility: 24h range, ATR% and |24h move| are the ranking keys.
 */
import { api, ExchangeSymbol } from './binance';
import { adx, atr, ema, lastFinite } from './indicators';
import { getSettings, MAX_POSITIONS_CAP } from './settings';
import { emit } from './broadcast';

export type MarketType = 'TRENDING' | 'RANGING' | 'QUIET' | 'PEGGED';

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
  trend: 'UP' | 'DOWN';
  alignment: number; // 1.0 = 15m trend agrees with 1h trend
  fundingRate: number;
  nextFundingTime: number;
  volatility: number; // 0..100 — primary ranking key (descending)
  trendScore: number; // 0..100
  liquidityScore: number; // 0..100
  score: number; // combined rank score
  marketType: MarketType;
  tradable: boolean;
  reason: string; // why it is / is not tradable
  updatedAt: number;
}

export interface ScanResult {
  at: number;
  durationMs: number;
  universe: number;
  analysed: number;
  rows: ScanRow[]; // all analysed rows, volatility descending
  selected: string[]; // symbols handed to the engine (≤ maxPositions)
  gate: {
    minQuoteVolume24h: number;
    minRange24hPct: number;
    minAtrPct: number;
    minAdx: number;
    maxPositions: number;
  };
}

/**
 * Pegged / staked / wrapped / index bases. These are "copy or stack" style
 * markets: tracking another asset 1:1 means no directional edge, and they must
 * never be traded by the bot.
 */
const PEGGED_BASES = new Set([
  // stablecoins & cash-like
  'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDD', 'PYUSD', 'USDE', 'USDS', 'SUSDE', 'SUSDS',
  'USDF', 'USDG', 'USD1', 'XUSD', 'USTC', 'UST', 'BFUSD', 'LDUSDT', 'SUSD', 'GUSD', 'FRAX', 'MIM', 'EUR', 'EURI', 'AEUR',
  'USDY', 'USDR', 'USDB', 'DOLA', 'CRVUSD', 'GHO', 'USDX', 'VAI', 'ALUSD',
  // fiat rails
  'BIDR', 'IDRT', 'TRY', 'BRL', 'ARS', 'JPY', 'GBP', 'AUD', 'RUB', 'NGN', 'ZAR', 'PLN', 'RON', 'CZK', 'UAH', 'MXN',
  'COP', 'PEN', 'PHP', 'INR',
  // wrapped / liquid-staked ("stack") tokens
  'WBTC', 'WBETH', 'WETH', 'BNSOL', 'BETH', 'CBBTC', 'SOLVBTC', 'WBETH', 'STETH', 'WSTETH', 'RETH', 'JITOSOL', 'MSOL',
  'SFRXETH', 'EZETH', 'RSETH', 'ANKRETH',
  // metals & index trackers
  'PAXG', 'XAUT', 'BTCDOM', 'DEFI', 'ALT', '1000BTCDOM',
]);

export function isPeggedSymbol(sym: ExchangeSymbol): boolean {
  const base = sym.baseAsset.toUpperCase();
  if (PEGGED_BASES.has(base)) return true;
  // index / dominance trackers
  if (/DOM$/.test(sym.symbol) || /^DEFIUSDT$/.test(sym.symbol)) return true;
  // base like "USDC" embedded in a synthetic ticker (e.g. 1000X-style pegs)
  if (/^USD|USD$/.test(base) && base !== 'USDE') return true;
  return false;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

class MarketScanner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private last: ScanResult | null = null;
  private selected = new Set<string>();
  private listeners = new Set<(r: ScanResult) => void>();

  start(): void {
    if (this.timer) return;
    const s = getSettings();
    if (!s.scanner.enabled) return;
    // Self-scheduling loop: after a failed scan we retry sooner so the feed
    // recovers quickly once Binance is reachable again.
    const loop = async () => {
      await this.scan();
      const ok = !!this.last;
      const delay = ok ? Math.max(15, getSettings().scanner.intervalSec) * 1000 : 15_000;
      this.timer = setTimeout(() => void loop(), delay);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    };
    void loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  restart(): void {
    this.stop();
    this.start();
  }

  result(): ScanResult | null {
    return this.last;
  }

  /** Symbols the engine should watch / trade right now (≤ maxPositions). */
  activeSymbols(): string[] {
    if (!this.selected.size) return [];
    return [...this.selected];
  }

  isTradable(symbol: string): boolean {
    if (!this.last) return true; // scanner still warming up — engine covers the primary symbol
    return this.selected.has(symbol);
  }

  onChange(fn: (r: ScanResult) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async scan(): Promise<ScanResult | null> {
    if (this.running) return this.last;
    this.running = true;
    const t0 = Date.now();
    try {
      const s = getSettings();
      const gate = {
        minQuoteVolume24h: s.scanner.minQuoteVolume24h,
        minRange24hPct: s.scanner.minRange24hPct,
        minAtrPct: s.scanner.minAtrPct,
        minAdx: s.scanner.minAdx,
        maxPositions: Math.min(s.maxPositions, MAX_POSITIONS_CAP),
      };

      const info = await api.exchangeInfoAll();
      const universe = info.filter((x) => x.status === 'TRADING' && x.contractType === 'PERPETUAL');

      const tickers = await api.ticker24hrAll();
      const tickerMap = new Map(tickers.map((t) => [t.symbol, t]));
      const premium = await api.premiumIndexAll();
      const fundMap = new Map(premium.map((p) => [p.symbol, p]));

      type Cand = { sym: ExchangeSymbol; t: (typeof tickers)[number]; rangePct: number; volScore: number };
      const candidates: Cand[] = [];
      for (const sym of universe) {
        if (isPeggedSymbol(sym)) continue;
        const t = tickerMap.get(sym.symbol);
        if (!t || t.lastPrice <= 0 || t.highPrice <= 0 || t.lowPrice <= 0) continue;
        const rangePct = ((t.highPrice - t.lowPrice) / t.lastPrice) * 100;
        if (t.quoteVolume < gate.minQuoteVolume24h) continue;
        // Behavioural pegged check: a market that never moves cannot be traded
        // directionally no matter what its ticker says.
        if (rangePct < Math.max(1.5, gate.minRange24hPct * 0.5)) continue;
        const volScore = 0.6 * clamp(rangePct / 25, 0, 1) + 0.4 * clamp(Math.abs(t.priceChangePercent) / 15, 0, 1);
        candidates.push({ sym, t, rangePct, volScore });
      }

      // Volatility descending — the scanner always reads the market top down.
      candidates.sort((a, b) => b.volScore - a.volScore);
      const shortlist = candidates.slice(0, s.scanner.candidates);

      const rows: ScanRow[] = [];
      const leaders = new Set(shortlist.slice(0, Math.max(gate.maxPositions * 2, 12)).map((c) => c.sym.symbol));

      for (const c of shortlist) {
        try {
          const k15 = await api.klines(c.sym.symbol, '15m', 120, 20_000);
          const k1h = await api.klines(c.sym.symbol, '1h', 120, 60_000);
          const row = analyse(c.sym, c.t, k15, k1h, null, fundMap.get(c.sym.symbol), gate);
          if (leaders.has(c.sym.symbol)) {
            try {
              const k5 = await api.klines(c.sym.symbol, '5m', 120, 10_000);
              const a5 = lastFinite(atr(k5, s.atrLength));
              const p5 = k5[k5.length - 1]?.close ?? row.price;
              row.atrPct5m = p5 > 0 && Number.isFinite(a5) ? (a5 / p5) * 100 : 0;
            } catch {
              /* keep 0 — 5m ATR is informational */
            }
          }
          rows.push(row);
        } catch {
          /* symbol skipped this round (exchange hiccup) */
        }
      }

      // Final ranking: volatility first, then trend quality, then liquidity.
      rows.sort((a, b) => b.volatility - a.volatility || b.score - a.score);

      const tradable = rows.filter((r) => r.tradable).slice(0, gate.maxPositions);
      const selectedNext = new Set(tradable.map((r) => r.symbol));
      // Keep watching a traded symbol even if it slips out of the ranking this
      // round — the executor must never lose sight of an open position.
      for (const sym of this.selected) if (!selectedNext.has(sym) && this.holdsPosition(sym)) selectedNext.add(sym);

      const changed = selectedNext.size !== this.selected.size || [...selectedNext].some((x) => !this.selected.has(x));
      this.selected = selectedNext;

      const result: ScanResult = {
        at: Date.now(),
        durationMs: Date.now() - t0,
        universe: universe.length,
        analysed: rows.length,
        rows,
        selected: [...selectedNext],
        gate,
      };
      this.last = result;

      if (changed) {
        emit('log', {
          level: 'info',
          msg: `Scanner: ${rows.length} markets analysed · trading ${result.selected.map((x) => x.replace('USDT', '')).join(', ') || '—'}`,
        });
      }
      for (const fn of this.listeners) {
        try {
          fn(result);
        } catch { /* listener errors must not kill the scan */ }
      }
      return result;
    } catch (e: any) {
      emit('log', { level: 'error', msg: `Scanner error: ${e?.message || e}` });
      return this.last;
    } finally {
      this.running = false;
    }
  }

  /** Late-bound hook so the scanner can ask the trader whether a symbol is held. */
  holdsPosition: (symbol: string) => boolean = () => false;
}

function trendOf(emaFast: number, emaSlow: number, price: number): 'UP' | 'DOWN' {
  return emaSlow < emaFast && price > emaSlow ? 'UP' : 'DOWN';
}

export function analyse(
  sym: ExchangeSymbol,
  t: { lastPrice: number; priceChangePercent: number; highPrice: number; lowPrice: number; quoteVolume: number },
  k15: { open: number; high: number; low: number; close: number; time: number; closeTime: number; volume: number }[],
  k1h: { open: number; high: number; low: number; close: number; time: number; closeTime: number; volume: number }[],
  _unused: null,
  fund: { lastFundingRate: number; nextFundingTime: number } | undefined,
  gate: ScanResult['gate'],
): ScanRow {
  const s = getSettings();
  const price = k15[k15.length - 1]?.close ?? t.lastPrice;
  const range24hPct = ((t.highPrice - t.lowPrice) / t.lastPrice) * 100;

  const atr15 = lastFinite(atr(k15, s.atrLength));
  const atrPct = price > 0 && Number.isFinite(atr15) ? (atr15 / price) * 100 : 0;

  const adx15 = lastFinite(adx(k15, 14));
  const adxVal = Number.isFinite(adx15) ? adx15 : 0;

  const closes15 = k15.map((c) => c.close);
  const f15 = lastFinite(ema(closes15, s.emaLengths[1]));
  const s15 = lastFinite(ema(closes15, s.emaLengths[7]));
  const closes1h = k1h.map((c) => c.close);
  const f1h = lastFinite(ema(closes1h, s.emaLengths[1]));
  const s1h = lastFinite(ema(closes1h, s.emaLengths[7]));

  const trend = trendOf(f15, s15, price);
  const trend1h: 'UP' | 'DOWN' = s1h < f1h ? 'UP' : 'DOWN';
  const alignment = trend === trend1h ? 1 : 0.55;

  // --- scores (0..100) -----------------------------------------------------
  const volatility =
    0.4 * clamp(range24hPct / 25, 0, 1) * 100 +
    0.35 * clamp(atrPct / 3, 0, 1) * 100 +
    0.25 * clamp(Math.abs(t.priceChangePercent) / 15, 0, 1) * 100;
  const trendScore = clamp(adxVal / 45, 0, 1) * 100 * alignment;
  const liquidityScore = clamp(Math.log10(Math.max(1, t.quoteVolume) / 1e6) / 2.5, 0, 1) * 100;
  const score = 0.45 * volatility + 0.3 * trendScore + 0.25 * liquidityScore;

  // --- classification ------------------------------------------------------
  let marketType: MarketType;
  if (range24hPct < 1.5 || atrPct < 0.15) marketType = 'PEGGED';
  else if (adxVal >= gate.minAdx && trendScore >= 18) marketType = 'TRENDING';
  else if (range24hPct >= gate.minRange24hPct && atrPct >= gate.minAtrPct) marketType = 'RANGING';
  else marketType = 'QUIET';

  // --- tradability gates ---------------------------------------------------
  let tradable = true;
  let reason = 'high volatility + trending';
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
  } else if (adxVal < gate.minAdx) {
    tradable = false;
    reason = `ADX ${adxVal.toFixed(1)} < ${gate.minAdx} — choppy, not trending`;
  } else if (trend !== trend1h) {
    tradable = false;
    reason = '15m and 1h trends disagree';
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
    trend,
    alignment,
    fundingRate: fund?.lastFundingRate ?? 0,
    nextFundingTime: fund?.nextFundingTime ?? 0,
    volatility: Number(volatility.toFixed(2)),
    trendScore: Number(trendScore.toFixed(2)),
    liquidityScore: Number(liquidityScore.toFixed(2)),
    score: Number(score.toFixed(2)),
    marketType,
    tradable,
    reason,
    updatedAt: Date.now(),
  };
}

/** Test surface (unit checks in scripts/verify-realtime.js). */
export const __scanInternals = { isPeggedSymbol, analyse };

export const scanner = new MarketScanner();

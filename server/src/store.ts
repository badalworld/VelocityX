import fs from 'fs';
import path from 'path';
import { dataPath } from './settings';

export type TradeStatus = 'OPEN' | 'CLOSED';
export type TradeSide = 'LONG' | 'SHORT';

export interface Trade {
  id: string;
  symbol: string;
  side: TradeSide;
  status: TradeStatus;
  qty: number;
  q1: number; // TP1 slice
  q2: number; // TP2 slice (of remaining)
  q3: number; // legacy TP3 slice / POC strategy third 20% slice
  q4?: number;
  q5?: number;
  exitPlan?: 'LEGACY_3TP' | 'LIQUIDITY_5R';
  entryPrice: number;
  atrAtEntry: number;
  slInitial: number;
  slCurrent: number;
  slStage: number; // 0 = initial; five-step plan advances through 4R protection
  tp1: number;
  tp2: number;
  tp3: number;
  tp4?: number;
  tp5?: number;
  notional: number;
  margin: number;
  leverage: number;
  openedAt: number;
  closedAt: number | null;
  closeReason: 'TP3' | 'TP5' | 'SL' | 'SL_PARTIAL' | 'REVERSE' | 'KILL' | 'EXTERNAL' | null;
  tp1Filled: boolean;
  tp2Filled: boolean;
  tp3Filled: boolean;
  tp4Filled?: boolean;
  tp5Filled?: boolean;
  realizedPnl: number; // net of fees
  fees: number;
  /** Binance funding paid/received while this trade was open (USDT, real data). */
  funding: number;
  /** Binance-verified realised PnL from ORDER_TRADE_UPDATE (live/testnet only). */
  binanceRealizedPnl: number;
  /** Commission reported by Binance in a non-USDT asset (e.g. BNB), if any. */
  commissionOtherAsset: number;
  initialRisk: number; // |entry-sl| * qty (price risk at open)
  /** Binance client order ids (VX<tradeId><suffix>) for this trade's ladder. */
  orders: { entry?: string; sl?: string; tp1?: string; tp2?: string; tp3?: string; tp4?: string; tp5?: string };
  mode: 'testnet' | 'live';
  result: 'WIN' | 'LOSS' | null;
  /** Always true: the bot NEVER adopts or manages trades it did not open. */
  botOwned: true;
  /** Opportunity-zone snapshot at entry for execution auditability. */
  scan?: {
    volatility: number;
    adx: number;
    atrPct: number;
    rank: number;
    setupScore?: number;
    emaGapAtr?: number;
    opportunity?: boolean;
  } | null;
}

export interface SignalRecord {
  id: string;
  symbol: string;
  time: number; // candle open time (ms)
  detectedAt: number;
  side: SignalSide_;
  price: number;
  atr: number;
  acted: boolean; // bot opened a trade for this signal
  tradeId: string | null;
  strategy?: 'LIQUIDITY_SWEEP_POC_RETEST';
  pocPrice?: number;
  sweptLevel?: number;
  sweepExtreme?: number;
  stopPrice?: number;
  riskDistance?: number;
  sweepTime?: number;
}
type SignalSide_ = 'LONG' | 'SHORT';

const TRADES_FILE = dataPath('trades.json');
const SIGNALS_FILE = dataPath('signals.json');

/**
 * Read a persisted JSON document. A corrupt journal is NEVER silently dropped:
 * the bad file is moved aside (`<name>.corrupt-<ts>`) so the operator can
 * recover it, and the problem is logged — losing a trade journal silently is
 * exactly the kind of failure a trading bot must never have.
 */
function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (e: any) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
    } catch { /* keep going with defaults */ }
    console.error(
      `[store] ${path.basename(file)} is not valid JSON (${e?.message}) — moved to ${path.basename(backup)} and starting from defaults`,
    );
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  const tmp = file + '.tmp';
  try {
    // the data dir can disappear under a running bot (fresh checkout, manual
    // cleanup) — recreate it instead of losing the journal
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error(`[store] could not persist ${path.basename(file)}: ${(e as Error).message}`);
  }
}

// ---------- trades ----------
let trades: Trade[] = readJson<Trade[]>(TRADES_FILE, []);

export function allTrades(): Trade[] {
  return trades;
}
/** True for the new fixed 1R..5R liquidity strategy; missing is the legacy 3-leg plan. */
export function isFiveRTrade(t: Trade): boolean {
  return t.exitPlan === 'LIQUIDITY_5R';
}

export function tpCountOf(t: Trade): number {
  return isFiveRTrade(t) ? 5 : 3;
}

export function tpQtyOf(t: Trade, level: number): number {
  return Number((t as any)[`q${level}`]) || 0;
}

export function tpPriceOf(t: Trade, level: number): number {
  return Number((t as any)[`tp${level}`]) || 0;
}

export function tpFilledOf(t: Trade, level: number): boolean {
  return Boolean((t as any)[`tp${level}Filled`]);
}

/** Remaining quantity after whichever scale-out legs belong to this trade plan. */
export function remainingQtyOf(t: Trade): number {
  let closed = 0;
  for (let level = 1; level <= tpCountOf(t); level++) {
    if (tpFilledOf(t, level)) closed += tpQtyOf(t, level);
  }
  return Math.max(0, t.qty - closed);
}

/** All OPEN trades the bot itself opened (≤ maxPositions). */
export function openTrades(): Trade[] {
  return trades.filter((t) => t.status === 'OPEN');
}
export function openTradeOn(symbol: string): Trade | null {
  return trades.find((t) => t.status === 'OPEN' && t.symbol === symbol) || null;
}
export function saveTrade(t: Trade): void {
  const idx = trades.findIndex((x) => x.id === t.id);
  if (idx >= 0) trades[idx] = t;
  else trades.unshift(t);
  // Cap the journal, but only ever drop CLOSED history — an OPEN trade is the
  // bot's record of a live exchange position and must never fall off the end.
  for (let i = trades.length - 1; i >= 0 && trades.length > 1000; i--) {
    if (trades[i].status !== 'OPEN') trades.splice(i, 1);
  }
  writeJson(TRADES_FILE, trades);
}

// ---------- signals ----------
let signals: SignalRecord[] = readJson<SignalRecord[]>(SIGNALS_FILE, []);

export function allSignals(): SignalRecord[] {
  return signals;
}
export function saveSignal(s: SignalRecord): void {
  signals.unshift(s);
  if (signals.length > 2000) signals.length = 2000;
  writeJson(SIGNALS_FILE, signals);
}
export function markSignalActed(id: string, tradeId: string): void {
  const s = signals.find((x) => x.id === id);
  if (s) {
    s.acted = true;
    s.tradeId = tradeId;
    writeJson(SIGNALS_FILE, signals);
  }
}

// ---------- pruning ----------
export function pruneOld(days: number): void {
  const cutoff = Date.now() - days * 86400000;
  const before = signals.length;
  signals = signals.filter((s) => s.time >= cutoff);
  if (signals.length !== before) writeJson(SIGNALS_FILE, signals);
  // keep trade history longer (90 days) but always keep OPEN trades
  const tradeCutoff = Date.now() - 90 * 86400000;
  const tb = trades.length;
  trades = trades.filter((t) => t.status === 'OPEN' || (t.closedAt || 0) >= tradeCutoff);
  if (trades.length !== tb) writeJson(TRADES_FILE, trades);
}

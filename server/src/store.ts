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
  q3: number; // TP3 slice (rest)
  entryPrice: number;
  atrAtEntry: number;
  slInitial: number;
  slCurrent: number;
  slStage: 0 | 1 | 2; // 0 = initial, 1 = breakeven, 2 = at TP1
  tp1: number;
  tp2: number;
  tp3: number;
  notional: number;
  margin: number;
  leverage: number;
  openedAt: number;
  closedAt: number | null;
  closeReason: 'TP3' | 'SL' | 'SL_PARTIAL' | 'REVERSE' | 'KILL' | 'EXTERNAL' | null;
  tp1Filled: boolean;
  tp2Filled: boolean;
  tp3Filled: boolean;
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
  orders: { entry?: string; sl?: string; tp1?: string; tp2?: string; tp3?: string };
  mode: 'testnet' | 'live';
  result: 'WIN' | 'LOSS' | null;
  /** Always true: the bot NEVER adopts or manages trades it did not open. */
  botOwned: true;
  /** Market-scanner snapshot at entry (volatility rank, ADX, ATR%). */
  scan?: { volatility: number; adx: number; atrPct: number; rank: number } | null;
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
/** Remaining quantity of a trade after the scale-out ladder fills. */
export function remainingQtyOf(t: Trade): number {
  return t.qty - (t.tp1Filled ? t.q1 : 0) - (t.tp2Filled ? t.q2 : 0) - (t.tp3Filled ? t.q3 : 0);
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
  if (trades.length > 1000) trades.length = 1000;
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

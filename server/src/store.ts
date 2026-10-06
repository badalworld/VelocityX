import fs from 'fs';
import path from 'path';
import { dataPath } from './settings';

export type TradeStatus = 'OPEN' | 'CLOSED';
export type TradeSide = 'LONG' | 'SHORT';

/**
 * Strategy-neutral archive record. Legacy strategy/target/stop/size-policy
 * fields are deliberately removed when the old journal is read.
 */
export interface Trade {
  id: string;
  symbol: string;
  side: TradeSide;
  status: TradeStatus;
  qty: number;
  entryPrice: number;
  openedAt: number;
  closedAt: number | null;
  closePrice: number | null;
  realizedPnl: number;
  fees: number;
  funding: number;
  mode: 'testnet' | 'live';
  result: 'WIN' | 'LOSS' | null;
}

const TRADES_FILE = dataPath('trades.json');

/** Never discard an unreadable journal; preserve the original for recovery. */
function readJson(file: string): unknown {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return [];
  try {
    return JSON.parse(raw);
  } catch (e: any) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, backup); } catch { /* keep the running service alive */ }
    console.error(`[store] ${path.basename(file)} is invalid JSON (${e?.message}); preserved as ${path.basename(backup)}`);
    return [];
  }
}

function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e: any) {
    console.error(`[store] could not persist ${path.basename(file)}: ${e?.message || e}`);
  }
}

function number(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeTrade(value: any): Trade | null {
  if (!value || typeof value !== 'object') return null;
  const symbol = String(value.symbol || '').trim().toUpperCase();
  const side = value.side === 'SHORT' ? 'SHORT' : value.side === 'LONG' ? 'LONG' : null;
  const status = value.status === 'OPEN' ? 'OPEN' : value.status === 'CLOSED' ? 'CLOSED' : null;
  const id = String(value.id || '').trim();
  if (!id || !/^[A-Z0-9]{4,24}$/.test(symbol) || !side || !status) return null;
  const pnl = number(value.realizedPnl);
  const result = value.result === 'WIN' || value.result === 'LOSS'
    ? value.result
    : status === 'CLOSED' && pnl !== 0 ? (pnl > 0 ? 'WIN' : 'LOSS') : null;
  return {
    id,
    symbol,
    side,
    status,
    qty: Math.max(0, number(value.qty)),
    entryPrice: Math.max(0, number(value.entryPrice)),
    openedAt: Math.max(0, number(value.openedAt)),
    closedAt: value.closedAt == null ? null : Math.max(0, number(value.closedAt)),
    closePrice: value.closePrice == null ? null : Math.max(0, number(value.closePrice)),
    realizedPnl: pnl,
    fees: Math.max(0, number(value.fees)),
    funding: number(value.funding),
    mode: value.mode === 'testnet' ? 'testnet' : 'live',
    result,
  };
}

const rawTrades = readJson(TRADES_FILE);
const trades: Trade[] = Array.isArray(rawTrades)
  ? rawTrades.map(sanitizeTrade).filter((trade): trade is Trade => trade !== null).slice(0, 1000)
  : [];

// Migrate old trade journals in-place to a strategy-neutral archive shape.
// Open trades remain listed for manual attention; this module does not manage
// them, restore orders, update stops or close positions.
if (JSON.stringify(rawTrades) !== JSON.stringify(trades)) writeJson(TRADES_FILE, trades);

export function allTrades(): Trade[] {
  return trades;
}

export function openTrades(): Trade[] {
  return trades.filter((trade) => trade.status === 'OPEN');
}

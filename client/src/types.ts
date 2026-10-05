export type Mode = 'paper' | 'testnet' | 'live';

export interface Trade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  status: 'OPEN' | 'CLOSED';
  qty: number;
  q1: number;
  q2: number;
  q3: number;
  entryPrice: number;
  atrAtEntry: number;
  slInitial: number;
  slCurrent: number;
  slStage: 0 | 1 | 2;
  tp1: number;
  tp2: number;
  tp3: number;
  notional: number;
  margin: number;
  leverage: number;
  openedAt: number;
  closedAt: number | null;
  closeReason: string | null;
  tp1Filled: boolean;
  tp2Filled: boolean;
  tp3Filled: boolean;
  realizedPnl: number;
  fees: number;
  initialRisk: number;
  mode: Mode;
  result: 'WIN' | 'LOSS' | null;
  unrealized?: number;
}

export interface SignalRecord {
  id: string;
  symbol: string;
  time: number;
  detectedAt: number;
  side: 'LONG' | 'SHORT';
  price: number;
  atr: number;
  acted: boolean;
  tradeId: string | null;
}

export interface Status {
  mode: Mode;
  autoTrade: boolean;
  symbol: string;
  interval: string;
  leverage: number;
  tradeSizePercent: number;
  price: number;
  balance: { source: string; total: number | null; available: number | null; error?: string };
  openTrade: Trade | null;
  engine: {
    atr: number;
    ribbonBull: boolean;
    lastSignal: SignalRecord | null;
    emas: number[];
    emaExtra: number;
    lastClosedCandleTime: number;
    startedAt: number;
  } | null;
  feed?: string;
  streams?: { market?: boolean };
  keysConfigured: { testnet: boolean; live: boolean };
  logs: { t: number; level: string; msg: string }[];
  now: number;
}

export interface ChartPoint { time: number; value: number | null }
export interface ChartData {
  candles: { time: number; open: number; high: number; low: number; close: number }[];
  emas: ChartPoint[][];
  emaExtra: ChartPoint[];
  signals: { time: number; side: 'LONG' | 'SHORT'; price: number; id: string; acted: boolean }[];
  trade: {
    side: 'LONG' | 'SHORT';
    entry: number;
    sl: number;
    slStage: number;
    tp1: number;
    tp2: number;
    tp3: number;
    status: string;
    tp1Filled: boolean;
    tp2Filled: boolean;
    tp3Filled: boolean;
  } | null;
}

export interface Stats {
  windowDays: number;
  totalSignals: number;
  totalClosedTrades: number;
  tp1Count: number; tp2Count: number; tp3Count: number; slCount: number;
  tp1Pct: number; tp2Pct: number; tp3Pct: number; slPct: number;
  winCount: number; lossCount: number;
  overallWinRate: number;
  rrRatio: number;
  breakevenRate: number;
  expectancy: number;
  netPnl: number;
  totalFees: number;
}

export interface Mtf { timeframes: { tf: string; bull: boolean }[]; atr: number; ribbonBull: boolean; overall: string; bullCount?: number }
export interface ScreenerData { rows: { symbol: string; state: string }[] }

export interface Settings {
  mode: Mode;
  autoTrade: boolean;
  symbol: string;
  interval: string;
  tradeSizePercent: number;
  leverage: number;
  paperBalance: number;
  feeRate: number;
  emaLengths: number[];
  emaExtraLength: number;
  atrLength: number;
  atrSlMultiplier: number;
  tpRrFactor: number;
  tp1ClosePct: number;
  tp2ClosePct: number;
  historyDays: number;
  screenerSymbols: string[];
  dashboardTimeframes: string[];
  keys: {
    testnet: { key: string; secret: string; configured?: boolean };
    live: { key: string; secret: string; configured?: boolean };
  };
}

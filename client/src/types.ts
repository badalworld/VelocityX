export type Mode = 'testnet' | 'live';

export interface Trade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  status: 'OPEN' | 'CLOSED';
  qty: number;
  entryPrice: number;
  openedAt: number;
  closedAt: number | null;
  closePrice: number | null;
  realizedPnl: number;
  fees: number;
  funding: number;
  mode: Mode;
  result: 'WIN' | 'LOSS' | null;
}

export interface Position {
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

export interface IncomeSummary {
  windowDays: number;
  realizedPnl: number;
  commission: number;
  funding: number;
  transfers: number;
  insurance: number;
  other: number;
  net: number;
  bySymbol: { symbol: string; realizedPnl: number; commission: number; funding: number; net: number }[];
  records: number;
  at: number;
}

export interface AccountView {
  source: 'binance';
  mode: Mode;
  at: number;
  equity: number | null;
  walletBalance: number | null;
  unrealizedPnl: number | null;
  availableBalance: number | null;
  initialMargin: number | null;
  maintMargin: number | null;
  roiPct: number | null;
  roiOnWalletPct: number | null;
  canTrade: boolean | null;
  positions: Position[];
  income: IncomeSummary | null;
  errors: string[];
  latencyMs: number;
}

export interface Settings {
  mode: Mode;
  symbol: string;
  interval: '5m';
  historyDays: number;
  keys: Record<Mode, { key: string; secret: string; configured?: boolean }>;
}

export interface MarketState {
  symbol: string;
  interval: string;
  lastPrice: number;
  lastClosedCandleTime: number;
  engineStartedAt: number;
}

export interface StrategyView {
  name: string;
  execution: 'paper-signal-only';
  point: { time: number; fema: number; fsma: number; atr: number } | null;
  signal: { time: number; fema: number; fsma: number; atr: number; signal: 'BUY' | 'SELL'; reason: string } | null;
  settings: { overbought: number; oversold: number; atrMultiplier: number; atrLength: number; channelLength: number; averageLength: number; signalLength: number };
}

export interface Status {
  mode: Mode;
  symbol: string;
  interval: string;
  entriesEnabled: false;
  entriesDisabledReason: string;
  market: MarketState | null;
  feed: {
    feed: string;
    source: string;
    reachable: boolean | null;
    lastRestOkAt: number;
    lastRestError: string | null;
    latencyMs: number;
    avgLatencyMs: number;
    serverTimeOffsetMs: number;
    wsLastMessageAt: number;
  };
  streams: {
    market: boolean;
    marketLastMessageAt: number;
    user: boolean;
    userLastMessageAt: number;
  };
  strategy: StrategyView;
  engine: {
    activeSymbols: string[];
    lastTickAt: number;
    lastClosedCandleTime: number;
    startedAt: number;
  };
  account: AccountView | null;
  openTrades: Trade[];
  tradeCount: number;
  keysConfigured: Record<Mode, boolean>;
  apiTokenRequired: boolean;
  logs: LogLine[];
  now: number;
}

export interface PositionsPayload {
  positions: Position[];
  openJournalEntries: Trade[];
  at: number;
  note: string;
}

export interface LogLine {
  t: number;
  level: string;
  msg: string;
}

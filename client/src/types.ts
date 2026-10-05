/**
 * Execution environment. There is no simulated mode: orders always go to a real
 * Binance environment (testnet = Binance's test exchange, live = mainnet).
 */
export type Mode = 'testnet' | 'live';

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
  markPrice?: number;
  remainingQty?: number;
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
  funding: number;
  binanceRealizedPnl: number;
  commissionOtherAsset: number;
  initialRisk: number;
  mode: Mode;
  result: 'WIN' | 'LOSS' | null;
  botOwned: true;
  scan?: { volatility: number; adx: number; atrPct: number; rank: number } | null;
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

export interface BotTotals {
  managedCount: number;
  /** closed bot trades all-time (they keep contributing to realizedPnl/fees/funding) */
  closedCount: number;
  maxPositions: number;
  marginUsed: number;
  notional: number;
  unrealizedPnl: number;
  realizedPnl: number;
  fees: number;
  funding: number;
  netPnl: number;
  roiPct: number;
}

export interface AccountView {
  /** Always Binance — the account is never simulated. */
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
  bot: BotTotals;
  income: IncomeSummary | null;
  external: { count: number; notional: number; unrealized: number };
  errors?: string[];
  latencyMs?: number;
}

export interface ManagedPosition {
  trade: Trade;
  markPrice: number;
  unrealized: number;
  roiPct: number;
  fees: number;
  funding: number;
  remainingQty: number;
  notional: number;
  margin: number;
  leverage: number;
  liquidationPrice: number;
  source: 'binance';
}

export interface ExternalPosition {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealized: number;
  leverage: number;
  notional: number;
  managed: false;
  note?: string;
}

export interface PositionsPayload {
  managed: ManagedPosition[];
  external: ExternalPosition[];
  slots: { used: number; max: number };
  note: string;
  at: number;
}

export interface ScannerRow {
  symbol: string;
  base: string;
  price: number;
  change24hPct: number;
  range24hPct: number;
  quoteVolume24h: number;
  atrPct: number;
  atrPct5m: number;
  adx: number;
  emaFast: number;
  emaSlow: number;
  trend: 'UP' | 'DOWN';
  alignment: number;
  fundingRate: number;
  nextFundingTime: number;
  volatility: number;
  trendScore: number;
  liquidityScore: number;
  score: number;
  marketType: 'TRENDING' | 'RANGING' | 'QUIET' | 'PEGGED';
  tradable: boolean;
  reason: string;
  updatedAt: number;
}

export interface ScanResult {
  at: number;
  durationMs?: number;
  universe: number;
  analysed: number;
  rows: ScannerRow[];
  selected: string[];
  warming?: boolean;
  gate: {
    minQuoteVolume24h: number;
    minRange24hPct: number;
    minAtrPct: number;
    minAdx: number;
    maxPositions: number;
  } | null;
}

export interface FeedInfo {
  feed: 'binance' | 'binance-unreachable';
  source: string;
  reachable: boolean | null;
  lastRestOkAt: number;
  lastRestError: string | null;
  latencyMs: number;
  avgLatencyMs: number;
  serverTimeOffsetMs: number;
  wsLastMessageAt: number;
  candles?: { symbols: number; series: number; bars: number; lastWsAt: number };
}

export interface AreaStat {
  area: string;
  sharePct: number;
  weightUsed: number;
  weightCap: number;
  calls: number;
  waiting: number;
  avgWaitMs: number;
}

export interface LimitStatus {
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
}

export interface Status {
  mode: Mode;
  autoTrade: boolean;
  symbol: string;
  interval: string;
  leverage: number;
  tradeSizePercent: number;
  maxPositions: number;
  autoScan: boolean;
  price: number;
  account: AccountView | null;
  openTrades: Trade[];
  openTrade: Trade | null;
  slots: { used: number; max: number };
  scanner: { at: number; universe: number; analysed: number; selected: string[]; top: ScannerRow[] } | null;
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
  feedInfo?: FeedInfo;
  limits?: LimitStatus;
  streams?: { market?: boolean; user?: boolean; userLastMessageAt?: number };
  keysConfigured: { testnet: boolean; live: boolean };
  logs: { t: number; level: string; msg: string }[];
  now: number;
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
  totalFunding: number;
  openTrades: number;
  binance?: {
    source: string;
    equity: number | null;
    walletBalance: number | null;
    unrealizedPnl: number | null;
    roiPct: number | null;
    fees: number;
    funding: number;
    realizedPnlBot: number;
    income: IncomeSummary | null;
  } | null;
}

export interface Mtf { symbol?: string; timeframes: { tf: string; bull: boolean }[]; atr: number; ribbonBull: boolean; overall: string; bullCount?: number }
export interface ScannerSettings {
  enabled: boolean;
  intervalSec: number;
  candidates: number;
  minQuoteVolume24h: number;
  minRange24hPct: number;
  minAtrPct: number;
  minAdx: number;
  topN: number;
}

export interface Settings {
  mode: Mode;
  autoTrade: boolean;
  symbol: string;
  interval: string;
  tradeSizePercent: number;
  leverage: number;
  maxPositions: number;
  autoScan: boolean;
  scanner: ScannerSettings;
  emaLengths: number[];
  emaExtraLength: number;
  atrLength: number;
  atrSlMultiplier: number;
  tpRrFactor: number;
  tp1ClosePct: number;
  tp2ClosePct: number;
  historyDays: number;
  dashboardTimeframes: string[];
  keys: {
    testnet: { key: string; secret: string; configured?: boolean };
    live: { key: string; secret: string; configured?: boolean };
  };
}

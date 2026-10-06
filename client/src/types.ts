/**
 * Order-execution environment. Historical backtests are separate and cannot
 * submit orders; execution always targets configured Binance Demo or LIVE.
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
  q4?: number;
  q5?: number;
  exitPlan?: 'LEGACY_3TP' | 'LIQUIDITY_5R';
  entryPrice: number;
  markPrice?: number;
  remainingQty?: number;
  atrAtEntry: number;
  slInitial: number;
  slCurrent: number;
  slStage: number;
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
  closeReason: string | null;
  tp1Filled: boolean;
  tp2Filled: boolean;
  tp3Filled: boolean;
  tp4Filled?: boolean;
  tp5Filled?: boolean;
  realizedPnl: number;
  fees: number;
  funding: number;
  binanceRealizedPnl: number;
  commissionOtherAsset: number;
  initialRisk: number;
  mode: Mode;
  result: 'WIN' | 'LOSS' | null;
  botOwned: true;
  scan?: {
    volatility: number;
    adx: number;
    atrPct: number;
    rank: number;
    setupScore?: number;
    emaGapAtr?: number;
    opportunity?: boolean;
  } | null;
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
  strategy?: 'LIQUIDITY_SWEEP_POC_RETEST';
  pocPrice?: number;
  sweptLevel?: number;
  sweepExtreme?: number;
  stopPrice?: number;
  riskDistance?: number;
  sweepTime?: number;
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

export type OpportunityState = 'MONITORING' | 'TRIGGERED' | 'EXECUTED';

export interface OpportunityZone {
  symbol: string;
  base: string;
  side: 'LONG' | 'SHORT' | 'BOTH';
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

export interface ScanProgress {
  id: string;
  running: boolean;
  target: number;
  completed: number;
  failed: number;
  startedAt: number;
  updatedAt: number;
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
  emaFast5m: number;
  emaSlow5m: number;
  trend: 'UP' | 'DOWN';
  alignment: number;
  fundingRate: number;
  nextFundingTime: number;
  volatility: number;
  trendScore: number;
  liquidityScore: number;
  score: number;
  setupScore: number;
  emaGapPct: number;
  emaGapAtr: number;
  approachAtr: number;
  opportunity: boolean;
  inOpportunityZone: boolean;
  opportunitySide: 'LONG' | 'SHORT' | 'BOTH';
  marketType: 'TRENDING' | 'RANGING' | 'QUIET' | 'PEGGED';
  tradable: boolean;
  reason: string;
  opportunityReason: string;
  updatedAt: number;
}

export interface ScanResult {
  at: number;
  durationMs?: number;
  universe: number;
  target: number;
  analysed: number;
  rows: ScannerRow[];
  selected: string[];
  opportunities: OpportunityZone[];
  progress: ScanProgress;
  warming?: boolean;
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

export interface ExecutionReadiness {
  ready: boolean;
  infrastructureReady: boolean;
  state: 'READY' | 'DISARMED' | 'BLOCKED';
  reasons: string[];
  mode: Mode;
  armed: boolean;
  checks: Record<string, boolean>;
  at: number;
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
  scanner: {
    at: number;
    universe: number;
    target: number;
    analysed: number;
    selected: string[];
    opportunities: OpportunityZone[];
    progress: ScanProgress;
    top: ScannerRow[];
  } | null;
  execution?: ExecutionReadiness;
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
  tp1Count: number; tp2Count: number; tp3Count: number; tp4Count: number; tp5Count: number; slCount: number;
  tp1Pct: number; tp2Pct: number; tp3Pct: number; tp4Pct: number; tp5Pct: number; slPct: number;
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
  minOpportunityScore: number;
  maxEmaGapAtr: number;
  zoneRetentionMin: number;
}

export interface LiquidityStrategySettings {
  lookbackBars: number;
  profileBins: number;
  setupExpiryBars: number;
  sweepMinAtr: number;
  retestToleranceAtr: number;
  stopBufferAtr: number;
  maxStopAtr: number;
}

export interface BacktestTrade {
  side: 'LONG' | 'SHORT';
  entryTime: number;
  exitTime: number | null;
  entryPrice: number;
  exitPrice: number | null;
  initialStop: number;
  pocPrice: number;
  sweptLevel: number;
  sweepTime: number;
  barsHeld: number;
  tpHits: number[];
  closeReason: string | null;
  status: 'CLOSED' | 'OPEN';
  grossPnl: number;
  fees: number;
  netPnl: number;
  initialRiskCash: number;
  rMultiple: number;
}

export interface BacktestResult {
  symbol: string;
  interval: '5m';
  dataSource: string;
  startTime: number | null;
  endTime: number | null;
  candles: number;
  startingBalance: number;
  endingEquity: number;
  netPnl: number;
  returnPct: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  averageR: number;
  expectancyR: number;
  profitFactor: number | null;
  maxDrawdown: number;
  maxDrawdownPct: number;
  fees: number;
  stopExits: number;
  tpHitCounts: { tp1: number; tp2: number; tp3: number; tp4: number; tp5: number };
  openPosition: BacktestTrade | null;
  trades: BacktestTrade[];
  assumptions: string[];
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
  strategy: LiquidityStrategySettings;
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

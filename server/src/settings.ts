import fs from 'fs';
import path from 'path';

/**
 * Order-execution environment. Testnet targets Binance Demo and live targets
 * mainnet; the separate historical backtester never submits orders.
 */
export type Mode = 'testnet' | 'live';

export interface ApiKeys {
  key: string;
  secret: string;
}

/** Scanner thresholds select active liquid markets for monitoring; strategy signals remain direction-agnostic. */
export interface ScannerSettings {
  /** Scan the whole USD-M universe and drive the engine (auto symbol selection). */
  enabled: boolean;
  /** Seconds between full scans (weights are budgeted by ratelimit.ts). */
  intervalSec: number;
  /** How many 24h leaders get full multi-timeframe analysis each scan. */
  candidates: number;
  /** Minimum 24h quote volume (USDT) — liquidity gate. */
  minQuoteVolume24h: number;
  /** Minimum 24h high-low range (% of price) — volatility gate. */
  minRange24hPct: number;
  /** Minimum ATR(14) on 15m (% of price) — volatility gate. */
  minAtrPct: number;
  /** Legacy diagnostic only; not used to gate monitoring or entries. */
  minAdx: number;
  /** Maximum high-quality opportunity zones monitored by the 5m signal engine. */
  topN: number;
  /** Legacy ranking threshold retained for settings migration; not an entry gate. */
  minOpportunityScore: number;
  /** Legacy indicator threshold retained for settings migration; not used by the liquidity strategy. */
  maxEmaGapAtr: number;
  /** Keep a qualified zone under dedicated monitoring for this many minutes. */
  zoneRetentionMin: number;
}

export interface LiquidityStrategySettings {
  /** Prior closed 5m candles used for both the sweep and volume profile. */
  lookbackBars: number;
  /** Price bins for the OHLCV-estimated fixed-range volume profile. */
  profileBins: number;
  /** Pending setup expires this many bars after its sweep. */
  setupExpiryBars: number;
  /** Minimum excursion beyond the prior high/low, in ATR units. */
  sweepMinAtr: number;
  /** Maximum distance from POC considered a retest, in ATR units. */
  retestToleranceAtr: number;
  /** Stop buffer beyond the sweep wick, in ATR units. */
  stopBufferAtr: number;
  /** Skip a retest if sweep-extreme risk is wider than this many ATRs. */
  maxStopAtr: number;
}

export interface Settings {
  mode: Mode;
  autoTrade: boolean;
  /** Primary symbol (chart + manual mode). In auto-scan the engine follows the scanner. */
  symbol: string;
  interval: '5m';
  /** % of balance used as margin for each trade (your spec: 5%) */
  tradeSizePercent: number;
  /** Leverage (your spec: 10x) */
  leverage: number;
  /** Max simultaneous bot positions — hard cap 8 (your spec). */
  maxPositions: number;
  /** Use scanner-selected liquid symbols as the two-sided strategy's watch set. */
  autoScan: boolean;

  scanner: ScannerSettings;
  strategy: LiquidityStrategySettings;

  // ---- legacy indicator display settings (not used to create trade signals) ----
  emaLengths: number[]; // [5,11,15,18,21,24,28,34]
  emaExtraLength: number; // 200
  atrLength: number; // 14
  atrSlMultiplier: number; // 2
  tpRrFactor: number; // legacy three-target formula for compatibility-only signals

  // ---- legacy scale-out settings (used only by compatibility signals) ----
  /** Legacy TP1 percentage; new liquidity trades use fixed ~20% tranches. */
  tp1ClosePct: number;
  /** Legacy TP2 percentage; new liquidity trades use fixed ~20% tranches. */
  tp2ClosePct: number;

  // ---- UI / analytics ----
  historyDays: number; // rolling stats window (indicator default 7)
  dashboardTimeframes: string[]; // ['5','15','30']

  keys: { testnet: ApiKeys; live: ApiKeys };
}

/** Hard cap on simultaneous positions — the bot never manages more. */
export const MAX_POSITIONS_CAP = 8;

export const DEFAULT_SETTINGS: Settings = {
  mode: 'live',
  autoTrade: false,
  symbol: 'BTCUSDT',
  interval: '5m',
  tradeSizePercent: 5,
  leverage: 10,
  maxPositions: MAX_POSITIONS_CAP,
  autoScan: true,

  scanner: {
    enabled: true,
    intervalSec: 60,
    // Analyse fifty markets on every cycle. Opportunity zones are retained and
    // monitored separately, so they never stop the scanner moving on to the
    // rest of the batch.
    candidates: 50,
    minQuoteVolume24h: 20_000_000,
    minRange24hPct: 3,
    minAtrPct: 0.6,
    minAdx: 18, // retained for settings migration; no longer an entry gate
    topN: 16,
    minOpportunityScore: 65, // retained for settings migration; no longer an entry gate
    maxEmaGapAtr: 0.45, // retained for settings migration; no longer an entry gate
    zoneRetentionMin: 30,
  },

  strategy: {
    lookbackBars: 30,
    profileBins: 24,
    setupExpiryBars: 24,
    sweepMinAtr: 0.05,
    retestToleranceAtr: 0.2,
    stopBufferAtr: 0.1,
    maxStopAtr: 6,
  },

  emaLengths: [5, 11, 15, 18, 21, 24, 28, 34],
  emaExtraLength: 200,
  atrLength: 14,
  atrSlMultiplier: 2,
  tpRrFactor: 1.5,

  tp1ClosePct: 33,
  tp2ClosePct: 50,

  historyDays: 7,
  dashboardTimeframes: ['5', '15', '30'],

  keys: { testnet: { key: '', secret: '' }, live: { key: '', secret: '' } },
};

/**
 * Where trades/signals/settings live. Overridable so tests can run on a clean
 * sandbox without touching the operator's live journal.
 */
export const DATA_DIR = process.env.VX_DATA_DIR
  ? path.resolve(process.env.VX_DATA_DIR)
  : path.resolve(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let current: Settings = { ...DEFAULT_SETTINGS };

function envKeys(): Partial<Settings> {
  const patch: any = {};
  patch.keys = {
    testnet: {
      key: process.env.BINANCE_TESTNET_KEY || '',
      secret: process.env.BINANCE_TESTNET_SECRET || '',
    },
    live: {
      key: process.env.BINANCE_LIVE_KEY || '',
      secret: process.env.BINANCE_LIVE_SECRET || '',
    },
  };
  if (process.env.BINANCE_MODE) {
    const m = process.env.BINANCE_MODE;
    if (m === 'testnet' || m === 'live') patch.mode = m;
    else if (m === 'paper') {
      console.warn('[settings] BINANCE_MODE=paper was removed — order execution uses Binance Demo or LIVE; use the separate historical backtest for no-orders simulation');
    }
  }
  if (process.env.BINANCE_SYMBOL) patch.symbol = process.env.BINANCE_SYMBOL;
  return patch;
}

function deepMerge<T>(base: T, patch: any): T {
  const out: any = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(patch || {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue; // never merge into the prototype chain
    const v = patch[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v) && typeof (base as any)[k] === 'object' && (base as any)[k] !== null && !Array.isArray((base as any)[k])) {
      out[k] = deepMerge((base as any)[k], v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function loadSettings(): Settings {
  ensureDir();
  let fileSettings: any = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) fileSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch { /* corrupted -> defaults */ }
  // An empty key in the file (saved before the key was provisioned) must never
  // wipe a key the operator supplied through the environment.
  for (const env of ['testnet', 'live'] as const) {
    const k = fileSettings?.keys?.[env];
    if (k && typeof k === 'object') {
      if (!k.key) delete k.key;
      if (!k.secret) delete k.secret;
    }
  }
  current = sanitize(deepMerge(deepMerge(DEFAULT_SETTINGS, envKeys()), fileSettings));
  return current;
}

function sanitize(s: Settings): Settings {
  // Request-only confirmation flags must never become durable settings. If one
  // were echoed back by a client, it could otherwise weaken the next LIVE-arm
  // confirmation check.
  delete (s as any).confirmLive;
  s.tradeSizePercent = clamp(num(s.tradeSizePercent, 5), 0.5, 100);
  s.leverage = Math.round(clamp(num(s.leverage, 10), 1, 125));
  s.maxPositions = Math.round(clamp(num(s.maxPositions, MAX_POSITIONS_CAP), 1, MAX_POSITIONS_CAP));
  s.autoScan = s.autoScan !== false;
  // Strictly boolean: a string such as "false" is truthy and would arm the bot.
  s.autoTrade = s.autoTrade === true;
  s.atrLength = Math.round(clamp(num(s.atrLength, 14), 1, 500));
  s.atrSlMultiplier = clamp(num(s.atrSlMultiplier, 2), 0.1, 100);
  s.tpRrFactor = clamp(num(s.tpRrFactor, 1.5), 0.1, 100);
  s.historyDays = Math.round(clamp(num(s.historyDays, 7), 1, 365));
  if (!Array.isArray(s.emaLengths)) s.emaLengths = [...DEFAULT_SETTINGS.emaLengths];

  const sc = (s.scanner = { ...DEFAULT_SETTINGS.scanner, ...(s.scanner || {}) });
  sc.intervalSec = Math.round(clamp(num(sc.intervalSec, 60), 30, 600));
  sc.candidates = Math.round(clamp(num(sc.candidates, 50), 10, 80));
  sc.minQuoteVolume24h = clamp(num(sc.minQuoteVolume24h, 20_000_000), 0, 1e12);
  sc.minRange24hPct = clamp(num(sc.minRange24hPct, 3), 0, 100);
  sc.minAtrPct = clamp(num(sc.minAtrPct, 0.6), 0, 50);
  sc.minAdx = clamp(num(sc.minAdx, 18), 0, 100);
  sc.topN = Math.round(clamp(num(sc.topN, 16), 1, 24));
  sc.minOpportunityScore = clamp(num(sc.minOpportunityScore, 65), 0, 100);
  sc.maxEmaGapAtr = clamp(num(sc.maxEmaGapAtr, 0.45), 0.05, 3);
  sc.zoneRetentionMin = Math.round(clamp(num(sc.zoneRetentionMin, 30), 5, 240));
  sc.enabled = sc.enabled !== false;

  const strategy = (s.strategy = { ...DEFAULT_SETTINGS.strategy, ...(s.strategy || {}) });
  strategy.lookbackBars = Math.round(clamp(num(strategy.lookbackBars, 30), 10, 250));
  strategy.profileBins = Math.round(clamp(num(strategy.profileBins, 24), 8, 100));
  strategy.setupExpiryBars = Math.round(clamp(num(strategy.setupExpiryBars, 24), 1, 288));
  strategy.sweepMinAtr = clamp(num(strategy.sweepMinAtr, 0.05), 0, 2);
  strategy.retestToleranceAtr = clamp(num(strategy.retestToleranceAtr, 0.2), 0, 2);
  strategy.stopBufferAtr = clamp(num(strategy.stopBufferAtr, 0.1), 0, 2);
  strategy.maxStopAtr = clamp(num(strategy.maxStopAtr, 6), 0.1, 30);

  // Simulation was removed as a trading mode: paper configs from env/file/API migrate
  // to LIVE. Historical backtesting is a separate, isolated, no-orders feature.
  // LIVE. Order placement still requires an explicit arming step, so a legacy
  // paper setting can never start trading by itself.
  if (!['testnet', 'live'].includes(s.mode)) {
    if (s.mode !== undefined && s.mode !== null && s.mode !== 'live') {
      console.warn(`[settings] mode "${s.mode}" is not supported — falling back to LIVE (auto-trading stays off until armed)`);
    }
    s.mode = 'live';
  }

  // ---- connection / identity ------------------------------------------------
  s.symbol = String(s.symbol || DEFAULT_SETTINGS.symbol).toUpperCase().trim();
  if (!/^[A-Z0-9]{4,24}$/.test(s.symbol)) s.symbol = DEFAULT_SETTINGS.symbol;
  s.interval = '5m';
  s.emaExtraLength = Math.round(clamp(num(s.emaExtraLength, 200), 1, 1000));
  s.dashboardTimeframes = Array.isArray(s.dashboardTimeframes) && s.dashboardTimeframes.length
    ? s.dashboardTimeframes.filter((t) => ['5', '15', '30', '60', '240', 'D'].includes(t)).slice(0, 6)
    : [...DEFAULT_SETTINGS.dashboardTimeframes];
  if (!s.dashboardTimeframes.length) s.dashboardTimeframes = [...DEFAULT_SETTINGS.dashboardTimeframes];
  s.tp1ClosePct = clamp(num(s.tp1ClosePct, 33), 1, 90);
  s.tp2ClosePct = clamp(num(s.tp2ClosePct, 50), 1, 90);
  s.emaLengths = (Array.isArray(s.emaLengths) ? s.emaLengths : [])
    .map((x) => Math.round(Number(x)))
    .filter((x) => Number.isFinite(x) && x > 0 && x <= 1000)
    .slice(0, 12);
  if (s.emaLengths.length < 8 || !s.emaLengths.includes(11) || !s.emaLengths.includes(34)) {
    s.emaLengths = [...DEFAULT_SETTINGS.emaLengths];
  }

  // ---- exchange keys: opaque strings only ----------------------------------
  for (const env of ['testnet', 'live'] as const) {
    const k = s.keys?.[env];
    s.keys[env] = {
      key: typeof k?.key === 'string' ? k.key.trim() : '',
      secret: typeof k?.secret === 'string' ? k.secret.trim() : '',
    };
  }
  return s;
}

function num(v: any, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: any): Settings {
  // Masked secrets from the UI must not overwrite real keys.
  if (patch && patch.keys) {
    for (const env of ['testnet', 'live'] as const) {
      const k = patch.keys?.[env];
      if (k) {
        if (typeof k.key === 'string' && k.key.includes('••••')) delete k.key;
        if (typeof k.secret === 'string' && k.secret.includes('••••')) delete k.secret;
        if (Object.keys(k).length === 0) delete patch.keys[env];
      }
    }
  }
  // Legacy keys from removed features are ignored if a stale client sends them.
  delete patch.paperBalance;
  delete patch.feeRate;
  delete patch.screenerSymbols;
  delete patch.confirmLive; // one-request proof, never a persistent capability
  current = sanitize(deepMerge(current, patch));
  persistSettings();
  return current;
}

export function persistSettings(): void {
  ensureDir();
  const tmp = SETTINGS_FILE + '.tmp';
  // Keys that came from the environment stay in the environment: copying them
  // into the file would freeze a stale copy that silently outlives a key
  // rotation in .env. Only keys typed into the dashboard are persisted.
  const toWrite: any = JSON.parse(JSON.stringify(current));
  const fromEnv: any = envKeys().keys;
  for (const env of ['testnet', 'live'] as const) {
    if (fromEnv[env].key && toWrite.keys[env].key === fromEnv[env].key) toWrite.keys[env].key = '';
    if (fromEnv[env].secret && toWrite.keys[env].secret === fromEnv[env].secret) toWrite.keys[env].secret = '';
  }
  // 0600: this file holds exchange API secrets — never world-readable.
  fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_FILE);
  try {
    fs.chmodSync(SETTINGS_FILE, 0o600);
  } catch { /* best effort (non-POSIX filesystems) */ }
}

/** Settings with secrets masked — safe to send to the browser. */
export function publicSettings(): any {
  const s: any = { ...current };
  s.keys = {
    testnet: {
      key: mask(s.keys.testnet.key),
      secret: s.keys.testnet.secret ? '••••••••' : '',
      configured: !!(s.keys.testnet.key && s.keys.testnet.secret),
    },
    live: {
      key: mask(s.keys.live.key),
      secret: s.keys.live.secret ? '••••••••' : '',
      configured: !!(s.keys.live.key && s.keys.live.secret),
    },
  };
  return s;
}

function mask(v: string): string {
  if (!v) return '';
  if (v.length <= 8) return '••••••••';
  return v.slice(0, 4) + '••••••••' + v.slice(-4);
}

export function dataPath(name: string): string {
  ensureDir();
  return path.join(DATA_DIR, name);
}

import fs from 'fs';
import path from 'path';

/** Trading mode. Paper uses live Binance market data with simulated fills. */
export type Mode = 'paper' | 'testnet' | 'live';

export interface ApiKeys {
  key: string;
  secret: string;
}

/** Market-scanner gate: only high-volatility *trending* markets are traded. */
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
  /** Minimum ADX(14) on 15m — "trending, not chop" gate. */
  minAdx: number;
  /** Max symbols handed to the engine/executor (hard-capped by maxPositions). */
  topN: number;
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
  /** Follow the scanner's top high-volatility trending markets. */
  autoScan: boolean;
  /** Taker fee rate used *only* for paper-mode simulation (live fees come from Binance). */
  feeRate: number;

  scanner: ScannerSettings;

  // ---- SUPER INDIBOT indicator parameters (defaults preserved) ----
  emaLengths: number[]; // [5,11,15,18,21,24,28,34]
  emaExtraLength: number; // 200
  atrLength: number; // 14
  atrSlMultiplier: number; // 2
  tpRrFactor: number; // 1.5  (TP1 = 1.5R, TP2 = 3R, TP3 = 4.5R)

  // ---- scale-out ladder (your spec) ----
  /** TP1 closes 33% of position, SL -> breakeven */
  tp1ClosePct: number; // 33
  /** TP2 closes 50% of REMAINING, SL -> TP1 */
  tp2ClosePct: number; // 50

  // ---- UI / analytics ----
  historyDays: number; // rolling stats window (indicator default 7)
  dashboardTimeframes: string[]; // ['5','15','30']

  keys: { testnet: ApiKeys; live: ApiKeys };
}

/** Paper mode starts from this fixed, non-editable virtual balance (no manual input). */
export const PAPER_START_BALANCE = 1000;
/** Hard cap on simultaneous positions — the bot never manages more. */
export const MAX_POSITIONS_CAP = 8;

export const DEFAULT_SETTINGS: Settings = {
  mode: 'paper',
  autoTrade: false,
  symbol: 'BTCUSDT',
  interval: '5m',
  tradeSizePercent: 5,
  leverage: 10,
  maxPositions: MAX_POSITIONS_CAP,
  autoScan: true,
  feeRate: 0.0005,

  scanner: {
    enabled: true,
    intervalSec: 60,
    candidates: 30,
    minQuoteVolume24h: 20_000_000,
    minRange24hPct: 3,
    minAtrPct: 0.6,
    minAdx: 18,
    topN: MAX_POSITIONS_CAP,
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
    if (m === 'paper' || m === 'testnet' || m === 'live') patch.mode = m;
  }
  if (process.env.BINANCE_SYMBOL) patch.symbol = process.env.BINANCE_SYMBOL;
  return patch;
}

function deepMerge<T>(base: T, patch: any): T {
  const out: any = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(patch || {})) {
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
  current = sanitize(deepMerge(deepMerge(DEFAULT_SETTINGS, envKeys()), fileSettings));
  return current;
}

function sanitize(s: Settings): Settings {
  s.tradeSizePercent = clamp(num(s.tradeSizePercent, 5), 0.5, 100);
  s.leverage = Math.round(clamp(num(s.leverage, 10), 1, 125));
  s.maxPositions = Math.round(clamp(num(s.maxPositions, MAX_POSITIONS_CAP), 1, MAX_POSITIONS_CAP));
  s.autoScan = s.autoScan !== false;
  s.atrLength = Math.round(clamp(num(s.atrLength, 14), 1, 500));
  s.atrSlMultiplier = clamp(num(s.atrSlMultiplier, 2), 0.1, 100);
  s.tpRrFactor = clamp(num(s.tpRrFactor, 1.5), 0.1, 100);
  s.historyDays = Math.round(clamp(num(s.historyDays, 7), 1, 365));
  s.feeRate = clamp(num(s.feeRate, 0.0005), 0, 0.01);
  if (!Array.isArray(s.emaLengths) || s.emaLengths.length < 2) s.emaLengths = [...DEFAULT_SETTINGS.emaLengths];

  const sc = (s.scanner = { ...DEFAULT_SETTINGS.scanner, ...(s.scanner || {}) });
  sc.intervalSec = Math.round(clamp(num(sc.intervalSec, 60), 15, 600));
  sc.candidates = Math.round(clamp(num(sc.candidates, 30), 8, 80));
  sc.minQuoteVolume24h = clamp(num(sc.minQuoteVolume24h, 20_000_000), 0, 1e12);
  sc.minRange24hPct = clamp(num(sc.minRange24hPct, 3), 0, 100);
  sc.minAtrPct = clamp(num(sc.minAtrPct, 0.6), 0, 50);
  sc.minAdx = clamp(num(sc.minAdx, 18), 0, 100);
  sc.topN = Math.round(clamp(num(sc.topN, MAX_POSITIONS_CAP), 1, MAX_POSITIONS_CAP));
  sc.enabled = sc.enabled !== false;

  if (!['paper', 'testnet', 'live'].includes(s.mode)) s.mode = 'paper';

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
  if (s.emaLengths.length < 2) s.emaLengths = [...DEFAULT_SETTINGS.emaLengths];

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
  // Manual asset input was removed — any legacy patch trying to set it is ignored.
  delete patch.paperBalance;
  delete patch.screenerSymbols;
  current = sanitize(deepMerge(current, patch));
  persistSettings();
  return current;
}

export function persistSettings(): void {
  ensureDir();
  const tmp = SETTINGS_FILE + '.tmp';
  // 0600: this file holds exchange API secrets — never world-readable.
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
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

import fs from 'fs';
import path from 'path';

/** Trading mode. Paper uses live Binance prices with simulated fills. */
export type Mode = 'paper' | 'testnet' | 'live';

export interface ApiKeys {
  key: string;
  secret: string;
}

export interface Settings {
  mode: Mode;
  autoTrade: boolean;
  symbol: string;
  interval: '5m';
  /** % of wallet balance used as margin for each trade (your spec: 5%) */
  tradeSizePercent: number;
  /** Leverage (your spec: 10x) */
  leverage: number;
  /** Paper simulation starting balance (USDT) */
  paperBalance: number;
  /** Taker fee rate used for paper fill simulation & stats (0.05%) */
  feeRate: number;

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
  /** TP3 closes the rest (full profit) */

  // ---- UI / analytics ----
  historyDays: number; // rolling stats window (indicator default 7)
  screenerSymbols: string[];
  dashboardTimeframes: string[]; // ['5','15','30']

  keys: { testnet: ApiKeys; live: ApiKeys };
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'paper',
  autoTrade: false,
  symbol: 'BTCUSDT',
  interval: '5m',
  tradeSizePercent: 5,
  leverage: 10,
  paperBalance: 1000,
  feeRate: 0.0005,

  emaLengths: [5, 11, 15, 18, 21, 24, 28, 34],
  emaExtraLength: 200,
  atrLength: 14,
  atrSlMultiplier: 2,
  tpRrFactor: 1.5,

  tp1ClosePct: 33,
  tp2ClosePct: 50,

  historyDays: 7,
  screenerSymbols: [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT',
  ],
  dashboardTimeframes: ['5', '15', '30'],

  keys: { testnet: { key: '', secret: '' }, live: { key: '', secret: '' } },
};

export const DATA_DIR = path.resolve(__dirname, '..', 'data');
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
  s.atrLength = Math.round(clamp(num(s.atrLength, 14), 1, 500));
  s.atrSlMultiplier = clamp(num(s.atrSlMultiplier, 2), 0.1, 100);
  s.tpRrFactor = clamp(num(s.tpRrFactor, 1.5), 0.1, 100);
  s.historyDays = Math.round(clamp(num(s.historyDays, 7), 1, 365));
  s.tradeSizePercent = clamp(num(s.tradeSizePercent, 5), 0.5, 100);
  if (!Array.isArray(s.emaLengths) || s.emaLengths.length < 2) s.emaLengths = [...DEFAULT_SETTINGS.emaLengths];
  if (!Array.isArray(s.screenerSymbols)) s.screenerSymbols = [...DEFAULT_SETTINGS.screenerSymbols];
  if (!['paper', 'testnet', 'live'].includes(s.mode)) s.mode = 'paper';
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
        // masked values are echoed back by the UI — never overwrite stored secrets with them
        if (typeof k.key === 'string' && k.key.includes('••••')) delete k.key;
        if (typeof k.secret === 'string' && k.secret.includes('••••')) delete k.secret;
        if (Object.keys(k).length === 0) delete patch.keys[env];
      }
    }
  }
  current = sanitize(deepMerge(current, patch));
  persistSettings();
  return current;
}

export function persistSettings(): void {
  ensureDir();
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
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

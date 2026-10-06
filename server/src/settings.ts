/**
 * Runtime settings for the strategy-free VelocityX baseline.
 *
 * Only exchange connection, the display symbol and income-history range remain.
 * All strategy, indicator, scanner, sizing, target and execution settings were removed.
 */
import fs from 'fs';
import path from 'path';

export type Mode = 'testnet' | 'live';

export interface ApiKeys {
  key: string;
  secret: string;
}

export interface Settings {
  mode: Mode;
  /** Symbol used for the live market-data view and candle cache. */
  symbol: string;
  interval: '5m';
  historyDays: number;
  keys: { testnet: ApiKeys; live: ApiKeys };
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'testnet',
  symbol: 'BTCUSDT',
  interval: '5m',
  historyDays: 7,
  keys: { testnet: { key: '', secret: '' }, live: { key: '', secret: '' } },
};

/**
 * Where the operator's settings and trade journal live. Tests can point this at
 * a private temporary directory instead of touching an installed instance.
 */
export const DATA_DIR = process.env.VX_DATA_DIR
  ? path.resolve(process.env.VX_DATA_DIR)
  : path.resolve(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let current: Settings = { ...DEFAULT_SETTINGS };

function envSettings(): Partial<Settings> {
  const patch: any = {
    keys: {
      testnet: {
        key: process.env.BINANCE_TESTNET_KEY || '',
        secret: process.env.BINANCE_TESTNET_SECRET || '',
      },
      live: {
        key: process.env.BINANCE_LIVE_KEY || '',
        secret: process.env.BINANCE_LIVE_SECRET || '',
      },
    },
  };
  if (process.env.BINANCE_MODE === 'testnet' || process.env.BINANCE_MODE === 'live') {
    patch.mode = process.env.BINANCE_MODE;
  } else if (process.env.BINANCE_MODE === 'paper') {
    console.warn('[settings] BINANCE_MODE=paper is unsupported; use Binance Demo or LIVE for account data');
  }
  if (process.env.BINANCE_SYMBOL) patch.symbol = process.env.BINANCE_SYMBOL;
  return patch;
}

function deepMerge<T>(base: T, patch: any): T {
  const out: any = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(patch || {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const value = patch[k];
    if (value === undefined || value === null) continue;
    if (
      typeof value === 'object' && !Array.isArray(value) &&
      typeof (base as any)[k] === 'object' && (base as any)[k] !== null && !Array.isArray((base as any)[k])
    ) {
      out[k] = deepMerge((base as any)[k], value);
    } else {
      out[k] = value;
    }
  }
  return out as T;
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Canonicalize to the small strategy-free contract. The explicit object shape
 * also strips old persisted strategy, scanner and execution-policy keys.
 */
function sanitize(raw: any): Settings {
  const mode: Mode = raw?.mode === 'live' ? 'live' : 'testnet';
  const symbol = String(raw?.symbol || DEFAULT_SETTINGS.symbol).toUpperCase().trim();
  const historyDays = Math.round(Math.min(365, Math.max(1, numberOr(raw?.historyDays, DEFAULT_SETTINGS.historyDays))));
  const cleanKey = (env: 'testnet' | 'live'): ApiKeys => {
    const value = raw?.keys?.[env] || {};
    return {
      key: typeof value.key === 'string' ? value.key.trim() : '',
      secret: typeof value.secret === 'string' ? value.secret.trim() : '',
    };
  };
  return {
    mode,
    symbol: /^[A-Z0-9]{4,24}$/.test(symbol) ? symbol : DEFAULT_SETTINGS.symbol,
    interval: '5m',
    historyDays,
    keys: { testnet: cleanKey('testnet'), live: cleanKey('live') },
  };
}

export function loadSettings(): Settings {
  ensureDir();
  let fileSettings: any = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) fileSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    fileSettings = {};
  }

  // A blank value in an old settings file must never erase a key from env.
  const environment = envSettings() as any;
  for (const env of ['testnet', 'live'] as const) {
    const fileKey = fileSettings?.keys?.[env];
    if (fileKey && typeof fileKey === 'object') {
      if (!fileKey.key && environment.keys[env].key) fileKey.key = environment.keys[env].key;
      if (!fileKey.secret && environment.keys[env].secret) fileKey.secret = environment.keys[env].secret;
    }
  }
  current = sanitize(deepMerge(deepMerge(DEFAULT_SETTINGS, environment), fileSettings));

  // Persist the canonical shape on migration. This removes obsolete strategy
  // knobs from the operator's settings file without deleting trade history.
  try { persistSettings(); } catch (e: any) {
    console.warn(`[settings] could not persist migrated settings: ${e?.message || e}`);
  }
  return current;
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: any): Settings {
  const safePatch = patch && typeof patch === 'object' ? { ...patch } : {};
  delete safePatch.confirmLive;

  // Masked secrets from the browser must not overwrite real credentials.
  if (safePatch.keys && typeof safePatch.keys === 'object') {
    safePatch.keys = { ...safePatch.keys };
    for (const env of ['testnet', 'live'] as const) {
      const supplied = safePatch.keys[env];
      if (!supplied || typeof supplied !== 'object') continue;
      const clean = { ...supplied };
      if (typeof clean.key === 'string' && clean.key.includes('••••')) delete clean.key;
      if (typeof clean.secret === 'string' && clean.secret.includes('••••')) delete clean.secret;
      if (!Object.keys(clean).length) delete safePatch.keys[env];
      else safePatch.keys[env] = clean;
    }
  }

  current = sanitize(deepMerge(current, safePatch));
  persistSettings();
  return current;
}

export function persistSettings(): void {
  ensureDir();
  const tmp = SETTINGS_FILE + '.tmp';
  const toWrite: any = JSON.parse(JSON.stringify(current));
  const fromEnv: any = envSettings().keys;
  for (const env of ['testnet', 'live'] as const) {
    if (fromEnv[env].key && toWrite.keys[env].key === fromEnv[env].key) toWrite.keys[env].key = '';
    if (fromEnv[env].secret && toWrite.keys[env].secret === fromEnv[env].secret) toWrite.keys[env].secret = '';
  }
  fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_FILE);
  try { fs.chmodSync(SETTINGS_FILE, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
}

/** Settings with secrets masked — safe to send to the browser. */
export function publicSettings(): Settings & { keys: { testnet: ApiKeys & { configured: boolean }; live: ApiKeys & { configured: boolean } } } {
  const mask = (value: string) => !value ? '' : value.length <= 8 ? '••••••••' : `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
  return {
    ...current,
    keys: {
      testnet: {
        key: mask(current.keys.testnet.key),
        secret: current.keys.testnet.secret ? '••••••••' : '',
        configured: !!(current.keys.testnet.key && current.keys.testnet.secret),
      },
      live: {
        key: mask(current.keys.live.key),
        secret: current.keys.live.secret ? '••••••••' : '',
        configured: !!(current.keys.live.key && current.keys.live.secret),
      },
    },
  };
}

export function dataPath(name: string): string {
  ensureDir();
  return path.join(DATA_DIR, name);
}

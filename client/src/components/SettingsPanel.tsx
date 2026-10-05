import { useEffect, useState } from 'react';
import { Settings } from '../types';
import { apiPost, getApiToken, setApiToken } from '../api';
import { Btn, Panel, Segmented } from '../motion/primitives';
import { IconAlert, IconCheck, IconChart, IconCoins, IconRadar, IconSettings, IconTrend } from '../motion/Icons';

/** Deep clone that also works on browsers/patchy webviews without structuredClone. */
function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through to JSON */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

interface Props {
  settings: Settings | null;
  onSaved: (s: Settings) => void;
  onError: (msg: string) => void;
}

type Tab = 'conn' | 'trade' | 'scanner' | 'ind';

const TABS: { value: Tab; label: string; icon: React.ReactNode }[] = [
  { value: 'conn', label: 'Connection', icon: <IconSettings /> },
  { value: 'trade', label: 'Trading', icon: <IconCoins /> },
  { value: 'scanner', label: 'Scanner', icon: <IconRadar /> },
  { value: 'ind', label: 'Indicator', icon: <IconTrend /> },
];

export default function SettingsPanel({ settings, onSaved, onError }: Props) {
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('trade');
  // API access token lives in localStorage only — it is never part of the
  // traded settings document and never leaves this origin.
  const [token, setToken] = useState(() => getApiToken());
  const [tokenSaved, setTokenSaved] = useState(false);
  const [liveConfirmed, setLiveConfirmed] = useState(false);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);

  useEffect(() => {
    if (settings) setDraft(clone(settings));
  }, [settings]);

  if (!draft) return <div className="empty">Loading settings…</div>;

  const set = (patch: Partial<Settings>) => setDraft({ ...(draft as Settings), ...patch });
  const setKey = (env: 'testnet' | 'live', field: 'key' | 'secret', v: string) =>
    set({ keys: { ...draft.keys, [env]: { ...draft.keys[env], [field]: v } } });

  const save = async () => {
    setSaving(true);
    try {
      // Arming LIVE (real money) is a two-step action: an explicit confirmation
      // here, echoed to the server as confirmLive so a stray POST cannot do it.
      const armingLive = draft.mode === 'live' && settings?.mode !== 'live';
      if (armingLive && !liveConfirmed) {
        const ok = window.confirm(
          'Switch to LIVE mainnet?\n\nReal orders will be placed on your Binance account when auto-trading is on. Test on paper and testnet first.',
        );
        if (!ok) {
          setSaving(false);
          return;
        }
        setLiveConfirmed(true);
      }
      const saved = await apiPost<Settings>('/settings', { ...draft, confirmLive: armingLive });
      onSaved(saved);
      setLiveConfirmed(false);
      // The server always lands LIVE disarmed; say so instead of leaving the
      // user wondering why the auto-trade switch flipped back off.
      setLiveNotice(
        armingLive && saved.mode === 'live'
          ? 'LIVE armed — auto-trading is OFF. Switch it on from the header when you are ready to execute.'
          : null,
      );
      setSavedAt(Date.now());
    } catch (e: any) {
      onError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const saveToken = () => {
    setApiToken(token.trim());
    setTokenSaved(true);
    window.setTimeout(() => setTokenSaved(false), 4000);
  };

  const justSaved = savedAt != null && Date.now() - savedAt < 4000;

  return (
    <Panel
      title="Settings"
      sub={draft.mode}
      icon={<IconChart />}
      meta={draft.autoTrade ? 'auto-trade on' : 'auto-trade off'}
    >
      <Segmented value={tab} onChange={setTab} items={TABS} ariaLabel="Settings sections" />

      {tab === 'conn' && (
        <>
          <div className="settings-sec">
            <h4>Execution environment</h4>
            <div className="frow one">
              <label className="field">
                <span className="field-label">Mode</span>
                <select
                  className="select"
                  value={draft.mode}
                  onChange={(e) => {
                    const next = e.target.value as Settings['mode'];
                    if (next === 'live' && !window.confirm('Select LIVE mainnet? Real funds are at risk. Confirm to continue.')) return;
                    set({ mode: next });
                  }}
                >
                  <option value="paper">Paper — simulate fills on live prices (safe)</option>
                  <option value="testnet">Binance Futures Testnet — real test orders</option>
                  <option value="live">🔴 LIVE Mainnet — real money</option>
                </select>
              </label>
            </div>
            <div className="hint">
              Free testnet keys: <b>testnet.binancefuture.com</b> → API Management. Live keys: Binance → Account → API
              Management (enable Futures, restrict by IP).
            </div>
          </div>

          <div className="settings-sec">
            <h4>Testnet API keys</h4>
            <div className="frow">
              <label className="field">
                <span className="field-label">API key</span>
                <input
                  className="input"
                  type="password"
                  placeholder={draft.keys.testnet.configured ? '(saved — leave blank to keep)' : 'testnet API key'}
                  value={draft.keys.testnet.key}
                  onChange={(e) => setKey('testnet', 'key', e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Secret</span>
                <input
                  className="input"
                  type="password"
                  placeholder={draft.keys.testnet.configured ? '(saved)' : 'secret'}
                  value={draft.keys.testnet.secret}
                  onChange={(e) => setKey('testnet', 'secret', e.target.value)}
                />
              </label>
            </div>
            {draft.keys.testnet.configured && (
              <div className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <IconCheck style={{ width: 13, height: 13, color: 'var(--green)' }} /> keys configured (masked)
              </div>
            )}
          </div>

          <div className="settings-sec">
            <h4>Dashboard API access</h4>
            <div className="frow one">
              <label className="field">
                <span className="field-label">API token (server VX_API_TOKEN)</span>
                <input
                  className="input"
                  type="password"
                  placeholder="leave empty when the server has no token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
            </div>
            <div className="row mt" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Btn size="sm" onClick={saveToken}>
                {tokenSaved ? 'Token saved — reconnecting' : 'Save token'}
              </Btn>
              <span className="hint">
                Stored only in this browser. Set <span className="mono">VX_API_TOKEN</span> on the server to require it for
                every API call, the WebSocket and the kill switch.
              </span>
            </div>
          </div>

          <div className="settings-sec">
            <h4>🔴 Live mainnet keys</h4>
            <div className="frow">
              <label className="field">
                <span className="field-label">API key</span>
                <input
                  className="input"
                  type="password"
                  placeholder={draft.keys.live.configured ? '(saved — leave blank to keep)' : 'live API key'}
                  value={draft.keys.live.key}
                  onChange={(e) => setKey('live', 'key', e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Secret</span>
                <input
                  className="input"
                  type="password"
                  placeholder={draft.keys.live.configured ? '(saved)' : 'secret'}
                  value={draft.keys.live.secret}
                  onChange={(e) => setKey('live', 'secret', e.target.value)}
                />
              </label>
            </div>
            <div className="hint warn" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <IconAlert style={{ width: 13, height: 13 }} /> Live mode places real orders with real funds — test on
              paper &amp; testnet first.
            </div>
          </div>
        </>
      )}

      {tab === 'trade' && (
        <>
          <div className="settings-sec">
            <h4>Markets &amp; sizing</h4>
            <div className="frow">
              <label className="field">
                <span className="field-label">Auto-scan markets (recommended)</span>
                <select
                  className="select"
                  value={draft.autoScan ? 'auto' : 'manual'}
                  onChange={(e) => set({ autoScan: e.target.value === 'auto' })}
                >
                  <option value="auto">Scanner — trade the top trending high-volatility markets</option>
                  <option value="manual">Manual — only the primary symbol below</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Primary chart symbol</span>
                <input
                  className="input"
                  value={draft.symbol}
                  disabled={draft.autoScan}
                  onChange={(e) => set({ symbol: e.target.value.toUpperCase().trim() })}
                />
              </label>
            </div>
            <div className="frow">
              <label className="field">
                <span className="field-label">Trade size (% of equity per trade)</span>
                <input
                  className="input"
                  type="number"
                  min={0.5}
                  max={100}
                  step={0.5}
                  value={draft.tradeSizePercent}
                  onChange={(e) => set({ tradeSizePercent: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                <span className="field-label">Leverage</span>
                <select className="select" value={draft.leverage} onChange={(e) => set({ leverage: Number(e.target.value) })}>
                  {[1, 2, 3, 5, 10, 15, 20, 25, 50, 75, 100].map((l) => (
                    <option key={l} value={l}>
                      {l}x
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="frow">
              <label className="field">
                <span className="field-label">Max simultaneous positions (hard cap 8)</span>
                <select
                  className="select"
                  value={draft.maxPositions}
                  onChange={(e) => set({ maxPositions: Math.min(8, Number(e.target.value)) })}
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <option key={n} value={n}>
                      {n} position{n > 1 ? 's' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Stats window (days)</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={365}
                  value={draft.historyDays}
                  onChange={(e) => set({ historyDays: Number(e.target.value) })}
                />
              </label>
            </div>
            <div className="hint">
              Every trade uses <b>{draft.tradeSizePercent}% of equity</b> as margin × <b>{draft.leverage}x</b> leverage, up
              to <b>{draft.maxPositions}</b> positions. SL = ATR(14) × {draft.atrSlMultiplier}, TPs at {draft.tpRrFactor}R /{' '}
              {draft.tpRrFactor * 2}R / {draft.tpRrFactor * 3}R. Equity, PNL, ROI, fees and funding are always read from
              Binance — there is no manual balance to enter.
            </div>
          </div>

          <div className="settings-sec">
            <h4>Scale-out ladder</h4>
            <div className="frow">
              <label className="field">
                <span className="field-label">TP1 closes (% of position)</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={90}
                  value={draft.tp1ClosePct}
                  onChange={(e) => set({ tp1ClosePct: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                <span className="field-label">TP2 closes (% of remaining)</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={90}
                  value={draft.tp2ClosePct}
                  onChange={(e) => set({ tp2ClosePct: Number(e.target.value) })}
                />
              </label>
            </div>
            <div className="hint">
              TP1 → close {draft.tp1ClosePct}% + <b>SL to breakeven</b> · TP2 → close {draft.tp2ClosePct}% of the rest +{' '}
              <b>SL to TP1</b> · TP3 → <b>full exit</b>.
            </div>
          </div>

        </>
      )}

      {tab === 'scanner' && (
        <>
          <div className="settings-sec">
            <h4>Market scanner</h4>
            <div className="frow">
              <label className="field">
                <span className="field-label">Scanner</span>
                <select
                  className="select"
                  value={draft.scanner.enabled ? 'on' : 'off'}
                  onChange={(e) => set({ scanner: { ...draft.scanner, enabled: e.target.value === 'on' } })}
                >
                  <option value="on">Enabled — sweep the whole USD-M universe</option>
                  <option value="off">Disabled — manual symbol only</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Scan interval (seconds)</span>
                <input
                  className="input"
                  type="number"
                  min={15}
                  max={600}
                  value={draft.scanner.intervalSec}
                  onChange={(e) => set({ scanner: { ...draft.scanner, intervalSec: Number(e.target.value) } })}
                />
              </label>
            </div>
            <div className="hint">
              Scans run inside the <b>95% Binance weight budget</b> (2280 of 2400/min) in their own work area, so market
              data, account data and the executor keep working at full speed.
            </div>
          </div>

          <div className="settings-sec">
            <h4>Trending &amp; volatility gates</h4>
            <div className="frow two">
              <label className="field">
                <span className="field-label">Min 24h quote volume (USDT)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={1_000_000}
                  value={draft.scanner.minQuoteVolume24h}
                  onChange={(e) => set({ scanner: { ...draft.scanner, minQuoteVolume24h: Number(e.target.value) } })}
                />
              </label>
              <label className="field">
                <span className="field-label">Min 24h range (%)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={0.5}
                  value={draft.scanner.minRange24hPct}
                  onChange={(e) => set({ scanner: { ...draft.scanner, minRange24hPct: Number(e.target.value) } })}
                />
              </label>
            </div>
            <div className="frow two">
              <label className="field">
                <span className="field-label">Min ATR(14) 15m (% of price)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={0.1}
                  value={draft.scanner.minAtrPct}
                  onChange={(e) => set({ scanner: { ...draft.scanner, minAtrPct: Number(e.target.value) } })}
                />
              </label>
              <label className="field">
                <span className="field-label">Min ADX(14) — trending gate</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  value={draft.scanner.minAdx}
                  onChange={(e) => set({ scanner: { ...draft.scanner, minAdx: Number(e.target.value) } })}
                />
              </label>
            </div>
            <div className="frow two">
              <label className="field">
                <span className="field-label">Candidates analysed per scan</span>
                <input
                  className="input"
                  type="number"
                  min={8}
                  max={80}
                  value={draft.scanner.candidates}
                  onChange={(e) => set({ scanner: { ...draft.scanner, candidates: Number(e.target.value) } })}
                />
              </label>
              <label className="field">
                <span className="field-label">Symbols handed to the engine</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={8}
                  value={draft.scanner.topN}
                  onChange={(e) => set({ scanner: { ...draft.scanner, topN: Math.min(8, Number(e.target.value)) } })}
                />
              </label>
            </div>
            <div className="hint warn" style={{ display: 'flex', gap: 7 }}>
              <IconAlert style={{ width: 14, height: 14, flex: 'none', marginTop: 2 }} />
              Stable / pegged / staked / wrapped / index markets (USDC, FDUSD, BNSOL, WBETH, BTCDOM…) are rejected
              automatically — the bot only trades trending, volatile directional markets.
            </div>
          </div>
        </>
      )}

      {tab === 'ind' && (
        <div className="settings-sec">
          <h4>Indicator parameters (SUPER INDIBOT defaults)</h4>
          <div className="frow three">
            <label className="field">
              <span className="field-label">EMA lengths (8)</span>
              <input
                className="input"
                value={draft.emaLengths.join(',')}
                onChange={(e) => {
                  const arr = e.target.value
                    .split(',')
                    .map((x) => parseInt(x.trim(), 10))
                    .filter((x) => Number.isFinite(x) && x > 0);
                  if (arr.length >= 2) set({ emaLengths: arr });
                }}
              />
            </label>
            <label className="field">
              <span className="field-label">Extra EMA</span>
              <input
                className="input"
                type="number"
                value={draft.emaExtraLength}
                onChange={(e) => set({ emaExtraLength: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span className="field-label">ATR length</span>
              <input
                className="input"
                type="number"
                value={draft.atrLength}
                onChange={(e) => set({ atrLength: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="frow">
            <label className="field">
              <span className="field-label">SL = ATR × multiplier</span>
              <input
                className="input"
                type="number"
                step={0.1}
                value={draft.atrSlMultiplier}
                onChange={(e) => set({ atrSlMultiplier: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span className="field-label">TP multiplier (RR per TP)</span>
              <input
                className="input"
                type="number"
                step={0.1}
                value={draft.tpRrFactor}
                onChange={(e) => set({ tpRrFactor: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="hint">
            Signals: <b>confirmed crossover of EMA{draft.emaLengths[1]}/EMA{draft.emaLengths[7]}</b> on a closed 5m bar
            (entry = signal candle close). Values match the TradingView script — non-repaint.
          </div>
        </div>
      )}

      <div className="mt" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Btn variant="primary" onClick={save} disabled={saving} className="save-btn">
          {saving ? (
            <>
              <span className="goo-loader small" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              Saving…
            </>
          ) : (
            <>
              {justSaved ? <IconCheck style={{ width: 14, height: 14 }} /> : <IconCoins style={{ width: 14, height: 14 }} />}
              {justSaved ? 'Saved' : 'Save settings'}
            </>
          )}
        </Btn>
        {justSaved && <span className="chip green">applied to the engine</span>}
        {liveNotice && <span className="chip amber">{liveNotice}</span>}
      </div>
    </Panel>
  );
}

import { useEffect, useState } from 'react';
import { Settings } from '../types';
import { apiPost } from '../api';
import { Btn, Panel, Segmented } from '../motion/primitives';
import { IconAlert, IconCheck, IconChart, IconCoins, IconSettings, IconTrend } from '../motion/Icons';

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

type Tab = 'conn' | 'trade' | 'ind';

const TABS: { value: Tab; label: string; icon: React.ReactNode }[] = [
  { value: 'conn', label: 'Connection', icon: <IconSettings /> },
  { value: 'trade', label: 'Trading', icon: <IconCoins /> },
  { value: 'ind', label: 'Indicator', icon: <IconTrend /> },
];

export default function SettingsPanel({ settings, onSaved, onError }: Props) {
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('trade');

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
      const saved = await apiPost<Settings>('/settings', { ...draft });
      onSaved(saved);
      setSavedAt(Date.now());
    } catch (e: any) {
      onError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const resetPaper = async () => {
    try {
      await apiPost('/paper/reset', { balance: draft.paperBalance });
      onError('');
      setSavedAt(Date.now());
    } catch (e: any) {
      onError(e.message);
    }
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
                <select className="select" value={draft.mode} onChange={(e) => set({ mode: e.target.value as Settings['mode'] })}>
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
            <h4>Symbol &amp; sizing</h4>
            <div className="frow">
              <label className="field">
                <span className="field-label">Futures symbol</span>
                <input
                  className="input"
                  value={draft.symbol}
                  onChange={(e) => set({ symbol: e.target.value.toUpperCase().trim() })}
                />
              </label>
              <label className="field">
                <span className="field-label">Trade size (% of balance)</span>
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
            </div>
            <div className="frow">
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
              <label className="field">
                <span className="field-label">Paper balance (USDT)</span>
                <input
                  className="input"
                  type="number"
                  min={10}
                  value={draft.paperBalance}
                  onChange={(e) => set({ paperBalance: Number(e.target.value) })}
                />
              </label>
            </div>
            <div className="hint">
              Every trade uses <b>{draft.tradeSizePercent}% of balance</b> as margin × <b>{draft.leverage}x</b> leverage.
              SL = ATR(14) × {draft.atrSlMultiplier}, TPs at {draft.tpRrFactor}R / {draft.tpRrFactor * 2}R /{' '}
              {draft.tpRrFactor * 3}R.
            </div>
            <div className="row mt">
              <Btn size="sm" onClick={resetPaper}>
                Reset paper balance
              </Btn>
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

          <div className="settings-sec">
            <h4>Screener symbols (max 9, comma separated)</h4>
            <div className="frow one">
              <label className="field">
                <span className="field-label">Watchlist</span>
                <textarea
                  className="textarea"
                  rows={2}
                  value={draft.screenerSymbols.join(', ')}
                  onChange={(e) =>
                    set({
                      screenerSymbols: e.target.value
                        .split(',')
                        .map((x) => x.trim().toUpperCase())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
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
          <div className="frow">
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
      </div>
    </Panel>
  );
}

import { useEffect, useState } from 'react';
import { Settings } from '../types';
import { apiGet, apiPost } from '../api';

interface Props {
  settings: Settings | null;
  onSaved: (s: Settings) => void;
  onError: (msg: string) => void;
}

export default function SettingsPanel({ settings, onSaved, onError }: Props) {
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'conn' | 'trade' | 'ind'>('trade');

  useEffect(() => {
    if (settings) setDraft(structuredClone(settings));
  }, [settings]);

  if (!draft) return <div className="empty">Loading settings…</div>;

  const set = (patch: any) => setDraft({ ...(draft as any), ...patch });
  const setKey = (env: 'testnet' | 'live', field: 'key' | 'secret', v: string) =>
    set({ keys: { ...draft.keys, [env]: { ...draft.keys[env], [field]: v } } });

  const save = async () => {
    setSaving(true);
    try {
      const body: any = { ...draft };
      // only send key fields that were actually typed into (masked/empty echo handled server-side too)
      const saved = await apiPost<Settings>('/settings', body);
      onSaved(saved);
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
    } catch (e: any) { onError(e.message); }
  };

  return (
    <div className="card-body">
      <div className="row" style={{ marginBottom: 10 }}>
        {(['conn', 'trade', 'ind'] as const).map((t) => (
          <button key={t} className={`btn small ${tab === t ? 'primary' : ''}`} onClick={() => setTab(t)}>
            {t === 'conn' ? 'CONNECTION' : t === 'trade' ? 'TRADING' : 'INDICATOR'}
          </button>
        ))}
      </div>

      {tab === 'conn' && (
        <>
          <div className="settings-sec">
            <h4>Environment</h4>
            <div className="frow one">
              <label className="f">Mode
                <select className="f" value={draft.mode} onChange={(e) => set({ mode: e.target.value })}>
                  <option value="paper">Paper — simulate fills on live prices (safe)</option>
                  <option value="testnet">Binance Futures Testnet — real test orders</option>
                  <option value="live">🔴 LIVE Mainnet — real money</option>
                </select>
              </label>
            </div>
            <div className="hint">
              Get free testnet keys at <b>testnet.binancefuture.com</b> (Log in → API Management).
              Live keys: Binance → Account → API Management (enable Futures, restrict IP).
            </div>
          </div>

          <div className="settings-sec">
            <h4>Testnet API keys</h4>
            <div className="frow">
              <label className="f">API Key
                <input className="f" type="password" placeholder={draft.keys.testnet.configured ? '(saved — leave blank to keep)' : 'testnet API key'}
                  value={draft.keys.testnet.key} onChange={(e) => setKey('testnet', 'key', e.target.value)} />
              </label>
              <label className="f">Secret
                <input className="f" type="password" placeholder={draft.keys.testnet.configured ? '(saved)' : 'secret'}
                  value={draft.keys.testnet.secret} onChange={(e) => setKey('testnet', 'secret', e.target.value)} />
              </label>
            </div>
            {draft.keys.testnet.configured && <div className="hint">✓ keys configured (masked)</div>}
          </div>

          <div className="settings-sec">
            <h4>🔴 Live Mainnet API keys</h4>
            <div className="frow">
              <label className="f">API Key
                <input className="f" type="password" placeholder={draft.keys.live.configured ? '(saved — leave blank to keep)' : 'live API key'}
                  value={draft.keys.live.key} onChange={(e) => setKey('live', 'key', e.target.value)} />
              </label>
              <label className="f">Secret
                <input className="f" type="password" placeholder={draft.keys.live.configured ? '(saved)' : 'secret'}
                  value={draft.keys.live.secret} onChange={(e) => setKey('live', 'secret', e.target.value)} />
              </label>
            </div>
            <div className="hint warn">Live mode places REAL orders with REAL funds. Test thoroughly on paper &amp; testnet first.</div>
          </div>
        </>
      )}

      {tab === 'trade' && (
        <>
          <div className="settings-sec">
            <h4>Symbol &amp; sizing</h4>
            <div className="frow">
              <label className="f">Futures symbol
                <input className="f" value={draft.symbol} onChange={(e) => set({ symbol: e.target.value.toUpperCase().trim() })} />
              </label>
              <label className="f">Trade size (% of balance)
                <input className="f" type="number" min={0.5} max={100} step={0.5} value={draft.tradeSizePercent}
                  onChange={(e) => set({ tradeSizePercent: Number(e.target.value) })} />
              </label>
            </div>
            <div className="frow">
              <label className="f">Leverage
                <select className="f" value={draft.leverage} onChange={(e) => set({ leverage: Number(e.target.value) })}>
                  {[1, 2, 3, 5, 10, 15, 20, 25, 50, 75, 100].map((l) => <option key={l} value={l}>{l}x</option>)}
                </select>
              </label>
              <label className="f">Paper balance (USDT)
                <input className="f" type="number" min={10} value={draft.paperBalance}
                  onChange={(e) => set({ paperBalance: Number(e.target.value) })} />
              </label>
            </div>
            <div className="hint">
              Each trade uses <b>{draft.tradeSizePercent}% of balance</b> as margin × <b>{draft.leverage}x</b> leverage.
              SL = ATR(14)×{draft.atrSlMultiplier} · TP1/2/3 at 1.5R / 3R / 4.5R.
            </div>
            <div className="row mt">
              <button className="btn small" onClick={resetPaper}>Reset paper balance</button>
            </div>
          </div>

          <div className="settings-sec">
            <h4>Scale-out ladder</h4>
            <div className="frow">
              <label className="f">TP1 closes (% of position)
                <input className="f" type="number" min={1} max={90} value={draft.tp1ClosePct}
                  onChange={(e) => set({ tp1ClosePct: Number(e.target.value) })} />
              </label>
              <label className="f">TP2 closes (% of remaining)
                <input className="f" type="number" min={1} max={90} value={draft.tp2ClosePct}
                  onChange={(e) => set({ tp2ClosePct: Number(e.target.value) })} />
              </label>
            </div>
            <div className="hint">
              TP1 hit → close {draft.tp1ClosePct}% + <b>SL → breakeven</b> ·
              TP2 hit → close {draft.tp2ClosePct}% of remaining + <b>SL → TP1</b> ·
              TP3 hit → <b>full exit</b>.
            </div>
          </div>

          <div className="settings-sec">
            <h4>Screener symbols (max 9, comma separated)</h4>
            <div className="frow one">
              <textarea className="f" rows={2} value={draft.screenerSymbols.join(', ')}
                onChange={(e) => set({ screenerSymbols: e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) })} />
            </div>
          </div>
        </>
      )}

      {tab === 'ind' && (
        <div className="settings-sec">
          <h4>Indicator parameters (SUPER INDIBOT defaults)</h4>
          <div className="frow three">
            <label className="f">EMA lengths (8)
              <input className="f" value={draft.emaLengths.join(',')}
                onChange={(e) => {
                  const arr = e.target.value.split(',').map((x) => parseInt(x.trim(), 10)).filter((x) => Number.isFinite(x) && x > 0);
                  if (arr.length >= 2) set({ emaLengths: arr });
                }} />
            </label>
            <label className="f">Extra EMA
              <input className="f" type="number" value={draft.emaExtraLength} onChange={(e) => set({ emaExtraLength: Number(e.target.value) })} />
            </label>
            <label className="f">ATR length
              <input className="f" type="number" value={draft.atrLength} onChange={(e) => set({ atrLength: Number(e.target.value) })} />
            </label>
          </div>
          <div className="frow">
            <label className="f">SL = ATR × multiplier
              <input className="f" type="number" step={0.1} value={draft.atrSlMultiplier}
                onChange={(e) => set({ atrSlMultiplier: Number(e.target.value) })} />
            </label>
            <label className="f">TP multiplier (RR per TP)
              <input className="f" type="number" step={0.1} value={draft.tpRrFactor}
                onChange={(e) => set({ tpRrFactor: Number(e.target.value) })} />
            </label>
          </div>
          <div className="frow">
            <label className="f">Stats window (days)
              <input className="f" type="number" min={1} max={365} value={draft.historyDays}
                onChange={(e) => set({ historyDays: Number(e.target.value) })} />
            </label>
          </div>
          <div className="hint">
            Signals: <b>confirmed crossover of EMA{draft.emaLengths[1]}/EMA{draft.emaLengths[7]}</b> on closed 5m bar
            (entry = signal candle close). Same values as the TradingView script — non-repaint.
          </div>
        </div>
      )}

      <div className="mt">
        <button className="btn primary" onClick={save} disabled={saving} style={{ width: '100%' }}>
          {saving ? 'Saving…' : '💾 SAVE SETTINGS'}
        </button>
      </div>
    </div>
  );
}

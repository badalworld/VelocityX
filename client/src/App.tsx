import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost, fmt, fmtPrice, fmtQtyN, getApiToken, setApiToken, timeAgo } from './api';
import { reconnect, subscribe } from './ws';
import type { AccountView, LogLine, Mode, PositionsPayload, Settings, Status, Trade } from './types';

const pages = [
  { id: 'overview', label: 'Overview', icon: '◫' },
  { id: 'positions', label: 'Positions', icon: '⌁' },
  { id: 'history', label: 'Trade archive', icon: '▤' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
] as const;
type Page = (typeof pages)[number]['id'];

type Toast = { id: number; message: string; kind: 'success' | 'error' | 'info' };

function money(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value < 0 ? '−' : ''}$${fmt(Math.abs(value), digits)}`;
}

function dateTime(value: number | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function mergeLogs(previous: LogLine[], incoming: LogLine[]): LogLine[] {
  const unique = new Map<string, LogLine>();
  for (const line of [...previous, ...incoming]) unique.set(`${line.t}:${line.level}:${line.msg}`, line);
  return [...unique.values()].sort((a, b) => a.t - b.t).slice(-200);
}

export default function App() {
  const [page, setPage] = useState<Page>('overview');
  const [status, setStatus] = useState<Status | null>(null);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [positions, setPositions] = useState<PositionsPayload | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [socketUp, setSocketUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastCounter = useRef(0);
  const [settingsDraft, setSettingsDraft] = useState({ mode: 'live' as Mode, symbol: 'BTCUSDT' });
  const [keyDraft, setKeyDraft] = useState<Record<Mode, { key: string; secret: string }>>({
    live: { key: '', secret: '' },
    testnet: { key: '', secret: '' },
  });
  const [apiToken, setApiTokenDraft] = useState(getApiToken);
  const [localModeConfirmed, setLocalModeConfirmed] = useState(false);
  const [search, setSearch] = useState('');
  const [lastRefreshAt, setLastRefreshAt] = useState(0);

  const toast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastCounter.current;
    setToasts((previous) => [...previous, { id, message, kind }]);
    window.setTimeout(() => setToasts((previous) => previous.filter((item) => item.id !== id)), 4200);
  }, []);

  const loadStatus = useCallback(async () => {
    const data = await apiGet<Status>('/status');
    setStatus(data);
    if (data.account) setAccount((previous) => !previous || data.account!.at >= previous.at ? data.account : previous);
    setLogs((previous) => mergeLogs(previous, data.logs || []));
    setLastRefreshAt(Date.now());
  }, []);

  const loadAccount = useCallback(async () => {
    const data = await apiGet<AccountView>('/account');
    setAccount((previous) => !previous || data.at >= previous.at ? data : previous);
  }, []);

  const loadPositions = useCallback(async () => {
    const data = await apiGet<PositionsPayload>('/positions');
    setPositions((previous) => !previous || data.at >= previous.at ? data : previous);
  }, []);

  const loadTrades = useCallback(async () => {
    setTrades(await apiGet<Trade[]>('/trades?limit=500'));
  }, []);

  const loadSettings = useCallback(async () => {
    const data = await apiGet<Settings>('/settings');
    setSettings(data);
    setSettingsDraft({ mode: data.mode, symbol: data.symbol });
  }, []);

  const loadAll = useCallback(async () => {
    setError('');
    const results = await Promise.allSettled([loadStatus(), loadAccount(), loadPositions(), loadTrades(), loadSettings()]);
    const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failed) setError(failed.reason?.message || 'Could not load dashboard data. Check the server connection and API token.');
  }, [loadAccount, loadPositions, loadSettings, loadStatus, loadTrades]);

  useEffect(() => {
    void loadAll();
    const timer = window.setInterval(() => {
      void Promise.allSettled([loadStatus(), loadAccount(), loadPositions()]);
    }, 10_000);
    const archiveTimer = window.setInterval(() => void loadTrades(), 45_000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(archiveTimer);
    };
  }, [loadAccount, loadAll, loadPositions, loadStatus, loadTrades]);

  useEffect(() => subscribe((event) => {
    if (event.type === '_open') setSocketUp(true);
    if (event.type === '_close') setSocketUp(false);
    if (event.type === 'price') {
      setStatus((previous) => previous ? {
        ...previous,
        market: previous.market ? { ...previous.market, lastPrice: Number(event.data?.price) || previous.market.lastPrice } : previous.market,
      } : previous);
    }
    if (event.type === 'log' && event.data?.msg) {
      const line: LogLine = { t: Number(event.t) || Date.now(), level: String(event.data.level || 'info'), msg: String(event.data.msg) };
      setLogs((previous) => mergeLogs(previous, [line]));
    }
    if (event.type === 'account') {
      void Promise.allSettled([loadAccount(), loadPositions()]);
    }
    if (event.type === 'feed' || event.type === 'stream' || event.type === 'status') void loadStatus();
  }), [loadAccount, loadPositions, loadStatus]);

  const positionsNow = positions?.positions ?? account?.positions ?? [];
  const openJournalEntries = positions?.openJournalEntries ?? status?.openTrades ?? [];
  const visibleTrades = useMemo(() => {
    const term = search.trim().toUpperCase();
    return term ? trades.filter((trade) => trade.symbol.includes(term) || trade.id.toUpperCase().includes(term)) : trades;
  }, [search, trades]);
  const marketPrice = status?.market?.lastPrice ?? 0;
  const accountAge = account?.at ? Math.max(0, Date.now() - account.at) : Infinity;
  const isFresh = accountAge < 45_000;
  const feedOnline = status?.feed?.reachable === true;

  async function saveToken(event: FormEvent): Promise<void> {
    event.preventDefault();
    setApiToken(apiToken.trim());
    reconnect();
    toast('API token saved in this browser.', 'success');
    window.setTimeout(() => void loadAll(), 250);
  }

  async function saveSettings(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!settingsDraft.symbol.trim()) return toast('Enter a market symbol.', 'error');
    if (settingsDraft.mode === 'live' && settings?.mode !== 'live' && !localModeConfirmed) {
      return toast('Confirm the LIVE account switch before saving.', 'error');
    }
    setBusy(true);
    setError('');
    try {
      const keys: Partial<Record<Mode, { key?: string; secret?: string }>> = {};
      for (const mode of ['testnet', 'live'] as const) {
        const key = keyDraft[mode].key.trim();
        const secret = keyDraft[mode].secret.trim();
        if (key || secret) keys[mode] = { ...(key ? { key } : {}), ...(secret ? { secret } : {}) };
      }
      const body: Record<string, unknown> = {
        mode: settingsDraft.mode,
        symbol: settingsDraft.symbol.trim().toUpperCase(),
      };
      if (Object.keys(keys).length) body.keys = keys;
      if (settingsDraft.mode === 'live' && settings?.mode !== 'live') body.confirmLive = true;
      const saved = await apiPost<Settings>('/settings', body);
      setSettings(saved);
      setSettingsDraft({ mode: saved.mode, symbol: saved.symbol });
      setKeyDraft({ live: { key: '', secret: '' }, testnet: { key: '', secret: '' } });
      setLocalModeConfirmed(false);
      toast('Connection settings saved. No orders or strategy actions are enabled.', 'success');
      await loadAll();
    } catch (saveError: any) {
      setError(saveError?.message || 'Settings could not be saved.');
      toast(saveError?.message || 'Settings could not be saved.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#overview" onClick={() => setPage('overview')} aria-label="VelocityX overview">
          <span className="brand-mark">V</span>
          <span className="brand-copy"><strong>VELOCITY<span>X</span></strong><small>Exchange monitor</small></span>
        </a>
        <nav className="nav" aria-label="Main navigation">
          {pages.map((item) => (
            <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)}>
              <span aria-hidden="true">{item.icon}</span>{item.label}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <span className={`connection ${feedOnline && socketUp ? 'online' : ''}`}><i />{feedOnline && socketUp ? 'LIVE DATA' : 'CONNECTING'}</span>
          <span className={`mode-tag ${status?.mode === 'live' ? 'live' : 'demo'}`}>{status?.mode === 'live' ? 'LIVE ACCOUNT' : 'DEMO ACCOUNT'}</span>
          <button className="icon-button refresh-button" onClick={() => void loadAll()} title="Refresh dashboard" aria-label="Refresh dashboard">↻</button>
        </div>
      </header>

      <main className="main-content">
        <section className="page-heading">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" /> VELOCITYX / READ-ONLY BASELINE</div>
            <h1>{pages.find((item) => item.id === page)?.label}</h1>
            <p>Live Binance market and account data. Trading logic has been removed pending your new strategy.</p>
          </div>
          <div className="updated"><span className={`status-dot ${isFresh ? 'good' : ''}`} />
            {lastRefreshAt ? `Updated ${timeAgo(lastRefreshAt)}` : 'Waiting for data'}
          </div>
        </section>

        <section className="safety-banner" role="status">
          <div className="safety-icon">Ⅱ</div>
          <div><strong>Strategy-free mode</strong><p>No signals, automated entries, order placement, stop management or trade controls are available.</p></div>
          <span className="readonly-pill">READ ONLY</span>
        </section>

        {error && <div className="error-banner"><span>Connection notice</span><p>{error}</p><button onClick={() => void loadAll()}>Retry</button></div>}

        {page === 'overview' && (
          <Overview
            status={status}
            account={account}
            positions={positionsNow}
            openJournalEntries={openJournalEntries}
            trades={trades}
            logs={logs}
            onNavigate={setPage}
          />
        )}
        {page === 'positions' && (
          <PositionsPage positions={positionsNow} journal={openJournalEntries} at={positions?.at ?? account?.at ?? 0} />
        )}
        {page === 'history' && <HistoryPage trades={visibleTrades} search={search} onSearch={setSearch} />}
        {page === 'settings' && (
          <SettingsPage
            settings={settings}
            draft={settingsDraft}
            setDraft={setSettingsDraft}
            keyDraft={keyDraft}
            setKeyDraft={setKeyDraft}
            token={apiToken}
            setToken={setApiTokenDraft}
            saveToken={saveToken}
            saveSettings={saveSettings}
            confirmed={localModeConfirmed}
            setConfirmed={setLocalModeConfirmed}
            busy={busy}
          />
        )}
      </main>

      <footer className="footer"><span>VELOCITYX <b>·</b> BINANCE USDⓈ-M</span><span>NO STRATEGY INSTALLED <i /> NO ORDERS SENT</span></footer>
      <div className="toast-stack" aria-live="polite">
        {toasts.map((item) => <div className={`toast ${item.kind}`} key={item.id}><span>{item.kind === 'success' ? '✓' : item.kind === 'error' ? '!' : 'i'}</span>{item.message}</div>)}
      </div>
    </div>
  );
}

function Overview({
  status, account, positions, openJournalEntries, trades, logs, onNavigate,
}: {
  status: Status | null;
  account: AccountView | null;
  positions: AccountView['positions'];
  openJournalEntries: Trade[];
  trades: Trade[];
  logs: LogLine[];
  onNavigate: (page: Page) => void;
}) {
  const price = status?.market?.lastPrice ?? 0;
  const recent = trades.slice(0, 5);
  return (
    <>
      {openJournalEntries.length > 0 && (
        <div className="legacy-warning"><span>!</span><div><strong>{openJournalEntries.length} legacy journal position{openJournalEntries.length === 1 ? '' : 's'} marked open</strong>
          <p>VelocityX no longer monitors or manages these positions. Check Binance directly; any exchange-side orders are untouched.</p></div>
        </div>
      )}
      <section className="hero-grid">
        <article className="panel market-card">
          <div className="panel-top"><div><span className="label">SELECTED MARKET</span><h2>{status?.symbol ?? '—'} <span className="market-interval">/ {status?.interval ?? '5m'}</span></h2></div><span className="live-chip"><i /> MAINNET MARKET DATA</span></div>
          <div className="market-price">{price ? `$${fmtPrice(price)}` : '—'}</div>
          <div className="market-foot"><span><i className="pulse-dot" /> Price stream {status?.streams.market ? 'connected' : 'waiting'}</span><span>{status?.feed?.latencyMs ? `${Math.round(status.feed.latencyMs)} ms REST` : 'REST latency —'}</span></div>
          <div className="price-line"><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /></div>
        </article>
        <article className="panel status-card">
          <div className="panel-top"><div><span className="label">SYSTEM STATE</span><h2>Monitoring only</h2></div><div className="state-ring">Ⅱ</div></div>
          <p className="muted">Strategy and order execution modules are not installed.</p>
          <div className="status-rows">
            <StatusRow label="Exchange REST" value={status?.feed?.reachable === true ? 'Connected' : status?.feed?.reachable === false ? 'Unavailable' : 'Checking'} ok={status?.feed?.reachable === true} />
            <StatusRow label="Market stream" value={status?.streams.market ? 'Connected' : 'Reconnecting'} ok={!!status?.streams.market} />
            <StatusRow label="Account stream" value={status?.streams.user ? 'Connected' : 'Not connected'} ok={!!status?.streams.user} />
          </div>
        </article>
      </section>

      <section className="metric-grid">
        <Metric label="Account equity" value={money(account?.equity)} detail="Binance total margin balance" icon="◇" tone="blue" />
        <Metric label="Wallet balance" value={money(account?.walletBalance)} detail="Binance wallet balance" icon="◈" tone="violet" />
        <Metric label="Unrealized P&L" value={money(account?.unrealizedPnl)} detail="Across exchange positions" icon="↗" tone={(account?.unrealizedPnl ?? 0) >= 0 ? 'green' : 'red'} />
        <Metric label="Available balance" value={money(account?.availableBalance)} detail="Binance available balance" icon="＋" tone="amber" />
      </section>

      <section className="content-grid">
        <article className="panel table-panel">
          <div className="section-head"><div><span className="label">EXCHANGE EXPOSURE</span><h2>Open positions <span className="count-badge">{positions.length}</span></h2></div><button className="text-button" onClick={() => onNavigate('positions')}>View all <b>→</b></button></div>
          {positions.length ? <PositionTable positions={positions.slice(0, 6)} /> : <EmptyState title="No open exchange positions" text="Positions reported by Binance will appear here." />}
          {openJournalEntries.length > 0 && <p className="inline-warning">Legacy archive: {openJournalEntries.length} open record(s) — manual review required.</p>}
        </article>
        <article className="panel activity-panel">
          <div className="section-head"><div><span className="label">SERVER ACTIVITY</span><h2>Recent updates</h2></div></div>
          {logs.length ? <div className="activity-list">{logs.slice(-6).reverse().map((log, index) => <ActivityItem key={`${log.t}-${index}`} log={log} />)}</div> : <EmptyState title="Waiting for activity" text="Server and exchange status messages appear here." />}
        </article>
      </section>

      <section className="panel archive-preview">
        <div className="section-head"><div><span className="label">HISTORICAL JOURNAL</span><h2>Recent archived trades</h2></div><button className="text-button" onClick={() => onNavigate('history')}>Open archive <b>→</b></button></div>
        {recent.length ? <TradeTable trades={recent} compact /> : <EmptyState title="No archived trades" text="Existing journal records are kept as a strategy-neutral archive." />}
      </section>
    </>
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return <div className="status-row"><span>{label}</span><strong className={ok ? 'good-text' : ''}><i className={ok ? 'good' : ''} />{value}</strong></div>;
}

function Metric({ label, value, detail, icon, tone }: { label: string; value: string; detail: string; icon: string; tone: string }) {
  return <article className={`panel metric-card ${tone}`}><div className="metric-head"><span className="label">{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}</strong><small>{detail}</small></article>;
}

function PositionTable({ positions }: { positions: AccountView['positions'] }) {
  return <div className="table-scroll"><table><thead><tr><th>Market</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>Unrealized P&L</th></tr></thead><tbody>
    {positions.map((position) => <tr key={`${position.symbol}:${position.positionAmt}`}>
      <td className="symbol-cell">{position.symbol}</td><td><span className={`side-pill ${position.positionAmt >= 0 ? 'long' : 'short'}`}>{position.positionAmt >= 0 ? 'LONG' : 'SHORT'}</span></td>
      <td>{fmtQtyN(Math.abs(position.positionAmt))}</td><td>${fmtPrice(position.entryPrice)}</td><td>${fmtPrice(position.markPrice)}</td>
      <td className={position.unRealizedProfit >= 0 ? 'positive' : 'negative'}>{money(position.unRealizedProfit)}</td>
    </tr>)}
  </tbody></table></div>;
}

function PositionsPage({ positions, journal, at }: { positions: AccountView['positions']; journal: Trade[]; at: number }) {
  return <section className="panel page-panel">
    <div className="section-head"><div><span className="label">BINANCE USDⓈ-M</span><h2>Exchange positions <span className="count-badge">{positions.length}</span></h2></div><span className="data-time">{at ? `Snapshot ${timeAgo(at)}` : 'Awaiting account snapshot'}</span></div>
    <div className="legacy-warning compact-warning"><span>i</span><div><strong>Read-only position view</strong><p>No stops, targets, re-entry, close, or position-management actions are performed by VelocityX.</p></div></div>
    {positions.length ? <PositionTable positions={positions} /> : <EmptyState title="No open exchange positions" text="When Binance reports open exposure, it will be listed here." />}
    {journal.length > 0 && <div className="journal-list"><h3>Legacy journal records marked open</h3><p>These are archival records only and are not automatically reconciled with Binance.</p>
      {journal.map((trade) => <div className="journal-row" key={trade.id}><strong>{trade.symbol}</strong><span>{trade.side}</span><span>{fmtQtyN(trade.qty)} qty</span><span>Entry ${fmtPrice(trade.entryPrice)}</span><span>Opened {dateTime(trade.openedAt)}</span></div>)}
    </div>}
  </section>;
}

function HistoryPage({ trades, search, onSearch }: { trades: Trade[]; search: string; onSearch: (value: string) => void }) {
  return <section className="panel page-panel">
    <div className="section-head"><div><span className="label">STRATEGY-NEUTRAL RECORDS</span><h2>Trade archive <span className="count-badge">{trades.length}</span></h2></div>
      <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Filter market or ID" /></label>
    </div>
    <p className="muted archive-note">Historical executions are retained without their former signal, target, stop, sizing, or strategy fields.</p>
    {trades.length ? <TradeTable trades={trades} /> : <EmptyState title="No matching archive records" text="Try a different market or trade ID." />}
  </section>;
}

function TradeTable({ trades, compact = false }: { trades: Trade[]; compact?: boolean }) {
  return <div className="table-scroll"><table><thead><tr><th>Opened</th><th>Market</th><th>Side</th><th>Quantity</th><th>Entry</th><th>Status</th><th>Realized P&L</th><th>Mode</th></tr></thead><tbody>
    {trades.map((trade) => <tr key={trade.id}>
      <td>{compact ? dateTime(trade.openedAt) : <><span>{dateTime(trade.openedAt)}</span><small className="sub-cell">{trade.id}</small></>}</td>
      <td className="symbol-cell">{trade.symbol}</td><td><span className={`side-pill ${trade.side.toLowerCase()}`}>{trade.side}</span></td>
      <td>{fmtQtyN(trade.qty)}</td><td>${fmtPrice(trade.entryPrice)}</td>
      <td><span className={`record-status ${trade.status.toLowerCase()}`}>{trade.status === 'OPEN' ? 'ARCHIVED OPEN' : 'CLOSED'}</span></td>
      <td className={trade.realizedPnl >= 0 ? 'positive' : 'negative'}>{money(trade.realizedPnl)}</td><td><span className={`mode-tag mini ${trade.mode === 'live' ? 'live' : 'demo'}`}>{trade.mode === 'live' ? 'LIVE' : 'DEMO'}</span></td>
    </tr>)}
  </tbody></table></div>;
}

function ActivityItem({ log }: { log: LogLine }) {
  return <div className="activity-item"><span className={`activity-dot ${log.level}`} /><div><p>{log.msg}</p><small>{timeAgo(log.t)}</small></div></div>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><span>◇</span><strong>{title}</strong><p>{text}</p></div>;
}

function SettingsPage({
  settings, draft, setDraft, keyDraft, setKeyDraft, token, setToken, saveToken, saveSettings, confirmed, setConfirmed, busy,
}: {
  settings: Settings | null;
  draft: { mode: Mode; symbol: string };
  setDraft: (value: { mode: Mode; symbol: string }) => void;
  keyDraft: Record<Mode, { key: string; secret: string }>;
  setKeyDraft: (value: Record<Mode, { key: string; secret: string }>) => void;
  token: string;
  setToken: (value: string) => void;
  saveToken: (event: FormEvent) => void;
  saveSettings: (event: FormEvent) => void;
  confirmed: boolean;
  setConfirmed: (value: boolean) => void;
  busy: boolean;
}) {
  const configured = settings?.keys[draft.mode]?.configured ?? false;
  return <div className="settings-grid">
    <form className="panel settings-panel" onSubmit={saveSettings}>
      <div className="section-head"><div><span className="label">EXCHANGE CONNECTION</span><h2>Account & market</h2></div><span className="read-only-tag">NO EXECUTION</span></div>
      <label className="field"><span>Account environment</span><select value={draft.mode} onChange={(event) => { setDraft({ ...draft, mode: event.target.value as Mode }); setConfirmed(false); }}>
        <option value="testnet">Binance Demo</option><option value="live">Binance LIVE</option>
      </select><small>Changing this only changes which Binance account is displayed; it never submits an order.</small></label>
      <label className="field"><span>Market symbol</span><input value={draft.symbol} maxLength={24} onChange={(event) => setDraft({ ...draft, symbol: event.target.value.toUpperCase() })} placeholder="BTCUSDT" /><small>Used only for public market data and the dashboard candle feed.</small></label>
      <div className="field"><span>{draft.mode === 'live' ? 'LIVE' : 'DEMO'} API credentials</span><div className="credential-state"><i className={configured ? 'good' : ''} />{configured ? 'Credentials saved' : 'Not configured'}</div>
        <input autoComplete="off" spellCheck={false} value={keyDraft[draft.mode].key} onChange={(event) => setKeyDraft({ ...keyDraft, [draft.mode]: { ...keyDraft[draft.mode], key: event.target.value } })} placeholder={configured ? 'Leave blank to keep the saved API key' : 'API key'} />
        <input autoComplete="new-password" type="password" value={keyDraft[draft.mode].secret} onChange={(event) => setKeyDraft({ ...keyDraft, [draft.mode]: { ...keyDraft[draft.mode], secret: event.target.value } })} placeholder={configured ? 'Leave blank to keep the saved secret' : 'API secret'} />
        <small>Use read-only permissions where possible. Credentials are stored locally by the server and are never returned in clear text.</small>
      </div>
      {draft.mode === 'live' && settings?.mode !== 'live' && <label className="confirm-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I understand this selects the real Binance account. VelocityX remains read-only and will not place or manage orders.</span></label>}
      <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save connection settings'}</button>
    </form>

    <div className="settings-side">
      <section className="panel settings-panel token-panel">
        <div className="section-head"><div><span className="label">DASHBOARD ACCESS</span><h2>API token</h2></div><span className="lock-icon">⌑</span></div>
        <p className="muted">If VX_API_TOKEN is configured on the server, enter it here. The token is stored only in this browser.</p>
        <form onSubmit={saveToken}><label className="field"><span>Access token</span><input type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Server access token" /></label><button className="secondary-button" type="submit">Save token locally</button></form>
      </section>
      <section className="panel clean-card"><div className="clean-icon">✓</div><span className="label">CLEAN BASELINE</span><h3>Ready for your strategy</h3><p>All previous signal generation, scanner, strategy settings, entry sizing, stop/target logic, and order execution have been removed from this build.</p><p>Send your new strategy when you are ready. Nothing has been substituted.</p></section>
    </div>
  </div>;
}

import { ReactNode } from 'react';
import { Status } from '../types';
import { fmt } from '../api';
import { BrandMark, IconBolt, IconChart, IconGauge, IconHistory, IconKill, IconRadar, IconSettings, IconTarget, IconWaves } from '../motion/Icons';
import { AnimatedNumber, Btn, Segmented } from '../motion/primitives';

export type ViewKey = 'dash' | 'scanner' | 'positions' | 'trades' | 'settings';

const NAV: { value: ViewKey; label: string; icon: ReactNode }[] = [
  { value: 'dash', label: 'Dashboard', icon: <IconGauge /> },
  { value: 'scanner', label: 'Scanner', icon: <IconRadar /> },
  { value: 'positions', label: 'Positions', icon: <IconTarget /> },
  { value: 'trades', label: 'Trades', icon: <IconHistory /> },
  { value: 'settings', label: 'Settings', icon: <IconSettings /> },
];

/* ---------------------------------------------------------------------------
   Topbar — identity, live Binance read-outs, panic control.
   ------------------------------------------------------------------------- */
export function Topbar({
  status,
  onKill,
  onOpenPnl,
}: {
  status: Status | null;
  onKill: () => void;
  onOpenPnl?: () => void;
}) {
  const mode = status?.mode ?? 'paper';
  const price = status?.price ?? 0;
  const account = status?.account ?? null;
  const positions = status?.openTrades ?? [];
  const openCount = status?.slots?.used ?? positions.length;
  const maxPos = status?.slots?.max ?? status?.maxPositions ?? 8;
  const unPnl = account?.bot.unrealizedPnl ?? positions.reduce((a, t) => a + (t.unrealized ?? 0), 0);
  const feed = status?.feedInfo?.feed ?? status?.feed ?? 'binance';
  const feedLabel = feed === 'binance' ? 'Binance' : feed === 'offline-demo' ? 'Demo feed' : 'Offline';
  const feedTone = feed === 'binance' ? 'live' : feed === 'offline-demo' ? 'warn' : 'error';

  const priceNode = price
    ? price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <BrandMark className="brand-svg" />
        </span>
        <span className="brand-text">
          <span className="brand-name">VelocityX</span>
          <span className="brand-sub">Super Indibot · scanner · USD-M Futures</span>
        </span>
      </div>

      <span className={`badge-mode ${mode}`}>
        <i className="led" />
        {mode === 'paper' ? 'Paper' : mode === 'testnet' ? 'Testnet' : 'Live Money'}
      </span>

      <span
        className={`badge-mode ${feedTone}`}
        title={
          feed === 'binance'
            ? `Realtime Binance data · REST ${status?.feedInfo?.avgLatencyMs ?? 0}ms · ${status?.feedInfo?.candles?.bars ?? 0} candles cached`
            : feed === 'offline-demo'
              ? 'Binance unreachable from this host — labelled synthetic demo feed active (VX_OFFLINE_DEMO=1)'
              : 'Binance unreachable — no market data is being invented'
        }
      >
        <i className="led" />
        {feedLabel}
      </span>

      <div className="spacer" />

      <div className="stat-pod" title={`${status?.symbol ?? ''} last price (Binance)`}>
        <span className="pod-ico">
          <IconChart />
        </span>
        <span className="pod-body">
          <span className="pod-k">{status?.symbol ?? 'Symbol'}</span>
          <span className="pod-v">{priceNode}</span>
        </span>
      </div>

      <div className="stat-pod hide-md" title={account?.source === 'binance' ? 'Binance margin balance (equity)' : 'Paper equity'}>
        <span className="pod-ico">
          <IconBolt />
        </span>
        <span className="pod-body">
          <span className="pod-k">Equity · {account?.source === 'binance' ? 'binance' : 'paper'}</span>
          <span className="pod-v">
            {account?.equity != null ? <AnimatedNumber value={account.equity} decimals={2} /> : '—'}
            <span style={{ fontSize: 9.5, color: 'var(--dim)', marginLeft: 4 }}>USDT</span>
          </span>
        </span>
      </div>

      <div className={`stat-pod ${unPnl >= 0 ? 'is-up' : 'is-down'} hide-sm`} title="Unrealised P&L of bot positions (Binance)">
        <span className="pod-ico">
          <IconWaves />
        </span>
        <span className="pod-body">
          <span className="pod-k">
            Open P&amp;L · {openCount}/{maxPos}
          </span>
          <span className={`pod-v ${unPnl >= 0 ? 'up' : 'down'}`}>
            <AnimatedNumber value={unPnl} decimals={2} signed />
          </span>
        </span>
      </div>

      <button
        className="btn danger"
        onClick={onKill}
        disabled={!openCount}
        title={openCount ? `Market-close all ${openCount} bot position(s) — external positions are never touched` : 'No bot position open'}
      >
        <span className="btn-ico">
          <IconKill />
        </span>
        <span className="kill-label">
          Kill<span className="hide-sm"> / Close all</span>
        </span>
      </button>

      {onOpenPnl && (
        <Btn className="only-mobile" size="sm" onClick={onOpenPnl} title="Show P&L chart">
          P&amp;L
        </Btn>
      )}
    </header>
  );
}

/* ---------------------------------------------------------------------------
   Nav row — view switcher + stream health + auto-trade master switch.
   ------------------------------------------------------------------------- */
export function NavRow({
  view,
  onView,
  status,
  wsUp,
  onToggleAuto,
  motionOn,
  onToggleMotion,
}: {
  view: ViewKey;
  onView: (v: ViewKey) => void;
  status: Status | null;
  wsUp: boolean;
  onToggleAuto: (v: boolean) => void;
  motionOn: boolean;
  onToggleMotion: () => void;
}) {
  const marketUp = !!status?.streams?.market || status?.feed === 'offline-demo';
  const userUp = !!status?.streams?.user;
  return (
    <nav className="navrow" aria-label="Views">
      <Segmented value={view} onChange={onView} items={NAV} className="nav-seg" ariaLabel="Dashboard sections" />

      <div className="spacer" />

      <div className="streams hide-md" title="Realtime connections">
        <span className="stream">
          <i className={`dot ${wsUp ? 'on' : 'off'}`} /> UI
        </span>
        <span className="stream">
          <i className={`dot ${marketUp ? 'on' : 'off'}`} /> MARKET
        </span>
        <span className="stream" title="Binance user-data stream (fills, fees, balance)">
          <i className={`dot ${userUp ? 'on' : 'off'}`} /> USER
        </span>
      </div>

      <button
        className={`motion-toggle ${motionOn ? 'is-on' : ''}`}
        onClick={onToggleMotion}
        title={motionOn ? 'Motion graphics ON — click to calm the UI' : 'Motion graphics OFF — click to re-enable'}
        aria-pressed={motionOn}
      >
        <IconWaves />
        <span className="hide-sm">Motion</span>
        <i className="motion-led" />
      </button>

      <label className={`auto-switch ${status?.autoTrade ? 'is-on' : ''}`} title="Auto-trading master switch">
        <span className="auto-label">
          <b>Auto-Trade</b>
          <em>{status?.autoTrade ? 'executing signals' : 'signals logged only'}</em>
        </span>
        <span className="switch">
          <input type="checkbox" checked={!!status?.autoTrade} onChange={(e) => onToggleAuto(e.target.checked)} />
          <span className="slider" />
        </span>
      </label>
    </nav>
  );
}

/* ---------------------------------------------------------------------------
   Ticker — scanner verdicts as an infinite liquid marquee.
   ------------------------------------------------------------------------- */
export function Ticker({ rows }: { rows: { symbol: string; state: string; volatility?: number; tradable?: boolean }[] }) {
  if (!rows.length) return null;
  const items = [...rows, ...rows];
  return (
    <div className="ticker" aria-hidden="true">
      <div className="ticker-track">
        {items.map((r, i) => {
          const bull = /bull|long/i.test(r.state);
          const bear = /bear|short/i.test(r.state);
          return (
            <span key={`${r.symbol}-${i}`} className={`ticker-item ${bull ? 'bull' : bear ? 'bear' : ''}`}>
              <i className="dot-state" />
              <span className="sym">{r.symbol.replace('USDT', '')}</span>
              <span>{bull ? '▲ BULL' : bear ? '▼ BEAR' : r.state}</span>
              {r.volatility != null && <span style={{ color: 'var(--dim)' }}>vol {fmt(r.volatility, 0)}</span>}
              {r.tradable && <span className="chip green" style={{ padding: '0 5px' }}>TRADE</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default Topbar;

import { ReactNode } from 'react';
import { Status } from '../types';
import { fmt } from '../api';
import { useFlash } from '../hooks/motion';
import { BrandMark, IconBolt, IconChart, IconCandles, IconGauge, IconHistory, IconKill, IconSettings, IconWaves } from '../motion/Icons';
import { AnimatedNumber, Btn, Segmented } from '../motion/primitives';

export type ViewKey = 'dash' | 'chart' | 'trades' | 'settings';

const NAV: { value: ViewKey; label: string; icon: ReactNode }[] = [
  { value: 'dash', label: 'Dashboard', icon: <IconGauge /> },
  { value: 'chart', label: 'Chart', icon: <IconCandles /> },
  { value: 'trades', label: 'Trades', icon: <IconHistory /> },
  { value: 'settings', label: 'Settings', icon: <IconSettings /> },
];

/* ---------------------------------------------------------------------------
   Topbar — identity, live market read-outs, panic control.
   ------------------------------------------------------------------------- */
export function Topbar({
  status,
  wsUp,
  onKill,
  onOpenSheet,
}: {
  status: Status | null;
  wsUp: boolean;
  onKill: () => void;
  onOpenSheet?: () => void;
}) {
  const mode = status?.mode ?? 'paper';
  const price = status?.price ?? 0;
  const bal = status?.balance;
  const open = status?.openTrade ?? null;
  const flash = useFlash(price, 850);
  const unPnl = open?.unrealized ?? 0;

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
          <span className="brand-sub">Super Indibot · 5m · USD-M Futures</span>
        </span>
      </div>

      <span className={`badge-mode ${mode}`}>
        <i className="led" />
        {mode === 'paper' ? 'Paper' : mode === 'testnet' ? 'Testnet' : 'Live Money'}
      </span>

      {status?.feed === 'offline-demo' && (
        <span className="badge-mode warn" title="Binance is unreachable from this server — synthetic demo feed at 10× speed. Signal and execution logic stay live.">
          <i className="led" />
          Offline Feed
        </span>
      )}

      <div className="spacer" />

      <div className={`stat-pod ${flash ? `is-${flash}` : ''}`} title={`${status?.symbol ?? ''} last price`}>
        <span className="pod-ico">
          <IconChart />
        </span>
        <span className="pod-body">
          <span className="pod-k">{status?.symbol ?? 'Symbol'}</span>
          <span className={`pod-v value-flash-${flash ?? 'none'}`}>{priceNode}</span>
        </span>
      </div>

      <div className="stat-pod hide-md" title="Account equity">
        <span className="pod-ico">
          <IconBolt />
        </span>
        <span className="pod-body">
          <span className="pod-k">Equity · {bal?.source === 'paper' ? 'paper' : 'usdt-m'}</span>
          <span className="pod-v">
            {bal?.total != null ? <AnimatedNumber value={bal.total} decimals={2} /> : '—'}
            <span style={{ fontSize: 9.5, color: 'var(--dim)', marginLeft: 4 }}>USDT</span>
          </span>
        </span>
      </div>

      {open && (
        <div className={`stat-pod ${unPnl >= 0 ? 'is-up' : 'is-down'} hide-sm`} title="Open position P&L">
          <span className="pod-ico">
            <IconWaves />
          </span>
          <span className="pod-body">
            <span className="pod-k">Open P&L</span>
            <span className={`pod-v ${unPnl >= 0 ? 'up' : 'down'}`}>
              <AnimatedNumber value={unPnl} decimals={2} signed />
            </span>
          </span>
        </div>
      )}

      <button
        className="btn danger"
        onClick={onKill}
        disabled={!open}
        title={open ? 'Market-close the open position and cancel all orders' : 'No position open'}
      >
        <span className="btn-ico">
          <IconKill />
        </span>
        <span className="kill-label">
          Kill<span className="hide-sm"> / Close</span>
        </span>
      </button>

      {onOpenSheet && (
        <Btn className="only-mobile" size="sm" onClick={onOpenSheet} title="Show P&L chart">
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
  return (
    <nav className="navrow" aria-label="Views">
      <Segmented value={view} onChange={onView} items={NAV} className="nav-seg" ariaLabel="Dashboard sections" />

      <div className="spacer" />

      <div className="streams hide-md" title="Realtime connections">
        <span className="stream">
          <i className={`dot ${wsUp ? 'on' : 'off'}`} /> UI
        </span>
        <span className="stream">
          <i className={`dot ${wsUp ? 'on' : 'off'}`} /> MARKET
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
   Ticker — screener state as an infinite liquid marquee.
   ------------------------------------------------------------------------- */
export function Ticker({ rows }: { rows: { symbol: string; state: string }[] }) {
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
              <span>{bull ? '▲ BULL' : bear ? '▼ BEAR' : '— FLAT'}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default Topbar;

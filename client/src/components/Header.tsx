import { Status } from '../types';
import { fmt } from '../api';

interface Props {
  status: Status | null;
  wsUp: boolean;
  onToggleAuto: (v: boolean) => void;
  onKill: () => void;
}

export default function Header({ status, wsUp, onToggleAuto, onKill }: Props) {
  const mode = status?.mode ?? 'paper';
  const price = status?.price ?? 0;
  const bal = status?.balance;
  const hasTrade = !!status?.openTrade;

  return (
    <header className="topbar">
      <div className="logo">
        VELOCITY<span className="X x">X</span>
        <span className="sub">SUPER INDIBOT · 5m · USD-M</span>
      </div>

      <span className={`badge ${mode}`}>{mode === 'paper' ? 'PAPER' : mode === 'testnet' ? 'BINANCE TESTNET' : '🔴 LIVE'}</span>

      {status?.feed === 'offline-demo' && (
        <span className="badge" style={{ background: 'rgba(255,152,0,.12)', color: 'var(--orange)', border: '1px solid rgba(255,152,0,.45)' }}
          title="Binance API unreachable from this server — synthetic demo data (10× clock). Signals & trading logic are fully live; prices are simulated.">
          OFFLINE DEMO FEED
        </span>
      )}

      <div className="hstat">
        <span className="lbl">{status?.symbol ?? '—'} · Price</span>
        <span className="val">{price ? price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}</span>
      </div>

      <div className="hstat">
        <span className="lbl">Balance ({bal?.source === 'paper' ? 'Paper' : 'USDT-M'})</span>
        <span className="val">
          {bal?.total != null ? fmt(bal.total, 2) : '—'} <span style={{ fontSize: 10, color: 'var(--muted)' }}>USDT</span>
        </span>
      </div>

      <div className="hstat">
        <span className="lbl">Auto-Trading</span>
        <span className="row" style={{ gap: 8 }}>
          <label className="switch" title="Enable automatic trade execution">
            <input type="checkbox" checked={!!status?.autoTrade} onChange={(e) => onToggleAuto(e.target.checked)} />
            <span className="slider" />
          </label>
          <span className="val" style={{ fontSize: 12, color: status?.autoTrade ? 'var(--green)' : 'var(--muted)' }}>
            {status?.autoTrade ? 'ON' : 'OFF'}
          </span>
        </span>
      </div>

      <div className="spacer" />

      <div className="hstat" title="Live price stream">
        <span className="lbl">Streams</span>
        <span className="val" style={{ fontSize: 11 }}>
          <span className={`dot ${wsUp ? 'on' : 'off'}`} />UI
          <span className={`dot ${wsUp ? 'on' : 'off'}`} style={{ marginLeft: 8 }} />MARKET
        </span>
      </div>

      <button className="btn danger" onClick={onKill} disabled={!hasTrade} title="Close the open position immediately">
        ⛔ KILL / CLOSE
      </button>
    </header>
  );
}

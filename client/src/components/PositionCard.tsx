import { Trade } from '../types';
import { fmt, fmtPrice, fmtQtyN } from '../api';

interface Props {
  trade: Trade;
  price: number;
  onKill: () => void;
}

export default function PositionCard({ trade: t, price, onKill }: Props) {
  const long = t.side === 'LONG';
  const unreal = t.unrealized ?? (price ? (price - t.entryPrice) * (long ? 1 : -1) * t.qty : 0);
  const unPct = t.margin > 0 ? (unreal / t.margin) * 100 : 0;
  const slLabel = t.slStage === 0 ? `ATR×2 STOP` : t.slStage === 1 ? 'BREAKEVEN' : 'AT TP1';
  const slClass = t.slStage === 0 ? '' : t.slStage === 1 ? 'be' : 'tp1lvl';

  return (
    <div className="card">
      <div className="card-head">
        <span>Open Position · Executed by bot</span>
        <span style={{ color: 'var(--muted)', fontSize: 10 }}>{new Date(t.openedAt).toLocaleString()}</span>
      </div>
      <div className="card-body">
        <div className="pos-head">
          <span className={`side-badge ${t.side}`}>{t.side} · {t.leverage}x</span>
          <div>
            <div className={`pnl-big ${unreal >= 0 ? 'up' : 'down'}`}>
              {unreal >= 0 ? '+' : ''}{fmt(unreal)} USDT
            </div>
            <div className="pnl-sub">{unPct >= 0 ? '+' : ''}{fmt(unPct)}% on margin · realized {t.realizedPnl >= 0 ? '+' : ''}{fmt(t.realizedPnl)}</div>
          </div>
          <div className="spacer" />
          <div style={{ textAlign: 'right' }}>
            <div className="k" style={{ fontSize: 10, color: 'var(--muted)' }}>MARK</div>
            <div style={{ fontSize: 17, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmtPrice(price)}</div>
          </div>
        </div>

        <div className="pos-grid">
          <div className="cell"><div className="k">Entry</div><div className="v">{fmtPrice(t.entryPrice)}</div></div>
          <div className="cell"><div className="k">Quantity</div><div className="v">{fmtQtyN(t.qty)}</div></div>
          <div className="cell"><div className="k">Notional</div><div className="v">{fmt(t.notional)} USDT</div></div>
          <div className="cell"><div className="k">Margin ({fmt(t.margin)} @ {t.leverage}x)</div><div className="v">{fmt(t.margin, 2)}</div></div>
          <div className="cell"><div className="k">ATR(14) at entry</div><div className="v">{fmtPrice(t.atrAtEntry)}</div></div>
          <div className="cell"><div className="k">Risk (1R)</div><div className="v">{fmt(t.initialRisk)} USDT</div></div>
        </div>

        <div className="ladder">
          <div className={`tp-row sl ${slClass}`}>
            <span className="lvl" style={{ color: 'var(--red)' }}>SL</span>
            <span className="px">{fmtPrice(t.slCurrent)}</span>
            <span className="pct">initial {fmtPrice(t.slInitial)}</span>
            <span className={`chip ${t.slStage === 0 ? 'pending' : t.slStage === 1 ? 'be' : 'tp1'}`}>{slLabel}</span>
          </div>
          <div className={`tp-row ${t.tp1Filled ? 'hit' : ''}`}>
            <span className="lvl">TP1</span>
            <span className="px">{fmtPrice(t.tp1)}</span>
            <span className="pct">1.5R · close 33% ({fmtQtyN(t.q1)})</span>
            <span className={`chip ${t.tp1Filled ? 'hit' : 'pending'}`}>{t.tp1Filled ? 'HIT ✓' : 'WAITING'}</span>
          </div>
          <div className={`tp-row ${t.tp2Filled ? 'hit' : ''}`}>
            <span className="lvl">TP2</span>
            <span className="px">{fmtPrice(t.tp2)}</span>
            <span className="pct">3R · close 50% of remaining ({fmtQtyN(t.q2)})</span>
            <span className={`chip ${t.tp2Filled ? 'hit' : 'pending'}`}>{t.tp2Filled ? 'HIT ✓' : 'WAITING'}</span>
          </div>
          <div className={`tp-row ${t.tp3Filled ? 'hit' : ''}`}>
            <span className="lvl">TP3</span>
            <span className="px">{fmtPrice(t.tp3)}</span>
            <span className="pct">4.5R · close full rest ({fmtQtyN(t.q3)})</span>
            <span className={`chip ${t.tp3Filled ? 'hit' : 'pending'}`}>{t.tp3Filled ? 'HIT ✓' : 'WAITING'}</span>
          </div>
        </div>

        <div className="row mt">
          <button className="btn danger" onClick={onKill}>Close position now</button>
          <span className="hint">
            Rule: TP1 → 33% out + SL→BE &nbsp;·&nbsp; TP2 → 50% of rest out + SL→TP1 &nbsp;·&nbsp; TP3 → full exit
          </span>
        </div>
      </div>
    </div>
  );
}

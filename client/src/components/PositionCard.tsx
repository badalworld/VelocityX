import { Trade } from '../types';
import { fmt, fmtPrice, fmtQtyN } from '../api';
import { AnimatedNumber, Btn, Panel } from '../motion/primitives';
import { IconKill, IconShield, IconTarget } from '../motion/Icons';

interface Props {
  trade: Trade;
  price: number;
  onKill: () => void;
}

/** Fraction of the way price has travelled from entry toward `level`. */
function progress(entry: number, level: number, price: number, long: boolean): number {
  if (!price || level === entry) return 0;
  const d = long ? (price - entry) / (level - entry) : (entry - price) / (entry - level);
  return Math.max(0, Math.min(1, d)) * 100;
}

export default function PositionCard({ trade: t, price, onKill }: Props) {
  const long = t.side === 'LONG';
  const unreal = t.unrealized ?? (price ? (price - t.entryPrice) * (long ? 1 : -1) * t.qty : 0);
  const unPct = t.margin > 0 ? (unreal / t.margin) * 100 : 0;
  const rMultiple = t.initialRisk > 0 ? (unreal + t.realizedPnl) / t.initialRisk : 0;
  const slLabel = t.slStage === 0 ? 'ATR ×2 STOP' : t.slStage === 1 ? 'BREAKEVEN' : 'LOCKED AT TP1';
  const slClass = t.slStage === 0 ? '' : t.slStage === 1 ? 'lvl-be' : 'lvl-tp1';

  const rows: {
    key: string;
    lvl: string;
    px: number;
    note: string;
    chip: string;
    tone: string;
    hit: boolean;
    prog: number;
  }[] = [
    {
      key: 'sl',
      lvl: 'SL',
      px: t.slCurrent,
      note: `initial ${fmtPrice(t.slInitial)} · ${slLabel}`,
      chip: t.slStage === 0 ? 'ARMED' : t.slStage === 1 ? 'AT BE' : 'AT TP1',
      tone: `lvl-sl ${slClass}`,
      hit: t.slStage > 0,
      prog: progress(t.entryPrice, t.slCurrent, price, long),
    },
    {
      key: 'tp1',
      lvl: 'TP1',
      px: t.tp1,
      note: `1.5R · close 33% · ${fmtQtyN(t.q1)}`,
      chip: t.tp1Filled ? 'HIT' : 'WAITING',
      tone: 'lvl-tp',
      hit: t.tp1Filled,
      prog: progress(t.entryPrice, t.tp1, price, long),
    },
    {
      key: 'tp2',
      lvl: 'TP2',
      px: t.tp2,
      note: `3R · close 50% of rest · ${fmtQtyN(t.q2)}`,
      chip: t.tp2Filled ? 'HIT' : 'WAITING',
      tone: 'lvl-tp',
      hit: t.tp2Filled,
      prog: progress(t.entryPrice, t.tp2, price, long),
    },
    {
      key: 'tp3',
      lvl: 'TP3',
      px: t.tp3,
      note: `4.5R · full exit · ${fmtQtyN(t.q3)}`,
      chip: t.tp3Filled ? 'HIT' : 'WAITING',
      tone: 'lvl-tp',
      hit: t.tp3Filled,
      prog: progress(t.entryPrice, t.tp3, price, long),
    },
  ];

  return (
    <Panel
      title="Open Position"
      sub="executed by bot"
      icon={<IconTarget />}
      meta={new Date(t.openedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
      className="glass-frost"
      headSlot={
        <span className={`side-badge ${t.side}`}>
          {long ? '▲' : '▼'} {t.side} · {t.leverage}x
        </span>
      }
    >
      <div className="pos-head">
        <div>
          <div className={`pnl-big ${unreal >= 0 ? 'up' : 'down'}`}>
            <AnimatedNumber value={unreal} decimals={2} signed />
            <span className="cur">USDT</span>
          </div>
          <div className="pnl-sub">
            <span className={`chip ${unreal >= 0 ? 'green' : 'red'}`}>
              {unPct >= 0 ? '+' : ''}
              {fmt(unPct)}% on margin
            </span>
            <span className={`chip ${rMultiple >= 0 ? 'green' : 'red'}`}>
              {rMultiple >= 0 ? '+' : ''}
              {fmt(rMultiple, 2)}R live
            </span>
            <span className="hint">realised {t.realizedPnl >= 0 ? '+' : ''}{fmt(t.realizedPnl)} USDT</span>
          </div>
        </div>

        <div className="spacer" />

        <div style={{ textAlign: 'right' }}>
          <div className="pod-k">MARK PRICE</div>
          <div style={{ fontSize: 19, fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{fmtPrice(price)}</div>
          <div className="pod-k" style={{ marginTop: 2 }}>
            entry {fmtPrice(t.entryPrice)}
          </div>
        </div>
      </div>

      <div className="pos-grid">
        <div className="cell">
          <div className="k">Quantity</div>
          <div className="v">{fmtQtyN(t.qty)}</div>
        </div>
        <div className="cell">
          <div className="k">Notional</div>
          <div className="v">{fmt(t.notional)}</div>
        </div>
        <div className="cell">
          <div className="k">Margin @ {t.leverage}x</div>
          <div className="v">{fmt(t.margin)}</div>
        </div>
        <div className="cell">
          <div className="k">ATR at entry</div>
          <div className="v">{fmtPrice(t.atrAtEntry)}</div>
        </div>
        <div className="cell">
          <div className="k">Risk (1R)</div>
          <div className="v">{fmt(t.initialRisk)}</div>
        </div>
        <div className="cell">
          <div className="k">Fees</div>
          <div className="v">{fmt(t.fees, 3)}</div>
        </div>
      </div>

      <div className="ladder">
        {rows.map((row) => (
          <div key={row.key} className={`lad-row ${row.tone} ${row.hit ? 'is-hit' : ''}`}>
            <span className="lad-lvl" style={{ color: row.key === 'sl' ? 'var(--red)' : 'var(--green)' }}>
              {row.lvl}
            </span>
            <span className="lad-track">
              <span className="lad-fill" style={{ width: `${row.prog.toFixed(1)}%` }} />
            </span>
            <span className="lad-px">{fmtPrice(row.px)}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
              <span className="lad-note hide-sm">{row.note}</span>
              <span className={`chip ${row.hit ? 'green' : row.key === 'sl' ? 'amber' : ''}`}>{row.chip}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="row mt" style={{ flexWrap: 'wrap' }}>
        <Btn variant="danger" icon={<IconKill />} onClick={onKill}>
          Close position now
        </Btn>
        <span className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <IconShield style={{ width: 13, height: 13, color: 'var(--cyan)' }} />
          TP1 → 33% out + SL→BE · TP2 → 50% of rest + SL→TP1 · TP3 → full exit
        </span>
      </div>
    </Panel>
  );
}

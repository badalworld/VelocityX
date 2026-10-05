import { Mtf, ScreenerData, Status } from '../types';
import { fmtPrice } from '../api';

export function TrendDashboard({ mtf, status }: { mtf: Mtf | null; status: Status | null }) {
  if (!mtf) return <div className="empty">Loading trend…</div>;
  const ribbon = status?.engine?.ribbonBull ?? mtf.ribbonBull;
  return (
    <div className="card-body" style={{ padding: '6px 12px' }}>
      {mtf.timeframes.map((t) => (
        <div className="kv-row" key={t.tf}>
          <span className="k">{t.tf}</span>
          <span className="v" style={{ color: t.bull ? 'var(--green)' : 'var(--red)' }}>
            {t.bull ? '▲ Bullish' : '▼ Bearish'}
          </span>
        </div>
      ))}
      <div className="kv-row">
        <span className="k">Current TF (ribbon)</span>
        <span className="v" style={{ color: ribbon ? 'var(--green)' : 'var(--red)' }}>
          {ribbon ? 'Bullish' : 'Bearish'}
        </span>
      </div>
      <div className="kv-row">
        <span className="k">ATR(14)</span>
        <span className="v">{fmtPrice(status?.engine?.atr ?? mtf.atr)}</span>
      </div>
      <div className="kv-row">
        <span className="k">Overall</span>
        <span className="v" style={{ color: mtf.overall === 'BULLISH' ? 'var(--green)' : 'var(--red)' }}>
          {mtf.overall}
        </span>
      </div>
    </div>
  );
}

export function Screener({ data }: { data: ScreenerData | null }) {
  if (!data) return <div className="empty">Loading screener…</div>;
  return (
    <div className="card-body" style={{ padding: '8px 12px' }}>
      {data.rows.map((r) => (
        <div className="kv-row" key={r.symbol}>
          <span className="k" style={{ color: 'var(--text)', fontWeight: 600 }}>{r.symbol}</span>
          <span className={`st ${r.state}`}>{r.state}</span>
        </div>
      ))}
    </div>
  );
}

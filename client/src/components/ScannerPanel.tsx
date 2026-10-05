import { ScanResult, ScannerRow } from '../types';
import { fmt, fmtPrice } from '../api';
import { AnimatedNumber, Panel } from '../motion/primitives';
import { IconRadar, IconTrend } from '../motion/Icons';

/* ============================================================================
   Market Scanner — volatility ranked, top to bottom, Binance data only.
   Only **trending** high-volatility markets are ever marked TRADE; pegged /
   stable / staked ("copy or stack") markets are rejected by name and by
   behaviour and can never reach the executor.
   ========================================================================== */

export function VolatilityBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const tone = pct >= 66 ? 'red' : pct >= 33 ? 'amber' : 'cyan';
  return (
    <span className="bar-track" style={{ height: 6, minWidth: 54, flex: '1 1 auto' }} title={`volatility ${fmt(value, 1)}/100`}>
      <span className={`bar-fill ${tone}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

export function VerdictChip({ row }: { row: ScannerRow }) {
  if (row.tradable) {
    return <span className="chip green">TRADE · {row.trend === 'UP' ? '▲ LONG' : '▼ SHORT'}</span>;
  }
  if (row.marketType === 'PEGGED') return <span className="chip red">PEGGED</span>;
  if (row.marketType === 'RANGING') return <span className="chip amber">RANGING</span>;
  if (row.marketType === 'QUIET') return <span className="chip">QUIET</span>;
  return <span className="chip">{row.marketType}</span>;
}

export function ScannerTable({ scan, limit = 14, compact = false }: { scan: ScanResult | null; limit?: number; compact?: boolean }) {
  if (!scan || !scan.rows?.length) {
    return <div className="empty">Scanner is warming up — reading the Binance USD-M universe…</div>;
  }
  const rows = scan.rows.slice(0, limit);
  const selected = new Set(scan.selected ?? []);
  return (
    <div className="table-wrap">
      <table className="tbl scr-tbl">
        <thead>
          <tr>
            <th>#</th>
            <th>Market</th>
            <th style={{ minWidth: 80 }}>Volatility</th>
            <th className="r">24h range</th>
            <th className="r">ATR%</th>
            <th className="r">ADX</th>
            <th className="r">Trend</th>
            {!compact && <th className="r">Funding</th>}
            {!compact && <th className="r">24h volume</th>}
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.symbol} className={selected.has(r.symbol) ? 'row-selected' : ''} title={r.reason}>
              <td style={{ color: 'var(--dim)' }}>{i + 1}</td>
              <td>
                <span style={{ fontWeight: 800 }}>{r.base}</span>
                <span style={{ color: 'var(--dim)', fontSize: 10, marginLeft: 4 }}>/USDT</span>
                {selected.has(r.symbol) && <span className="chip cyan" style={{ marginLeft: 6 }}>engine</span>}
              </td>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <VolatilityBar value={r.volatility} />
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>{fmt(r.volatility, 1)}</span>
                </div>
              </td>
              <td className="r">{fmt(r.range24hPct, 1)}%</td>
              <td className="r">{fmt(r.atrPct, 2)}%</td>
              <td className="r">{fmt(r.adx, 1)}</td>
              <td className={`r ${r.trend === 'UP' ? 'pos' : 'neg'}`}>{r.trend === 'UP' ? '▲ Bull' : '▼ Bear'}</td>
              {!compact && <td className={`r ${r.fundingRate >= 0 ? 'pos' : 'neg'}`}>{fmt(r.fundingRate * 100, 4)}%</td>}
              {!compact && <td className="r">{fmt(r.quoteVolume24h / 1e6, 0)}M</td>}
              <td>
                <VerdictChip row={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ScannerPanel({ scan, onScan, scanning }: { scan: ScanResult | null; onScan?: () => void; scanning?: boolean }) {
  const selected = scan?.selected ?? [];
  return (
    <Panel
      title="Market Scanner"
      sub="volatility ranked · trending only"
      icon={<IconRadar />}
      meta={
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="chip cyan">{scan?.analysed ?? 0} scanned</span>
          <span className="chip green">{selected.length} trading</span>
          {onScan && (
            <button className="btn sm" onClick={onScan} disabled={scanning}>
              {scanning ? 'Scanning…' : 'Rescan'}
            </button>
          )}
        </span>
      }
      bodyClass="flush"
    >
      <ScannerTable scan={scan} limit={10} compact />
      <div className="hint" style={{ padding: '10px 12px' }}>
        <IconTrend style={{ width: 12, height: 12, color: 'var(--cyan)', verticalAlign: '-2px' }} /> Only{' '}
        <b>trending, high-volatility</b> markets pass: 24h range ≥ {scan?.gate?.minRange24hPct ?? '—'}% · ATR ≥{' '}
        {scan?.gate?.minAtrPct ?? '—'}% · ADX ≥ {scan?.gate?.minAdx ?? '—'} · volume ≥{' '}
        {scan?.gate ? fmt(scan.gate.minQuoteVolume24h / 1e6, 0) : '—'}M. Pegged / stable / staked markets are rejected.
      </div>
    </Panel>
  );
}

export function ScannerSummary({ scan }: { scan: ScanResult | null }) {
  const rows = scan?.rows ?? [];
  const trending = rows.filter((r) => r.marketType === 'TRENDING').length;
  const pegged = rows.filter((r) => r.marketType === 'PEGGED').length;
  const avgVol = rows.length ? rows.reduce((a, r) => a + r.volatility, 0) / rows.length : 0;
  const top = rows[0];
  return (
    <div className="mini-grid">
      <div className="mini">
        <div className="k">Universe scanned</div>
        <div className="v">
          <AnimatedNumber value={scan?.universe ?? 0} decimals={0} /> pairs
        </div>
      </div>
      <div className="mini">
        <div className="k">Analysed</div>
        <div className="v">
          <AnimatedNumber value={scan?.analysed ?? 0} decimals={0} />
        </div>
      </div>
      <div className="mini">
        <div className="k">Trending</div>
        <div className="v up">{trending}</div>
      </div>
      <div className="mini">
        <div className="k">Rejected pegged</div>
        <div className="v down">{pegged}</div>
      </div>
      <div className="mini">
        <div className="k">Avg volatility</div>
        <div className="v">{fmt(avgVol, 1)}</div>
      </div>
      <div className="mini">
        <div className="k">Most volatile</div>
        <div className="v">{top ? top.base : '—'}</div>
      </div>
      <div className="mini">
        <div className="k">Engine symbols</div>
        <div className="v" style={{ fontSize: 12 }}>
          {(scan?.selected ?? []).map((s) => s.replace('USDT', '')).join(' · ') || '—'}
        </div>
      </div>
      <div className="mini">
        <div className="k">Scan age</div>
        <div className="v">{scan?.at ? `${Math.max(0, Math.round((Date.now() - scan.at) / 1000))}s` : '—'}</div>
      </div>
    </div>
  );
}

export function TopPicks({ scan }: { scan: ScanResult | null }) {
  const picks = (scan?.rows ?? []).filter((r) => r.tradable).slice(0, 8);
  if (!picks.length) return <div className="empty">No trending high-volatility market passed the gates right now.</div>;
  return (
    <div className="scr-grid">
      {picks.map((r) => (
        <div key={r.symbol} className={`scr-item ${r.trend === 'UP' ? 'bull' : 'bear'}`}>
          <span className="scr-sym">{r.base}</span>
          <span className={`scr-state ${r.trend === 'UP' ? 'bull' : 'bear'}`}>
            {r.trend === 'UP' ? '▲ LONG' : '▼ SHORT'}
          </span>
          <span className="hint" style={{ fontSize: 10 }}>
            vol {fmt(r.volatility, 0)} · ADX {fmt(r.adx, 0)} · {fmtPrice(r.price)}
          </span>
        </div>
      ))}
    </div>
  );
}

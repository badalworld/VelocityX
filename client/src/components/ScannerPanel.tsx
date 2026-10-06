import { OpportunityZone, ScanResult, ScannerRow } from '../types';
import { fmt, fmtPrice, timeAgo } from '../api';
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
  if (row.inOpportunityZone) {
    return <span className="chip green">ZONE · {row.opportunitySide === 'LONG' ? '▲ LONG' : '▼ SHORT'}</span>;
  }
  if (row.opportunity) return <span className="chip cyan">QUALIFIED</span>;
  if (row.tradable) return <span className="chip">TREND · SCANNING</span>;
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
            <th className="r">Setup</th>
            <th className="r">EMA gap</th>
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
            <tr
              key={r.symbol}
              className={selected.has(r.symbol) ? 'row-selected' : ''}
              title={r.opportunityReason || r.reason}
            >
              <td style={{ color: 'var(--dim)' }}>{i + 1}</td>
              <td>
                <span style={{ fontWeight: 800 }}>{r.base}</span>
                <span style={{ color: 'var(--dim)', fontSize: 10, marginLeft: 4 }}>/USDT</span>
                {selected.has(r.symbol) && <span className="chip cyan" style={{ marginLeft: 6 }}>zone</span>}
              </td>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <VolatilityBar value={r.volatility} />
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>{fmt(r.volatility, 1)}</span>
                </div>
              </td>
              <td className={`r ${(r.setupScore ?? 0) >= (scan?.gate?.minOpportunityScore ?? 65) ? 'pos' : ''}`}>
                {fmt(r.setupScore, 0)}
              </td>
              <td className="r">{fmt(r.emaGapAtr, 2)} ATR</td>
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
          <span className="chip cyan">{scan?.analysed ?? 0}/{scan?.target ?? 50} scanned</span>
          <span className="chip green">{selected.length} zones</span>
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
        <IconTrend style={{ width: 12, height: 12, color: 'var(--cyan)', verticalAlign: '-2px' }} /> Fifty assets are
        analysed every cycle. Only <b>aligned, trending markets near a fresh 5m EMA cross</b> move into the retained
        opportunity monitor: quality ≥ {scan?.gate?.minOpportunityScore ?? '—'} · gap ≤{' '}
        {scan?.gate?.maxEmaGapAtr ?? '—'} ATR. The score is rules-based setup quality, not a profit guarantee.
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
        <div className="k">Opportunity zones</div>
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

function zoneTone(zone: OpportunityZone): string {
  if (zone.state === 'EXECUTED') return 'executed';
  if (zone.state === 'TRIGGERED') return 'triggered';
  return zone.side === 'LONG' ? 'long' : 'short';
}

/** Persistent hand-off between the 50-asset scanner and the execution engine. */
export function OpportunityQueue({ scan }: { scan: ScanResult | null }) {
  const zones = scan?.opportunities ?? [];
  const progress = scan?.progress;
  const progressPct = progress?.target ? Math.min(100, (progress.completed / progress.target) * 100) : 0;
  return (
    <div className="opp-wrap">
      {progress?.running && (
        <div className="scan-progress" role="status" aria-live="polite">
          <span className="scan-progress-copy">
            Parallel scan in progress <b>{progress.completed}/{progress.target || 50}</b>
            {progress.failed ? ` · ${progress.failed} unavailable` : ''}
          </span>
          <span className="bar-track"><span className="bar-fill" style={{ width: `${progressPct}%` }} /></span>
        </div>
      )}
      {!zones.length ? (
        <div className="empty">
          No asset is inside the opportunity zone right now. The 50-asset scan continues; no order is sent until a
          qualified setup is retained and its confirmed 5m signal fires.
        </div>
      ) : (
        <div className="opp-grid">
          {zones.map((zone) => {
            const mins = Math.max(0, Math.ceil((zone.expiresAt - Date.now()) / 60_000));
            return (
              <article key={zone.symbol} className={`opp-card ${zoneTone(zone)}`} title={zone.reason}>
                <div className="opp-head">
                  <span>
                    <b>{zone.base}</b><small>/USDT</small>
                  </span>
                  <span className={`chip ${zone.state === 'MONITORING' ? 'green' : zone.state === 'TRIGGERED' ? 'amber' : 'cyan'}`}>
                    {zone.state}
                  </span>
                </div>
                <div className={`opp-side ${zone.side === 'LONG' ? 'pos' : 'neg'}`}>
                  {zone.side === 'LONG' ? '▲ LONG setup' : '▼ SHORT setup'}
                </div>
                <div className="opp-score">
                  <span className="bar-track"><span className="bar-fill green" style={{ width: `${Math.max(0, Math.min(100, zone.score))}%` }} /></span>
                  <b>{fmt(zone.score, 0)}</b><small>quality</small>
                </div>
                <dl className="opp-meta">
                  <div><dt>EMA gap</dt><dd>{fmt(zone.emaGapAtr, 2)} ATR</dd></div>
                  <div><dt>ADX</dt><dd>{fmt(zone.adx, 1)}</dd></div>
                  <div><dt>Zone age</dt><dd>{timeAgo(zone.enteredAt)}</dd></div>
                  <div><dt>{zone.state === 'MONITORING' ? 'Retained' : 'Signal'}</dt><dd>{zone.state === 'MONITORING' ? `${mins}m` : zone.signalAt ? timeAgo(zone.signalAt) : '—'}</dd></div>
                </dl>
                <p>{zone.reason}</p>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TopPicks({ scan }: { scan: ScanResult | null }) {
  const picks = (scan?.rows ?? [])
    .filter((r) => r.tradable)
    .sort((a, b) => (b.setupScore ?? 0) - (a.setupScore ?? 0))
    .slice(0, 8);
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
            quality {fmt(r.setupScore, 0)} · gap {fmt(r.emaGapAtr, 2)} ATR · {fmtPrice(r.price)}
          </span>
        </div>
      ))}
    </div>
  );
}

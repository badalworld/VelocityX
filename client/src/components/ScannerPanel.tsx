import { OpportunityZone, ScanResult, ScannerRow } from '../types';
import { fmt, fmtPrice, timeAgo } from '../api';
import { AnimatedNumber, Panel } from '../motion/primitives';
import { IconRadar, IconTrend } from '../motion/Icons';

/* ============================================================================
   Market Scanner — ranks liquid, active USD-M markets for dedicated monitoring.
   It never predicts the entry side: closed 5m liquidity/POC rules create signals.
   Pegged/stable/staked markets are rejected before they reach the monitor.
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
  if (row.inOpportunityZone) return <span className="chip green">MONITOR · BOTH SIDES</span>;
  if (row.opportunity) return <span className="chip cyan">MONITOR CANDIDATE</span>;
  if (row.tradable) return <span className="chip">LIQUID · SCANNING</span>;
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
            <th className="r">Monitor score</th>
            <th className="r">24h range</th>
            <th className="r">ATR 15m</th>
            {!compact && <th className="r">Funding</th>}
            {!compact && <th className="r">24h volume</th>}
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.symbol} className={selected.has(r.symbol) ? 'row-selected' : ''} title={r.opportunityReason || r.reason}>
              <td style={{ color: 'var(--dim)' }}>{i + 1}</td>
              <td>
                <span style={{ fontWeight: 800 }}>{r.base}</span>
                <span style={{ color: 'var(--dim)', fontSize: 10, marginLeft: 4 }}>/USDT</span>
                {selected.has(r.symbol) && <span className="chip cyan" style={{ marginLeft: 6 }}>watching</span>}
              </td>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <VolatilityBar value={r.volatility} />
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>{fmt(r.volatility, 1)}</span>
                </div>
              </td>
              <td className="r">{fmt(r.setupScore ?? r.score, 0)}</td>
              <td className="r">{fmt(r.range24hPct, 1)}%</td>
              <td className="r">{fmt(r.atrPct, 2)}%</td>
              {!compact && <td className={`r ${r.fundingRate >= 0 ? 'pos' : 'neg'}`}>{fmt(r.fundingRate * 100, 4)}%</td>}
              {!compact && <td className="r">{fmt(r.quoteVolume24h / 1e6, 0)}M</td>}
              <td><VerdictChip row={r} /></td>
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
      sub="liquid markets · both directions"
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
        <IconTrend style={{ width: 12, height: 12, color: 'var(--cyan)', verticalAlign: '-2px' }} /> Fifty liquid/activity-ranked assets are analysed each cycle. Zones only select symbols for the 5m engine; <b>neither EMA trend nor monitor score triggers an entry</b>. The signal itself requires a closed-candle sweep → POC reclaim → retest.
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
  return zone.side === 'LONG' ? 'long' : zone.side === 'SHORT' ? 'short' : 'both';
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
          No symbols are retained for dedicated monitoring right now. The market scan continues; no order is sent until a later closed 5m candle confirms the sweep → POC reclaim → retest sequence.
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
                <div className={`opp-side ${zone.side === 'LONG' ? 'pos' : zone.side === 'SHORT' ? 'neg' : 'both'}`}>
                  {zone.side === 'LONG' ? '▲ LONG monitor' : zone.side === 'SHORT' ? '▼ SHORT monitor' : '↕ BOTH SIDES'}
                </div>
                <div className="opp-score">
                  <span className="bar-track"><span className="bar-fill cyan" style={{ width: `${Math.max(0, Math.min(100, zone.score))}%` }} /></span>
                  <b>{fmt(zone.score, 0)}</b><small>monitor score</small>
                </div>
                <dl className="opp-meta">
                  <div><dt>ATR 15m</dt><dd>{fmt(zone.atrPct, 2)}%</dd></div>
                  <div><dt>ATR 5m</dt><dd>{fmt(zone.atrPct5m, 2)}%</dd></div>
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
  if (!picks.length) return <div className="empty">No market passed the current liquidity and activity gates.</div>;
  return (
    <div className="scr-grid">
      {picks.map((r) => (
        <div key={r.symbol} className="scr-item">
          <span className="scr-sym">{r.base}</span>
          <span className="scr-state neutral">MONITOR · BOTH SIDES</span>
          <span className="hint" style={{ fontSize: 10 }}>
            score {fmt(r.setupScore ?? r.score, 0)} · range {fmt(r.range24hPct, 1)}% · {fmtPrice(r.price)}
          </span>
        </div>
      ))}
    </div>
  );
}

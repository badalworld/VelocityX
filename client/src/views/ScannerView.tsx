import { ScanResult, Status } from '../types';
import { fmt } from '../api';
import { AnimatedNumber, Panel } from '../motion/primitives';
import { OpportunityQueue, ScannerSummary, ScannerTable, TopPicks } from '../components/ScannerPanel';
import { IconAlert, IconRadar, IconShield, IconTrend } from '../motion/Icons';

/* ============================================================================
   Scanner view — liquid markets and their dedicated 5m sweep monitors.
   ========================================================================== */

export default function ScannerView({
  scan,
  status,
  scanning,
  onScan,
}: {
  scan: ScanResult | null;
  status: Status | null;
  scanning: boolean;
  onScan: () => void;
}) {
  const selected = new Set(scan?.selected ?? []);
  const slots = status?.slots ?? { used: 0, max: status?.maxPositions ?? 8 };
  const execution = status?.execution;
  const progress = scan?.progress;

  return (
    <>
      <section className="panel hero" data-reveal="true">
        <div className="hero-main">
          <span className="hero-kicker">
            <span className="chip cyan">
              <IconRadar style={{ width: 12, height: 12 }} /> market scanner
            </span>
            <span className="chip green">binance USD-M universe</span>
          </span>
          <h1 className="hero-title">Liquid markets watched. Sweeps confirmed before any entry.</h1>
          <p className="hero-sub">
            Each cycle ranks up to fifty active USD-M markets for monitoring. The 5m engine independently waits for a 30-bar liquidity sweep, close back inside, POC reclaim and later retest/rejection. No EMA crossover or scanner score triggers an entry; orders still require the server-side execution gate.
          </p>
        </div>
        <div className="hero-metrics">
          <div className="hero-metric">
            <span className="hm-k">Universe</span>
            <span className="hm-v">
              <AnimatedNumber value={scan?.universe ?? 0} decimals={0} />
            </span>
          </div>
          <div className="hero-metric">
            <span className="hm-k">50-asset batch</span>
            <span className="hm-v">
              {progress?.running ? progress.completed : scan?.analysed ?? 0}/{progress?.target || scan?.target || 50}
            </span>
          </div>
          <div className="hero-metric">
            <span className="hm-k">Opportunity zones</span>
            <span className="hm-v up">{selected.size}</span>
          </div>
          <div className="hero-metric">
            <span className="hm-k">Position slots</span>
            <span className="hm-v">
              {slots.used}/{slots.max}
            </span>
          </div>
          <div className="hero-metric">
            <span className="hm-k">Real execution</span>
            <span className={`hm-v ${execution?.state === 'READY' ? 'up' : execution?.state === 'BLOCKED' ? 'down' : ''}`}>
              {execution?.state ?? 'CHECKING'}
            </span>
          </div>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={onScan} disabled={scanning}>
          {scanning ? 'Scanning the market…' : 'Rescan now'}
        </button>
      </section>

      <div className={`feed-banner ${execution?.state === 'READY' ? 'ok' : execution?.state === 'BLOCKED' ? 'error' : 'warn'}`} role="status">
        <span className={`led-dot ${execution?.state === 'READY' ? 'on' : ''}`} />
        <b>Execution bridge: {execution?.state ?? 'CHECKING'}</b>
        <span>
          {execution?.state === 'READY'
            ? 'Frontend state and backend gate agree: armed, Binance connected, account trade-enabled, streams fresh and scanner current.'
            : execution?.state === 'DISARMED'
              ? 'Infrastructure is ready, but auto-trade is OFF. Signals are recorded and never replayed later.'
              : execution?.reasons?.slice(0, 3).join(' · ') || 'Waiting for the backend readiness checks.'}
        </span>
      </div>

      <Panel
        title="Opportunity Zone"
        sub="retained monitor · confirmed signal required"
        icon={<IconTrend />}
        meta={<span className="chip green">{selected.size} monitoring</span>}
      >
        <OpportunityQueue scan={scan} />
        <div className="hint mt">
          Watched symbols stay on the 5m engine while the next market scan runs. Scanner score only ranks monitoring priority and is not a setup probability. Execution still requires a fresh sweep/POC signal, auto-trade, available position capacity and Binance preflight.
        </div>
      </Panel>

      <div className="grid-2">
        <Panel title="Monitor Candidates" sub="activity ranked · no direction bias" icon={<IconTrend />} meta={`${(scan?.rows ?? []).filter((r) => r.tradable).length} liquid`}>
          <TopPicks scan={scan} />
          <div className="hint mt">
            The score is for monitoring priority only. Both LONG and SHORT sweep/POC setups are evaluated; at most {slots.max} real positions can run at once.
          </div>
        </Panel>

        <Panel title="Scan Summary" sub="volatility distribution" icon={<IconRadar />} meta={scan?.at ? new Date(scan.at).toLocaleTimeString([], { hour12: false }) : '—'}>
          <ScannerSummary scan={scan} />
        </Panel>
      </div>

      <Panel
        title="Full Ranking"
        sub="50-asset batch · liquidity/activity ranked · both sides monitored"
        icon={<IconRadar />}
        bodyClass="flush"
        meta={
          <span style={{ display: 'flex', gap: 6 }}>
            <span className="chip cyan">{scan?.analysed ?? 0} markets</span>
            <span className="chip green">{selected.size} zones</span>
          </span>
        }
      >
        <ScannerTable scan={scan} limit={60} />
      </Panel>

      <div className="grid-2">
        <Panel title="Trade Gates" sub="your rules, enforced" icon={<IconShield />}>
          <div className="mini-grid">
            <div className="mini"><div className="k">Min 24h volume</div><div className="v">{fmt((scan?.gate?.minQuoteVolume24h ?? 0) / 1e6, 0)}M</div></div>
            <div className="mini"><div className="k">Min 24h range</div><div className="v">{fmt(scan?.gate?.minRange24hPct ?? 0, 1)}%</div></div>
            <div className="mini"><div className="k">Min ATR (15m)</div><div className="v">{fmt(scan?.gate?.minAtrPct ?? 0, 2)}%</div></div>
            <div className="mini"><div className="k">Monitor-zone cap</div><div className="v">{scan?.gate?.maxOpportunityZones ?? '—'}</div></div>
            <div className="mini"><div className="k">Zone retention</div><div className="v">{scan?.gate?.zoneRetentionMin ?? 0} min</div></div>
            <div className="mini"><div className="k">Max positions</div><div className="v">{scan?.gate?.maxPositions ?? 8}</div></div>
            <div className="mini"><div className="k">Scan duration</div><div className="v">{scan?.durationMs ? `${scan.durationMs} ms` : '—'}</div></div>
          </div>
          <div className="hint warn mt">
            <IconAlert style={{ width: 13, height: 13, verticalAlign: '-2px', marginRight: 4 }} />
            Pegged (<span className="mono">USDC, FDUSD, EUR…</span>), staked/wrapped (<span className="mono">BNSOL, WBETH, BTC-pegs…</span>)
            and index markets are hard-rejected; a pair whose 24h range collapses is treated as pegged even if the ticker
            claims otherwise.
          </div>
        </Panel>

        <Panel title="Dedicated Monitor" sub="retained symbols · both directions" icon={<IconTrend />} meta={`${(status?.scanner?.selected ?? []).length} symbols`}>
          {(status?.scanner?.selected ?? []).length === 0 ? (
            <div className="empty">No symbols are currently retained for dedicated 5m sweep monitoring.</div>
          ) : (
            <div className="scr-grid">
              {(status?.scanner?.selected ?? []).map((s) => (
                <div key={s} className="scr-item">
                  <span className="scr-sym">{s.replace('USDT', '')}</span>
                  <span className="scr-state neutral">sweep monitor · both sides</span>
                </div>
              ))}
              <div className="scr-item">
                <span className="scr-sym">{(status?.symbol ?? 'BTCUSDT').replace('USDT', '')}</span>
                <span className="scr-state neutral">primary chart</span>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

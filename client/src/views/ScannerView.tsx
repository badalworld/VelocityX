import { ScanResult, Status } from '../types';
import { fmt } from '../api';
import { AnimatedNumber, Panel } from '../motion/primitives';
import { ScannerSummary, ScannerTable, TopPicks } from '../components/ScannerPanel';
import { IconAlert, IconRadar, IconShield, IconTrend } from '../motion/Icons';

/* ============================================================================
   Scanner view — the whole ranked market, top volatility first.
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
          <h1 className="hero-title">Highest volatility markets, ranked top to down</h1>
          <p className="hero-sub">
            The scanner sweeps every Binance USDT-M perpetual, ranks it by volatility (24h range · ATR% · 24h move) and
            keeps only markets that are genuinely <b>trending</b>. Pegged, stable, staked and index markets are rejected
            by name and by behaviour — the bot never trades a copy or stack market.
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
            <span className="hm-k">Analysed</span>
            <span className="hm-v">
              <AnimatedNumber value={scan?.analysed ?? 0} decimals={0} />
            </span>
          </div>
          <div className="hero-metric">
            <span className="hm-k">Trading now</span>
            <span className="hm-v up">{selected.size}</span>
          </div>
          <div className="hero-metric">
            <span className="hm-k">Position slots</span>
            <span className="hm-v">
              {slots.used}/{slots.max}
            </span>
          </div>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={onScan} disabled={scanning}>
          {scanning ? 'Scanning the market…' : 'Rescan now'}
        </button>
      </section>

      <div className="grid-2">
        <Panel title="Top Picks" sub="passed every gate" icon={<IconTrend />} meta={`${(scan?.rows ?? []).filter((r) => r.tradable).length} markets`}>
          <TopPicks scan={scan} />
          <div className="hint mt">
            These symbols are handed to the signal engine. Signals still have to fire (EMA11/EMA34) before a
            position is opened, and at most {slots.max} positions can run at once.
          </div>
        </Panel>

        <Panel title="Scan Summary" sub="volatility distribution" icon={<IconRadar />} meta={scan?.at ? new Date(scan.at).toLocaleTimeString([], { hour12: false }) : '—'}>
          <ScannerSummary scan={scan} />
        </Panel>
      </div>

      <Panel
        title="Full Ranking"
        sub="volatility descending"
        icon={<IconRadar />}
        bodyClass="flush"
        meta={
          <span style={{ display: 'flex', gap: 6 }}>
            <span className="chip cyan">{scan?.analysed ?? 0} markets</span>
            <span className="chip green">{selected.size} engine</span>
          </span>
        }
      >
        <ScannerTable scan={scan} limit={60} />
      </Panel>

      <div className="grid-2">
        <Panel title="Trade Gates" sub="your rules, enforced" icon={<IconShield />}>
          <div className="mini-grid">
            <div className="mini">
              <div className="k">Min 24h volume</div>
              <div className="v">{fmt((scan?.gate?.minQuoteVolume24h ?? 0) / 1e6, 0)}M</div>
            </div>
            <div className="mini">
              <div className="k">Min 24h range</div>
              <div className="v">{fmt(scan?.gate?.minRange24hPct ?? 0, 1)}%</div>
            </div>
            <div className="mini">
              <div className="k">Min ATR (15m)</div>
              <div className="v">{fmt(scan?.gate?.minAtrPct ?? 0, 2)}%</div>
            </div>
            <div className="mini">
              <div className="k">Min ADX (trend)</div>
              <div className="v">{fmt(scan?.gate?.minAdx ?? 0, 0)}</div>
            </div>
            <div className="mini">
              <div className="k">Max positions</div>
              <div className="v">{scan?.gate?.maxPositions ?? 8}</div>
            </div>
            <div className="mini">
              <div className="k">Scan cadence</div>
              <div className="v">{scan?.durationMs ? `${scan.durationMs} ms` : '—'}</div>
            </div>
          </div>
          <div className="hint warn mt">
            <IconAlert style={{ width: 13, height: 13, verticalAlign: '-2px', marginRight: 4 }} />
            Pegged (<span className="mono">USDC, FDUSD, EUR…</span>), staked/wrapped (<span className="mono">BNSOL, WBETH, BTC-pegs…</span>)
            and index markets are hard-rejected; a pair whose 24h range collapses is treated as pegged even if the ticker
            claims otherwise.
          </div>
        </Panel>

        <Panel title="Engine Watchlist" sub="symbols under the signal engine" icon={<IconTrend />} meta={`${(status?.scanner?.selected ?? []).length} symbols`}>
          {(status?.scanner?.selected ?? []).length === 0 ? (
            <div className="empty">Scanner has not selected a tradable market yet.</div>
          ) : (
            <div className="scr-grid">
              {(status?.scanner?.selected ?? []).map((s) => (
                <div key={s} className="scr-item bull">
                  <span className="scr-sym">{s.replace('USDT', '')}</span>
                  <span className="scr-state bull">being watched</span>
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

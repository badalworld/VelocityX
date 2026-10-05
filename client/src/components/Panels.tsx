import { Mtf, ScreenerData, Status } from '../types';
import { fmtPrice } from '../api';
import { LiquidLoader, Panel } from '../motion/primitives';
import { IconActivity, IconRadar, IconTrend } from '../motion/Icons';

/* ============================================================================
   Trend + Screener panels — motion-heavy, zero charts.
   ========================================================================== */

export function TrendGauge({ mtf, status }: { mtf: Mtf | null; status: Status | null }) {
  if (!mtf) return <LiquidLoader label="Reading multi-timeframe trend…" />;

  const tfs = mtf.timeframes ?? [];
  const bullCount = mtf.bullCount ?? tfs.filter((t) => t.bull).length;
  const total = Math.max(1, tfs.length);
  const frac = bullCount / total;
  const bullish = (mtf.overall || '').toUpperCase().startsWith('BULL') || frac > 0.5;
  const ribbon = status?.engine?.ribbonBull ?? mtf.ribbonBull;
  const color = bullish ? '#23dd8a' : '#ff4f74';
  const color2 = bullish ? '#34f0b2' : '#ff9a6b';

  // semicircle arc: M 20 100 A 80 80 0 0 1 180 100  (length = π·80)
  const R = 80;
  const cx = 100;
  const cy = 100;
  const theta = Math.PI * (1 - frac);
  const dotX = cx + R * Math.cos(theta);
  const dotY = cy - R * Math.sin(theta);

  return (
    <div className="trend">
      <div className="gauge">
        <svg className="gauge-svg" viewBox="0 0 200 118" aria-label="Multi-timeframe trend gauge">
          <defs>
            <linearGradient id="vx-gauge" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={color} stopOpacity="0.55" />
              <stop offset="100%" stopColor={color2} />
            </linearGradient>
          </defs>
          <path className="gauge-track" d={`M 20 100 A ${R} ${R} 0 0 1 180 100`} />
          <path
            className="gauge-fill"
            d={`M 20 100 A ${R} ${R} 0 0 1 180 100`}
            stroke="url(#vx-gauge)"
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1 - frac}
            style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(.22,1,.36,1)' }}
          />
          <circle cx={dotX} cy={dotY} r="5" fill={color2} opacity="0.9" />
          <circle cx={dotX} cy={dotY} r="10" fill="none" stroke={color2} strokeOpacity="0.35" />
          <text x="20" y="114" fontSize="8.4" fill="rgba(255,255,255,.34)">
            BEARISH
          </text>
          <text x="180" y="114" fontSize="8.4" fill="rgba(255,255,255,.34)" textAnchor="end">
            BULLISH
          </text>
        </svg>
        <div className="gauge-center">
          <div className={`gauge-verdict ${bullish ? 'bull' : 'bear'}`}>{bullish ? 'Bullish' : 'Bearish'}</div>
          <div className="gauge-sub">
            {bullCount}/{total} timeframes agree
          </div>
        </div>
      </div>

      <div className="tf-chips">
        {tfs.map((t) => (
          <span key={t.tf} className={`tf-chip ${t.bull ? 'bull' : 'bear'}`}>
            <span className="tf-arrow">{t.bull ? '▲' : '▼'}</span>
            {t.tf}
          </span>
        ))}
        <span className={`tf-chip ${ribbon ? 'bull' : 'bear'}`} title="EMA ribbon state on the current timeframe">
          <span className="tf-arrow">{ribbon ? '▲' : '▼'}</span>
          RIBBON
        </span>
      </div>

      <div className="mini-grid mt">
        <div className="mini">
          <div className="k">ATR (14)</div>
          <div className="v">{fmtPrice(status?.engine?.atr ?? mtf.atr)}</div>
        </div>
        <div className="mini">
          <div className="k">Overall</div>
          <div className={`v ${bullish ? 'up' : 'down'}`}>{mtf.overall ?? (bullish ? 'BULLISH' : 'BEARISH')}</div>
        </div>
        <div className="mini">
          <div className="k">Signal TF</div>
          <div className="v">{status?.interval ?? '5m'} · EMA cross</div>
        </div>
      </div>
    </div>
  );
}

export function TrendPanel({ mtf, status }: { mtf: Mtf | null; status: Status | null }) {
  return (
    <Panel title="Trend Engine" sub="MTF" icon={<IconTrend />} meta="ribbon live">
      <TrendGauge mtf={mtf} status={status} />
    </Panel>
  );
}

export function ScreenerGrid({ data, loading }: { data: ScreenerData | null; loading?: boolean }) {
  if (!data || !data.rows?.length) return <LiquidLoader label={loading ? 'Scanning symbols…' : 'No screener rows'} />;
  return (
    <div className="scr-grid">
      {data.rows.map((r) => {
        const bull = /bull|long/i.test(r.state);
        const bear = /bear|short/i.test(r.state);
        return (
          <div key={r.symbol} className={`scr-item ${bull ? 'bull' : bear ? 'bear' : ''}`}>
            <span className="scr-sym">{r.symbol}</span>
            <span className={`scr-state ${bull ? 'bull' : bear ? 'bear' : 'neutral'}`}>
              {bull ? 'Bullish' : bear ? 'Bearish' : r.state}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ScreenerPanel({ data }: { data: ScreenerData | null }) {
  return (
    <Panel title="Screener" sub="5m EMA Cross" icon={<IconRadar />} meta={`${data?.rows?.length ?? 0} symbols`}>
      <ScreenerGrid data={data} />
    </Panel>
  );
}

export function ActivityPanel({ logs }: { logs: { t: number; level: string; msg: string }[] }) {
  const rows = logs.slice(-140).reverse();
  return (
    <Panel
      title="Live Activity"
      sub="engine feed"
      icon={<IconActivity />}
      meta={
        <span className="chip live">
          streaming
        </span>
      }
      bodyClass="flush"
    >
      {rows.length === 0 ? (
        <div className="empty">The engine has not logged anything yet.</div>
      ) : (
        <div className="feed" style={{ padding: '10px 12px' }}>
          {rows.map((l, i) => (
            <div className={`feed-line ${l.level}`} key={`${l.t}-${i}`}>
              <span className="feed-ts">{new Date(l.t).toLocaleTimeString([], { hour12: false })}</span>
              <span className="feed-msg">{l.msg}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

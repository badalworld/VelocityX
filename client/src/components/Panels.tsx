import { ScreenerData } from '../types';
import { LiquidLoader, Panel } from '../motion/primitives';
import { IconActivity, IconRadar } from '../motion/Icons';

/* ============================================================================
   Screener + activity panels — motion-heavy, zero charts.
   ========================================================================== */

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

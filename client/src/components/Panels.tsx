import { Panel } from '../motion/primitives';
import { IconActivity } from '../motion/Icons';

/* ============================================================================
   Live activity panel — the engine's own log ring.
   ========================================================================== */

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

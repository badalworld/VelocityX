import { SignalRecord, Trade } from '../types';
import { fmt, fmtPrice, fmtQtyN } from '../api';
import { Panel } from '../motion/primitives';
import { IconBolt, IconHistory, IconRadar } from '../motion/Icons';

/* ============================================================================
   History — trade journal, signal log and raw engine feed.
   Rows stagger in as the view scrolls, so long logs feel choreographed.
   ========================================================================== */

const rowStyle = (i: number) => ({
  animation: 'log-in 420ms cubic-bezier(.22,1,.36,1) both',
  animationDelay: `${Math.min(420, i * 26)}ms`,
});

export function TradeHistory({ trades, embedded }: { trades: Trade[]; embedded?: boolean }) {
  if (trades.length === 0)
    return <div className="empty">No trades yet — the bot books its first position the moment a signal fires.</div>;

  const body = (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Opened</th>
            <th>Side</th>
            <th className="r">Entry</th>
            <th className="r">Qty</th>
            <th>Result</th>
            <th>Exit reason</th>
            <th className="r">PnL</th>
            <th className="r">R</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => {
            const r = t.initialRisk > 0 ? t.realizedPnl / t.initialRisk : 0;
            const open = t.status === 'OPEN';
            return (
              <tr key={t.id} style={rowStyle(i)}>
                <td style={{ color: 'var(--muted)' }}>
                  {new Date(t.openedAt).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </td>
                <td style={{ color: t.side === 'LONG' ? 'var(--green)' : 'var(--red)', fontWeight: 800 }}>{t.side}</td>
                <td className="r">{fmtPrice(t.entryPrice)}</td>
                <td className="r">{fmtQtyN(t.qty)}</td>
                <td>
                  <span className={`tag ${open ? 'OPEN' : t.result ?? 'NEUTRAL'}`}>
                    {open ? 'OPEN' : t.result ?? '—'}
                  </span>
                </td>
                <td style={{ color: 'var(--muted)' }}>{open ? 'live' : t.closeReason ?? '—'}</td>
                <td className={`r ${t.realizedPnl >= 0 ? 'pos' : 'neg'}`}>
                  {open ? fmt(t.realizedPnl) : `${t.realizedPnl >= 0 ? '+' : ''}${fmt(t.realizedPnl)}`}
                </td>
                <td className={`r ${r >= 0 ? 'pos' : 'neg'}`}>{open ? '—' : `${r >= 0 ? '+' : ''}${fmt(r, 2)}R`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  if (embedded) return body;
  return (
    <Panel
      title="Trade History"
      sub={`${trades.length} records`}
      icon={<IconHistory />}
      bodyClass="flush"
      meta="newest first"
    >
      {body}
    </Panel>
  );
}

export function SignalList({ signals, currentSymbol, embedded }: { signals: SignalRecord[]; currentSymbol: string; embedded?: boolean }) {
  const rows = signals.filter((s) => s.symbol === currentSymbol).slice(0, 60);
  if (rows.length === 0) return <div className="empty">No signals detected yet on {currentSymbol}.</div>;

  const body = (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Candle</th>
            <th>Side</th>
            <th className="r">Price</th>
            <th className="r">ATR</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => (
            <tr key={s.id} style={rowStyle(i)}>
              <td style={{ color: 'var(--muted)' }}>
                {new Date(s.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </td>
              <td style={{ color: s.side === 'LONG' ? 'var(--green)' : 'var(--red)', fontWeight: 800 }}>{s.side}</td>
              <td className="r">{fmtPrice(s.price)}</td>
              <td className="r">{fmtPrice(s.atr)}</td>
              <td>
                <span className={`chip ${s.acted ? 'green' : ''}`}>{s.acted ? 'traded' : 'logged'}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (embedded) return body;
  return (
    <Panel title="Signal Log" sub={currentSymbol} icon={<IconRadar />} bodyClass="flush" meta={`${rows.length} recent`}>
      {body}
    </Panel>
  );
}

export function LogFeed({ logs, embedded }: { logs: { t: number; level: string; msg: string }[]; embedded?: boolean }) {
  const rows = [...logs].slice(-200).reverse();
  if (rows.length === 0) return <div className="empty">Activity log is empty.</div>;
  const body = (
    <div className="feed" style={{ padding: '10px 12px' }}>
      {rows.map((l, i) => (
        <div className={`feed-line ${l.level}`} key={`${l.t}-${i}`} style={rowStyle(Math.min(i, 14))}>
          <span className="feed-ts">{new Date(l.t).toLocaleTimeString([], { hour12: false })}</span>
          <span className="feed-msg">{l.msg}</span>
        </div>
      ))}
    </div>
  );
  if (embedded) return body;
  return (
    <Panel title="Activity" sub="engine + executor" icon={<IconBolt />} bodyClass="flush" meta="live">
      {body}
    </Panel>
  );
}

export function TradesSummary({ trades }: { trades: Trade[] }) {
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const wins = closed.filter((t) => t.realizedPnl > 0).length;
  const net = closed.reduce((s, t) => s + t.realizedPnl, 0);
  const best = closed.length ? Math.max(...closed.map((t) => t.realizedPnl)) : 0;
  const worst = closed.length ? Math.min(...closed.map((t) => t.realizedPnl)) : 0;
  const open = trades.filter((t) => t.status === 'OPEN').length;
  return (
    <div className="mini-grid">
      <div className="mini">
        <div className="k">Closed / Open</div>
        <div className="v">
          {closed.length} <span style={{ color: 'var(--dim)' }}>/</span> {open}
        </div>
      </div>
      <div className="mini">
        <div className="k">Wins</div>
        <div className="v up">{wins}</div>
      </div>
      <div className="mini">
        <div className="k">Losses</div>
        <div className="v down">{closed.length - wins}</div>
      </div>
      <div className="mini">
        <div className="k">Net realised</div>
        <div className={`v ${net >= 0 ? 'up' : 'down'}`}>{fmt(net)}</div>
      </div>
      <div className="mini">
        <div className="k">Best trade</div>
        <div className="v up">+{fmt(best)}</div>
      </div>
      <div className="mini">
        <div className="k">Worst trade</div>
        <div className="v down">{fmt(worst)}</div>
      </div>
    </div>
  );
}

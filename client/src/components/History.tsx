import { SignalRecord, Trade } from '../types';
import { fmt, fmtPrice, fmtQtyN } from '../api';

export function TradeHistory({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) return <div className="empty">No trades yet — signals will appear here once executed.</div>;
  return (
    <div className="scroll-x">
      <table className="hist">
        <thead>
          <tr>
            <th>Opened</th><th>Side</th><th>Entry</th><th>Qty</th><th>Result</th><th>Reason</th><th>PnL</th><th>R</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const r = t.initialRisk > 0 ? t.realizedPnl / t.initialRisk : 0;
            return (
              <tr key={t.id}>
                <td>{new Date(t.openedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                <td style={{ color: t.side === 'LONG' ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{t.side}</td>
                <td>{fmtPrice(t.entryPrice)}</td>
                <td>{fmtQtyN(t.qty)}</td>
                <td>
                  <span className={`tag ${t.status === 'OPEN' ? 'OPEN' : t.result ?? ''}`}>
                    {t.status === 'OPEN' ? 'OPEN' : t.result ?? '—'}
                  </span>
                </td>
                <td style={{ color: 'var(--muted)' }}>{t.status === 'OPEN' ? '—' : t.closeReason}</td>
                <td className={t.realizedPnl >= 0 ? 'pos' : 'neg'}>
                  {t.status === 'OPEN' ? fmt(t.realizedPnl) : `${t.realizedPnl >= 0 ? '+' : ''}${fmt(t.realizedPnl)}`}
                </td>
                <td className={r >= 0 ? 'pos' : 'neg'}>{t.status === 'OPEN' ? '—' : `${r >= 0 ? '+' : ''}${fmt(r, 2)}R`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function SignalList({ signals, currentSymbol }: { signals: SignalRecord[]; currentSymbol: string }) {
  const rows = signals.filter((s) => s.symbol === currentSymbol).slice(0, 40);
  if (rows.length === 0) return <div className="empty">No signals detected yet on {currentSymbol} 5m.</div>;
  return (
    <div className="scroll-x">
      <table className="hist">
        <thead>
          <tr><th>Candle</th><th>Side</th><th>Price</th><th>ATR</th><th>Action</th></tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td>{new Date(s.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
              <td style={{ color: s.side === 'LONG' ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{s.side}</td>
              <td>{fmtPrice(s.price)}</td>
              <td>{fmtPrice(s.atr)}</td>
              <td style={{ color: s.acted ? 'var(--accent)' : 'var(--muted)' }}>
                {s.acted ? 'TRADED ✓' : 'logged'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LogFeed({ logs }: { logs: { t: number; level: string; msg: string }[] }) {
  if (logs.length === 0) return <div className="empty">Activity log is empty.</div>;
  return (
    <div className="logfeed">
      {[...logs].reverse().map((l, i) => (
        <div className={`line ${l.level}`} key={`${l.t}-${i}`}>
          <span className="ts">{new Date(l.t).toLocaleTimeString([], { hour12: false })}</span>
          <span className="msg">{l.msg}</span>
        </div>
      ))}
    </div>
  );
}

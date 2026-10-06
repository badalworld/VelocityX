import { useState } from 'react';
import { apiPost, fmt, fmtPrice } from '../api';
import { BacktestResult } from '../types';
import { IconAlert, IconChart } from '../motion/Icons';

export default function BacktestPanel({ symbol, disabled, onError }: { symbol: string; disabled?: boolean; onError: (message: string) => void }) {
  const [days, setDays] = useState(30);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);

  const run = async () => {
    setRunning(true);
    try {
      const next = await apiPost<BacktestResult>('/backtest/run', {
        symbol: symbol.toUpperCase().trim(),
        days,
        startingBalance: 10_000,
        riskPercent: 1,
        feeRate: 0.0004,
        slippageBps: 2,
      });
      setResult(next);
    } catch (e: any) {
      onError(e?.message || 'Backtest failed');
    } finally {
      setRunning(false);
    }
  };

  const date = (time: number | null) => time ? new Date(time).toLocaleString() : '—';
  const topMetrics = result ? [
    ['Net P&L', `${result.netPnl >= 0 ? '+' : ''}${fmt(result.netPnl)} USDT`, result.netPnl >= 0 ? 'up' : 'down'],
    ['Return', `${result.returnPct >= 0 ? '+' : ''}${fmt(result.returnPct)}%`, result.returnPct >= 0 ? 'up' : 'down'],
    ['Trades', String(result.closedTrades), ''],
    ['Win rate', `${fmt(result.winRatePct, 1)}%`, ''],
    ['Expectancy', `${result.expectancyR >= 0 ? '+' : ''}${fmt(result.expectancyR, 2)}R`, result.expectancyR >= 0 ? 'up' : 'down'],
    ['Max drawdown', `${fmt(result.maxDrawdownPct, 2)}%`, 'down'],
    ['Profit factor', result.profitFactor == null ? '∞*' : fmt(result.profitFactor, 2), ''],
    ['Fees', `${fmt(result.fees, 2)} USDT`, ''],
  ] : [];

  return (
    <div className="settings-sec">
      <h4><IconChart style={{ width: 14, height: 14, verticalAlign: '-2px', marginRight: 6 }} />Historical backtest — no orders</h4>
      <div className="frow">
        <label className="field">
          <span className="field-label">Symbol</span>
          <input className="input" value={symbol} readOnly aria-readonly="true" />
        </label>
        <label className="field">
          <span className="field-label">History</span>
          <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 14, 30, 60, 90].map((n) => <option key={n} value={n}>{n} days</option>)}
          </select>
        </label>
      </div>
      <div className="row mt" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn primary" type="button" onClick={run} disabled={running || disabled}>
          {running ? 'Fetching 5m candles…' : disabled ? 'Save strategy before testing' : `Run ${days}-day backtest`}
        </button>
        <span className="hint">Current saved strategy · 1% equity risk · 4 bps fee · 2 bps slippage</span>
      </div>
      <div className="hint warn mt" style={{ display: 'flex', gap: 7 }}>
        <IconAlert style={{ width: 14, height: 14, flex: 'none', marginTop: 2 }} />
        This is a historical OHLCV backtest, not paper trading or a profit forecast. POC approximates volume-at-price by spreading each 5m candle's volume across its full high-low range. Funding, liquidation, queue priority and market impact are not modeled.
      </div>

      {result && (
        <div className="col-stack mt" aria-live="polite">
          <div className="hint">{result.dataSource} · {result.candles.toLocaleString()} bars · {date(result.startTime)} — {date(result.endTime)}</div>
          <div className="mini-grid">
            {topMetrics.map(([label, value, tone]) => (
              <div className="mini" key={label}>
                <div className="k">{label}</div>
                <div className={`v ${tone}`}>{value}</div>
              </div>
            ))}
            {(['tp1', 'tp2', 'tp3', 'tp4', 'tp5'] as const).map((key, i) => (
              <div className="mini" key={key}>
                <div className="k">TP{i + 1} hits</div>
                <div className="v">{result.tpHitCounts[key]}</div>
              </div>
            ))}
          </div>
          {result.openPosition && (
            <div className="hint warn">
              Open at end: {result.openPosition.side} from {fmtPrice(result.openPosition.entryPrice)} · marked {result.openPosition.netPnl >= 0 ? '+' : ''}{fmt(result.openPosition.netPnl)} USDT ({fmt(result.openPosition.rMultiple, 2)}R); ending equity includes mark-to-market.
            </div>
          )}
          {result.trades.length > 0 && (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Opened</th><th>Side</th><th className="r">Entry</th><th>Exit</th><th className="r">Net P&amp;L</th><th className="r">R</th><th>TPs</th></tr></thead>
                <tbody>
                  {result.trades.slice(-8).reverse().map((trade, i) => (
                    <tr key={`${trade.entryTime}-${i}`}>
                      <td>{date(trade.entryTime)}</td>
                      <td className={trade.side === 'LONG' ? 'pos' : 'neg'}>{trade.side}</td>
                      <td className="r">{fmtPrice(trade.entryPrice)}</td>
                      <td>{trade.closeReason}</td>
                      <td className={`r ${trade.netPnl >= 0 ? 'pos' : 'neg'}`}>{trade.netPnl >= 0 ? '+' : ''}{fmt(trade.netPnl)}</td>
                      <td className={`r ${trade.rMultiple >= 0 ? 'pos' : 'neg'}`}>{trade.rMultiple >= 0 ? '+' : ''}{fmt(trade.rMultiple, 2)}R</td>
                      <td>{trade.tpHits.length ? trade.tpHits.map((n) => `TP${n}`).join(' · ') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details>
            <summary className="hint">Backtest assumptions</summary>
            <ul className="hint">{result.assumptions.map((item) => <li key={item}>{item}</li>)}</ul>
          </details>
        </div>
      )}
    </div>
  );
}

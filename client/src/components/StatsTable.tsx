import { Stats } from '../types';
import { fmt } from '../api';

export default function StatsTable({ stats }: { stats: Stats | null }) {
  if (!stats) return <div className="empty">Loading stats…</div>;
  const s = stats;
  const expPos = s.expectancy >= 0;
  return (
    <div className="card-body" style={{ padding: 0 }}>
      <table className="stats-table">
        <tbody>
          <tr>
            <td className="lbl">RR</td>
            <td className="num"><span className="pill cyan">1 : {fmt(s.rrRatio, 2)}</span></td>
            <td className="num"><span className="pill cyan">BE {fmt(s.breakevenRate, 1)}%</span></td>
          </tr>
          <tr className="hdr"><td>Level</td><td className="num">Hits</td><td className="num">Win %</td></tr>
          <tr>
            <td className="lbl">TP1 ({fmt(s.rrRatio, 2)}R)</td>
            <td className="num"><span className="pill green">{s.tp1Count}</span></td>
            <td className="num"><span className="pill cyan">{fmt(s.tp1Pct, 1)}%</span></td>
          </tr>
          <tr>
            <td className="lbl">TP2 ({fmt(s.rrRatio * 2, 2)}R)</td>
            <td className="num"><span className="pill green">{s.tp2Count}</span></td>
            <td className="num"><span className="pill cyan">{fmt(s.tp2Pct, 1)}%</span></td>
          </tr>
          <tr>
            <td className="lbl">TP3 ({fmt(s.rrRatio * 3, 2)}R)</td>
            <td className="num"><span className="pill green">{s.tp3Count}</span></td>
            <td className="num"><span className="pill cyan">{fmt(s.tp3Pct, 1)}%</span></td>
          </tr>
          <tr>
            <td className="lbl">SL (−1R)</td>
            <td className="num"><span className="pill red">{s.slCount}</span></td>
            <td className="num"><span className="pill red">{fmt(s.slPct, 1)}%</span></td>
          </tr>
          <tr>
            <td className="lbl">OVERALL WR</td>
            <td className="num"><span className="pill cyan">{s.winCount}W/{s.lossCount}L</span></td>
            <td className="num"><span className="pill cyan">{fmt(s.overallWinRate, 1)}%</span></td>
          </tr>
          <tr>
            <td className="lbl">EXPECTANCY</td>
            <td className="num"><span className={`pill ${expPos ? 'green' : 'red'}`}>{fmt(s.expectancy, 3)}R</span></td>
            <td className="num"><span className={`pill ${expPos ? 'green' : 'red'}`}>{expPos ? 'PROFIT' : 'LOSS'}</span></td>
          </tr>
          <tr>
            <td className="lbl">NET PnL ({s.windowDays}d)</td>
            <td className="num" colSpan={2}>
              <span className={`pill ${s.netPnl >= 0 ? 'green' : 'red'}`}>{s.netPnl >= 0 ? '+' : ''}{fmt(s.netPnl)} USDT</span>
            </td>
          </tr>
          <tr>
            <td className="lbl">Signals</td>
            <td className="num">{s.totalSignals}</td>
            <td className="num">{s.windowDays}d window</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

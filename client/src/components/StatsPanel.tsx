import { Stats } from '../types';
import { fmt } from '../api';
import { AnimatedNumber, BarRow, LiquidLoader, Panel, Ring } from '../motion/primitives';
import { IconLayers } from '../motion/Icons';

/* ============================================================================
   Weekly stats — presented as animated rings + liquid hit-rate bars.
   (No charts here by design: the dashboard stays metric-first.)
   ========================================================================== */

export function StatsBody({ stats }: { stats: Stats | null }) {
  if (!stats) return <LiquidLoader label="Crunching the trade journal…" />;
  const s = stats;
  const expPos = s.expectancy >= 0;

  return (
    <div className="col-stack">
      <div className="ring-grid" data-reveal-group>
        <Ring
          pct={s.overallWinRate}
          value={`${fmt(s.overallWinRate, 1)}%`}
          label="Win rate"
          color={s.overallWinRate >= 50 ? 'var(--green)' : 'var(--amber)'}
          glow={s.overallWinRate >= 50 ? 'rgba(35,221,138,.8)' : 'rgba(255,200,87,.8)'}
        />
        <Ring
          pct={s.tp3Pct}
          value={`${fmt(s.tp3Pct, 0)}%`}
          label="Full TP3"
          color="var(--cyan)"
          glow="rgba(62,240,255,.8)"
          delay={90}
        />
        <Ring
          pct={s.slPct}
          value={`${fmt(s.slPct, 0)}%`}
          label="Stopped"
          color="var(--red)"
          glow="rgba(255,79,116,.8)"
          delay={180}
        />
      </div>

      <div className="bars" data-reveal-group>
        <BarRow label="TP1" pct={s.tp1Pct} value={`${fmt(s.tp1Pct, 1)}%`} tone="green" />
        <BarRow label="TP2" pct={s.tp2Pct} value={`${fmt(s.tp2Pct, 1)}%`} tone="green" />
        <BarRow label="TP3" pct={s.tp3Pct} value={`${fmt(s.tp3Pct, 1)}%`} tone="green" />
        <BarRow label="SL" pct={s.slPct} value={`${fmt(s.slPct, 1)}%`} tone="red" />
        <BarRow label="Break-even" pct={s.breakevenRate} value={`${fmt(s.breakevenRate, 1)}%`} tone="cyan" />
      </div>

      <div className="mini-grid">
        <div className="mini">
          <div className="k">Net P&amp;L · {s.windowDays}d</div>
          <div className={`v ${s.netPnl >= 0 ? 'up' : 'down'}`}>
            <AnimatedNumber value={s.netPnl} decimals={2} signed unit="USDT" />
          </div>
        </div>
        <div className="mini">
          <div className="k">Expectancy</div>
          <div className={`v ${expPos ? 'up' : 'down'}`}>
            <AnimatedNumber value={s.expectancy} decimals={3} signed unit="R" />
          </div>
        </div>
        <div className="mini">
          <div className="k">RR ratio</div>
          <div className="v">1 : {fmt(s.rrRatio, 2)}</div>
        </div>
        <div className="mini">
          <div className="k">Closed trades</div>
          <div className="v">
            <AnimatedNumber value={s.totalClosedTrades} decimals={0} />
          </div>
        </div>
        <div className="mini">
          <div className="k">Wins / Losses</div>
          <div className="v">
            <span className="up">{s.winCount}</span>
            <span style={{ color: 'var(--dim)' }}> / </span>
            <span className="down">{s.lossCount}</span>
          </div>
        </div>
        <div className="mini">
          <div className="k">Fees paid</div>
          <div className="v">{fmt(s.totalFees, 2)}</div>
        </div>
        <div className="mini">
          <div className="k">Signals seen</div>
          <div className="v">
            <AnimatedNumber value={s.totalSignals} decimals={0} />
          </div>
        </div>
        <div className="mini">
          <div className="k">Verdict</div>
          <div className={`v ${expPos ? 'up' : 'down'}`}>{expPos ? 'PROFITABLE' : 'UNDER WATER'}</div>
        </div>
      </div>
    </div>
  );
}

export default function StatsPanel({ stats }: { stats: Stats | null }) {
  return (
    <Panel
      title="Weekly Statistics"
      sub={stats ? `${stats.windowDays}d window` : ''}
      icon={<IconLayers />}
      meta={stats ? `${stats.totalClosedTrades} closed` : ''}
    >
      <StatsBody stats={stats} />
    </Panel>
  );
}

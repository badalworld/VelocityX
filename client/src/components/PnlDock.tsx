import { useMemo } from 'react';
import { AccountView, Trade } from '../types';
import { PNL_RANGES, PnlRangeKey, usePnlModel } from '../pnl';
import { useLocalState } from '../hooks/motion';
import { AnimatedNumber, Segmented } from '../motion/primitives';
import PnlChart from './PnlChart';
import { IconCrown, IconDrop, IconScale } from '../motion/Icons';
import { fmt } from '../api';

/* ============================================================================
   PnlDock — the equity chart module that lives in the fixed rail.
   Every breakpoint keeps it on screen: sticky side rail on desktop, docked
   sheet on tablet/phone (collapsing to a live mini-readout).
   ========================================================================== */

export default function PnlDock({ account, trades }: { account: AccountView | null; trades: Trade[] }) {
  const [range, setRange] = useLocalState<PnlRangeKey>('vx.pnl.range', '7d');
  const model = usePnlModel(null, trades, account, range);

  const rangeLabel = useMemo(
    () => PNL_RANGES.find((r) => r.key === range)?.label ?? '7D',
    [range],
  );
  const up = model.net >= 0;

  return (
    <div className="pnl-dock">
      <div className="pnl-top">
        <div style={{ minWidth: 0 }}>
          <div className="pnl-axis-note" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            Cumulative P&amp;L
            <span className={`chip ${model.hasData ? (up ? 'green' : 'red') : ''}`}>
              {model.hasData ? `${model.trades} trades` : 'no closed trades'}
            </span>
          </div>
          <div className={`pnl-value ${up ? 'up' : 'down'}`}>
            <AnimatedNumber value={model.net} decimals={2} signed />
            <span className="cur">USDT</span>
          </div>
          <div className="pnl-sub">
            <span className={up ? 'up' : 'down'} style={{ fontWeight: 800 }}>
              {up ? '▲' : '▼'} <AnimatedNumber value={model.changePct} decimals={2} signed />%
            </span>
            <span style={{ color: 'var(--dim)' }}>vs {fmt(model.base, 2)} start equity</span>
          </div>
        </div>

        <Segmented
          value={range}
          onChange={setRange}
          items={PNL_RANGES.map((r) => ({ value: r.key, label: r.label }))}
          ariaLabel="P&L range"
        />
      </div>

      <PnlChart
        start={model.start}
        end={model.end}
        base={model.base}
        series={model.series}
        bars={model.bars}
        live={model.isLive}
        drawKey={range}
        height={218}
      />

      <div className="pnl-stats">
        <div className="pnl-stat">
          <div className="k">Win rate</div>
          <div className="v">
            {model.trades ? (
              <>
                <AnimatedNumber value={model.winRate} decimals={1} />
                <span style={{ fontSize: 10, color: 'var(--dim)' }}> %</span>
              </>
            ) : (
              '—'
            )}
          </div>
          <div className="k" style={{ marginTop: 2 }}>
            {model.wins}W / {model.losses}L
          </div>
        </div>
        <div className="pnl-stat">
          <div className="k">Avg R</div>
          <div className={`v ${model.avgR >= 0 ? 'up' : 'down'}`}>
            <AnimatedNumber value={model.avgR} decimals={2} signed unit="R" />
          </div>
          <div className="k" style={{ marginTop: 2 }}>
            expectancy
          </div>
        </div>
        <div className="pnl-stat">
          <div className="k">Max DD</div>
          <div className={`v ${model.maxDD < 0 ? 'down' : ''}`}>
            <AnimatedNumber value={model.maxDD} decimals={2} />
          </div>
          <div className="k" style={{ marginTop: 2 }}>
            <AnimatedNumber value={model.maxDDPct} decimals={1} />% peak
          </div>
        </div>
      </div>

      <div className="pnl-stats" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
        <div className="pnl-stat">
          <div className="k" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <IconCrown style={{ width: 11, height: 11 }} /> Best / Worst
          </div>
          <div className="v">
            <span className="up">
              +<AnimatedNumber value={Math.max(0, model.best)} decimals={2} />
            </span>
            <span style={{ color: 'var(--dim)' }}> / </span>
            <span className="down">
              <AnimatedNumber value={Math.min(0, model.worst)} decimals={2} />
            </span>
          </div>
        </div>
        <div className="pnl-stat">
          <div className="k" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <IconDrop style={{ width: 11, height: 11 }} /> Realized / Unreal
          </div>
          <div className="v">
            <span className={model.realized >= 0 ? 'up' : 'down'}>
              <AnimatedNumber value={model.realized} decimals={2} signed />
            </span>
            <span style={{ color: 'var(--dim)' }}> / </span>
            <span className={model.unrealized >= 0 ? 'up' : 'down'}>
              <AnimatedNumber value={model.unrealized} decimals={2} signed />
            </span>
          </div>
        </div>
      </div>

      <div className="hint" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <IconScale style={{ width: 12, height: 12, color: 'var(--cyan)' }} />
        Equity = Binance account equity · realised ladder + live unrealised on bot positions only · {rangeLabel} window
      </div>
    </div>
  );
}

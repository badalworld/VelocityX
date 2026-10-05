import { useMemo } from 'react';
import { Mtf, ScreenerData, Stats, Status, Trade } from '../types';
import { fmt, timeAgo } from '../api';
import { usePnlModel } from '../pnl';
import { AnimatedNumber, BarRow, Panel, Sparkline } from '../motion/primitives';
import PositionCard from '../components/PositionCard';
import StatsPanel from '../components/StatsPanel';
import { ActivityPanel, ScreenerPanel, TrendPanel } from '../components/Panels';
import { IconBolt, IconCoins, IconShield, IconSparkles, IconTarget, IconTrend } from '../motion/Icons';

interface Props {
  status: Status | null;
  stats: Stats | null;
  mtf: Mtf | null;
  screener: ScreenerData | null;
  trades: Trade[];
  logs: { t: number; level: string; msg: string }[];
  onKill: () => void;
}

function MiniBar({ pct, tone = 'cyan' }: { pct: number; tone?: 'cyan' | 'green' | 'red' }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <span className="bar-track" style={{ height: 6, flex: '1 1 auto' }}>
      <span className={`bar-fill ${tone === 'cyan' ? '' : tone}`} style={{ width: `${clamped}%` }} />
    </span>
  );
}

export default function Overview({ status, stats, mtf, screener, trades, logs, onKill }: Props) {
  const model = usePnlModel(status, trades, 'all');
  const open = status?.openTrade ?? null;
  const equity = status?.balance?.total ?? 0;
  const unPnl = open?.unrealized ?? 0;
  const totalPnl = model.realized + unPnl;

  const uptime = useMemo(() => {
    const started = status?.engine?.startedAt;
    if (!started) return '—';
    return timeAgo(started).replace(' ago', '');
  }, [status?.engine?.startedAt]);

  const spark = useMemo(() => (model.curve.length > 2 ? model.curve : [0, 0, 0]), [model.curve]);

  const kicker = (
    <>
      <span className="chip cyan">
        <IconSparkles style={{ width: 11, height: 11 }} /> liquid glass command deck
      </span>
      <span className={`badge-mode ${status?.mode ?? 'paper'}`} style={{ padding: '3px 9px', fontSize: 9.5 }}>
        {status?.mode ?? 'paper'}
      </span>
    </>
  );

  return (
    <>
      {/* ---------------- hero ---------------- */}
      <section className="panel hero" data-reveal="true">
        <div className="hero-main">
          <span className="hero-kicker">{kicker}</span>
          <h1 className="hero-title">
            {(status?.symbol ?? 'BTCUSDT').replace('USDT', '/USDT')} · {(status?.interval ?? '5m').toUpperCase()} automated desk
          </h1>
          <p className="hero-sub">
            Every statistic the engine knows, in one glass pane. Chart lives in its own tab — this view is metrics
            only, with the live equity curve pinned to the right on desktop and to the bottom on your phone.
          </p>
        </div>

        <div className="hero-metrics">
          <div className="hero-metric">
            <span className="hm-k">Equity</span>
            <span className="hm-v">
              <AnimatedNumber value={equity} decimals={2} />
            </span>
          </div>
          <div className="hero-metric">
            <span className="hm-k">Total P&amp;L</span>
            <span className={`hm-v ${totalPnl >= 0 ? 'up' : 'down'}`}>
              <AnimatedNumber value={totalPnl} decimals={2} signed />
            </span>
          </div>
          <div className="hero-metric">
            <span className="hm-k">Open R</span>
            <span className={`hm-v ${unPnl >= 0 ? 'up' : 'down'}`}>
              {open && open.initialRisk > 0 ? (
                <>
                  <AnimatedNumber value={(unPnl + open.realizedPnl) / open.initialRisk} decimals={2} signed />
                  <span style={{ fontSize: 11, color: 'var(--dim)' }}>R</span>
                </>
              ) : (
                '—'
              )}
            </span>
          </div>
          <div className="hero-metric">
            <span className="hm-k">Engine up</span>
            <span className="hm-v">{uptime}</span>
          </div>
        </div>

        <div className="spacer" />

        <div style={{ width: 'min(240px, 100%)' }}>
          <Sparkline data={spark} color={totalPnl >= 0 ? 'var(--green)' : 'var(--red)'} />
          <div className="hint" style={{ textAlign: 'right' }}>
            equity curve · {trades.length} trades logged
          </div>
        </div>
      </section>

      {/* ---------------- KPI pods ---------------- */}
      <div className="grid-4" data-reveal-group>
        <article className={`panel kpi tone-${totalPnl >= 0 ? 'green' : 'red'}`}>
          <div className="kpi-top">
            <span className="kpi-ico">
              <IconCoins />
            </span>
            <span className="kpi-label">Net P&amp;L</span>
            <span className="spacer" />
            <span className={`chip ${totalPnl >= 0 ? 'green' : 'red'}`}>
              {totalPnl >= 0 ? '▲' : '▼'} {fmt(Math.abs(model.changePct), 2)}%
            </span>
          </div>
          <div className="kpi-value">
            <AnimatedNumber value={totalPnl} decimals={2} signed />
            <small>USDT</small>
          </div>
          <div className="kpi-foot">
            <Sparkline data={spark} color={totalPnl >= 0 ? 'var(--green)' : 'var(--red)'} strokeWidth={1.6} />
          </div>
          <span className="kpi-glow" />
        </article>

        <article className="panel kpi tone-cyan">
          <div className="kpi-top">
            <span className="kpi-ico">
              <IconTarget />
            </span>
            <span className="kpi-label">Win rate</span>
            <span className="spacer" />
            <span className="chip cyan">
              {stats ? `${stats.winCount}W / ${stats.lossCount}L` : '—'}
            </span>
          </div>
          <div className="kpi-value">
            <AnimatedNumber value={stats?.overallWinRate ?? 0} decimals={1} />
            <small>%</small>
          </div>
          <div className="kpi-foot">
            <MiniBar pct={stats?.overallWinRate ?? 0} tone={(stats?.overallWinRate ?? 0) >= 50 ? 'green' : 'red'} />
          </div>
          <span className="kpi-glow" />
        </article>

        <article className={`panel kpi tone-${(stats?.expectancy ?? 0) >= 0 ? 'green' : 'red'}`}>
          <div className="kpi-top">
            <span className="kpi-ico">
              <IconTrend />
            </span>
            <span className="kpi-label">Expectancy</span>
            <span className="spacer" />
            <span className={`chip ${(stats?.expectancy ?? 0) >= 0 ? 'green' : 'red'}`}>
              {(stats?.expectancy ?? 0) >= 0 ? 'profitable' : 'under water'}
            </span>
          </div>
          <div className="kpi-value">
            <AnimatedNumber value={stats?.expectancy ?? 0} decimals={3} signed />
            <small>R / trade</small>
          </div>
          <div className="kpi-foot">
            <span className="hint">
              RR 1 : {fmt(stats?.rrRatio ?? 0, 2)} · break-even {fmt(stats?.breakevenRate ?? 0, 1)}%
            </span>
          </div>
          <span className="kpi-glow" />
        </article>

        <article className="panel kpi tone-violet">
          <div className="kpi-top">
            <span className="kpi-ico">
              <IconBolt />
            </span>
            <span className="kpi-label">Signals</span>
            <span className="spacer" />
            <span className="chip violet">{stats?.totalClosedTrades ?? 0} closed</span>
          </div>
          <div className="kpi-value">
            <AnimatedNumber value={stats?.totalSignals ?? 0} decimals={0} />
            <small>{stats?.windowDays ?? 7}d window</small>
          </div>
          <div className="kpi-foot" style={{ flexWrap: 'wrap', gap: 6 }}>
            <span className="chip green">TP1 {stats?.tp1Count ?? 0}</span>
            <span className="chip green">TP2 {stats?.tp2Count ?? 0}</span>
            <span className="chip green">TP3 {stats?.tp3Count ?? 0}</span>
            <span className="chip red">SL {stats?.slCount ?? 0}</span>
          </div>
          <span className="kpi-glow" />
        </article>
      </div>

      {/* ---------------- position ---------------- */}
      {open && <PositionCard trade={open} price={status?.price ?? 0} onKill={onKill} />}

      {/* ---------------- stats + trend ---------------- */}
      <div className="grid-2">
        <StatsPanel stats={stats} />
        <TrendPanel mtf={mtf} status={status} />
      </div>

      {/* ---------------- screener + activity ---------------- */}
      <div className="grid-2">
        <ScreenerPanel data={screener} />
        <Panel
          title="Engine Health"
          sub="runtime"
          icon={<IconShield />}
          meta={status?.feed === 'offline-demo' ? 'offline demo feed' : 'binance live'}
        >
          <div className="mini-grid">
            <div className="mini">
              <div className="k">Feed</div>
              <div className="v">{status?.feed === 'offline-demo' ? 'Simulated' : 'Live'}</div>
            </div>
            <div className="mini">
              <div className="k">Mode</div>
              <div className="v" style={{ textTransform: 'uppercase' }}>{status?.mode ?? '—'}</div>
            </div>
            <div className="mini">
              <div className="k">Leverage</div>
              <div className="v">{status?.leverage ?? '—'}x</div>
            </div>
            <div className="mini">
              <div className="k">Size</div>
              <div className="v">{status?.tradeSizePercent ?? '—'}%</div>
            </div>
            <div className="mini">
              <div className="k">ATR(14)</div>
              <div className="v">{fmt(status?.engine?.atr ?? 0, 2)}</div>
            </div>
            <div className="mini">
              <div className="k">Ribbon</div>
              <div className={`v ${status?.engine?.ribbonBull ? 'up' : 'down'}`}>
                {status?.engine?.ribbonBull ? 'Bullish' : 'Bearish'}
              </div>
            </div>
          </div>

          <div className="settings-sec">
            <h4>Risk ladder in force</h4>
            <div className="bars">
              <BarRow label="TP1 · 1.5R" pct={stats?.tp1Pct ?? 0} value={`${fmt(stats?.tp1Pct ?? 0, 0)}%`} tone="green" />
              <BarRow label="TP2 · 3R" pct={stats?.tp2Pct ?? 0} value={`${fmt(stats?.tp2Pct ?? 0, 0)}%`} tone="green" />
              <BarRow label="TP3 · 4.5R" pct={stats?.tp3Pct ?? 0} value={`${fmt(stats?.tp3Pct ?? 0, 0)}%`} tone="green" />
            </div>
          </div>
        </Panel>
      </div>

      <ActivityPanel logs={logs} />
    </>
  );
}

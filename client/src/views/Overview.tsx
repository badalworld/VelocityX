import { useMemo } from 'react';
import { AccountView, Mtf, PositionsPayload, ScanResult, ScreenerData, Stats, Status, Trade } from '../types';
import { fmt, timeAgo } from '../api';
import { AnimatedNumber, Panel, Sparkline } from '../motion/primitives';
import { ManagedPositions } from '../components/Positions';
import StatsPanel from '../components/StatsPanel';
import { ActivityPanel, TrendPanel } from '../components/Panels';
import { ScannerPanel, TopPicks } from '../components/ScannerPanel';
import { IconAlert, IconBolt, IconCoins, IconPulse, IconShield, IconSparkles, IconTarget, IconTrend } from '../motion/Icons';

interface Props {
  status: Status | null;
  stats: Stats | null;
  mtf: Mtf | null;
  screener: ScreenerData | null;
  scan: ScanResult | null;
  account: AccountView | null;
  positions: PositionsPayload | null;
  trades: Trade[];
  logs: { t: number; level: string; msg: string }[];
  onKill: () => void;
  onClose: (id: string) => void;
  onScan: () => void;
  scanning: boolean;
}

function MiniBar({ pct, tone = 'cyan' }: { pct: number; tone?: 'cyan' | 'green' | 'red' }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <span className="bar-track" style={{ height: 6, flex: '1 1 auto' }}>
      <span className={`bar-fill ${tone === 'cyan' ? '' : tone}`} style={{ width: `${clamped}%` }} />
    </span>
  );
}

/* ---------------------------------------------------------------------------
   Data-source banner — the dashboard must never look "live" when it is not.
   ------------------------------------------------------------------------- */
export function FeedBanner({ status }: { status: Status | null }) {
  const feed = status?.feedInfo?.feed ?? 'binance';
  if (feed === 'binance') {
    const latency = status?.feedInfo?.latencyMs ?? 0;
    const age = status?.feedInfo?.wsLastMessageAt ? Date.now() - status.feedInfo.wsLastMessageAt : Infinity;
    const stale = age > 15_000;
    return (
      <div className="feed-banner ok" data-reveal="true">
        <span className="led-dot on" />
        <b>Binance live feed</b>
        <span className="chip cyan">{status?.feedInfo?.avgLatencyMs || latency} ms REST</span>
        <span className="chip cyan">WS {Number.isFinite(age) ? `${Math.round(age / 1000)}s ago` : 'idle'}</span>
        <span className="chip">
          {status?.feedInfo?.candles?.symbols ?? 0} symbols · {status?.feedInfo?.candles?.bars ?? 0} candles cached
        </span>
        {stale && <span className="chip amber">stream quiet — reconnecting</span>}
      </div>
    );
  }
  if (feed === 'offline-demo') {
    return (
      <div className="feed-banner warn" data-reveal="true">
        <IconAlert style={{ width: 14, height: 14 }} />
        <b>OFFLINE DEMO FEED — synthetic data, not Binance.</b>
        <span>
          This host cannot reach fapi.binance.com and <span className="mono">VX_OFFLINE_DEMO=1</span> is set, so a clearly
          labelled simulator is driving the UI. Remove that flag on a networked host to see real Binance data only.
        </span>
      </div>
    );
  }
  return (
    <div className="feed-banner error" data-reveal="true">
      <IconAlert style={{ width: 14, height: 14 }} />
      <b>Binance unreachable — no market data.</b>
      <span>
        {status?.feedInfo?.lastRestError ?? 'REST call failed'} · the bot will not fabricate prices, and no order will be
        sent. It retries automatically.
      </span>
    </div>
  );
}

export default function Overview({
  status,
  stats,
  mtf,
  scan,
  account,
  positions,
  trades,
  logs,
  onKill,
  onClose,
  onScan,
  scanning,
}: Props) {
  const openCount = positions?.managed.length ?? status?.openTrades?.length ?? 0;
  const maxPos = positions?.slots.max ?? status?.maxPositions ?? 8;
  const equity = account?.equity ?? 0;
  const unreal = account?.unrealizedPnl ?? 0;
  const botNet = account?.bot.netPnl ?? 0;
  const realized = account?.bot.realizedPnl ?? 0;
  const roi = account?.roiPct ?? 0;

  const uptime = useMemo(() => {
    const started = status?.engine?.startedAt;
    if (!started) return '—';
    return timeAgo(started).replace(' ago', '');
  }, [status?.engine?.startedAt]);

  const spark = useMemo(() => {
    const closed = trades
      .filter((t) => t.status === 'CLOSED')
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
    if (!closed.length) return [0, 0, 0];
    let cum = 0;
    const pts = closed.map((t) => (cum += t.realizedPnl));
    return [...pts, cum + unreal];
  }, [trades, unreal]);

  const totalClosed = stats?.totalClosedTrades ?? 0;

  return (
    <>
      <FeedBanner status={status} />

      {/* ---------------- hero ---------------- */}
      <section className="panel hero" data-reveal="true">
        <div className="hero-main">
          <span className="hero-kicker">
            <span className="chip cyan">
              <IconSparkles style={{ width: 11, height: 11 }} /> live binance desk
            </span>
            <span className={`badge-mode ${status?.mode ?? 'paper'}`} style={{ padding: '3px 9px', fontSize: 9.5 }}>
              {status?.mode ?? 'paper'}
            </span>
            <span className={`chip ${account?.source === 'binance' ? 'green' : 'amber'}`}>
              {account?.source === 'binance' ? 'exchange equity' : 'paper simulation'}
            </span>
          </span>
          <h1 className="hero-title">
            {openCount}/{maxPos} positions · {status?.autoScan ? 'scanner-driven' : (status?.symbol ?? 'BTCUSDT')} ·{' '}
            {(status?.interval ?? '5m').toUpperCase()}
          </h1>
          <p className="hero-sub">
            Equity, PNL, ROI, fees and funding come straight from Binance. The scanner ranks the whole USD-M universe by
            volatility and only trending markets reach the executor — up to {maxPos} bot positions, nothing else.
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
            <span className="hm-k">Bot net P&amp;L</span>
            <span className={`hm-v ${botNet >= 0 ? 'up' : 'down'}`}>
              <AnimatedNumber value={botNet} decimals={2} signed />
            </span>
          </div>
          <div className="hero-metric">
            <span className="hm-k">ROI</span>
            <span className={`hm-v ${roi >= 0 ? 'up' : 'down'}`}>
              <AnimatedNumber value={roi} decimals={2} signed unit="%" />
            </span>
          </div>
          <div className="hero-metric">
            <span className="hm-k">Engine up</span>
            <span className="hm-v">{uptime}</span>
          </div>
        </div>

        <div className="spacer" />

        <div style={{ width: 'min(240px, 100%)' }}>
          <Sparkline data={spark} color={botNet >= 0 ? 'var(--green)' : 'var(--red)'} />
          <div className="hint" style={{ textAlign: 'right' }}>
            realised ladder + live unrealised · {trades.length} trades logged
          </div>
        </div>
      </section>

      {/* ---------------- KPI pods ---------------- */}
      <div className="grid-4" data-reveal-group>
        <article className={`panel kpi tone-${botNet >= 0 ? 'green' : 'red'}`}>
          <div className="kpi-top">
            <span className="kpi-ico">
              <IconCoins />
            </span>
            <span className="kpi-label">Net P&amp;L (bot)</span>
            <span className="spacer" />
            <span className={`chip ${botNet >= 0 ? 'green' : 'red'}`}>
              realised {realized >= 0 ? '+' : ''}
              {fmt(realized, 2)}
            </span>
          </div>
          <div className="kpi-value">
            <AnimatedNumber value={botNet} decimals={2} signed />
            <small>USDT</small>
          </div>
          <div className="kpi-foot">
            <Sparkline data={spark} color={botNet >= 0 ? 'var(--green)' : 'var(--red)'} strokeWidth={1.6} />
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
            <span className="chip violet">{totalClosed} closed</span>
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

      {/* ---------------- live positions (bot-owned only) ---------------- */}
      <ManagedPositions data={positions} onClose={onClose} />

      {/* ---------------- scanner ---------------- */}
      <div className="grid-2">
        <ScannerPanel scan={scan} onScan={onScan} scanning={scanning} />
        <Panel
          title="Top Picks"
          sub="trending · high volatility"
          icon={<IconTrend />}
          meta={<span className="chip green">{(scan?.rows ?? []).filter((r) => r.tradable).length} tradable</span>}
        >
          <TopPicks scan={scan} />
          <div className="hint mt">
            Scan runs every {scan?.gate ? '60' : '—'}s inside the 95% Binance weight budget — it never competes with the
            engine, the account poller or the executor.
          </div>
        </Panel>
      </div>

      {/* ---------------- stats + trend ---------------- */}
      <div className="grid-2">
        <StatsPanel stats={stats} />
        <TrendPanel mtf={mtf} status={status} />
      </div>

      {/* ---------------- health + activity ---------------- */}
      <div className="grid-2">
        <Panel
          title="Engine Health"
          sub="feed + rate budget"
          icon={<IconShield />}
          meta={status?.feed === 'binance' ? 'binance live' : status?.feed === 'offline-demo' ? 'demo feed' : 'disconnected'}
        >
          <div className="mini-grid">
            <div className="mini">
              <div className="k">Content source</div>
              <div className={`v ${status?.feed === 'binance' ? 'up' : 'down'}`}>
                {status?.feed === 'binance' ? 'Binance' : status?.feed === 'offline-demo' ? 'Simulated' : 'None'}
              </div>
            </div>
            <div className="mini">
              <div className="k">REST latency</div>
              <div className="v">{status?.feedInfo?.avgLatencyMs ?? 0} ms</div>
            </div>
            <div className="mini">
              <div className="k">Weight used</div>
              <div className="v">
                {status?.limits?.usedWeight ?? 0}/{status?.limits?.plannedLimitPerMin ?? 2280} · {status?.limits?.usedPct ?? 0}%
              </div>
            </div>
            <div className="mini">
              <div className="k">Order budget</div>
              <div className="v">
                {status?.limits?.usedOrders1m ?? 0}/{status?.limits?.orderLimitPerMin ?? 1140} /min
              </div>
            </div>
            <div className="mini">
              <div className="k">Positions</div>
              <div className="v">
                {openCount}/{maxPos}
              </div>
            </div>
            <div className="mini">
              <div className="k">Scanner</div>
              <div className="v">{status?.scanner?.selected.length ?? 0} symbols</div>
            </div>
            <div className="mini">
              <div className="k">Externals</div>
              <div className="v down">{account?.external.count ?? 0} excluded</div>
            </div>
            <div className="mini">
              <div className="k">Fees · Funding</div>
              <div className="v" style={{ fontSize: 12 }}>
                {fmt(account?.bot.fees ?? 0, 2)} · {fmt(account?.bot.funding ?? 0, 3)}
              </div>
            </div>
          </div>
          <div className="hint mt" style={{ display: 'flex', gap: 7 }}>
            <IconPulse style={{ width: 13, height: 13, flex: 'none', marginTop: 2, color: 'var(--cyan)' }} />
            Limit plan: {status?.limits?.plannedLimitPerMin ?? 2280}/min (95% of {status?.limits?.weightLimitPerMin ?? 2400}),
            split across {(status?.limits?.areas ?? []).length || 5} work areas — scanner, market, account, orders, stream.
          </div>
        </Panel>
        <ActivityPanel logs={logs} />
      </div>
    </>
  );
}

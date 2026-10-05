import { AccountView, PositionsPayload, Status, Trade } from '../types';
import { fmt, fmtPrice, timeAgo } from '../api';
import { AnimatedNumber, Panel } from '../motion/primitives';
import { AccountPanel, ExternalPositions, ManagedPositions } from '../components/Positions';
import { IconBolt, IconHistory, IconShield, IconTarget } from '../motion/Icons';

/* ============================================================================
   Positions view — everything Binance reports, split into managed/external,
   plus the closed-trade journal with the real exchange fees and funding.
   ========================================================================== */

export default function PositionsView({
  status,
  account,
  positions,
  trades,
  onClose,
  onKill,
}: {
  status: Status | null;
  account: AccountView | null;
  positions: PositionsPayload | null;
  trades: Trade[];
  onClose: (id: string) => void;
  onKill: () => void;
}) {
  const closed = trades.filter((t) => t.status === 'CLOSED').slice(0, 60);
  const slots = positions?.slots ?? status?.slots ?? { used: 0, max: 8 };
  const bot = account?.bot;

  return (
    <>
      <section className="panel hero" data-reveal="true">
        <div className="hero-main">
          <span className="hero-kicker">
            <span className="chip cyan">
              <IconTarget style={{ width: 12, height: 12 }} /> live positions
            </span>
            <span className={`chip ${account?.source === 'binance' ? 'green' : 'amber'}`}>
              {account?.source === 'binance' ? 'Binance data' : 'exchange data unavailable'}
            </span>
          </span>
          <h1 className="hero-title">
            {slots.used}/{slots.max} bot positions · {fmt(bot?.netPnl ?? 0, 2)} USDT net
          </h1>
          <p className="hero-sub">
            PNL, ROI, equity, fees and funding are read from Binance — never estimated. Only positions this bot opened
            are managed and counted; anything else on the account is listed as external and ignored.
          </p>
        </div>
        <div className="hero-metrics">
          <div className="hero-metric">
            <span className="hm-k">Equity</span>
            <span className="hm-v">
              <AnimatedNumber value={account?.equity ?? 0} decimals={2} />
            </span>
          </div>
          <div className="hero-metric">
            <span className="hm-k">Unrealised</span>
            <span className={`hm-v ${(account?.unrealizedPnl ?? 0) >= 0 ? 'up' : 'down'}`}>
              <AnimatedNumber value={account?.unrealizedPnl ?? 0} decimals={2} signed />
            </span>
          </div>
          <div className="hero-metric">
            <span className="hm-k">ROI</span>
            <span className={`hm-v ${(account?.roiPct ?? 0) >= 0 ? 'up' : 'down'}`}>
              <AnimatedNumber value={account?.roiPct ?? 0} decimals={2} signed unit="%" />
            </span>
          </div>
          <div className="hero-metric">
            <span className="hm-k">Fees · Funding</span>
            <span className="hm-v" style={{ fontSize: 16 }}>
              {fmt(bot?.fees ?? 0, 3)} · {fmt(bot?.funding ?? 0, 4)}
            </span>
          </div>
        </div>
        <div className="spacer" />
        <button className="btn danger" onClick={onKill} disabled={!slots.used}>
          Close all bot positions
        </button>
      </section>

      <AccountPanel account={account} latencyMs={status?.feedInfo?.latencyMs} feed={status?.feed} />

      <ManagedPositions data={positions} onClose={onClose} />

      <ExternalPositions rows={positions?.external ?? []} />

      <Panel
        title="Closed Trades"
        sub="binance fees + funding"
        icon={<IconHistory />}
        bodyClass="flush"
        meta={<span className="chip">{closed.length} records</span>}
      >
        {closed.length === 0 ? (
          <div className="empty">No closed trade yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Closed</th>
                  <th>Market</th>
                  <th>Side</th>
                  <th className="r">Entry</th>
                  <th>Exit</th>
                  <th className="r">Fees</th>
                  <th className="r">Funding</th>
                  <th className="r">Net PnL</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((t) => (
                  <tr key={t.id}>
                    <td style={{ color: 'var(--muted)' }}>{timeAgo(t.closedAt ?? t.openedAt)}</td>
                    <td style={{ fontWeight: 700 }}>{t.symbol.replace('USDT', '')}</td>
                    <td style={{ color: t.side === 'LONG' ? 'var(--green)' : 'var(--red)', fontWeight: 800 }}>{t.side}</td>
                    <td className="r">{fmtPrice(t.entryPrice)}</td>
                    <td style={{ color: 'var(--muted)' }}>{t.closeReason ?? '—'}</td>
                    <td className="r neg">{fmt(t.fees, 3)}</td>
                    <td className={`r ${(t.funding ?? 0) >= 0 ? 'pos' : 'neg'}`}>{fmt(t.funding ?? 0, 4)}</td>
                    <td className={`r ${t.realizedPnl >= 0 ? 'pos' : 'neg'}`}>
                      {t.realizedPnl >= 0 ? '+' : ''}
                      {fmt(t.realizedPnl)}
                    </td>
                    <td>
                      <span className={`tag ${t.result ?? 'NEUTRAL'}`}>{t.result ?? '—'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid-2">
        <Panel title="Risk Rules" sub="locked in the executor" icon={<IconShield />}>
          <div className="mini-grid">
            <div className="mini">
              <div className="k">Max positions</div>
              <div className="v">{slots.max}</div>
            </div>
            <div className="mini">
              <div className="k">Margin per trade</div>
              <div className="v">{status?.tradeSizePercent ?? 5}% of equity</div>
            </div>
            <div className="mini">
              <div className="k">Leverage</div>
              <div className="v">{status?.leverage ?? 10}x</div>
            </div>
            <div className="mini">
              <div className="k">External positions</div>
              <div className="v down">never touched</div>
            </div>
            <div className="mini">
              <div className="k">Market universe</div>
              <div className="v">{status?.autoScan ? 'scanner (trending only)' : 'manual symbol'}</div>
            </div>
            <div className="mini">
              <div className="k">Feed</div>
              <div className={`v ${status?.feed === 'binance' ? 'up' : 'down'}`}>
                {status?.feed === 'binance' ? 'live Binance' : 'unreachable'}
              </div>
            </div>
          </div>
        </Panel>

        <Panel title="Executor Feed" sub="activity" icon={<IconBolt />} bodyClass="flush">
          <div className="feed" style={{ padding: '10px 12px', maxHeight: 260, overflow: 'auto' }}>
            {(status?.logs ?? [])
              .slice(-60)
              .reverse()
              .map((l, i) => (
                <div className={`feed-line ${l.level}`} key={`${l.t}-${i}`}>
                  <span className="feed-ts">{new Date(l.t).toLocaleTimeString([], { hour12: false })}</span>
                  <span className="feed-msg">{l.msg}</span>
                </div>
              ))}
          </div>
        </Panel>
      </div>
    </>
  );
}

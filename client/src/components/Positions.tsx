import { AccountView, ExternalPosition, ManagedPosition, PositionsPayload } from '../types';
import { fmt, fmtPrice, fmtQtyN, timeAgo } from '../api';
import { AnimatedNumber, Btn, Panel } from '../motion/primitives';
import { IconAlert, IconKill, IconScale, IconShield, IconTarget, IconWallet } from '../motion/Icons';

/* ============================================================================
   Positions & account — the live Binance book, split into:
     • MANAGED  — trades this bot opened (max 8), with Binance fees + funding
     • EXTERNAL — anything else on the account: never adopted, never closed,
                  never counted in the bot's PnL/ROI.
   ========================================================================== */

function LevelRow({ label, price, value, hit, tone }: { label: string; price: number; value?: string; hit: boolean; tone: string }) {
  return (
    <div className={`lad-row ${tone} ${hit ? 'is-hit' : ''}`}>
      <span className="lad-lvl" style={{ color: tone === 'lvl-sl' ? 'var(--red)' : 'var(--green)' }}>
        {label}
      </span>
      <span className="lad-track" />
      <span className="lad-px">{fmtPrice(price)}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
        {value && <span className="lad-note hide-sm">{value}</span>}
        <span className={`chip ${hit ? 'green' : tone === 'lvl-sl' ? 'amber' : ''}`}>{hit ? 'HIT' : 'WAITING'}</span>
      </span>
    </div>
  );
}

export function PositionCard({ pos, slot, max, onClose }: { pos: ManagedPosition; slot: number; max: number; onClose: (id: string) => void }) {
  const t = pos.trade;
  const long = t.side === 'LONG';
  const up = pos.unrealized >= 0;
  const slLabel = t.slStage === 0 ? 'ATR STOP' : t.slStage === 1 ? 'BREAKEVEN' : 'LOCKED AT TP1';
  return (
    <article className={`panel glass-frost pos-item ${up ? 'tone-green' : 'tone-red'}`}>
      <div className="pos-item-head">
        <span className={`side-badge ${t.side}`}>
          {long ? '▲' : '▼'} {t.symbol.replace('USDT', '')} {t.side} · {t.leverage}x
        </span>
        <span className="chip cyan">
          slot {slot}/{max}
        </span>
        <span className="chip">{t.mode !== 'paper' ? 'binance' : 'paper-sim'}</span>
        <span className="spacer" />
        <span className="hint">{timeAgo(t.openedAt)}</span>
      </div>

      <div className="pos-head">
        <div>
          <div className={`pnl-big ${up ? 'up' : 'down'}`}>
            <AnimatedNumber value={pos.unrealized} decimals={2} signed />
            <span className="cur">USDT</span>
          </div>
          <div className="pnl-sub">
            <span className={`chip ${up ? 'green' : 'red'}`}>
              {pos.roiPct >= 0 ? '+' : ''}
              {fmt(pos.roiPct)}% ROI
            </span>
            <span className="hint">
              realised {t.realizedPnl >= 0 ? '+' : ''}
              {fmt(t.realizedPnl)} USDT
            </span>
          </div>
        </div>
        <div className="spacer" />
        <div style={{ textAlign: 'right' }}>
          <div className="pod-k">MARK {pos.source === 'binance' ? '(BINANCE)' : ''}</div>
          <div style={{ fontSize: 18, fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{fmtPrice(pos.markPrice)}</div>
          <div className="pod-k" style={{ marginTop: 2 }}>
            entry {fmtPrice(t.entryPrice)}
          </div>
        </div>
      </div>

      <div className="pos-grid">
        <div className="cell">
          <div className="k">Remaining qty</div>
          <div className="v">{fmtQtyN(pos.remainingQty)}</div>
        </div>
        <div className="cell">
          <div className="k">Notional</div>
          <div className="v">{fmt(pos.notional)}</div>
        </div>
        <div className="cell">
          <div className="k">Margin</div>
          <div className="v">{fmt(pos.margin)}</div>
        </div>
        <div className="cell">
          <div className="k">Fees (Binance)</div>
          <div className="v">{fmt(pos.fees, 3)}</div>
        </div>
        <div className="cell">
          <div className="k">Funding (Binance)</div>
          <div className={`v ${pos.funding >= 0 ? 'up' : 'down'}`}>{fmt(pos.funding, 4)}</div>
        </div>
        <div className="cell">
          <div className="k">Liquidation</div>
          <div className="v">{pos.liquidationPrice ? fmtPrice(pos.liquidationPrice) : '—'}</div>
        </div>
      </div>

      <div className="ladder">
        <LevelRow label="SL" price={t.slCurrent} value={slLabel} hit={t.slStage > 0} tone="lvl-sl" />
        <LevelRow label="TP1" price={t.tp1} value={`${fmtQtyN(t.q1)} · SL→BE`} hit={t.tp1Filled} tone="lvl-tp" />
        <LevelRow label="TP2" price={t.tp2} value={`${fmtQtyN(t.q2)} · SL→TP1`} hit={t.tp2Filled} tone="lvl-tp" />
        <LevelRow label="TP3" price={t.tp3} value={`${fmtQtyN(t.q3)} · full exit`} hit={t.tp3Filled} tone="lvl-tp" />
      </div>

      <div className="row mt" style={{ flexWrap: 'wrap' }}>
        <Btn variant="danger" size="sm" icon={<IconKill />} onClick={() => onClose(t.id)}>
          Close this position
        </Btn>
        {t.scan && (
          <span className="hint">
            scanner: volatility {fmt(t.scan.volatility, 0)} · ADX {fmt(t.scan.adx, 0)} · ATR {fmt(t.scan.atrPct, 2)}%
          </span>
        )}
      </div>
    </article>
  );
}

export function ManagedPositions({ data, onClose }: { data: PositionsPayload | null; onClose: (id: string) => void }) {
  const managed = data?.managed ?? [];
  const max = data?.slots?.max ?? 8;
  return (
    <Panel
      title="Live Positions"
      sub={`bot-owned · max ${max}`}
      icon={<IconTarget />}
      meta={
        <span style={{ display: 'flex', gap: 6 }}>
          <span className={`chip ${managed.length ? 'green' : ''}`}>
            {managed.length}/{max} open
          </span>
          <span className="chip cyan">Binance mark price</span>
        </span>
      }
    >
      {managed.length === 0 ? (
        <div className="empty">
          No open position. The scanner is ranking the market — the bot opens up to {max} positions on trending
          high-volatility markets only, and never touches anything it did not open itself.
        </div>
      ) : (
        <div className="pos-grid-wrap">
          {managed.map((p, i) => (
            <PositionCard key={p.trade.id} pos={p} slot={i + 1} max={max} onClose={onClose} />
          ))}
        </div>
      )}
    </Panel>
  );
}

export function ExternalPositions({ rows }: { rows: ExternalPosition[] }) {
  if (!rows?.length) return null;
  return (
    <Panel
      title="External Positions — not managed"
      sub="manual / other bots"
      icon={<IconAlert />}
      meta={<span className="chip amber">{rows.length} excluded</span>}
      bodyClass="flush"
    >
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="r">Size</th>
              <th className="r">Entry</th>
              <th className="r">Mark</th>
              <th className="r">Notional</th>
              <th className="r">uPnL (excluded)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.symbol}>
                <td style={{ fontWeight: 800 }}>{p.symbol}</td>
                <td className={`r ${p.positionAmt > 0 ? 'pos' : 'neg'}`}>{fmtQtyN(Math.abs(p.positionAmt))}</td>
                <td className="r">{fmtPrice(p.entryPrice)}</td>
                <td className="r">{fmtPrice(p.markPrice)}</td>
                <td className="r">{fmt(p.notional)}</td>
                <td className={`r ${p.unrealized >= 0 ? 'pos' : 'neg'}`}>{fmt(p.unrealized)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hint warn" style={{ margin: '10px 14px 14px' }}>
        <IconAlert style={{ width: 12, height: 12, verticalAlign: '-2px', marginRight: 4 }} />
        {rows[0]?.note ?? 'opened outside the bot — never adopted, never closed, never counted in any bot number'}
      </div>
      <div className="hint warn" style={{ padding: '10px 12px' }}>
        <IconShield style={{ width: 12, height: 12, verticalAlign: '-2px', marginRight: 4 }} />
        These positions were <b>not opened by VelocityX</b>. The bot will never adopt them, never close them and their
        profit/loss is <b>excluded</b> from every bot statistic (PNL, ROI, equity attribution, win rate).
      </div>
    </Panel>
  );
}

export function AccountPanel({ account, latencyMs, feed }: { account: AccountView | null; latencyMs?: number; feed?: string }) {
  if (!account) return <div className="empty">Reading the Binance account…</div>;
  const binance = account.source === 'binance';
  const roi = account.roiPct ?? 0;
  const income = account.income;
  return (
    <Panel
      title="Account · Binance"
      sub={binance ? 'live exchange data' : 'paper simulation'}
      icon={<IconWallet />}
      meta={
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className={`chip ${binance ? 'green' : 'amber'}`}>{binance ? 'REAL' : 'SIM'}</span>
          {feed === 'binance' && latencyMs ? <span className="chip cyan">{latencyMs} ms</span> : null}
          <span className="chip">{new Date(account.at).toLocaleTimeString([], { hour12: false })}</span>
        </span>
      }
    >
      <div className="mini-grid">
        <div className="mini">
          <div className="k">Equity (margin balance)</div>
          <div className="v">
            <AnimatedNumber value={account.equity ?? 0} decimals={2} unit="USDT" />
          </div>
        </div>
        <div className="mini">
          <div className="k">Wallet balance</div>
          <div className="v">{fmt(account.walletBalance, 2)}</div>
        </div>
        <div className="mini">
          <div className="k">Unrealised PNL</div>
          <div className={`v ${(account.unrealizedPnl ?? 0) >= 0 ? 'up' : 'down'}`}>
            <AnimatedNumber value={account.unrealizedPnl ?? 0} decimals={2} signed />
          </div>
        </div>
        <div className="mini">
          <div className="k">ROI</div>
          <div className={`v ${roi >= 0 ? 'up' : 'down'}`}>
            <AnimatedNumber value={roi} decimals={2} signed unit="%" />
          </div>
        </div>
        <div className="mini">
          <div className="k">Margin in use</div>
          <div className="v">{fmt(account.initialMargin, 2)}</div>
        </div>
        <div className="mini">
          <div className="k">Available</div>
          <div className="v">{fmt(account.availableBalance, 2)}</div>
        </div>
        <div className="mini">
          <div className="k">Bot closed trades</div>
          <div className="v">
            {account.bot.closedCount} <span style={{ color: 'var(--dim)', fontWeight: 600 }}>of {account.bot.closedCount + account.bot.managedCount}</span>
          </div>
        </div>
        <div className="mini">
          <div className="k">Bot realised PNL</div>
          <div className={`v ${account.bot.realizedPnl >= 0 ? 'up' : 'down'}`}>
            <AnimatedNumber value={account.bot.realizedPnl} decimals={2} signed />
          </div>
        </div>
        <div className="mini">
          <div className="k">Bot fees (Binance)</div>
          <div className="v down">
            <AnimatedNumber value={account.bot.fees} decimals={3} />
          </div>
        </div>
        <div className="mini">
          <div className="k">Bot funding (Binance)</div>
          <div className={`v ${account.bot.funding >= 0 ? 'up' : 'down'}`}>
            <AnimatedNumber value={account.bot.funding} decimals={4} signed />
          </div>
        </div>
        <div className="mini">
          <div className="k">Bot net PNL</div>
          <div className={`v ${account.bot.netPnl >= 0 ? 'up' : 'down'}`}>
            <AnimatedNumber value={account.bot.netPnl} decimals={2} signed />
          </div>
        </div>
      </div>

      {income && (
        <>
          <div className="panel-sub-title mt">Binance income ledger · {income.windowDays}d</div>
          <div className="mini-grid">
            <div className="mini">
              <div className="k">Realised PNL</div>
              <div className={`v ${income.realizedPnl >= 0 ? 'up' : 'down'}`}>{fmt(income.realizedPnl, 2)}</div>
            </div>
            <div className="mini">
              <div className="k">Commission (fees)</div>
              <div className="v down">{fmt(income.commission, 3)}</div>
            </div>
            <div className="mini">
              <div className="k">Funding</div>
              <div className={`v ${income.funding >= 0 ? 'up' : 'down'}`}>{fmt(income.funding, 4)}</div>
            </div>
            <div className="mini">
              <div className="k">Transfers in/out</div>
              <div className="v">{fmt(income.transfers, 2)}</div>
            </div>
            <div className="mini">
              <div className="k">Net income</div>
              <div className={`v ${income.net >= 0 ? 'up' : 'down'}`}>{fmt(income.net, 2)}</div>
            </div>
            <div className="mini">
              <div className="k">Records</div>
              <div className="v">{income.records}</div>
            </div>
          </div>
          {income.bySymbol.length > 0 && (
            <div className="table-wrap mt">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th className="r">Realised</th>
                    <th className="r">Fees</th>
                    <th className="r">Funding</th>
                    <th className="r">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {income.bySymbol.slice(0, 8).map((b) => (
                    <tr key={b.symbol}>
                      <td style={{ fontWeight: 700 }}>{b.symbol}</td>
                      <td className={`r ${b.realizedPnl >= 0 ? 'pos' : 'neg'}`}>{fmt(b.realizedPnl, 2)}</td>
                      <td className="r neg">{fmt(b.commission, 3)}</td>
                      <td className={`r ${b.funding >= 0 ? 'pos' : 'neg'}`}>{fmt(b.funding, 4)}</td>
                      <td className={`r ${b.net >= 0 ? 'pos' : 'neg'}`}>{fmt(b.net, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {account.external && account.external.count > 0 && (
        <div className="hint warn mt">
          <IconScale style={{ width: 12, height: 12, verticalAlign: '-2px', marginRight: 4 }} />
          {account.external.count} external position{account.external.count > 1 ? 's' : ''} detected (
          {fmt(account.external.notional, 0)} USDT notional) — <b>excluded</b> from every bot number. VelocityX never
          adopts them.
        </div>
      )}
      {account.errors && account.errors.length > 0 && (
        <div className="hint warn mt">Account warnings: {account.errors.join(' · ')}</div>
      )}
    </Panel>
  );
}

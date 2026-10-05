/**
 * Account / PnL service — every number here comes from Binance.
 *
 *   • Equity, wallet balance, margin in use, unrealised PnL, ROI  → /fapi/v2/account
 *   • Positions (managed + external)                              → /fapi/v2/positionRisk
 *   • Fees, funding, realised PnL, transfers                      → /fapi/v1/income
 *
 * Attribution rule (your requirement): only trades **opened by this bot** are
 * counted in the bot's PnL/ROI. Any position on the account that the bot did
 * not open is listed separately, is never adopted, never closed and its profit
 * or loss is never mixed into bot statistics.
 */
import { api, AccountSnapshot, IncomeRecord, RawPosition } from './binance';
import { getSettings, Mode, PAPER_START_BALANCE } from './settings';
import { allTrades, getPaperBalance, openTrades, remainingQtyOf, Trade } from './store';
import { emit } from './broadcast';
import { priceOf } from './prices';

export interface ManagedPosition {
  trade: Trade;
  markPrice: number;
  /** Unrealised PnL of OUR quantity only, priced from Binance mark price. */
  unrealized: number;
  roiPct: number;
  /** Binance-verified fees for this trade (commission), USDT. */
  fees: number;
  /** Binance funding paid/received while this trade was open, USDT. */
  funding: number;
  /** remaining quantity still open */
  remainingQty: number;
  notional: number;
  margin: number;
  leverage: number;
  liquidationPrice: number;
  source: 'binance' | 'paper-sim';
}

export interface ExternalPosition {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealized: number;
  leverage: number;
  notional: number;
  /** always false — the bot never adopts or manages these */
  managed: false;
  /** shown in the UI: why this row is excluded from every bot number */
  note?: string;
}

export interface IncomeSummary {
  windowDays: number;
  realizedPnl: number;
  commission: number; // negative = paid
  funding: number; // negative = paid
  transfers: number;
  insurance: number;
  other: number;
  net: number;
  bySymbol: { symbol: string; realizedPnl: number; commission: number; funding: number; net: number }[];
  records: number;
  at: number;
}

export interface AccountView {
  source: 'binance' | 'paper-sim';
  mode: Mode;
  at: number;
  /** Binance account fields (null in paper mode) */
  equity: number | null;
  walletBalance: number | null;
  unrealizedPnl: number | null;
  availableBalance: number | null;
  initialMargin: number | null;
  maintMargin: number | null;
  roiPct: number | null; // unrealised ÷ margin in use
  roiOnWalletPct: number | null;
  canTrade: boolean | null;
  /** Bot-attributed numbers — managed trades only */
  bot: {
    managedCount: number;
    closedCount: number;
    maxPositions: number;
    marginUsed: number;
    notional: number;
    unrealizedPnl: number;
    realizedPnl: number;
    fees: number;
    funding: number;
    netPnl: number;
    roiPct: number;
  };
  income: IncomeSummary | null;
  external: {
    count: number;
    notional: number;
    unrealized: number;
  };
  positions: {
    managed: ManagedPosition[];
    external: ExternalPosition[];
  };
  errors: string[];
  latencyMs: number;
}

const clampDays = (d: number) => Math.min(90, Math.max(1, Math.round(d)));

class AccountService {
  private view: AccountView | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private incomeCache = new Map<number, { at: number; data: IncomeSummary }>();
  private lastUserEventAt = 0;

  start(intervalMs = 12_000): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(): AccountView | null {
    return this.view;
  }

  /**
   * Real-time balance/position push from the user-data stream (no REST weight).
   *
   * Binance ACCOUNT_UPDATE semantics: `a.B[].wb` is the asset wallet balance,
   * `a.B[].cw` is the CROSS wallet balance (not a PnL!), and unrealised PnL
   * lives in `a.P[].up` per position. Equity is therefore wallet + Σup — the
   * same identity `/fapi/v2/account` reports. (Older builds mis-read `cw` as
   * PnL, which made equity jump before the next REST poll corrected it.)
   */
  onUserStreamAccount(payload: any): void {
    this.lastUserEventAt = Date.now();
    if (!this.view) return;
    try {
      const bal = (payload?.a?.B || []).find((b: any) => b.a === 'USDT');
      const positions: any[] = Array.isArray(payload?.a?.P) ? payload.a.P : [];
      const wallet = Number(bal?.wb);
      if (Number.isFinite(wallet) && wallet >= 0) {
        const hasPositions = positions.length > 0;
        const unreal = hasPositions
          ? positions.reduce((a, p) => a + (Number(p?.up) || 0), 0)
          : this.view.unrealizedPnl ?? 0;
        const initialMargin = hasPositions
          ? positions.reduce((a, p) => a + (Number(p?.iw) || 0), 0)
          : this.view.initialMargin;
        this.view = {
          ...this.view,
          at: Date.now(),
          walletBalance: wallet,
          unrealizedPnl: unreal,
          equity: wallet + unreal,
          initialMargin,
          roiOnWalletPct: wallet > 0 ? (unreal / wallet) * 100 : 0,
          roiPct: initialMargin && initialMargin > 0 ? (unreal / initialMargin) * 100 : this.view.roiPct,
        };
      }
      emit('account', { at: this.view.at, equity: this.view.equity, unrealizedPnl: this.view.unrealizedPnl });
    } catch {
      /* malformed event — next poll will reconcile */
    }
  }

  /** Force a fresh account + positions read. */
  async refresh(): Promise<AccountView | null> {
    if (this.running) return this.view;
    this.running = true;
    const t0 = Date.now();
    const s = getSettings();
    const errors: string[] = [];
    try {
      const mode = s.mode;
      const managed = this.managedPositions();
      let snapshot: AccountSnapshot | null = null;
      let rawPositions: RawPosition[] = [];
      let income: IncomeSummary | null = null;

      if (mode !== 'paper') {
        try {
          snapshot = await api.accountSnapshot();
        } catch (e: any) {
          errors.push(`account: ${e?.message || e}`);
        }
        try {
          rawPositions = await api.positionRisk();
        } catch (e: any) {
          errors.push(`positions: ${e?.message || e}`);
        }
      } else {
        rawPositions = [];
      }

      // ---- match Binance positions to bot trades -------------------------
      const bySymbol = new Map(rawPositions.map((p) => [p.symbol, p]));
      for (const m of managed) {
        const p = bySymbol.get(m.trade.symbol);
        m.markPrice = p?.markPrice || m.markPrice;
        m.liquidationPrice = p?.liquidationPrice || 0;
        if (p && p.markPrice > 0) {
          m.unrealized = (p.markPrice - m.trade.entryPrice) * (m.trade.side === 'LONG' ? 1 : -1) * m.remainingQty;
        }
        m.margin = m.trade.margin;
        m.notional = m.remainingQty * (m.markPrice || m.trade.entryPrice);
        m.roiPct = m.margin > 0 ? (m.unrealized / m.margin) * 100 : 0;
      }

      // ---- external positions: everything the bot did not open -----------
      const external: ExternalPosition[] = [];
      for (const p of rawPositions) {
        const mine = managed.reduce((sum, m) => (m.trade.symbol === p.symbol ? sum + m.remainingQty : sum), 0);
        const amt = Math.abs(p.positionAmt);
        const extra = Math.max(0, amt - mine);
        if (extra > 1e-9) {
          const dir = Math.sign(p.positionAmt);
          external.push({
            symbol: p.symbol,
            positionAmt: p.positionAmt,
            entryPrice: p.entryPrice,
            markPrice: p.markPrice,
            unrealized: (p.markPrice - p.entryPrice) * dir * extra,
            leverage: p.leverage,
            notional: Math.abs(extra * p.markPrice),
            managed: false,
            note: 'opened outside the bot — never adopted, never closed, never counted in any bot number',
          });
        }
      }

      // ---- bot totals: closed history + the positions open right now -----
      // (a closed trade keeps contributing to the P&L / fees / funding totals,
      //  exactly like Binance's own income ledger does)
      const closedTrades = allTrades().filter((t) => t.status === 'CLOSED');
      const closedSum = (key: 'realizedPnl' | 'fees' | 'funding') =>
        closedTrades.reduce((a, t) => a + (Number(t[key]) || 0), 0);
      const realizedPnl = closedSum('realizedPnl') + managed.reduce((a, m) => a + m.trade.realizedPnl, 0);
      const fees = closedSum('fees') + managed.reduce((a, m) => a + m.fees, 0);
      const funding = closedSum('funding') + managed.reduce((a, m) => a + m.funding, 0);
      const unrealizedPnl = managed.reduce((a, m) => a + m.unrealized, 0);
      const marginUsed = managed.reduce((a, m) => a + m.margin, 0);
      const notional = managed.reduce((a, m) => a + m.notional, 0);
      const netPnl = realizedPnl + unrealizedPnl;
      const closedCount = closedTrades.length;

      // Income (real fees / funding / realised PnL straight from Binance).
      if (mode !== 'paper') {
        try {
          income = await this.incomeSummary(s.historyDays);
        } catch (e: any) {
          errors.push(`income: ${e?.message || e}`);
        }
        // Attribute symbol-level funding to the open trade on that symbol.
        if (income) {
          const bySym = new Map(income.bySymbol.map((b) => [b.symbol, b]));
          for (const m of managed) {
            const b = bySym.get(m.trade.symbol);
            if (b) m.funding = b.funding;
          }
        }
      }

      // The paper balance already includes every booked fill (entry fees, TP
      // slices, closes), so equity = balance + unrealised — never add realised
      // on top or it would be counted twice.
      const paperBalance = getPaperBalance(PAPER_START_BALANCE);
      const isPaper = mode === 'paper';
      const equity = isPaper ? paperBalance + unrealizedPnl : snapshot?.equity ?? null;
      const walletBalance = isPaper ? paperBalance : snapshot?.walletBalance ?? null;
      const initialMargin = isPaper ? marginUsed : snapshot?.initialMargin ?? null;

      const view: AccountView = {
        source: isPaper ? 'paper-sim' : 'binance',
        mode,
        at: Date.now(),
        equity,
        walletBalance,
        unrealizedPnl: isPaper ? unrealizedPnl : snapshot?.unrealizedPnl ?? null,
        availableBalance: isPaper ? Math.max(0, (walletBalance ?? 0) - marginUsed) : snapshot?.availableBalance ?? null,
        initialMargin,
        maintMargin: isPaper ? 0 : snapshot?.maintMargin ?? null,
        roiPct: isPaper
          ? marginUsed > 0 ? (unrealizedPnl / marginUsed) * 100 : 0
          : snapshot?.roiPct ?? null,
        roiOnWalletPct: isPaper
          ? walletBalance ? (unrealizedPnl / walletBalance) * 100 : 0
          : snapshot?.roiOnWalletPct ?? null,
        canTrade: isPaper ? true : snapshot?.canTrade ?? null,
        bot: {
          managedCount: managed.length,
          closedCount,
          maxPositions: s.maxPositions,
          marginUsed,
          notional,
          unrealizedPnl,
          realizedPnl,
          fees,
          funding,
          netPnl,
          roiPct: marginUsed > 0 ? (unrealizedPnl / marginUsed) * 100 : 0,
        },
        income,
        external: {
          count: external.length,
          notional: external.reduce((a, e) => a + e.notional, 0),
          unrealized: external.reduce((a, e) => a + e.unrealized, 0),
        },
        positions: { managed, external },
        errors,
        latencyMs: Date.now() - t0,
      };

      this.view = view;
      return view;
    } finally {
      this.running = false;
      void t0;
    }
  }

  /** Binance income summary (fees, funding, realised PnL) over a day window. */
  async incomeSummary(days?: number): Promise<IncomeSummary> {
    const windowDays = clampDays(days ?? getSettings().historyDays);
    const cached = this.incomeCache.get(windowDays);
    if (cached && Date.now() - cached.at < 45_000) return cached.data;

    const startTime = Date.now() - windowDays * 86_400_000;
    const rows: IncomeRecord[] = [];
    // One page is 1000 records; the 95% budget keeps this cheap (weight 30).
    let page = await api.incomeHistory({ startTime, limit: 1000 });
    rows.push(...page);
    if (page.length === 1000) {
      const last = page[page.length - 1]?.time ?? startTime;
      page = await api.incomeHistory({ startTime: last + 1, limit: 1000 });
      rows.push(...page);
    }

    const bySymbol = new Map<string, { realizedPnl: number; commission: number; funding: number }>();
    let realizedPnl = 0, commission = 0, funding = 0, transfers = 0, insurance = 0, other = 0;

    for (const r of rows) {
      const key = r.symbol || 'ACCOUNT';
      const entry = bySymbol.get(key) || { realizedPnl: 0, commission: 0, funding: 0 };
      switch (r.incomeType) {
        case 'REALIZED_PNL':
          realizedPnl += r.income;
          entry.realizedPnl += r.income;
          break;
        case 'COMMISSION':
          commission += r.income;
          entry.commission += r.income;
          break;
        case 'FUNDING_FEE':
          funding += r.income;
          entry.funding += r.income;
          break;
        case 'TRANSFER':
        case 'INTERNAL_TRANSFER':
        case 'WELCOME_BONUS':
        case 'CONTEST_REWARD':
        case 'REFERRAL_KICKBACK':
          transfers += r.income;
          break;
        case 'INSURANCE_CLEAR':
          insurance += r.income;
          break;
        default:
          other += r.income;
      }
      bySymbol.set(key, entry);
    }

    const data: IncomeSummary = {
      windowDays,
      realizedPnl,
      commission,
      funding,
      transfers,
      insurance,
      other,
      net: realizedPnl + commission + funding + insurance + other + transfers,
      bySymbol: [...bySymbol.entries()]
        .map(([symbol, v]) => ({ symbol, ...v, net: v.realizedPnl + v.commission + v.funding }))
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net)),
      records: rows.length,
      at: Date.now(),
    };
    this.incomeCache.set(windowDays, { at: Date.now(), data });
    return data;
  }

  private managedPositions(): ManagedPosition[] {
    const s = getSettings();
    const out: ManagedPosition[] = [];
    for (const t of openTrades()) {
      // Start from the freshest local price; live modes refine it with the mark
      // price Binance reports straight afterwards.
      const local = priceOf(t.symbol) || t.entryPrice;
      const dirMul = t.side === 'LONG' ? 1 : -1;
      const remaining = remainingQtyOf(t);
      out.push({
        trade: t,
        markPrice: local,
        unrealized: (local - t.entryPrice) * dirMul * remaining,
        roiPct: t.margin > 0 ? (((local - t.entryPrice) * dirMul * remaining) / t.margin) * 100 : 0,
        fees: t.fees,
        funding: t.funding ?? 0,
        remainingQty: remainingQtyOf(t),
        notional: 0,
        margin: t.margin,
        leverage: t.leverage,
        liquidationPrice: 0,
        source: s.mode === 'paper' ? 'paper-sim' : 'binance',
      });
    }
    return out;
  }

  /**
   * Live view of the bot's positions, straight from the executor journal (never
   * the cached account poll), enriched with the freshest mark prices we have.
   * The Positions view must never lag behind a trade that just opened.
   */
  managedNow(): ManagedPosition[] {
    const managed = this.managedPositions();
    const cached = new Map((this.view?.positions.managed ?? []).map((m) => [m.trade.id, m]));
    for (const m of managed) {
      const price = priceOf(m.trade.symbol) || cached.get(m.trade.id)?.markPrice || m.trade.entryPrice;
      m.markPrice = price;
      const dirMul = m.trade.side === 'LONG' ? 1 : -1;
      m.unrealized = (price - m.trade.entryPrice) * dirMul * m.remainingQty;
      m.notional = m.remainingQty * price;
      m.margin = m.trade.margin;
      m.roiPct = m.margin > 0 ? (m.unrealized / m.margin) * 100 : 0;
      m.fees = m.trade.fees;
      m.funding = m.trade.funding ?? 0;
      m.liquidationPrice = cached.get(m.trade.id)?.liquidationPrice ?? 0;
    }
    return managed;
  }

  /** Closed trades enriched with Binance fees/funding for the journal. */
  closedStats(): { realizedPnl: number; fees: number; funding: number; count: number } {
    const closed = allTrades().filter((t) => t.status === 'CLOSED');
    return {
      realizedPnl: closed.reduce((a, t) => a + t.realizedPnl, 0),
      fees: closed.reduce((a, t) => a + t.fees, 0),
      funding: closed.reduce((a, t) => a + (t.funding ?? 0), 0),
      count: closed.length,
    };
  }

  lastUserPushAt(): number {
    return this.lastUserEventAt;
  }
}

export { remainingQtyOf };

export const accountService = new AccountService();

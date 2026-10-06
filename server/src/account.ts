/** Read-only Binance account, position and income snapshot service. */
import { api, AccountSnapshot, IncomeRecord, RawPosition } from './binance';
import { getSettings, Mode } from './settings';
import { emit } from './broadcast';

export interface IncomeSummary {
  windowDays: number;
  realizedPnl: number;
  commission: number;
  funding: number;
  transfers: number;
  insurance: number;
  other: number;
  net: number;
  bySymbol: { symbol: string; realizedPnl: number; commission: number; funding: number; net: number }[];
  records: number;
  at: number;
}

export interface AccountView {
  source: 'binance';
  mode: Mode;
  at: number;
  equity: number | null;
  walletBalance: number | null;
  unrealizedPnl: number | null;
  availableBalance: number | null;
  initialMargin: number | null;
  maintMargin: number | null;
  roiPct: number | null;
  roiOnWalletPct: number | null;
  canTrade: boolean | null;
  /** Direct exchange positions, with no bot adoption or automated management. */
  positions: RawPosition[];
  income: IncomeSummary | null;
  errors: string[];
  latencyMs: number;
}

const clampDays = (value: number) => Math.min(90, Math.max(1, Math.round(value)));

class AccountService {
  private view: AccountView | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private incomeCache = new Map<number, { at: number; data: IncomeSummary }>();
  private generation = 0;

  start(intervalMs = 12_000): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(): AccountView | null {
    return this.view;
  }

  invalidate(): void {
    this.generation += 1;
    this.view = null;
    this.incomeCache.clear();
  }

  /** Apply real Binance ACCOUNT_UPDATE balance/position values to the cache. */
  onUserStreamAccount(payload: any): void {
    if (!this.view) return;
    try {
      const balance = (payload?.a?.B || []).find((item: any) => item.a === 'USDT');
      const wallet = Number(balance?.wb);
      const accountPositions: any[] = Array.isArray(payload?.a?.P) ? payload.a.P : [];
      const known = new Map(this.view.positions.map((position) => [position.symbol, position]));
      for (const item of accountPositions) {
        const symbol = String(item?.s || '');
        if (!symbol) continue;
        const previous = known.get(symbol);
        const amount = Number(item.pa);
        if (Number.isFinite(amount) && amount === 0) {
          known.delete(symbol);
          continue;
        }
        known.set(symbol, {
          symbol,
          positionAmt: Number.isFinite(amount) ? amount : previous?.positionAmt ?? 0,
          entryPrice: Number(item.ep) || previous?.entryPrice || 0,
          markPrice: previous?.markPrice || 0,
          unRealizedProfit: Number(item.up) || 0,
          liquidationPrice: previous?.liquidationPrice || 0,
          leverage: previous?.leverage || 1,
          marginType: String(item.mt || previous?.marginType || ''),
          isolatedMargin: Number(item.iw) || previous?.isolatedMargin || 0,
          positionInitialMargin: Number(item.iw) || previous?.positionInitialMargin || 0,
          notional: previous?.notional || 0,
          updateTime: Date.now(),
        });
      }
      const positions = [...known.values()].filter((position) => position.positionAmt !== 0);
      const hasPositionUpdates = accountPositions.length > 0;
      const unrealized = hasPositionUpdates
        ? positions.reduce((sum, position) => sum + position.unRealizedProfit, 0)
        : this.view.unrealizedPnl ?? 0;
      const initialMargin = hasPositionUpdates
        ? positions.reduce((sum, position) => sum + position.positionInitialMargin, 0)
        : this.view.initialMargin;
      const walletBalance = Number.isFinite(wallet) && wallet >= 0 ? wallet : this.view.walletBalance;
      this.view = {
        ...this.view,
        at: Date.now(),
        positions,
        walletBalance,
        unrealizedPnl: unrealized,
        equity: walletBalance == null ? this.view.equity : walletBalance + unrealized,
        initialMargin,
        roiOnWalletPct: walletBalance && walletBalance > 0 ? (unrealized / walletBalance) * 100 : 0,
        roiPct: initialMargin && initialMargin > 0 ? (unrealized / initialMargin) * 100 : this.view.roiPct,
      };
      emit('account', { source: 'binance', at: this.view.at });
    } catch { /* malformed stream payloads must not corrupt the account cache */ }
  }

  async refresh(): Promise<AccountView | null> {
    if (this.running) return this.view;
    this.running = true;
    const generation = this.generation;
    const startedAt = Date.now();
    const mode = getSettings().mode;
    const errors: string[] = [];
    try {
      let snapshot: AccountSnapshot | null = null;
      let positions: RawPosition[] | null = null;
      const results = await Promise.allSettled([api.accountSnapshot(), api.positionRisk()]);
      if (results[0].status === 'fulfilled') snapshot = results[0].value;
      else errors.push(`account: ${results[0].reason?.message || results[0].reason}`);
      if (results[1].status === 'fulfilled') positions = results[1].value;
      else errors.push(`positions: ${results[1].reason?.message || results[1].reason}`);
      if (generation !== this.generation || mode !== getSettings().mode) return this.view;

      const previous = this.view;
      let income = previous?.income ?? null;
      try { income = await this.incomeSummary(getSettings().historyDays); }
      catch (e: any) { errors.push(`income: ${e?.message || e}`); }
      if (generation !== this.generation || mode !== getSettings().mode) return this.view;

      const values = snapshot ?? {} as Partial<AccountSnapshot>;
      this.view = {
        source: 'binance',
        mode,
        at: Date.now(),
        equity: values.equity ?? previous?.equity ?? null,
        walletBalance: values.walletBalance ?? previous?.walletBalance ?? null,
        unrealizedPnl: values.unrealizedPnl ?? previous?.unrealizedPnl ?? null,
        availableBalance: values.availableBalance ?? previous?.availableBalance ?? null,
        initialMargin: values.initialMargin ?? previous?.initialMargin ?? null,
        maintMargin: values.maintMargin ?? previous?.maintMargin ?? null,
        roiPct: values.roiPct ?? previous?.roiPct ?? null,
        roiOnWalletPct: values.roiOnWalletPct ?? previous?.roiOnWalletPct ?? null,
        canTrade: values.canTrade ?? previous?.canTrade ?? null,
        positions: positions ?? previous?.positions ?? [],
        income,
        errors,
        latencyMs: Date.now() - startedAt,
      };
      emit('account', { source: 'binance', at: this.view.at });
      return this.view;
    } finally {
      this.running = false;
    }
  }

  async incomeSummary(days?: number): Promise<IncomeSummary> {
    const generation = this.generation;
    const windowDays = clampDays(days ?? getSettings().historyDays);
    const cached = this.incomeCache.get(windowDays);
    if (cached && Date.now() - cached.at < 45_000) return cached.data;

    const startTime = Date.now() - windowDays * 86_400_000;
    const rows: IncomeRecord[] = [];
    let page = await api.incomeHistory({ startTime, limit: 1000 });
    rows.push(...page);
    if (page.length === 1000) {
      const last = page[page.length - 1]?.time ?? startTime;
      page = await api.incomeHistory({ startTime: last + 1, limit: 1000 });
      rows.push(...page);
    }

    const bySymbol = new Map<string, { realizedPnl: number; commission: number; funding: number }>();
    let realizedPnl = 0, commission = 0, funding = 0, transfers = 0, insurance = 0, other = 0;
    for (const row of rows) {
      const symbol = row.symbol || 'ACCOUNT';
      const item = bySymbol.get(symbol) || { realizedPnl: 0, commission: 0, funding: 0 };
      switch (row.incomeType) {
        case 'REALIZED_PNL': realizedPnl += row.income; item.realizedPnl += row.income; break;
        case 'COMMISSION': commission += row.income; item.commission += row.income; break;
        case 'FUNDING_FEE': funding += row.income; item.funding += row.income; break;
        case 'TRANSFER':
        case 'INTERNAL_TRANSFER':
        case 'WELCOME_BONUS':
        case 'CONTEST_REWARD':
        case 'REFERRAL_KICKBACK': transfers += row.income; break;
        case 'INSURANCE_CLEAR': insurance += row.income; break;
        default: other += row.income;
      }
      bySymbol.set(symbol, item);
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
        .map(([symbol, values]) => ({ ...values, symbol, net: values.realizedPnl + values.commission + values.funding }))
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net)),
      records: rows.length,
      at: Date.now(),
    };
    if (generation === this.generation) this.incomeCache.set(windowDays, { at: Date.now(), data });
    return data;
  }
}

export const accountService = new AccountService();

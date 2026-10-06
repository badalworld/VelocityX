/**
 * Trade executor — multi-position state machine implementing your rules:
 *   TP1  -> close 33% of position, SL moves to BREAKEVEN
 *   TP2  -> close 50% of remaining, SL moves to TP1
 *   TP3  -> close the rest (FULL profit)
 *   Opposite signal on the same symbol -> close & reverse
 *
 * Multi-position model (your spec):
 *   • Up to **8** simultaneous positions (hard cap), one per symbol, each
 *     selected by the market scanner from high-volatility trending markets.
 *   • The bot ONLY manages trades it opened itself. Orders it places are
 *     tagged `VX<tradeId>…`, every exit order is `reduceOnly` with an explicit
 *     quantity, and entries refuse a symbol that already carries a position —
 *     so a manual/external position can never be closed, reversed or adopted.
 *
 * Every fill, commission, funding payment and realised PnL number is taken from
 * Binance (ORDER_TRADE_UPDATE, /fapi/v1/userTrades, /fapi/v1/income). Nothing is
 * simulated and nothing is estimated: if the exchange has not reported a
 * number, the trade simply does not have it yet.
 */
import { api, floorToStep, roundToTick, fmtQty } from './binance';
import { SignalSide } from './indicators';
import {
  markSignalActed, openTradeOn, openTrades, remainingQtyOf, saveTrade, SignalRecord, Trade,
} from './store';
import { getSettings, MAX_POSITIONS_CAP } from './settings';
import { priceOf, setPrice } from './prices';
import { scanner } from './scanner';
import { emit } from './broadcast';

export interface OpenSignal {
  record: SignalRecord;
  side: SignalSide;
  price: number;
  atr: number;
}

export interface ExecutionGate {
  ready: boolean;
  reasons: string[];
}

function rndId(): string {
  return Math.random().toString(36).slice(2, 10);
}
function closeSide(side: Trade['side']): 'BUY' | 'SELL' {
  return side === 'LONG' ? 'SELL' : 'BUY';
}
function dir(side: Trade['side']): number {
  return side === 'LONG' ? 1 : -1;
}

/** 33 / 50-of-remaining / rest ladder, exchange-step aware. */
export function splitQty(qty: number, step: number, p1: number, p2: number): { q1: number; q2: number; q3: number } {
  if (step <= 0 || qty < 3 * step - 1e-12) return { q1: 0, q2: 0, q3: qty };
  let q1 = floorToStep(qty * (p1 / 100), step);
  if (q1 < step) q1 = step;
  let rem = qty - q1;
  if (rem < 2 * step) {
    q1 -= step;
    rem = qty - q1;
  }
  let q2 = floorToStep(rem * (p2 / 100), step);
  if (q2 < step) q2 = step;
  if (rem - q2 < step) q2 = rem - step;
  const q3 = rem - q2;
  if (q3 < step || q2 < step || q1 < step) return { q1: 0, q2: 0, q3: qty };
  return { q1, q2, q3 };
}

class Trader {
  /** Symbols with an entry round-trip in flight — blocks duplicates and reserves slots. */
  private entering = new Set<string>();
  private slBusy = new Set<string>();
  /** Production runtime gate (feed/account/stream freshness), wired at boot. */
  private runtimeGate: (() => ExecutionGate) | null = null;

  setRuntimeGate(fn: (() => ExecutionGate) | null): void {
    this.runtimeGate = fn;
  }

  private gate(): ExecutionGate {
    // Default-deny: only the production bootstrap (or an explicit hermetic test
    // harness) may declare the execution infrastructure ready.
    if (!this.runtimeGate) return { ready: false, reasons: ['runtime execution gate is not initialized'] };
    try {
      return this.runtimeGate();
    } catch (e: any) {
      return { ready: false, reasons: [`runtime gate failed: ${e?.message || e}`] };
    }
  }

  /** Symbols with an OPEN bot trade. */
  managedSymbols(): string[] {
    return openTrades().map((t) => t.symbol);
  }
  private slotsFree(): number {
    const s = getSettings();
    const cap = Math.min(s.maxPositions, MAX_POSITIONS_CAP);
    return Math.max(0, cap - openTrades().length - this.entering.size);
  }

  // ---------------- price tick ----------------

  /** Latest price for a symbol (0 when unknown). */
  priceOf(symbol: string): number {
    return priceOf(symbol);
  }

  /** Primary-symbol price, kept for the dashboard/topbar. */
  lastPrice(): number {
    return priceOf(getSettings().symbol);
  }

  /** Called by the market stream on every bookTicker tick — feeds the UI/account layer. */
  onPrice(price: number, symbol?: string): void {
    if (!Number.isFinite(price) || price <= 0) return;
    setPrice(symbol || getSettings().symbol, price);
  }

  // ---------------- signal entry ----------------

  async onSignal(sig: OpenSignal): Promise<void> {
    const symbol = sig.record.symbol;
    if (!Number.isFinite(sig.price) || sig.price <= 0 || !Number.isFinite(sig.atr) || sig.atr <= 0) {
      this.log('error', `${symbol}: invalid signal price/ATR — entry rejected`);
      return;
    }
    if (Date.now() - sig.record.detectedAt > 120_000) {
      this.log('error', `${symbol}: stale signal (${Math.round((Date.now() - sig.record.detectedAt) / 1000)}s) — never replaying an old entry`);
      return;
    }

    const current = openTradeOn(symbol);
    if (current) {
      const opposite = (sig.side === 'LONG' && current.side === 'SHORT') || (sig.side === 'SHORT' && current.side === 'LONG');
      if (opposite) {
        this.log('info', `${symbol}: opposite ${sig.side} signal → closing bot ${current.side} trade (close & reverse)`);
        const closed = await this.closeByMarket(current, 'REVERSE');
        if (!closed) {
          this.log('error', `${symbol}: reverse aborted because the existing position could not be confirmed closed`);
          return;
        }
      } else {
        this.log('info', `${symbol}: same-direction signal while a bot trade is open — keeping current trade`);
        return;
      }
    }

    const s = getSettings();
    if (!s.autoTrade) {
      this.log('info', `Signal ${sig.side} ${symbol} @ ${sig.price} — auto-trade OFF, not entering`);
      return;
    }
    if (openTrades().length + this.entering.size >= Math.min(s.maxPositions, MAX_POSITIONS_CAP)) {
      this.log('info', `Signal ${sig.side} ${symbol} — all ${s.maxPositions} position slots are used or reserved, skipping`);
      return;
    }
    if (s.autoScan && !scanner.isExecutionEligible(symbol, sig.side)) {
      this.log('info', `Signal ${sig.side} ${symbol} — no live matching opportunity zone, skipping`);
      return;
    }
    const gate = this.gate();
    if (!gate.ready) {
      this.log('error', `Signal ${sig.side} ${symbol} — execution blocked: ${gate.reasons.join(' · ') || 'runtime not ready'}`);
      return;
    }

    await this.openTrade(sig);
  }

  /** Reserve one global position slot and one symbol before any async preflight. */
  private async openTrade(sig: OpenSignal): Promise<void> {
    const symbol = sig.record.symbol;
    if (this.entering.has(symbol)) {
      this.log('info', `${symbol}: entry already in flight — duplicate signal ignored`);
      return;
    }
    const s = getSettings();
    if (openTrades().length + this.entering.size >= Math.min(s.maxPositions, MAX_POSITIONS_CAP)) {
      this.log('info', `${symbol}: no unreserved position slot — entry ignored`);
      return;
    }
    this.entering.add(symbol);
    try {
      await this.placeEntry(sig);
    } finally {
      this.entering.delete(symbol);
    }
  }

  private async placeEntry(sig: OpenSignal): Promise<void> {
    const s = getSettings();
    const symbol = sig.record.symbol;
    try {
      const info = await api.exchangeInfo(symbol);
      let entry = sig.price;
      const marginUsed = openTrades().reduce((a, t) => a + t.margin, 0);

      // ---- production guard 1: the market must be empty -------------------
      // If a position already exists on this symbol (manual or from another
      // tool) the bot refuses to trade it. Two owners on one symbol would make
      // the reduceOnly ladder ambiguous — refusing is the only safe option.
      const existing = await api.positionAmount(symbol);
      if (Math.abs(existing) > info.stepSize / 2) {
        throw new Error(
          `${symbol} already carries a position (${fmtQty(existing)}) that the bot did not open — refusing to trade this market`,
        );
      }

      const bal = await api.accountSnapshot();
      const equity = bal.equity;
      const available = bal.availableBalance;

      // ---- production guard 2: the key must be allowed to trade -----------
      if (!bal.canTrade) throw new Error('Binance API key reports canTrade=false — order placement is disabled');

      // ---- production guard 3: leverage must fit the exchange bracket -----
      // Binance publishes a max leverage per symbol; requesting more fails the
      // whole entry. Clamp down instead of losing the trade.
      let leverage = s.leverage;
      const maxLev = await api.maxLeverage(symbol);
      if (maxLev > 0 && leverage > maxLev) {
        this.log('info', `${symbol}: leverage clamped ${leverage}x → ${maxLev}x (exchange bracket)`);
        leverage = maxLev;
      }

      // Per-trade margin = tradeSizePercent of equity, but never consume more
      // than 95% of free margin, and keep a reserve for the remaining slots.
      const perTrade = (equity * s.tradeSizePercent) / 100;
      const freeSlots = this.slotsFree();
      const freeUsable = Math.max(0, Math.min(available, equity) * 0.95 - marginUsed);
      // Keep half a slot's margin in reserve for the other free slots, but never
      // let the reservation starve a single trade: fall back to free margin.
      const reserved = Math.max(0, freeSlots - 1) * perTrade * 0.5;
      const usable = Math.max(0, freeUsable - reserved);
      let margin = Math.max(0, Math.min(perTrade, usable > 0 ? usable : freeUsable));

      let qty = floorToStep((margin * leverage) / entry, info.stepSize);
      const needQty = Math.max(
        info.minQty,
        Math.ceil((info.minNotional / entry) / info.stepSize - 1e-9) * info.stepSize,
      );
      if (qty < needQty) {
        const needMargin = (needQty * entry) / leverage;
        if (needMargin > Math.max(0, Math.min(available, equity) * 0.95 - marginUsed)) {
          throw new Error(
            `Not enough free margin for ${symbol}: need ~${needMargin.toFixed(2)} USDT (min notional ${info.minNotional}), available ${Math.max(0, available).toFixed(2)}`,
          );
        }
        qty = needQty;
      }
      if (qty <= 0) throw new Error('Computed quantity is zero — increase trade size or balance');

      await api.setLeverage(symbol, leverage);
      await api.setIsolated(symbol);

      // Async preflight above can take seconds. Re-check every mutable safety
      // switch immediately before the irreversible entry POST.
      const latest = getSettings();
      if (!latest.autoTrade) throw new Error('auto-trade was disarmed during entry preflight');
      if (latest.mode !== s.mode) throw new Error(`execution mode changed from ${s.mode} to ${latest.mode} during preflight`);
      if (latest.autoScan && !scanner.isExecutionEligible(symbol, sig.side)) {
        throw new Error('opportunity zone expired during entry preflight');
      }
      const stillEmpty = await api.positionAmount(symbol);
      if (Math.abs(stillEmpty) > info.stepSize / 2) {
        throw new Error(`${symbol} acquired a position during preflight — entry cancelled to protect ownership`);
      }
      const finalGate = this.gate();
      if (!finalGate.ready) throw new Error(`runtime became unavailable: ${finalGate.reasons.join(' · ')}`);

      const id = rndId();
      const prefix = `VX${id}`;
      const entryCid = `${prefix}E`;
      const openSide: 'BUY' | 'SELL' = sig.side === 'LONG' ? 'BUY' : 'SELL';
      const entryStartedAt = Date.now();
      let entryRes: any;
      try {
        entryRes = await api.marketOrder(symbol, openSide, qty, { newClientOrderId: entryCid });
      } catch (postError) {
        // A timeout after Binance accepted a POST is ambiguous. Querying by our
        // unique client id makes the retry path idempotent and prevents a
        // second entry order from ever being sent.
        try {
          entryRes = await api.queryOrder(symbol, entryCid);
          const executed = Number(entryRes?.executedQty || 0);
          if (executed <= 0 || !['FILLED', 'PARTIALLY_FILLED'].includes(String(entryRes?.status))) throw postError;
          this.log('info', `${symbol}: recovered uncertain entry response from Binance by client order id`);
        } catch {
          // If both the POST response and order lookup were interrupted, the
          // preflight proved this symbol was flat immediately beforehand. A
          // newly visible position is therefore this exact entry and can be
          // recovered without sending another order.
          try {
            const recoveredPosition = await api.positionAmount(symbol, sig.side);
            const recoveredQty = Math.abs(recoveredPosition);
            const correctDirection = recoveredPosition * dir(sig.side) > info.stepSize / 2;
            const matchesOrderQty = Math.abs(recoveredQty - qty) <= info.stepSize / 2;
            if (!correctDirection || !matchesOrderQty) throw postError;
            entryRes = {
              status: 'FILLED',
              executedQty: recoveredQty,
              avgPrice: 0,
              clientOrderId: entryCid,
            };
            this.log('error', `${symbol}: recovered uncertain entry from the Binance position snapshot`);
          } catch {
            throw postError;
          }
        }
      }
      const executedQty = Number(entryRes?.executedQty || 0);
      if (entryRes?.status && !['FILLED', 'PARTIALLY_FILLED'].includes(String(entryRes.status)) && executedQty <= 0) {
        throw new Error(`entry order returned unexpected status ${entryRes.status}`);
      }
      if (executedQty > 0) qty = floorToStep(executedQty, info.stepSize);
      if (qty <= 0) throw new Error('Binance reported zero executed quantity for the entry');

      const filledAvg = await this.entryFillPrice(symbol, prefix, Number(entryRes?.avgPrice || 0), entryStartedAt);
      if (filledAvg > 0) entry = filledAvg;

      const slDist = sig.atr * s.atrSlMultiplier;
      const sl = entry - dir(sig.side) * slDist;
      const tp1 = entry + dir(sig.side) * slDist * s.tpRrFactor;
      const tp2 = entry + dir(sig.side) * slDist * s.tpRrFactor * 2;
      const tp3 = entry + dir(sig.side) * slDist * s.tpRrFactor * 3;
      const notional = qty * entry;
      margin = notional / leverage;
      const { q1, q2, q3 } = splitQty(qty, info.stepSize, s.tp1ClosePct, s.tp2ClosePct);

      const scanRow = scanner.result()?.rows.find((r) => r.symbol === symbol) ?? null;
      const trade: Trade = {
        id,
        symbol,
        side: sig.side,
        status: 'OPEN',
        qty,
        q1, q2, q3,
        entryPrice: entry,
        atrAtEntry: sig.atr,
        slInitial: roundToTick(sl, info.tickSize),
        slCurrent: roundToTick(sl, info.tickSize),
        slStage: 0,
        tp1: roundToTick(tp1, info.tickSize),
        tp2: roundToTick(tp2, info.tickSize),
        tp3: roundToTick(tp3, info.tickSize),
        notional,
        margin,
        leverage,
        openedAt: Date.now(),
        closedAt: null,
        closeReason: null,
        tp1Filled: false,
        tp2Filled: false,
        tp3Filled: false,
        realizedPnl: 0,
        fees: 0,
        funding: 0,
        binanceRealizedPnl: 0,
        commissionOtherAsset: 0,
        initialRisk: slDist * qty,
        // Predeclare deterministic client ids before any protective POST. If a
        // response is lost, emergency finalization can still cancel every
        // possibly-accepted order by id.
        orders: {
          entry: `${prefix}E`,
          sl: `${prefix}S0`,
          tp1: q1 > 0 ? `${prefix}1` : undefined,
          tp2: q2 > 0 ? `${prefix}2` : undefined,
          tp3: `${prefix}3`,
        },
        mode: s.mode,
        result: null,
        botOwned: true,
        scan: scanRow
          ? {
              volatility: scanRow.volatility,
              adx: scanRow.adx,
              atrPct: scanRow.atrPct,
              rank: (scanner.result()?.rows.indexOf(scanRow) ?? -1) + 1,
              setupScore: scanRow.setupScore,
              emaGapAtr: scanRow.emaGapAtr,
              opportunity: s.autoScan,
            }
          : null,
      };

      // Persist ownership as soon as the entry is confirmed. If the process
      // dies while placing the ladder, reconcile can now find this exact VX id
      // and protect/close it instead of leaving an unjournaled exchange trade.
      saveTrade(trade);
      markSignalActed(sig.record.id, trade.id);
      emit('trade', { event: 'entry-filled', trade });

      try {
        // One-way: explicit size + reduceOnly. Hedge: positionSide — both
        // scope every exit order to the bot's own quantity.
        const dual = await api.isDualSide();
        const hedgeSide = trade.side;
        await api.protectiveStop(symbol, closeSide(trade.side), trade.slInitial, qty, `${prefix}S0`);
        trade.orders.sl = `${prefix}S0`;
        saveTrade(trade);
        if (q1 > 0) {
          await api.takeProfitMarket(symbol, closeSide(trade.side), trade.tp1, q1, { newClientOrderId: `${prefix}1`, positionSide: dual ? hedgeSide : undefined });
          trade.orders.tp1 = `${prefix}1`;
          saveTrade(trade);
        }
        if (q2 > 0) {
          await api.takeProfitMarket(symbol, closeSide(trade.side), trade.tp2, q2, { newClientOrderId: `${prefix}2`, positionSide: dual ? hedgeSide : undefined });
          trade.orders.tp2 = `${prefix}2`;
          saveTrade(trade);
        }
        await api.takeProfitMarket(symbol, closeSide(trade.side), trade.tp3, q3, { newClientOrderId: `${prefix}3`, positionSide: dual ? hedgeSide : undefined });
        trade.orders.tp3 = `${prefix}3`;
        saveTrade(trade);
      } catch (err: any) {
        this.log('error', `Protective ladder failed (${err?.message}) — emergency flatten requested`);
        emit('error', { message: `${symbol}: protective ladder failed — emergency close requested` });
        const closed = await this.closeByMarket(trade, 'KILL');
        if (!closed) {
          this.log('error', `${symbol}: CRITICAL — entry remains OPEN after emergency close failure; reconcile will keep trying to arm protection`);
          emit('error', { message: `${symbol}: CRITICAL open position needs attention — emergency close was not confirmed` });
        }
        return;
      }

      this.log(
        'info',
        `${trade.mode.toUpperCase()} ${trade.side} ${fmtQty(qty)} ${symbol} @ ${trade.entryPrice} | SL ${trade.slInitial} | TP ${trade.tp1}/${trade.tp2}/${trade.tp3}`,
      );
      emit('trade', { event: 'opened', trade });
      emit('log', {
        level: 'info',
        msg: `Opened ${trade.side} ${symbol} @ ${trade.entryPrice} (${openTrades().length}/${Math.min(s.maxPositions, MAX_POSITIONS_CAP)} positions)`,
      });
    } catch (err: any) {
      this.log('error', `Entry failed: ${err?.message || err}`);
      emit('error', { message: `Entry failed: ${err?.message || err}` });
    }
  }

  /**
   * Average fill price of OUR entry order, straight from Binance. Returns 0
   * when the ledger is not available yet (the caller then keeps the signal
   * price as a reference and the fill ledger corrects the PnL later).
   */
  private async entryFillPrice(symbol: string, prefix: string, ackAvg: number, openedAt: number): Promise<number> {
    if (Number.isFinite(ackAvg) && ackAvg > 0) return ackAvg;
    try {
      const fills = await api.userTrades(symbol, { startTime: openedAt - 60_000, limit: 100 });
      const mine = fills.filter((f) => String(f.clientOrderId || '') === `${prefix}E`);
      if (!mine.length) return 0;
      let qty = 0;
      let cost = 0;
      for (const f of mine) {
        const q = Number(f.qty) || 0;
        const p = Number(f.price) || 0;
        if (q > 0 && p > 0) {
          qty += q;
          cost += q * p;
        }
      }
      return qty > 0 ? cost / qty : 0;
    } catch (e: any) {
      this.log('error', `${symbol}: entry fill lookup failed: ${e?.message} — using signal price`);
      return 0;
    }
  }

  // ---------------- TP / SL fills ----------------

  /** Binance-reported fill numbers for one order (commission is negative in the API). */
  private applyBinanceNumbers(t: Trade, rp?: number, commission?: number, commissionAsset?: string): void {
    if (Number.isFinite(rp as number)) t.binanceRealizedPnl += Number(rp);
    if (Number.isFinite(commission as number)) {
      if (!commissionAsset || /USDT|USDC|BUSD|FDUSD/i.test(commissionAsset)) {
        t.fees += Math.abs(Number(commission));
      } else {
        t.commissionOtherAsset += Math.abs(Number(commission));
      }
    }
    t.realizedPnl = t.binanceRealizedPnl - t.fees;
  }

  fillTP(t: Trade, n: 1 | 2 | 3, price: number, binance?: { rp?: number; commission?: number; commissionAsset?: string }): void {
    if (t.status !== 'OPEN') return;
    const q = n === 1 ? t.q1 : n === 2 ? t.q2 : t.q3;
    if (q <= 0 && n !== 3) return;

    if (binance) this.applyBinanceNumbers(t, binance.rp, binance.commission, binance.commissionAsset);

    if (n === 1) {
      t.tp1Filled = true;
      if (t.slStage < 1) {
        t.slStage = 1;
        t.slCurrent = t.entryPrice;
      }
      this.log('info', `${t.symbol}: TP1 hit @ ${price} — closed ${fmtQty(q)}, SL → breakeven (${t.entryPrice})`);
      emit('log', { level: 'win', msg: `${t.symbol} TP1 ✅ closed @ ${price} — SL moved to breakeven` });
    } else if (n === 2) {
      t.tp2Filled = true;
      if (t.slStage < 2) {
        t.slStage = 2;
        t.slCurrent = t.tp1;
      }
      this.log('info', `${t.symbol}: TP2 hit @ ${price} — closed ${fmtQty(q)} of remaining, SL → TP1 (${t.tp1})`);
      emit('log', { level: 'win', msg: `${t.symbol} TP2 ✅ closed @ ${price} — SL moved to TP1` });
    } else {
      t.tp3Filled = true;
      this.log('info', `${t.symbol}: TP3 hit @ ${price} — full profit booked (${fmtQty(q)})`);
      emit('log', { level: 'win', msg: `${t.symbol} TP3 🎯 FULL profit booked @ ${price}` });
    }
    saveTrade(t);
    emit('trade', { event: 'fill', level: n, price, trade: t });

    if (n === 3) {
      void this.finalize(t, 'TP3', price);
    } else {
      void this.moveSL(t);
    }
  }

  fillSL(t: Trade, stopPrice: number, marketPrice: number, binance?: { rp?: number; commission?: number; commissionAsset?: string }): void {
    if (t.status !== 'OPEN') return;
    const d = dir(t.side);
    const remaining = remainingQtyOf(t);
    if (remaining <= 0) {
      void this.finalize(t, 'TP3', stopPrice);
      return;
    }
    // A stop that gapped through fills at the market, never better than the
    // stop itself — the exchange decides the fill, we only mirror it.
    const market = Number.isFinite(marketPrice) && marketPrice > 0 ? marketPrice : stopPrice;
    const fill = d > 0 ? Math.min(stopPrice, market) : Math.max(stopPrice, market);
    if (binance) this.applyBinanceNumbers(t, binance.rp, binance.commission, binance.commissionAsset);
    const anyTP = t.tp1Filled || t.tp2Filled;
    const reason: Trade['closeReason'] = anyTP ? 'SL_PARTIAL' : 'SL';
    this.log('info', `${t.symbol}: SL hit @ ${fill} — remaining closed, PnL ${t.realizedPnl >= 0 ? '+' : ''}${t.realizedPnl.toFixed(2)} USDT`);
    emit('log', {
      level: anyTP ? 'win' : 'loss',
      msg: `${t.symbol} SL ${anyTP ? '(after TP — still a WIN 🟢)' : '🔴'} hit @ ${fill}, PnL ${t.realizedPnl.toFixed(2)} USDT`,
    });
    void this.finalize(t, reason, fill);
  }

  /** Pull Binance's own fill ledger for this trade (fees + realised PnL, idempotent). */
  async reconcileBinanceNumbers(t: Trade): Promise<void> {
    try {
      const orders = await api.allOrders(t.symbol, { startTime: t.openedAt - 60_000, limit: 200 });
      const mine = new Set(orders.filter((o) => String(o.clientOrderId || '').startsWith(`VX${t.id}`)).map((o) => o.orderId));
      if (!mine.size) return;
      const fills = await api.userTrades(t.symbol, { startTime: t.openedAt - 60_000, limit: 500 });
      let rp = 0, fees = 0, other = 0;
      for (const f of fills) {
        if (!mine.has(f.orderId)) continue;
        rp += Number(f.realizedPnl) || 0;
        const c = Math.abs(Number(f.commission) || 0);
        if (/USDT|USDC|BUSD|FDUSD/i.test(String(f.commissionAsset || 'USDT'))) fees += c;
        else other += c;
      }
      t.binanceRealizedPnl = rp;
      t.fees = fees;
      t.commissionOtherAsset = other;
      t.realizedPnl = rp - fees;
      saveTrade(t);
      emit('trade', { event: 'fees', trade: t });
    } catch (e: any) {
      this.log('error', `${t.symbol}: Binance fill ledger fetch failed: ${e?.message}`);
    }
  }

  /** Funding paid/received while this trade was open (Binance income ledger). */
  async refreshFunding(t: Trade): Promise<void> {
    try {
      const rows = await api.incomeHistory({
        symbol: t.symbol,
        incomeType: 'FUNDING_FEE',
        startTime: t.openedAt,
        endTime: t.closedAt ?? undefined,
        limit: 1000,
      });
      const total = rows.reduce((a, r) => a + r.income, 0);
      if (Math.abs(total - (t.funding ?? 0)) > 1e-9) {
        t.funding = total;
        saveTrade(t);
        emit('trade', { event: 'funding', trade: t });
      }
    } catch (e: any) {
      this.log('error', `${t.symbol}: funding fetch failed: ${e?.message}`);
    }
  }

  /**
   * Market-close a specific bot trade. Returns true only after Binance confirms
   * the close request and the relevant position leg is flat. A failed close is
   * never journalled as CLOSED and a reverse entry is never attempted on top.
   */
  async closeByMarket(t: Trade, reason: 'REVERSE' | 'KILL'): Promise<boolean> {
    if (!t || t.status !== 'OPEN') return true;
    const remaining = remainingQtyOf(t);
    const price = this.priceOf(t.symbol) || t.entryPrice;
    if (remaining > 0) {
      try {
        const info = await api.exchangeInfo(t.symbol);
        const before = await api.positionAmount(t.symbol, t.side);
        const directionalBefore = before * dir(t.side);

        // The leg is already gone (manual/external intervention or a missed
        // fill). Never send a close in the opposite direction. Finalise our
        // record, and block a reverse if an opposite external leg now exists.
        if (directionalBefore <= info.stepSize / 2) {
          const oppositeExternal = Math.abs(before) > info.stepSize / 2;
          await this.finalize(t, 'EXTERNAL', price);
          if (oppositeExternal) {
            this.log('error', `${t.symbol}: bot leg is gone but an opposite external position exists — reverse blocked`);
            return false;
          }
          return true;
        }

        // If somebody added size in the same direction after our entry, close
        // exactly the bot's remaining quantity and deliberately leave the
        // excess external size behind.
        const closeQty = floorToStep(Math.min(remaining, directionalBefore), info.stepSize);
        if (closeQty <= 0) throw new Error('close quantity resolved to zero');
        const expectedDirectionalAfter = Math.max(0, directionalBefore - closeQty);
        const dual = await api.isDualSide();
        const cid = `${t.orders.entry?.slice(0, -1) ?? `VX${t.id}`}X`;
        let closeRes: any;
        try {
          closeRes = await api.marketOrder(
            t.symbol,
            closeSide(t.side),
            closeQty,
            dual
              ? { positionSide: t.side === 'LONG' ? 'LONG' : 'SHORT', newClientOrderId: cid }
              : { reduceOnly: true, newClientOrderId: cid },
          );
        } catch (postError) {
          // Same idempotent recovery as entry: do not send a second close when
          // only the HTTP response was lost.
          try {
            closeRes = await api.queryOrder(t.symbol, cid);
            if (!['FILLED', 'PARTIALLY_FILLED'].includes(String(closeRes?.status))) throw postError;
          } catch {
            throw postError;
          }
        }
        if (closeRes?.status && !['FILLED', 'PARTIALLY_FILLED'].includes(String(closeRes.status))) {
          throw new Error(`close order returned status ${closeRes.status}`);
        }

        const after = await api.positionAmount(t.symbol, t.side);
        const directionalAfter = Math.max(0, after * dir(t.side));
        if (Math.abs(directionalAfter - expectedDirectionalAfter) > info.stepSize / 2) {
          throw new Error(
            `position delta not confirmed (expected ${fmtQty(expectedDirectionalAfter)}, Binance ${fmtQty(directionalAfter)})`,
          );
        }
        if (expectedDirectionalAfter > info.stepSize / 2) {
          this.log('info', `${t.symbol}: left ${fmtQty(expectedDirectionalAfter)} external same-side quantity untouched`);
        }
        await this.reconcileBinanceNumbers(t);
      } catch (e: any) {
        this.log('error', `${t.symbol}: market close NOT confirmed: ${e?.message}`);
        emit('error', { message: `${t.symbol}: close not confirmed — position remains managed and protected` });
        return false;
      }
    }
    this.log('info', `${t.symbol}: closed (${reason}) @ ${price} — PnL ${t.realizedPnl.toFixed(2)} USDT`);
    await this.finalize(t, reason, price);
    return true;
  }

  private async finalize(t: Trade, reason: Trade['closeReason'], price: number): Promise<void> {
    if (t.status === 'CLOSED') return;
    t.status = 'CLOSED';
    t.closedAt = Date.now();
    t.closeReason = reason;
    t.result = reason === 'TP3' || reason === 'SL_PARTIAL' ? 'WIN' : reason === 'SL' ? 'LOSS' : null;
    await this.reconcileBinanceNumbers(t);
    await this.refreshFunding(t);
    saveTrade(t);
    // Cancel what is left of OUR ladder (TPs, and the stop if the position was
    // already flattened). Only client ids tagged VX<tradeId> are ever touched.
    for (const key of ['sl', 'tp1', 'tp2', 'tp3'] as const) {
      const cid = t.orders[key];
      if (!cid) continue;
      try {
        await api.cancelOrder(t.symbol, undefined, cid);
      } catch { /* already gone */ }
    }
    emit('trade', { event: 'closed', trade: t, price });
    emit('log', {
      level: t.result === 'WIN' ? 'win' : t.result === 'LOSS' ? 'loss' : 'info',
      msg: `${t.symbol} trade closed (${reason}) — PnL ${t.realizedPnl >= 0 ? '+' : ''}${t.realizedPnl.toFixed(2)} USDT · fees ${t.fees.toFixed(3)} · funding ${t.funding.toFixed(3)}${t.result ? ` [${t.result}]` : ''}`,
    });
  }

  private async moveSL(t: Trade): Promise<void> {
    if (t.status !== 'OPEN' || this.slBusy.has(t.id)) return;
    this.slBusy.add(t.id);
    try {
      const info = await api.exchangeInfo(t.symbol);
      const newStop = roundToTick(t.slCurrent, info.tickSize);
      t.slCurrent = newStop;
      const oldCid = t.orders.sl;
      if (oldCid) {
        try {
          await api.cancelOrder(t.symbol, undefined, oldCid);
        } catch (e: any) {
          this.log('error', `${t.symbol}: SL cancel failed: ${e?.message} — will verify position`);
        }
      }
      const newCid = `VX${t.id}S${t.slStage}`;
      const qty = remainingQtyOf(t);
      if (qty <= 0) {
        await this.closeByMarket(t, 'KILL');
        return;
      }
      try {
        // Explicit quantity + reduceOnly: the stop can only ever close the
        // bot's remaining size — never a manual position on the same symbol.
        await api.protectiveStop(t.symbol, closeSide(t.side), newStop, qty, newCid);
        t.orders.sl = newCid;
        saveTrade(t);
        emit('trade', { event: 'sl-moved', trade: t });
        this.log('info', `${t.symbol}: SL moved to ${newStop} (stage ${t.slStage})`);
      } catch (e: any) {
        this.log('error', `${t.symbol}: SL replacement failed: ${e?.message} — FLATTENING for safety`);
        emit('error', { message: `${t.symbol}: SL replacement failed — closing bot position for safety` });
        await this.closeByMarket(t, 'KILL');
      }
    } finally {
      this.slBusy.delete(t.id);
    }
  }

  // ---------------- live order events ----------------

  /** ORDER_TRADE_UPDATE from the user data stream — routed by clientOrderId. */
  onOrderUpdate(ev: any): void {
    const o = ev.o ?? ev;
    const cid: string = o.c || '';
    if (!cid.startsWith('VX')) return;
    // resolve the trade by the client order id (VX<tradeId><suffix>)
    const t = openTrades().find((x) => cid.startsWith(`VX${x.id}`)) || null;
    if (!t || t.symbol !== o.s) return;
    const exec = o.x; // NEW | TRADE | CANCELED | EXPIRED | REJECTED
    const status = o.X;
    const price = Number(o.L) || Number(o.ap) || 0;
    const binance = { rp: Number(o.rp) || 0, commission: Number(o.n) || 0, commissionAsset: String(o.N || 'USDT') };
    // A TRADE event may be only a partial fill. Accrue its exchange numbers,
    // but move the ladder exactly once after terminal FILLED status.
    const filled = status === 'FILLED';
    if (!filled) {
      if (exec === 'TRADE' || exec === 'TRADED') {
        this.applyBinanceNumbers(t, binance.rp, binance.commission, binance.commissionAsset);
        saveTrade(t);
      }
      return;
    }

    if (cid.startsWith(`VX${t.id}S`)) {
      this.fillSL(t, Number(o.sp) || t.slCurrent, price || t.slCurrent, binance);
    } else if (cid === t.orders.tp1 && !t.tp1Filled) {
      this.fillTP(t, 1, price || t.tp1, binance);
    } else if (cid === t.orders.tp2 && !t.tp2Filled) {
      this.fillTP(t, 2, price || t.tp2, binance);
    } else if (cid === t.orders.tp3 && !t.tp3Filled) {
      this.fillTP(t, 3, price || t.tp3, binance);
    } else if (cid === t.orders.entry) {
      const avg = Number(ev.ap) || 0;
      if (avg > 0 && Math.abs(avg - t.entryPrice) / t.entryPrice > 0.001) {
        this.log('info', `${t.symbol}: entry fill confirmed @ ${avg}`);
      }
    }
  }

  /**
   * Periodic safety net — ONLY for bot-owned orders.
   *  • catches missed fills from our own clientOrderIds
   *  • re-arms a missing SL for our trade
   * It never closes, reverses or adopts anything the bot did not open.
   */
  async reconcile(): Promise<void> {
    for (const t of openTrades()) {
      // Entry + initial ladder placement is transactional under this symbol
      // reservation. Do not race the recovery loop against orders still being
      // submitted by placeEntry().
      if (this.entering.has(t.symbol)) continue;
      try {
        await this.reconcileOne(t);
      } catch (e: any) {
        this.log('error', `${t.symbol}: reconcile error: ${e?.message}`);
      }
    }
  }

  private async reconcileOne(t: Trade): Promise<void> {
    if (t.status !== 'OPEN') return;
    const info = await api.exchangeInfo(t.symbol);
    const orders = await api.allOrders(t.symbol, { startTime: t.openedAt - 60_000, limit: 200 });
    const mine = orders.filter((o) => String(o.clientOrderId || '').startsWith(`VX${t.id}`));
    const byCid = (cid?: string) => cid ? mine.find((o) => String(o.clientOrderId) === cid) : undefined;

    const filledStop = mine.find(
      (o) => String(o.clientOrderId).startsWith(`VX${t.id}S`) && String(o.status) === 'FILLED',
    );
    if (filledStop && t.status === 'OPEN') {
      this.fillSL(
        t,
        Number(filledStop.avgPrice || filledStop.stopPrice) || t.slCurrent,
        Number(filledStop.avgPrice) || t.slCurrent,
      );
      return;
    }
    const tp3Order = byCid(t.orders.tp3);
    if (!t.tp3Filled && tp3Order?.status === 'FILLED') this.fillTP(t, 3, Number(tp3Order.avgPrice) || t.tp3);
    if (t.status !== 'OPEN') return;
    const tp1Order = byCid(t.orders.tp1);
    if (!t.tp1Filled && tp1Order?.status === 'FILLED') this.fillTP(t, 1, Number(tp1Order.avgPrice) || t.tp1);
    if (t.status !== 'OPEN') return;
    const tp2Order = byCid(t.orders.tp2);
    if (!t.tp2Filled && tp2Order?.status === 'FILLED') this.fillTP(t, 2, Number(tp2Order.avgPrice) || t.tp2);
    if (t.status !== 'OPEN') return;

    const pos = await api.positionAmount(t.symbol, t.side);
    const directionalPos = pos * dir(t.side);
    if (Math.abs(pos) < info.stepSize / 2) {
      this.log('info', `${t.symbol}: position flat (external fill detected) — closing bot trade record`);
      void this.finalize(t, 'EXTERNAL', Number(tp3Order?.avgPrice) || this.priceOf(t.symbol) || t.entryPrice);
      return;
    }
    if (directionalPos <= info.stepSize / 2) {
      this.log('error', `${t.symbol}: bot-side position is gone and an opposite external leg exists — dropping bot orders`);
      void this.finalize(t, 'EXTERNAL', this.priceOf(t.symbol) || t.entryPrice);
      return;
    }

    if (!this.slBusy.has(t.id)) {
      const open = await api.openOrders(t.symbol);
      const isAlive = (cid?: string) => !!cid && (
        open.some((o) => String(o.clientOrderId) === cid) ||
        ['NEW', 'PARTIALLY_FILLED'].includes(String(byCid(cid)?.status))
      );
      const protectedQty = floorToStep(Math.min(remainingQtyOf(t), directionalPos), info.stepSize);
      if (protectedQty <= 0) {
        void this.finalize(t, 'EXTERNAL', this.priceOf(t.symbol) || t.entryPrice);
        return;
      }

      if (!isAlive(t.orders.sl) && !t.tp3Filled) {
        this.log('error', `${t.symbol}: SL order missing while position open — re-arming SL`);
        const cid = `VX${t.id}S${t.slStage}R${Date.now().toString(36).slice(-4)}`;
        await api.protectiveStop(
          t.symbol,
          closeSide(t.side),
          roundToTick(t.slCurrent, info.tickSize),
          protectedQty,
          cid,
        );
        t.orders.sl = cid;
        saveTrade(t);
        emit('trade', { event: 'sl-rearmed', trade: t });
      }

      // A crash can happen after the entry journal is written but before all
      // TP legs are acknowledged. Rebuild only missing, unfilled bot legs and
      // route future stream fills through their newly persisted client ids.
      const dual = await api.isDualSide();
      const hedgeSide = dual ? t.side : undefined;
      let capacity = protectedQty;
      const ensureTp = async (
        key: 'tp1' | 'tp2' | 'tp3',
        level: 1 | 2 | 3,
        filled: boolean,
        target: number,
        plannedQty: number,
      ): Promise<void> => {
        if (filled || plannedQty <= 0 || capacity < info.stepSize / 2) return;
        const qty = floorToStep(Math.min(plannedQty, capacity), info.stepSize);
        capacity = Math.max(0, capacity - qty);
        if (qty <= 0 || isAlive(t.orders[key])) return;
        const cid = `VX${t.id}${level}R${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;
        this.log('error', `${t.symbol}: TP${level} order missing — re-arming ${fmtQty(qty)}`);
        await api.takeProfitMarket(t.symbol, closeSide(t.side), target, qty, {
          newClientOrderId: cid,
          positionSide: hedgeSide,
        });
        t.orders[key] = cid;
        saveTrade(t);
        emit('trade', { event: 'tp-rearmed', level, trade: t });
      };
      await ensureTp('tp1', 1, t.tp1Filled, t.tp1, t.q1);
      await ensureTp('tp2', 2, t.tp2Filled, t.tp2, t.q2);
      await ensureTp('tp3', 3, t.tp3Filled, t.tp3, t.q3);
    }
  }

  // ---------------- kill switch ----------------

  /** Close every bot-owned position at market. External positions are never touched. */
  async kill(): Promise<number> {
    const trades = openTrades();
    if (!trades.length) {
      this.log('info', 'Kill switch: no open bot position');
      return 0;
    }
    let closed = 0;
    for (const t of trades) if (await this.closeByMarket(t, 'KILL')) closed += 1;
    return closed;
  }

  private log(level: 'info' | 'error' | 'win' | 'loss', msg: string): void {
    console.log(`[${level}] ${msg}`);
    emit('log', { level, msg, t: Date.now() });
  }
}

export const trader = new Trader();

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
 *     tagged `VX<tradeId>…` and every exit order is reduceOnly/closePosition,
 *     so a manual/external position can never be closed, reversed or adopted.
 *   • Live/testnet fees, funding and realised PnL are taken from Binance
 *     (ORDER_TRADE_UPDATE commission/`rp`, /fapi/v1/income) — never invented.
 */
import { api, floorToStep, roundToTick, fmtQty } from './binance';
import { SignalSide } from './indicators';
import {
  adjustPaperBalance, getPaperBalance, markSignalActed, openTradeOn, openTrades,
  remainingQtyOf, saveTrade, setPaperBalance, SignalRecord, Trade, allTrades,
} from './store';
import { getSettings, MAX_POSITIONS_CAP, PAPER_START_BALANCE } from './settings';
import { priceOf, setPrice } from './prices';
import { scanner } from './scanner';
import { emit } from './broadcast';

export interface OpenSignal {
  record: SignalRecord;
  side: SignalSide;
  price: number;
  atr: number;
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
  private priceQueue: { symbol: string; price: number } | null = null;
  private processing = false;
  private slBusy = new Set<string>();
  /** Symbols with an entry round-trip in flight — blocks duplicate entries. */
  private entering = new Set<string>();

  /** Symbols with an OPEN bot trade. */
  managedSymbols(): string[] {
    return openTrades().map((t) => t.symbol);
  }
  private slotsFree(): number {
    const s = getSettings();
    const cap = Math.min(s.maxPositions, MAX_POSITIONS_CAP);
    return Math.max(0, cap - openTrades().length);
  }

  // ---------------- price tick (paper fills + UI) ----------------

  /** Latest price for a symbol (0 when unknown). */
  priceOf(symbol: string): number {
    return priceOf(symbol);
  }

  /** Primary-symbol price, kept for the dashboard/topbar. */
  lastPrice(): number {
    return priceOf(getSettings().symbol);
  }

  onPrice(price: number, symbol?: string): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const sym = symbol || getSettings().symbol;
    setPrice(sym, price);
    // trailing tick per symbol
    if (this.priceQueue === null || this.priceQueue.symbol === sym) this.priceQueue = { symbol: sym, price };
    if (!this.processing) {
      this.processing = true;
      setImmediate(() => {
        this.processing = false;
        const q = this.priceQueue;
        this.priceQueue = null;
        if (q) this.checkPaperFills(q.symbol, q.price);
      });
    }
  }

  private checkPaperFills(symbol: string, price: number): void {
    for (const t of openTrades()) {
      if (t.mode !== 'paper' || t.symbol !== symbol) continue;
      const d = dir(t.side);
      const levels: Array<{ n: 1 | 2 | 3; px: number; filled: boolean; qty: number }> = [
        { n: 1, px: t.tp1, filled: t.tp1Filled, qty: t.q1 },
        { n: 2, px: t.tp2, filled: t.tp2Filled, qty: t.q2 },
        { n: 3, px: t.tp3, filled: t.tp3Filled, qty: t.q3 },
      ];
      for (const lv of levels) {
        if (lv.filled || lv.qty <= 0) continue;
        const reached = d > 0 ? price >= lv.px : price <= lv.px;
        // A resting stop/take-profit market order fills at the market that
        // crossed it, not at the level itself — so book the observed tick.
        if (reached) this.fillTP(t, lv.n, price);
        if ((t.status as string) === 'CLOSED') break;
      }
      if (t.status === 'OPEN' && !t.tp3Filled) {
        const slHit = d > 0 ? price <= t.slCurrent : price >= t.slCurrent;
        if (slHit) this.fillSL(t, t.slCurrent, price);
      }
    }
  }

  // ---------------- signal entry ----------------

  async onSignal(sig: OpenSignal): Promise<void> {
    const settings = getSettings();
    const symbol = sig.record.symbol;
    const current = openTradeOn(symbol);

    if (current) {
      const opposite = (sig.side === 'LONG' && current.side === 'SHORT') || (sig.side === 'SHORT' && current.side === 'LONG');
      if (opposite) {
        this.log('info', `${symbol}: opposite ${sig.side} signal → closing bot ${current.side} trade (close & reverse)`);
        await this.closeByMarket(current, 'REVERSE');
      } else {
        this.log('info', `${symbol}: same-direction signal while a bot trade is open — keeping current trade`);
        return;
      }
    }

    if (!settings.autoTrade) {
      this.log('info', `Signal ${sig.side} ${symbol} @ ${sig.price} — auto-trade OFF, not entering`);
      return;
    }

    const s = getSettings();
    if (openTrades().length >= Math.min(s.maxPositions, MAX_POSITIONS_CAP)) {
      this.log('info', `Signal ${sig.side} ${symbol} — all ${s.maxPositions} position slots in use, skipping`);
      return;
    }
    if (s.autoScan && scanner.result() && !scanner.isTradable(symbol) && symbol !== s.symbol) {
      this.log('info', `Signal ${sig.side} ${symbol} — symbol is not in the scanner's trending high-volatility set, skipping`);
      return;
    }

    await this.openTrade(sig);
  }

  /**
   * Entry gate: one entry round-trip per symbol at a time. Signals arrive from
   * a single engine loop today, but a duplicate/retried signal must never be
   * able to open a second position on the same market.
   */
  private async openTrade(sig: OpenSignal): Promise<void> {
    const symbol = sig.record.symbol;
    if (this.entering.has(symbol)) {
      this.log('info', `${symbol}: entry already in flight — duplicate signal ignored`);
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
      let equity: number;
      let available: number;
      let marginUsed = openTrades().reduce((a, t) => a + t.margin, 0);
      let margin: number;
      let canTrade = true;

      // ---- production guard 1: the market must be empty -------------------
      // If a position already exists on this symbol (manual or from another
      // tool) the bot refuses to trade it. Two owners on one symbol would make
      // the reduceOnly ladder ambiguous — refusing is the only safe option.
      if (s.mode !== 'paper') {
        const existing = await api.positionAmount(symbol);
        if (Math.abs(existing) > info.stepSize / 2) {
          throw new Error(
            `${symbol} already carries a position (${fmtQty(existing)}) that the bot did not open — refusing to trade this market`,
          );
        }
      }

      if (s.mode === 'paper') {
        const bal = getPaperBalance(PAPER_START_BALANCE);
        const realized = allTrades().reduce((a, t) => a + (t.status === 'CLOSED' ? t.realizedPnl : 0), 0);
        equity = bal + realized;
        available = Math.max(0, equity - marginUsed);
      } else {
        const bal = await api.accountSnapshot();
        equity = bal.equity;
        available = bal.availableBalance;
        canTrade = bal.canTrade;
      }
      // ---- production guard 2: the key must be allowed to trade -----------
      if (!canTrade) throw new Error('Binance API key reports canTrade=false — order placement is disabled');

      // ---- production guard 3: leverage must fit the exchange bracket -----
      // Binance publishes a max leverage per symbol; requesting more fails the
      // whole entry. Clamp down instead of losing the trade.
      let leverage = s.leverage;
      if (s.mode !== 'paper') {
        const maxLev = await api.maxLeverage(symbol);
        if (maxLev > 0 && leverage > maxLev) {
          this.log('info', `${symbol}: leverage clamped ${leverage}x → ${maxLev}x (exchange bracket)`);
          leverage = maxLev;
        }
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
      margin = Math.max(0, Math.min(perTrade, usable > 0 ? usable : freeUsable));

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
      const notional = qty * entry;
      margin = notional / leverage;

      const slDist = sig.atr * s.atrSlMultiplier;
      const sl = entry - dir(sig.side) * slDist;
      const tp1 = entry + dir(sig.side) * slDist * s.tpRrFactor;
      const tp2 = entry + dir(sig.side) * slDist * s.tpRrFactor * 2;
      const tp3 = entry + dir(sig.side) * slDist * s.tpRrFactor * 3;
      const { q1, q2, q3 } = splitQty(qty, info.stepSize, s.tp1ClosePct, s.tp2ClosePct);

      const id = rndId();
      const prefix = `VX${id}`;
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
        orders: {},
        mode: s.mode,
        result: null,
        botOwned: true,
        scan: scanRow
          ? { volatility: scanRow.volatility, adx: scanRow.adx, atrPct: scanRow.atrPct, rank: (scanner.result()?.rows.indexOf(scanRow) ?? -1) + 1 }
          : null,
      };

      if (s.mode === 'paper') {
        const bal = getPaperBalance(PAPER_START_BALANCE);
        if (margin > bal) throw new Error(`Insufficient paper balance (${bal.toFixed(2)} USDT)`);
        // Book the entry commission exactly like Binance does (taker fee on
        // notional at entry) so paper fees match the real fee model.
        const entryFee = notional * s.feeRate;
        trade.fees = entryFee;
        trade.realizedPnl -= entryFee;
        adjustPaperBalance(-entryFee);
        trade.orders = {
          entry: `${prefix}E`, sl: `${prefix}S`,
          tp1: q1 > 0 ? `${prefix}1` : undefined,
          tp2: q2 > 0 ? `${prefix}2` : undefined,
          tp3: `${prefix}3`,
        } as any;
        this.log('info', `PAPER ${trade.side} ${fmtQty(qty)} ${symbol} @ ${entry} | SL ${trade.slInitial} | TP ${trade.tp1}/${trade.tp2}/${trade.tp3}`);
      } else {
        await api.setLeverage(symbol, leverage);
        await api.setIsolated(symbol);
        const openSide: 'BUY' | 'SELL' = trade.side === 'LONG' ? 'BUY' : 'SELL';
        const entryRes = await api.marketOrder(symbol, openSide, qty, { newClientOrderId: `${prefix}E` });
        const avg = Number(entryRes?.avgPrice || 0);
        if (avg > 0 && Math.abs(avg - entry) / entry > 0.0001) {
          entry = avg;
          trade.entryPrice = avg;
          trade.notional = qty * avg;
          trade.margin = trade.notional / leverage;
          const sl2 = entry - dir(trade.side) * slDist;
          trade.slInitial = roundToTick(sl2, info.tickSize);
          trade.slCurrent = trade.slInitial;
          trade.tp1 = roundToTick(entry + dir(trade.side) * slDist * s.tpRrFactor, info.tickSize);
          trade.tp2 = roundToTick(entry + dir(trade.side) * slDist * s.tpRrFactor * 2, info.tickSize);
          trade.tp3 = roundToTick(entry + dir(trade.side) * slDist * s.tpRrFactor * 3, info.tickSize);
          trade.initialRisk = slDist * qty;
        }
        trade.orders.entry = `${prefix}E`;
        try {
          // Explicit size + reduceOnly (one-way) / positionSide (hedge): the
          // protective stop can never close more than the bot's own quantity.
          await api.protectiveStop(symbol, closeSide(trade.side), trade.slInitial, qty, `${prefix}S0`);
          trade.orders.sl = `${prefix}S0`;
          if (q1 > 0) {
            await api.takeProfitMarket(symbol, closeSide(trade.side), trade.tp1, q1, { newClientOrderId: `${prefix}1` });
            trade.orders.tp1 = `${prefix}1`;
          }
          if (q2 > 0) {
            await api.takeProfitMarket(symbol, closeSide(trade.side), trade.tp2, q2, { newClientOrderId: `${prefix}2` });
            trade.orders.tp2 = `${prefix}2`;
          }
          await api.takeProfitMarket(symbol, closeSide(trade.side), trade.tp3, q3, { newClientOrderId: `${prefix}3` });
          trade.orders.tp3 = `${prefix}3`;
        } catch (err: any) {
          this.log('error', `Order placement failed (${err?.message}) — flattening position`);
          try {
            await api.marketOrder(symbol, closeSide(trade.side), qty, { reduceOnly: true, newClientOrderId: `${prefix}X` });
          } catch { /* best effort */ }
          throw err;
        }
        this.log('info', `LIVE ${trade.side} ${fmtQty(qty)} ${symbol} @ ${trade.entryPrice} | SL ${trade.slInitial} | TP ${trade.tp1}/${trade.tp2}/${trade.tp3}`);
      }

      saveTrade(trade);
      markSignalActed(sig.record.id, trade.id);
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

  // ---------------- TP / SL fills ----------------

  fillTP(t: Trade, n: 1 | 2 | 3, price: number, binance?: { rp?: number; commission?: number; commissionAsset?: string }): void {
    if (t.status !== 'OPEN') return;
    const d = dir(t.side);
    const s = getSettings();
    const q = n === 1 ? t.q1 : n === 2 ? t.q2 : t.q3;
    if (q <= 0 && n !== 3) return;

    if (t.mode === 'paper') {
      const gross = (price - t.entryPrice) * d * q;
      const fee = price * q * s.feeRate;
      t.realizedPnl += gross - fee;
      t.fees += fee;
      adjustPaperBalance(gross - fee);
    } else if (binance) {
      this.applyBinanceNumbers(t, binance.rp, binance.commission, binance.commissionAsset);
    }

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
      this.finalize(t, 'TP3', price);
    } else if (t.mode !== 'paper') {
      void this.moveSL(t);
    }
  }

  fillSL(t: Trade, stopPrice: number, marketPrice: number, binance?: { rp?: number; commission?: number; commissionAsset?: string }): void {
    if (t.status !== 'OPEN') return;
    const d = dir(t.side);
    const s = getSettings();
    const remaining = remainingQtyOf(t);
    if (remaining <= 0) {
      this.finalize(t, 'TP3', stopPrice);
      return;
    }
    // A stop that gapped through fills at the market, never better than the
    // stop itself. This keeps the paper simulation honest on gaps.
    const market = Number.isFinite(marketPrice) && marketPrice > 0 ? marketPrice : stopPrice;
    const fill = d > 0 ? Math.min(stopPrice, market) : Math.max(stopPrice, market);
    if (t.mode === 'paper') {
      const gross = (fill - t.entryPrice) * d * remaining;
      const fee = fill * remaining * s.feeRate;
      t.realizedPnl += gross - fee;
      t.fees += fee;
      adjustPaperBalance(gross - fee);
    } else if (binance) {
      this.applyBinanceNumbers(t, binance.rp, binance.commission, binance.commissionAsset);
    }
    const anyTP = t.tp1Filled || t.tp2Filled;
    const reason: Trade['closeReason'] = anyTP ? 'SL_PARTIAL' : 'SL';
    this.log('info', `${t.symbol}: SL hit @ ${fill} — remaining closed, PnL ${t.realizedPnl >= 0 ? '+' : ''}${t.realizedPnl.toFixed(2)} USDT`);
    emit('log', {
      level: anyTP ? 'win' : 'loss',
      msg: `${t.symbol} SL ${anyTP ? '(after TP — still a WIN 🟢)' : '🔴'} hit @ ${fill}, PnL ${t.realizedPnl.toFixed(2)} USDT`,
    });
    this.finalize(t, reason, fill);
  }

  /** Sum Binance-reported fills into the trade (commission is negative in the API). */
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

  /** Pull Binance's own fill ledger for this trade (fees + realised PnL, idempotent). */
  async reconcileBinanceNumbers(t: Trade): Promise<void> {
    if (t.mode === 'paper') return;
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
    if (t.mode === 'paper') return;
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

  /** Market-close a specific bot trade (reverse / kill switch). */
  async closeByMarket(t: Trade, reason: 'REVERSE' | 'KILL'): Promise<void> {
    if (!t || t.status !== 'OPEN') return;
    const d = dir(t.side);
    const s = getSettings();
    const remaining = remainingQtyOf(t);
    const price = this.priceOf(t.symbol) || t.entryPrice;
    if (remaining > 0) {
      if (t.mode === 'paper') {
        const gross = (price - t.entryPrice) * d * remaining;
        const fee = price * remaining * s.feeRate;
        t.realizedPnl += gross - fee;
        t.fees += fee;
        adjustPaperBalance(gross - fee);
      } else {
        try {
          const dual = await api.isDualSide();
          // Tagged + reduceOnly: the close can only shrink OUR position and is
          // always attributable to this trade by client order id.
          await api.marketOrder(
            t.symbol,
            closeSide(t.side),
            remaining,
            dual
              ? { positionSide: t.side === 'LONG' ? 'LONG' : 'SHORT', newClientOrderId: `${t.orders.entry?.slice(0, -1) ?? `VX${t.id}`}X` }
              : { reduceOnly: true, newClientOrderId: `${t.orders.entry?.slice(0, -1) ?? `VX${t.id}`}X` },
          );
          // Authoritative numbers straight from Binance's ledger.
          await this.reconcileBinanceNumbers(t);
        } catch (e: any) {
          this.log('error', `${t.symbol}: market close failed: ${e?.message}`);
        }
      }
    }
    this.log('info', `${t.symbol}: closed (${reason}) @ ${price} — PnL ${t.realizedPnl.toFixed(2)} USDT`);
    this.finalize(t, reason, price);
  }

  private async finalize(t: Trade, reason: Trade['closeReason'], price: number): Promise<void> {
    if (t.status === 'CLOSED') return;
    t.status = 'CLOSED';
    t.closedAt = Date.now();
    t.closeReason = reason;
    t.result = reason === 'TP3' || reason === 'SL_PARTIAL' ? 'WIN' : reason === 'SL' ? 'LOSS' : null;
    if (t.mode !== 'paper') {
      await this.reconcileBinanceNumbers(t);
      await this.refreshFunding(t);
    }
    saveTrade(t);
    if (t.mode !== 'paper') {
      // Cancel what is left of OUR ladder (TPs, and the stop if the position was
      // already flattened). Only client ids tagged VX<tradeId> are ever touched.
      for (const key of ['sl', 'tp1', 'tp2', 'tp3'] as const) {
        const cid = t.orders[key];
        if (!cid) continue;
        try {
          await api.cancelOrder(t.symbol, undefined, cid);
        } catch { /* already gone */ }
      }
    }
    emit('trade', { event: 'closed', trade: t, price });
    emit('log', {
      level: t.result === 'WIN' ? 'win' : t.result === 'LOSS' ? 'loss' : 'info',
      msg: `${t.symbol} trade closed (${reason}) — PnL ${t.realizedPnl >= 0 ? '+' : ''}${t.realizedPnl.toFixed(2)} USDT · fees ${t.fees.toFixed(3)} · funding ${t.funding.toFixed(3)}${t.result ? ` [${t.result}]` : ''}`,
    });
  }

  private async moveSL(t: Trade): Promise<void> {
    if (t.status !== 'OPEN' || t.mode === 'paper' || this.slBusy.has(t.id)) return;
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
    if (!t || t.mode === 'paper' || t.symbol !== o.s) return;
    const exec = o.x; // NEW | TRADED | CANCELED | EXPIRED | REJECTED
    const status = o.X;
    const price = Number(o.L) || Number(o.ap) || 0;
    const filled = exec === 'TRADED' || status === 'FILLED';
    if (!filled) return;
    const binance = { rp: Number(o.rp) || 0, commission: Number(o.n) || 0, commissionAsset: String(o.N || 'USDT') };

    if (cid.startsWith(`VX${t.id}S`)) {
      this.fillSL(t, Number(o.sp) || t.slCurrent, price || t.slCurrent, binance);
    } else if (cid === `VX${t.id}1` && !t.tp1Filled) {
      this.fillTP(t, 1, price || t.tp1, binance);
    } else if (cid === `VX${t.id}2` && !t.tp2Filled) {
      this.fillTP(t, 2, price || t.tp2, binance);
    } else if (cid === `VX${t.id}3` && !t.tp3Filled) {
      this.fillTP(t, 3, price || t.tp3, binance);
    } else if (cid === `VX${t.id}E`) {
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
    const trades = openTrades().filter((t) => t.mode !== 'paper');
    for (const t of trades) {
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
    const byCid = (suffix: string) => mine.find((o) => String(o.clientOrderId) === `VX${t.id}${suffix}`);

    const sl = mine.find((o) => String(o.clientOrderId).startsWith(`VX${t.id}S`));
    if (sl?.status === 'FILLED' && t.status === 'OPEN') {
      this.fillSL(t, Number(sl.avgPrice || sl.stopPrice) || t.slCurrent, Number(sl.avgPrice) || t.slCurrent);
      return;
    }
    if (!t.tp3Filled && byCid('3')?.status === 'FILLED') this.fillTP(t, 3, Number(byCid('3')!.avgPrice) || t.tp3);
    if (t.status !== 'OPEN') return;
    if (!t.tp1Filled && byCid('1')?.status === 'FILLED') this.fillTP(t, 1, Number(byCid('1')!.avgPrice) || t.tp1);
    if (t.status !== 'OPEN') return;
    if (!t.tp2Filled && byCid('2')?.status === 'FILLED') this.fillTP(t, 2, Number(byCid('2')!.avgPrice) || t.tp2);
    if (t.status !== 'OPEN') return;

    // Our position still open? Check the position amount for our symbol.
    const pos = await api.positionAmount(t.symbol);
    const flat = Math.abs(pos) < info.stepSize / 2;
    if (flat && t.status === 'OPEN') {
      this.log('info', `${t.symbol}: position flat (external fill detected) — closing bot trade record`);
      this.finalize(t, 'EXTERNAL', Number(byCid('3')?.avgPrice) || this.priceOf(t.symbol) || t.entryPrice);
      return;
    }
    if (!flat && !this.slBusy.has(t.id)) {
      const open = await api.openOrders(t.symbol);
      const hasSL = open.some((o) => String(o.clientOrderId || '').startsWith(`VX${t.id}S`));
      if (!hasSL && !t.tp3Filled) {
        const slAlive = mine.some(
          (o) => String(o.clientOrderId).startsWith(`VX${t.id}S`) && ['NEW', 'PARTIALLY_FILLED'].includes(String(o.status)),
        );
        if (!slAlive) {
          this.log('error', `${t.symbol}: SL order missing while position open — re-arming SL`);
          const cid = `VX${t.id}S${t.slStage}`;
          await api.protectiveStop(
            t.symbol,
            closeSide(t.side),
            roundToTick(t.slCurrent, info.tickSize),
            remainingQtyOf(t),
            cid,
          );
          t.orders.sl = cid;
          saveTrade(t);
          emit('trade', { event: 'sl-rearmed', trade: t });
        }
      }
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
    for (const t of trades) await this.closeByMarket(t, 'KILL');
    return trades.length;
  }

  usedPaperBalance(): number {
    return openTrades().reduce((a, t) => a + t.margin, 0);
  }

  /** Only used by tests / maintenance. */
  resetPaper(): void {
    setPaperBalance(PAPER_START_BALANCE);
  }

  private log(level: 'info' | 'error' | 'win' | 'loss', msg: string): void {
    console.log(`[${level}] ${msg}`);
    emit('log', { level, msg, t: Date.now() });
  }
}

export const trader = new Trader();

/**
 * Trade executor — state machine implementing your scale-out rules:
 *   TP1  -> close 33% of position, SL moves to BREAKEVEN
 *   TP2  -> close 50% of remaining, SL moves to TP1
 *   TP3  -> close the rest (FULL profit)
 *   Opposite signal -> close & reverse (TradingView indicator behaviour)
 *
 * Runs against live Binance prices in 'paper' mode (simulated fills) and places
 * real STOP_MARKET / TAKE_PROFIT_MARKET orders in 'testnet' / 'live' modes.
 * Only trades opened by this bot are ever monitored or touched.
 */
import { api, floorToStep, roundToTick, fmtQty } from './binance';
import { SignalSide } from './indicators';
import {
  activeTrade, adjustPaperBalance, allTrades, getPaperBalance, markSignalActed,
  saveTrade, setPaperBalance, SignalRecord, Trade,
} from './store';
import { getSettings } from './settings';
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
  private lastPrice = 0;
  private priceQueue: number | null = null;
  private processing = false;
  private slBusy = false;
  /** intended cancellations — don't treat as unexpected in reconcile */
  private intentionalCancel = new Set<string>();

  // ---------------- price tick (paper fills + UI) ----------------

  onPrice(price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    this.lastPrice = price;
    if (this.priceQueue === null) this.priceQueue = price;
    else this.priceQueue = price; // keep trailing
    if (!this.processing) {
      this.processing = true;
      setImmediate(() => {
        this.processing = false;
        const p = this.priceQueue;
        this.priceQueue = null;
        if (p != null) this.checkPaperFills(p);
      });
    }
  }

  private checkPaperFills(price: number): void {
    const t = activeTrade();
    if (!t || t.mode !== 'paper' || t.status !== 'OPEN') return;
    const d = dir(t.side);
    // TPs first (furthest level would have filled nearer ones on the way)
    const levels: Array<{ n: 1 | 2 | 3; px: number; filled: boolean; qty: number }> = [
      { n: 1, px: t.tp1, filled: t.tp1Filled, qty: t.q1 },
      { n: 2, px: t.tp2, filled: t.tp2Filled, qty: t.q2 },
      { n: 3, px: t.tp3, filled: t.tp3Filled, qty: t.q3 },
    ];
    for (const lv of levels) {
      if (lv.filled || lv.qty <= 0) continue;
      const reached = d > 0 ? price >= lv.px : price <= lv.px;
      if (reached) this.fillTP(t, lv.n, lv.px);
      if ((t.status as string) === 'CLOSED') return;
    }
    if (t.status === 'OPEN' && !t.tp3Filled) {
      const slHit = d > 0 ? price <= t.slCurrent : price >= t.slCurrent;
      if (slHit) this.fillSL(t, t.slCurrent, price);
    }
  }

  // ---------------- signal entry ----------------

  async onSignal(sig: OpenSignal): Promise<void> {
    const settings = getSettings();
    const current = activeTrade();

    if (current) {
      const opposite = (sig.side === 'LONG' && current.side === 'SHORT') || (sig.side === 'SHORT' && current.side === 'LONG');
      if (opposite) {
        // Close & reverse — matches indicator behaviour (old trade replaced)
        this.log('info', `Opposite ${sig.side} signal → closing ${current.side} trade (close & reverse)`);
        await this.closeByMarket('REVERSE');
      } else {
        // same-direction signal while open: indicator would replace — we keep the running trade
        this.log('info', 'Same-direction signal while a trade is open — keeping current trade');
        return;
      }
    }

    if (!settings.autoTrade) {
      this.log('info', `Signal ${sig.side} @ ${sig.price} — auto-trade OFF, not entering`);
      return;
    }
    await this.openTrade(sig);
  }

  private async openTrade(sig: OpenSignal): Promise<void> {
    const s = getSettings();
    const symbol = s.symbol;
    try {
      const info = await api.exchangeInfo(symbol);
      let entry = sig.price;
      let margin: number;
      let balanceSource: 'paper' | 'real';

      if (s.mode === 'paper') {
        balanceSource = 'paper';
        const bal = getPaperBalance(s.paperBalance);
        margin = (bal * s.tradeSizePercent) / 100;
      } else {
        balanceSource = 'real';
        const bal = await api.balanceUSDT();
        margin = Math.min((bal.total * s.tradeSizePercent) / 100, bal.available * 0.95);
      }

      let qty = floorToStep((margin * s.leverage) / entry, info.stepSize);
      const needQty = Math.max(
        info.minQty,
        Math.ceil((info.minNotional / entry) / info.stepSize - 1e-9) * info.stepSize,
      );
      if (qty < needQty) {
        // top-up to exchange minimum if balance allows
        const needMargin = (needQty * entry) / s.leverage;
        if (s.mode === 'paper') {
          const bal = getPaperBalance(s.paperBalance);
          if (needMargin > bal * 0.95) throw new Error(`Balance too small: need ~${needMargin.toFixed(2)} USDT margin (min notional ${info.minNotional})`);
          qty = needQty;
        } else {
          if (needMargin > margin) throw new Error(`Balance too small: need ~${needMargin.toFixed(2)} USDT margin (min notional ${info.minNotional})`);
          qty = needQty;
        }
      }
      if (qty <= 0) throw new Error('Computed quantity is zero — increase trade size or balance');
      const notional = qty * entry;
      margin = notional / s.leverage;

      const slDist = sig.atr * s.atrSlMultiplier;
      const sl = entry - dir(sig.side) * slDist;
      const tp1 = entry + dir(sig.side) * slDist * s.tpRrFactor;
      const tp2 = entry + dir(sig.side) * slDist * s.tpRrFactor * 2;
      const tp3 = entry + dir(sig.side) * slDist * s.tpRrFactor * 3;
      const { q1, q2, q3 } = splitQty(qty, info.stepSize, s.tp1ClosePct, s.tp2ClosePct);

      const id = rndId();
      const prefix = `VX${id}`;
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
        leverage: s.leverage,
        openedAt: Date.now(),
        closedAt: null,
        closeReason: null,
        tp1Filled: false,
        tp2Filled: false,
        tp3Filled: false,
        realizedPnl: 0,
        fees: 0,
        initialRisk: slDist * qty,
        orders: {},
        mode: s.mode,
        result: null,
      };

      if (s.mode === 'paper') {
        const bal = getPaperBalance(s.paperBalance);
        if (margin > bal) throw new Error(`Insufficient paper balance (${bal.toFixed(2)} USDT)`);
        trade.orders = {
          entry: `${prefix}E`, sl: `${prefix}S`,
          tp1: q1 > 0 ? `${prefix}1` : undefined,
          tp2: q2 > 0 ? `${prefix}2` : undefined,
          tp3: `${prefix}3`,
        } as any;
        this.log('info', `PAPER ${trade.side} ${fmtQty(qty)} ${symbol} @ ${entry} | SL ${trade.slInitial} | TP ${trade.tp1}/${trade.tp2}/${trade.tp3}`);
      } else {
        // ---- real orders (testnet / live) ----
        await api.setLeverage(symbol, s.leverage);
        await api.setIsolated(symbol);
        const openSide: 'BUY' | 'SELL' = trade.side === 'LONG' ? 'BUY' : 'SELL';
        const entryRes = await api.marketOrder(symbol, openSide, qty, { newClientOrderId: `${prefix}E` });
        const avg = Number(entryRes?.avgPrice || 0);
        if (avg > 0 && Math.abs(avg - entry) / entry > 0.0001) {
          // recompute levels from the real fill (settings-driven formula unchanged)
          entry = avg;
          trade.entryPrice = avg;
          trade.notional = qty * avg;
          trade.margin = trade.notional / s.leverage;
          const sl2 = entry - dir(trade.side) * slDist;
          trade.slInitial = roundToTick(sl2, info.tickSize);
          trade.slCurrent = trade.slInitial;
          trade.tp1 = roundToTick(entry + dir(trade.side) * slDist * s.tpRrFactor, info.tickSize);
          trade.tp2 = roundToTick(entry + dir(trade.side) * slDist * s.tpRrFactor * 2, info.tickSize);
          trade.tp3 = roundToTick(entry + dir(trade.side) * slDist * s.tpRrFactor * 3, info.tickSize);
          trade.initialRisk = slDist * qty;
        }
        trade.orders.entry = `${prefix}E`;
        // Orders must be correct from the first second — if anything fails, flatten.
        try {
          const slOrder = await api.stopMarket(symbol, closeSide(trade.side), trade.slInitial, {
            closePosition: true, newClientOrderId: `${prefix}S0`,
          });
          trade.orders.sl = `${prefix}S0`;
          void slOrder;
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
            await api.marketOrder(symbol, closeSide(trade.side), qty, { reduceOnly: true });
          } catch { /* best effort */ }
          throw err;
        }
        this.log('info', `LIVE ${trade.side} ${fmtQty(qty)} ${symbol} @ ${trade.entryPrice} | SL ${trade.slInitial} | TP ${trade.tp1}/${trade.tp2}/${trade.tp3}`);
      }

      saveTrade(trade);
      markSignalActed(sig.record.id, trade.id);
      emit('trade', { event: 'opened', trade });
      emit('log', { level: 'info', msg: `Opened ${trade.side} ${trade.symbol} @ ${trade.entryPrice}` });
    } catch (err: any) {
      this.log('error', `Entry failed: ${err?.message || err}`);
      emit('error', { message: `Entry failed: ${err?.message || err}` });
    }
  }

  // ---------------- TP / SL fills ----------------

  fillTP(t: Trade, n: 1 | 2 | 3, price: number): void {
    if (t.status !== 'OPEN') return;
    const d = dir(t.side);
    const s = getSettings();
    const q = n === 1 ? t.q1 : n === 2 ? t.q2 : t.q3;
    if (q <= 0 && n !== 3) return;
    const gross = (price - t.entryPrice) * d * q;
    const fee = price * q * s.feeRate;
    t.realizedPnl += gross - fee;
    t.fees += fee;
    if (n === 1) {
      t.tp1Filled = true;
      if (t.slStage < 1) {
        t.slStage = 1;
        t.slCurrent = t.entryPrice;
      }
      this.log('info', `TP1 hit @ ${price} — closed 33% (${fmtQty(q)}), SL → breakeven (${t.entryPrice})`);
      emit('log', { level: 'win', msg: `TP1 ✅ 33% closed @ ${price} — SL moved to breakeven` });
    } else if (n === 2) {
      t.tp2Filled = true;
      if (t.slStage < 2) {
        t.slStage = 2;
        t.slCurrent = t.tp1;
      }
      this.log('info', `TP2 hit @ ${price} — closed 50% of remaining (${fmtQty(q)}), SL → TP1 (${t.tp1})`);
      emit('log', { level: 'win', msg: `TP2 ✅ 50% remaining closed @ ${price} — SL moved to TP1` });
    } else {
      t.tp3Filled = true;
      this.log('info', `TP3 hit @ ${price} — full profit booked (${fmtQty(q)})`);
      emit('log', { level: 'win', msg: `TP3 🎯 FULL profit booked @ ${price}` });
    }
    if (t.mode === 'paper') adjustPaperBalance(gross - fee);
    saveTrade(t);
    emit('trade', { event: 'fill', level: n, price, trade: t });

    if (n === 3) {
      this.finalize(t, 'TP3', price);
    } else if (t.mode !== 'paper') {
      void this.moveSL(t);
    }
  }

  fillSL(t: Trade, stopPrice: number, marketPrice: number): void {
    if (t.status !== 'OPEN') return;
    const d = dir(t.side);
    const s = getSettings();
    const remaining = t.qty - (t.tp1Filled ? t.q1 : 0) - (t.tp2Filled ? t.q2 : 0) - (t.tp3Filled ? t.q3 : 0);
    if (remaining <= 0) {
      this.finalize(t, 'TP3', stopPrice);
      return;
    }
    const fill = stopPrice; // stop-market: fills at/around stop
    const gross = (fill - t.entryPrice) * d * remaining;
    const fee = fill * remaining * s.feeRate;
    t.realizedPnl += gross - fee;
    t.fees += fee;
    if (t.mode === 'paper') adjustPaperBalance(gross - fee);
    const anyTP = t.tp1Filled || t.tp2Filled;
    const reason: Trade['closeReason'] = anyTP ? 'SL_PARTIAL' : 'SL';
    this.log('info', `SL hit @ ${fill} — remaining closed, PnL ${t.realizedPnl >= 0 ? '+' : ''}${t.realizedPnl.toFixed(2)} USDT`);
    emit('log', { level: anyTP ? 'win' : 'loss', msg: `SL ${anyTP ? '(after TP — still a WIN 🟢)' : '🔴'} hit @ ${fill}, PnL ${t.realizedPnl.toFixed(2)} USDT` });
    void marketPrice;
    this.finalize(t, reason, fill);
  }

  /** Market-close remaining (reverse / kill switch). */
  async closeByMarket(reason: 'REVERSE' | 'KILL'): Promise<void> {
    const t = activeTrade();
    if (!t) return;
    const d = dir(t.side);
    const s = getSettings();
    const remaining = t.qty - (t.tp1Filled ? t.q1 : 0) - (t.tp2Filled ? t.q2 : 0) - (t.tp3Filled ? t.q3 : 0);
    const price = this.lastPrice || t.entryPrice;
    if (remaining > 0) {
      const gross = (price - t.entryPrice) * d * remaining;
      const fee = price * remaining * s.feeRate;
      t.realizedPnl += gross - fee;
      t.fees += fee;
      if (t.mode === 'paper') adjustPaperBalance(gross - fee);
      if (t.mode !== 'paper') {
        try {
          const dual = await api.isDualSide();
          await api.marketOrder(t.symbol, closeSide(t.side), remaining, dual
            ? { positionSide: t.side === 'LONG' ? 'LONG' : 'SHORT' }
            : { reduceOnly: true });
        } catch (e: any) {
          this.log('error', `Market close failed: ${e?.message}`);
        }
      }
    }
    this.log('info', `Closed (${reason}) @ ${price} — PnL ${t.realizedPnl.toFixed(2)} USDT`);
    this.finalize(t, reason, price);
  }

  private async finalize(t: Trade, reason: Trade['closeReason'], price: number): Promise<void> {
    if (t.status === 'CLOSED') return;
    t.status = 'CLOSED';
    t.closedAt = Date.now();
    t.closeReason = reason;
    t.result = reason === 'TP3' || reason === 'SL_PARTIAL' ? 'WIN' : reason === 'SL' ? 'LOSS' : null;
    saveTrade(t);
    // remove any resting bot orders (live) — never leave orphans
    if (t.mode !== 'paper') {
      for (const key of ['sl', 'tp1', 'tp2', 'tp3'] as const) {
        const cid = t.orders[key];
        if (!cid) continue;
        this.intentionalCancel.add(cid);
        try { await api.cancelOrder(t.symbol, undefined, cid); } catch { /* gone */ }
      }
    }
    emit('trade', { event: 'closed', trade: t, price });
    emit('log', {
      level: t.result === 'WIN' ? 'win' : t.result === 'LOSS' ? 'loss' : 'info',
      msg: `Trade closed (${reason}) — PnL ${t.realizedPnl >= 0 ? '+' : ''}${t.realizedPnl.toFixed(2)} USDT${t.result ? ` [${t.result}]` : ''}`,
    });
  }

  private async moveSL(t: Trade): Promise<void> {
    if (t.status !== 'OPEN' || t.mode === 'paper' || this.slBusy) return;
    this.slBusy = true;
    try {
      const info = await api.exchangeInfo(t.symbol);
      const newStop = roundToTick(t.slCurrent, info.tickSize);
      t.slCurrent = newStop;
      const oldCid = t.orders.sl;
      if (oldCid) {
        this.intentionalCancel.add(oldCid);
        try {
          await api.cancelOrder(t.symbol, undefined, oldCid);
        } catch (e: any) {
          this.log('error', `SL cancel failed: ${e?.message} — will verify position`);
        }
      }
      const newCid = `VX${t.id}S${t.slStage}`;
      try {
        await api.stopMarket(t.symbol, closeSide(t.side), newStop, {
          closePosition: true, newClientOrderId: newCid,
        });
        t.orders.sl = newCid;
        saveTrade(t);
        emit('trade', { event: 'sl-moved', trade: t });
        this.log('info', `SL moved to ${newStop} (stage ${t.slStage})`);
      } catch (e: any) {
        this.log('error', `SL replacement failed: ${e?.message} — FLATTENING for safety`);
        emit('error', { message: 'SL replacement failed — closing position for safety' });
        await this.closeByMarket('KILL');
      }
    } finally {
      this.slBusy = false;
    }
  }

  // ---------------- live order events ----------------

  /** ORDER_TRADE_UPDATE from the user data stream. */
  onOrderUpdate(ev: any): void {
    const o = ev.o ?? ev; // payload is wrapped in `o`
    const t = activeTrade();
    if (!t || t.mode === 'paper' || t.symbol !== o.s) return;
    const cid: string = o.c || '';
    if (!cid.startsWith(`VX${t.id}`)) return;
    const exec = o.x; // NEW | TRADED | CANCELED | EXPIRED | REJECTED
    const status = o.X;
    const price = Number(o.L) || Number(o.ap) || 0;
    const filled = exec === 'TRADED' || status === 'FILLED';

    if (!filled) return;
    if (cid.startsWith(`VX${t.id}S`)) {
      this.fillSL(t, Number(o.sp) || t.slCurrent, price || t.slCurrent);
    } else if (cid === `VX${t.id}1` && !t.tp1Filled) {
      this.fillTP(t, 1, price || t.tp1);
    } else if (cid === `VX${t.id}2` && !t.tp2Filled) {
      this.fillTP(t, 2, price || t.tp2);
    } else if (cid === `VX${t.id}3` && !t.tp3Filled) {
      this.fillTP(t, 3, price || t.tp3);
    } else if (cid === `VX${t.id}E`) {
      const avg = Number(ev.ap) || 0;
      if (avg > 0 && Math.abs(avg - t.entryPrice) / t.entryPrice > 0.001) {
        this.log('info', `Entry fill confirmed @ ${avg}`);
      }
    }
  }

  /** Periodic safety net for live/testnet: catch missed fills, re-arm missing SL. */
  async reconcile(): Promise<void> {
    const t = activeTrade();
    if (!t || t.mode === 'paper') return;
    const s = getSettings();
    if (s.symbol !== t.symbol) return;
    try {
      const info = await api.exchangeInfo(t.symbol);
      const pos = await api.positionAmount(t.symbol);
      const flat = Math.abs(pos) < info.stepSize / 2;
      if (flat && t.status === 'OPEN') {
        // find what actually happened
        const orders = await this.orderHistory(t);
        const sl = orders.find((o) => o.clientOrderId === `VX${t.id}S`);
        const tp3 = orders.find((o) => o.clientOrderId === `VX${t.id}3`);
        const tp2 = orders.find((o) => o.clientOrderId === `VX${t.id}2`);
        const tp1 = orders.find((o) => o.clientOrderId === `VX${t.id}1`);
        if (sl?.status === 'FILLED') this.fillSL(t, Number(sl.avgPrice || sl.stopPrice) || t.slCurrent, Number(sl.avgPrice) || t.slCurrent);
        else {
          if (tp1?.status === 'FILLED' && !t.tp1Filled) this.fillTP(t, 1, Number(tp1.avgPrice) || t.tp1);
          if (tp2?.status === 'FILLED' && !t.tp2Filled) this.fillTP(t, 2, Number(tp2.avgPrice) || t.tp2);
          if (tp3?.status === 'FILLED' && !t.tp3Filled) this.fillTP(t, 3, Number(tp3.avgPrice) || t.tp3);
          if (t.status === 'OPEN') {
            this.log('info', 'Position flat (external fill detected) — closing trade record');
            this.finalize(t, 'EXTERNAL', Number(tp3?.avgPrice) || this.lastPrice || t.entryPrice);
          }
        }
        return;
      }
      if (!flat && t.status === 'OPEN' && !this.slBusy) {
        const open = await api.openOrders(t.symbol);
        const hasSL = open.some((o) => String(o.clientOrderId || '').startsWith(`VX${t.id}S`));
        if (!hasSL && !t.tp3Filled) {
          const orders = await this.orderHistory(t);
          const sls = orders.filter((o) => String(o.clientOrderId || '').startsWith(`VX${t.id}S`));
          const slAlive = sls.some((o) => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED' || o.status === 'FILLED');
          if (!slAlive) {
            this.log('error', 'SL order missing while position open — re-arming SL');
            const info2 = await api.exchangeInfo(t.symbol);
            const cid = `VX${t.id}S${t.slStage}`;
            await api.stopMarket(t.symbol, closeSide(t.side), roundToTick(t.slCurrent, info2.tickSize), {
              closePosition: true, newClientOrderId: cid,
            });
            t.orders.sl = cid;
            saveTrade(t);
            emit('trade', { event: 'sl-rearmed', trade: t });
          }
        }
      }
    } catch (e: any) {
      this.log('error', `Reconcile error: ${e?.message}`);
    }
  }

  private async orderHistory(t: Trade): Promise<any[]> {
    try {
      const rows = (await (api as any).signed('GET', '/fapi/v1/allOrders', { symbol: t.symbol, limit: 50 })) as any[];
      return rows.filter((o: any) => String(o.clientOrderId || '').startsWith(`VX${t.id}`));
    } catch {
      return [];
    }
  }

  // ---------------- kill switch ----------------

  async kill(): Promise<void> {
    const t = activeTrade();
    if (!t) {
      this.log('info', 'Kill switch: no open trade');
      return;
    }
    await this.closeByMarket('KILL');
  }

  private log(level: 'info' | 'error' | 'win' | 'loss', msg: string): void {
    console.log(`[${level}] ${msg}`);
    emit('log', { level, msg, t: Date.now() });
  }
}

export const trader = new Trader();

/** Test helper: expose cancel-intent set. */
export const __intentional = (trader as any).intentionalCancel as Set<string>;
void allTrades;

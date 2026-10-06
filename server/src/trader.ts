/**
 * Trade executor — multi-position state machine.
 *
 * New liquidity-sweep trades use five equal scale-outs at 1R..5R:
 *   TP1..TP4 close ~20% each; the stop advances BE, 1R, 2R, 3R respectively;
 *   TP5 closes the final remainder. Existing journalled trades retain their
 *   legacy three-target ladder until they are flat.
 *
 * Multi-position model:
 *   • Up to **8** simultaneous positions (hard cap), one per symbol; scanner
 *     selection is a monitor list, while signal direction comes from the 5m setup.
 *   • The bot ONLY manages trades it opened itself. Orders are tagged
 *     `VX<tradeId>…`, exits carry explicit reduce-only quantities, and a symbol
 *     already carrying a position is never adopted or reversed by a new POC signal.
 *
 * Stops and take-profits are Binance Algo Service orders (POST /fapi/v1/algoOrder,
 * the only place STOP_MARKET / TAKE_PROFIT_MARKET are accepted since 2025-12-09).
 * Their client ids are `clientAlgoId`s; a fired leg is reported by ALGO_UPDATE
 * and double-checked by the REST reconcile loop, so a missed WebSocket frame can
 * never leave the journal out of step with the exchange.
 *
 * The live executor reads fills, commissions, funding and realised PnL from
 * Binance (ORDER_TRADE_UPDATE, /fapi/v1/userTrades, /fapi/v1/income). The
 * historical OHLCV simulator is a separate pure module and never calls this
 * state machine.
 */
import { AlgoLegState, api, floorToStep, roundToTick, fmtQty } from './binance';
import { SignalSide } from './indicators';
import {
  isFiveRTrade, markSignalActed, openTradeOn, openTrades, remainingQtyOf, saveTrade, SignalRecord, Trade,
  tpCountOf, tpFilledOf, tpPriceOf, tpQtyOf,
} from './store';
import { getSettings, MAX_POSITIONS_CAP, updateSettings } from './settings';
import { priceOf, setPrice } from './prices';
import { scanner } from './scanner';
import { emit } from './broadcast';

export interface OpenSignal {
  record: SignalRecord;
  side: SignalSide;
  price: number;
  atr: number;
  /** Locked sweep-wick stop from the liquidity strategy. Absent only on legacy/test signals. */
  stopPrice?: number;
}

export interface ExecutionGate {
  ready: boolean;
  reasons: string[];
}

/**
 * The exchange minimum notional can force a bigger position than the configured
 * margin. A small round-up is fine; beyond this multiple of the configured
 * per-trade margin the entry is skipped rather than silently multiplying risk.
 */
const MIN_NOTIONAL_BUMP_LIMIT = 2;

/**
 * Circuit breaker: this many entries in a row whose protective ladder could not
 * be placed (so each was flattened again, paying fees for nothing) disarm
 * auto-trade. It is what stops a protocol change at the exchange from turning
 * every signal into a guaranteed loss.
 */
const MAX_LADDER_FAILURES = 2;

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

/** Five approximately equal exchange-step-aware slices; every leg must be placeable. */
export function splitFiveWayQty(
  qty: number,
  step: number,
  minLegQty = step,
): { q1: number; q2: number; q3: number; q4: number; q5: number } | null {
  if (!(qty > 0) || !(step > 0) || !(minLegQty > 0)) return null;
  const totalSteps = Math.round(qty / step);
  const minSteps = Math.max(1, Math.ceil(minLegQty / step - 1e-9));
  if (totalSteps < 5 * minSteps) return null;
  const base = Math.floor(totalSteps / 5);
  const extra = totalSteps % 5;
  const steps = Array.from({ length: 5 }, (_, i) => base + (i < extra ? 1 : 0));
  if (steps.some((count) => count < minSteps)) return null;
  const parts = steps.map((count) => Number((count * step).toPrecision(12)));
  // Avoid cumulative binary rounding from making the final reduce-only quantity
  // differ from the position quantity by a few floating-point ulps.
  parts[4] = Number((qty - parts.slice(0, 4).reduce((sum, value) => sum + value, 0)).toPrecision(12));
  if (parts[4] < minLegQty - step * 1e-8) return null;
  return { q1: parts[0], q2: parts[1], q3: parts[2], q4: parts[3], q5: parts[4] };
}

class Trader {
  /** Symbols with an entry round-trip in flight — blocks duplicates and reserves slots. */
  private entering = new Set<string>();
  private slBusy = new Set<string>();
  /** A newer TP can arrive while a stop replacement is in flight; rerun it after the current POST. */
  private slMoveRequested = new Set<string>();
  /** Trades whose market close is in flight — the recovery loop must not re-arm legs under it. */
  private closing = new Set<string>();
  /** Re-entrancy guard for the 10 s recovery loop (a slow pass must never overlap the next). */
  private reconciling = false;
  /** Trades with a recovery pass in flight (the loop and ALGO_UPDATE can both ask for one). */
  private recovering = new Set<string>();
  /** Consecutive recovery passes that saw a flat position but could not classify a fired leg. */
  private unsureStrikes = new Map<string, number>();
  /** Debounced Binance-ledger refreshes after a leg fills. */
  private ledgerTimers = new Map<string, NodeJS.Timeout>();
  /** Consecutive entries whose protective ladder failed (circuit breaker). */
  private ladderFailures = 0;
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
    const liquiditySignal = sig.record.strategy === 'LIQUIDITY_SWEEP_POC_RETEST';
    if (liquiditySignal && sig.stopPrice === undefined) {
      this.log('error', `${symbol}: liquidity signal has no sweep-based stop — entry rejected`);
      return;
    }
    if (sig.stopPrice !== undefined && (!Number.isFinite(sig.stopPrice) || dir(sig.side) * (sig.price - sig.stopPrice) <= 0)) {
      this.log('error', `${symbol}: sweep stop is invalid for ${sig.side} at the signal price — entry rejected`);
      return;
    }
    if (Date.now() - sig.record.detectedAt > 120_000) {
      this.log('error', `${symbol}: stale signal (${Math.round((Date.now() - sig.record.detectedAt) / 1000)}s) — never replaying an old entry`);
      return;
    }

    const current = openTradeOn(symbol);
    if (current) {
      // A new liquidity setup is an independent reversal thesis, not an
      // instruction to liquidate an already managed position. Keep the first
      // trade protected; the fresh setup is consumed and ignored.
      if (sig.stopPrice !== undefined || sig.record.strategy === 'LIQUIDITY_SWEEP_POC_RETEST') {
        this.log('info', `${symbol}: ${sig.side} POC setup ignored — a bot-owned ${current.side} trade is already open`);
        return;
      }
      // Compatibility only for old journal/test signals during migration.
      const opposite = (sig.side === 'LONG' && current.side === 'SHORT') || (sig.side === 'SHORT' && current.side === 'LONG');
      if (!opposite) {
        this.log('info', `${symbol}: same-direction signal while a bot trade is open — keeping current trade`);
        return;
      }
      this.log('info', `${symbol}: legacy opposite signal → closing bot ${current.side} trade`);
      const closed = await this.closeByMarket(current, 'REVERSE');
      if (!closed) {
        this.log('error', `${symbol}: reverse aborted because the existing position could not be confirmed closed`);
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

      // ---- production guard 1b: no stale ladder of ours on this symbol ----
      // A conditional leg left behind by an earlier trade (failed cancel,
      // crash) could fire into THIS trade's position. Only orders tagged with
      // the bot's VX prefix and no live trade are ever removed.
      await this.sweepOrphanLegs(symbol);

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
        // The exchange minimum forces a bigger position than the configured
        // size. Allow a small round-up, never a silent multiple of the risk.
        if (needMargin > perTrade * MIN_NOTIONAL_BUMP_LIMIT) {
          throw new Error(
            `${symbol}: the exchange minimum notional (${info.minNotional} USDT) needs ~${needMargin.toFixed(2)} USDT margin — more than ${MIN_NOTIONAL_BUMP_LIMIT}× the configured ${perTrade.toFixed(2)} USDT (${s.tradeSizePercent}% of equity); skipping`,
          );
        }
        this.log('info', `${symbol}: size raised to the exchange minimum ${fmtQty(needQty)} (margin ${needMargin.toFixed(2)} vs configured ${perTrade.toFixed(2)} USDT)`);
        qty = needQty;
      }
      if (qty <= 0) throw new Error('Computed quantity is zero — increase trade size or balance');

      const useFiveR = Number.isFinite(sig.stopPrice) && Number(sig.stopPrice) > 0;
      if (useFiveR) {
        // All five reduce-only targets must meet the exchange's per-order
        // quantity/notional floor. Skip rather than silently omit a 20% exit.
        const minLegQty = Math.max(info.minQty, info.minNotional / entry);
        const minLegSteps = Math.max(1, Math.ceil(minLegQty / info.stepSize - 1e-9));
        const minLadderQty = minLegSteps * info.stepSize * 5;
        if (qty < minLadderQty - info.stepSize * 1e-8) {
          const needMargin = (minLadderQty * entry) / leverage;
          const availableCap = Math.max(0, Math.min(available, equity) * 0.95 - marginUsed);
          if (needMargin > availableCap) {
            throw new Error(`${symbol}: five 20% take-profit legs need ~${needMargin.toFixed(2)} USDT margin, above free margin`);
          }
          if (needMargin > perTrade * MIN_NOTIONAL_BUMP_LIMIT) {
            throw new Error(`${symbol}: exchange minimums cannot support five 20% exits within ${MIN_NOTIONAL_BUMP_LIMIT}× configured margin; skipping`);
          }
          qty = minLadderQty;
          this.log('info', `${symbol}: size raised to ${fmtQty(qty)} so all five 20% exits meet exchange minimums`);
        }
        if (!splitFiveWayQty(qty, info.stepSize, minLegSteps * info.stepSize)) {
          throw new Error(`${symbol}: quantity cannot be divided into five valid exchange-sized exits — skipping`);
        }
      }

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

      const filledAvg = await this.entryFillPrice(symbol, entryCid, Number(entryRes?.avgPrice || 0));
      if (filledAvg > 0) entry = filledAvg;

      let rawStop = useFiveR ? Number(sig.stopPrice) : entry - dir(sig.side) * sig.atr * s.atrSlMultiplier;
      let slInitial = roundToTick(rawStop, info.tickSize);
      let riskDistance = dir(sig.side) * (entry - slInitial);
      let invalidatedAtFill = false;
      if (!(riskDistance > 0) || !Number.isFinite(riskDistance)) {
        if (!useFiveR) throw new Error('could not construct a valid protective stop from the signal');
        // A market gap can put the fill past the planned sweep stop. Persist a
        // safe temporary stop, arm it, then immediately flatten rather than
        // leaving an unprotected/unowned exchange position.
        invalidatedAtFill = true;
        riskDistance = Math.max(info.tickSize, sig.atr * Math.max(0.1, s.strategy.stopBufferAtr));
        rawStop = entry - dir(sig.side) * riskDistance;
        slInitial = roundToTick(rawStop, info.tickSize);
        riskDistance = Math.max(info.tickSize, dir(sig.side) * (entry - slInitial));
        this.log('error', `${symbol}: market fill crossed the sweep stop — arming emergency protection and flattening`);
      }

      const tpCount = useFiveR ? 5 : 3;
      const targetPrices = Array.from({ length: tpCount }, (_, i) =>
        roundToTick(entry + dir(sig.side) * riskDistance * (useFiveR ? i + 1 : s.tpRrFactor * (i + 1)), info.tickSize),
      );
      const notional = qty * entry;
      margin = notional / leverage;

      let q1 = 0, q2 = 0, q3 = 0, q4 = 0, q5 = 0;
      if (useFiveR) {
        const minLegQty = Math.max(info.minQty, info.minNotional / entry);
        const minLegSteps = Math.max(1, Math.ceil(minLegQty / info.stepSize - 1e-9));
        const slices = splitFiveWayQty(qty, info.stepSize, minLegSteps * info.stepSize);
        if (slices) ({ q1, q2, q3, q4, q5 } = slices);
        else {
          // Entry is already filled. Do not attempt an invalid partial ladder;
          // place a stop for the full size and flatten immediately.
          invalidatedAtFill = true;
          q5 = qty;
        }
      } else {
        const legacy = splitQty(qty, info.stepSize, s.tp1ClosePct, s.tp2ClosePct);
        q1 = legacy.q1; q2 = legacy.q2; q3 = legacy.q3;
      }
      const tp1 = targetPrices[0];
      const tp2 = targetPrices[1];
      const tp3 = targetPrices[2];
      const tp4 = targetPrices[3];
      const tp5 = targetPrices[4];
      const scanRow = scanner.result()?.rows.find((r) => r.symbol === symbol) ?? null;
      const trade: Trade = {
        id,
        symbol,
        side: sig.side,
        status: 'OPEN',
        qty,
        q1, q2, q3, q4, q5,
        exitPlan: useFiveR ? 'LIQUIDITY_5R' : 'LEGACY_3TP',
        entryPrice: entry,
        atrAtEntry: sig.atr,
        slInitial,
        slCurrent: slInitial,
        slStage: 0,
        tp1,
        tp2,
        tp3,
        tp4,
        tp5,
        notional,
        margin,
        leverage,
        openedAt: Date.now(),
        closedAt: null,
        closeReason: null,
        tp1Filled: false,
        tp2Filled: false,
        tp3Filled: false,
        tp4Filled: useFiveR ? false : undefined,
        tp5Filled: useFiveR ? false : undefined,
        realizedPnl: 0,
        fees: 0,
        funding: 0,
        binanceRealizedPnl: 0,
        commissionOtherAsset: 0,
        initialRisk: riskDistance * qty,
        // Predeclare deterministic client ids before any protective POST. If a
        // response is lost, emergency finalization can still cancel every
        // possibly-accepted order by id.
        orders: {
          entry: `${prefix}E`,
          sl: `${prefix}S0`,
          tp1: q1 > 0 ? `${prefix}1` : undefined,
          tp2: q2 > 0 ? `${prefix}2` : undefined,
          tp3: q3 > 0 ? `${prefix}3` : undefined,
          tp4: q4 > 0 ? `${prefix}4` : undefined,
          tp5: q5 > 0 ? `${prefix}5` : undefined,
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
        // binance.ts adds `positionSide` itself in hedge mode (the position
        // side of the trade being closed) and `reduceOnly` in one-way mode.
        await api.protectiveStop(symbol, closeSide(trade.side), trade.slInitial, qty, `${prefix}S0`);
        trade.orders.sl = `${prefix}S0`;
        saveTrade(trade);
        if (invalidatedAtFill) {
          await this.closeByMarket(trade, 'KILL');
          return;
        }
        const quantities = [q1, q2, q3, q4, q5];
        const prices = [trade.tp1, trade.tp2, trade.tp3, trade.tp4, trade.tp5];
        for (let level = 1; level <= tpCount; level++) {
          const targetQty = quantities[level - 1];
          if (targetQty <= 0) continue;
          const key = `tp${level}` as 'tp1' | 'tp2' | 'tp3' | 'tp4' | 'tp5';
          const cid = `${prefix}${level}`;
          await api.takeProfitMarket(symbol, closeSide(trade.side), Number(prices[level - 1]), targetQty, { clientAlgoId: cid });
          trade.orders[key] = cid;
          saveTrade(trade);
        }
      } catch (err: any) {
        this.log('error', `Protective ladder failed (${err?.message}) — emergency flatten requested`);
        emit('error', { message: `${symbol}: protective ladder failed — emergency close requested` });
        const closed = await this.closeByMarket(trade, 'KILL');
        this.ladderFailures += 1;
        if (!closed) {
          this.log('error', `${symbol}: CRITICAL — entry remains OPEN after emergency close failure; reconcile will keep trying to arm protection`);
          emit('error', { message: `${symbol}: CRITICAL open position needs attention — emergency close was not confirmed` });
          this.disarm(`${symbol}: emergency close after a failed protective ladder was not confirmed`);
        } else if (this.ladderFailures >= MAX_LADDER_FAILURES) {
          this.disarm(`${this.ladderFailures} entries in a row could not be protected (last: ${err?.message || err})`);
        }
        return;
      }
      this.ladderFailures = 0;

      this.log(
        'info',
        `${trade.mode.toUpperCase()} ${trade.side} ${fmtQty(qty)} ${symbol} @ ${trade.entryPrice} | SL ${trade.slInitial} | ${useFiveR ? `TP 1R–5R ${trade.tp1}/${trade.tp2}/${trade.tp3}/${trade.tp4}/${trade.tp5}` : `legacy TP ${trade.tp1}/${trade.tp2}/${trade.tp3}`}`,
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
   * when nothing is available yet (the caller then keeps the signal price as a
   * reference and the fill ledger corrects the PnL later).
   *
   * Fallbacks, in order: the order itself (its avgPrice) and then the position's
   * entry price — the symbol was proven flat right before our entry, so the
   * only position on it is this one.
   */
  private async entryFillPrice(symbol: string, entryCid: string, ackAvg: number): Promise<number> {
    if (Number.isFinite(ackAvg) && ackAvg > 0) return ackAvg;
    try {
      const o = await api.queryOrder(symbol, entryCid);
      const avg = Number(o?.avgPrice);
      if (Number.isFinite(avg) && avg > 0) return avg;
    } catch { /* fall through to the position snapshot */ }
    try {
      const rows = await api.positionRisk(symbol);
      const own = rows.find((r) => r.symbol === symbol && Math.abs(r.positionAmt) > 0);
      if (own && Number.isFinite(own.entryPrice) && own.entryPrice > 0) return own.entryPrice;
    } catch (e: any) {
      this.log('error', `${symbol}: entry fill lookup failed: ${e?.message} — using signal price`);
    }
    return 0;
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

  fillTP(t: Trade, n: 1 | 2 | 3 | 4 | 5, price: number, binance?: { rp?: number; commission?: number; commissionAsset?: string }): void {
    if (t.status !== 'OPEN' || n > tpCountOf(t)) return;
    // The same fill can arrive through ORDER_TRADE_UPDATE, ALGO_UPDATE and the
    // REST reconcile — each leg is processed exactly once.
    if (tpFilledOf(t, n)) return;
    const q = tpQtyOf(t, n);
    if (q <= 0) return;

    if (binance) this.applyBinanceNumbers(t, binance.rp, binance.commission, binance.commissionAsset);
    (t as any)[`tp${n}Filled`] = true;

    const finalLevel = tpCountOf(t);
    if (n === 1) {
      if (t.slStage < 1) {
        t.slStage = 1;
        t.slCurrent = t.entryPrice;
      }
      this.log('info', `${t.symbol}: TP1 hit @ ${price} — closed ${fmtQty(q)}, SL → breakeven (${t.entryPrice})`);
      emit('log', { level: 'win', msg: `${t.symbol} TP1 ✅ closed ~20% @ ${price} — SL moved to breakeven` });
    } else if (n < finalLevel) {
      const lockAt = tpPriceOf(t, n - 1);
      if (t.slStage < n) {
        t.slStage = n;
        t.slCurrent = lockAt;
      }
      this.log('info', `${t.symbol}: TP${n} hit @ ${price} — closed ${fmtQty(q)}, SL → ${n - 1}R (${lockAt})`);
      emit('log', { level: 'win', msg: `${t.symbol} TP${n} ✅ closed ~20% @ ${price} — SL moved to ${n - 1}R` });
    } else {
      this.log('info', `${t.symbol}: TP${n} hit @ ${price} — final remainder closed (${fmtQty(q)})`);
      emit('log', { level: 'win', msg: `${t.symbol} TP${n} 🎯 full position closed @ ${price}` });
    }
    saveTrade(t);
    emit('trade', { event: 'fill', level: n, price, trade: t });

    if (n === finalLevel) {
      const unaccountedQty = remainingQtyOf(t);
      if (unaccountedQty <= Math.max(1e-10, t.qty * 1e-8)) {
        void this.finalize(t, isFiveRTrade(t) ? 'TP5' : 'TP3', price);
      } else {
        // A final-leg event can arrive before earlier TP events over WS/REST.
        // That final order is only its planned tranche, not permission to drop
        // the journal while earlier slices (and the actual position) remain.
        this.log('error', `${t.symbol}: TP${n} filled before earlier scale-outs were confirmed; ${fmtQty(unaccountedQty)} remains protected while reconciling`);
        void this.reconcile();
      }
    } else {
      void this.moveSL(t);
      // ALGO_UPDATE carries no commission / PnL — read them from the ledger.
      this.scheduleLedger(t);
    }
  }

  fillSL(t: Trade, stopPrice: number, marketPrice: number, binance?: { rp?: number; commission?: number; commissionAsset?: string }): void {
    if (t.status !== 'OPEN') return;
    const d = dir(t.side);
    const remaining = remainingQtyOf(t);
    if (remaining <= 0) {
      void this.finalize(t, isFiveRTrade(t) ? 'TP5' : 'TP3', stopPrice);
      return;
    }
    // A stop that gapped through fills at the market, never better than the
    // stop itself — the exchange decides the fill, we only mirror it.
    const market = Number.isFinite(marketPrice) && marketPrice > 0 ? marketPrice : stopPrice;
    const fill = d > 0 ? Math.min(stopPrice, market) : Math.max(stopPrice, market);
    if (binance) this.applyBinanceNumbers(t, binance.rp, binance.commission, binance.commissionAsset);
    const anyTP = Array.from({ length: tpCountOf(t) }, (_, i) => tpFilledOf(t, i + 1)).some(Boolean);
    const reason: Trade['closeReason'] = anyTP ? 'SL_PARTIAL' : 'SL';
    this.log('info', `${t.symbol}: SL hit @ ${fill} — remaining closed, PnL ${t.realizedPnl >= 0 ? '+' : ''}${t.realizedPnl.toFixed(2)} USDT`);
    emit('log', {
      level: anyTP ? 'info' : 'loss',
      msg: `${t.symbol} SL ${anyTP ? 'after one or more partial take-profits' : 'before any take-profit'} hit @ ${fill}, current realised PnL ${t.realizedPnl.toFixed(2)} USDT`,
    });
    void this.finalize(t, reason, fill);
  }

  /** Re-read Binance's fill ledger shortly after a fill (debounced per trade). */
  private scheduleLedger(t: Trade, delayMs = 2500): void {
    const pending = this.ledgerTimers.get(t.id);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.ledgerTimers.delete(t.id);
      void this.reconcileBinanceNumbers(t);
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.ledgerTimers.set(t.id, timer);
  }

  /**
   * Pull Binance's own fill ledger for this trade (fees + realised PnL,
   * idempotent — it overwrites the running totals with the exchange's figures).
   *
   * A stop-loss / take-profit is an algo order: when it fires Binance creates a
   * separate matching-engine order whose id is only reachable through the algo
   * order's `actualOrderId`, so those ids are collected alongside the orders
   * that carry our VX<tradeId> client id (entry / market close).
   */
  async reconcileBinanceNumbers(t: Trade): Promise<void> {
    try {
      const prefix = `VX${t.id}`;
      const orders = await api.allOrders(t.symbol, { startTime: t.openedAt - 60_000, limit: 200 });
      const mine = new Set<string>(
        orders.filter((o) => String(o.clientOrderId || '').startsWith(prefix)).map((o) => String(o.orderId)),
      );
      const algoIds = [t.orders.sl, ...Array.from({ length: tpCountOf(t) }, (_, i) => t.orders[`tp${i + 1}` as 'tp1' | 'tp2' | 'tp3' | 'tp4' | 'tp5'])];
      for (const cid of algoIds) {
        if (!cid) continue;
        try {
          const algo = await api.queryAlgoOrder(cid);
          const actual = String(algo?.actualOrderId ?? '');
          if (/^\d+$/.test(actual) && Number(actual) > 0) mine.add(actual);
        } catch { /* never placed, or already purged by Binance — nothing to add */ }
      }
      if (!mine.size) return;
      const fills = await api.userTrades(t.symbol, { startTime: t.openedAt - 60_000, limit: 500 });
      let rp = 0, fees = 0, other = 0;
      for (const f of fills) {
        if (!mine.has(String(f.orderId))) continue;
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
    if (this.closing.has(t.id)) {
      this.log('info', `${t.symbol}: a close is already in flight — second request ignored`);
      return false;
    }
    // While the close is in flight the recovery loop must not re-arm legs.
    this.closing.add(t.id);
    try {
      return await this.closeByMarketLocked(t, reason);
    } finally {
      this.closing.delete(t.id);
    }
  }

  private async closeByMarketLocked(t: Trade, reason: 'REVERSE' | 'KILL'): Promise<boolean> {
    const remaining = remainingQtyOf(t);
    const price = priceOf(t.symbol) || t.entryPrice;
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
    this.unsureStrikes.delete(t.id);
    t.closedAt = Date.now();
    t.closeReason = reason;
    t.result = null;
    await this.reconcileBinanceNumbers(t);
    if (reason !== 'EXTERNAL' && t.realizedPnl !== 0) t.result = t.realizedPnl > 0 ? 'WIN' : 'LOSS';
    else if (reason === 'SL_PARTIAL' || reason === 'TP3' || reason === 'TP5') t.result = 'WIN';
    else if (reason === 'SL') t.result = 'LOSS';
    await this.refreshFunding(t);
    saveTrade(t);
    await this.cancelLadder(t);
    emit('trade', { event: 'closed', trade: t, price });
    emit('log', {
      level: t.result === 'WIN' ? 'win' : t.result === 'LOSS' ? 'loss' : 'info',
      msg: `${t.symbol} trade closed (${reason}) — PnL ${t.realizedPnl >= 0 ? '+' : ''}${t.realizedPnl.toFixed(2)} USDT · fees ${t.fees.toFixed(3)} · funding ${t.funding.toFixed(3)}${t.result ? ` [${t.result}]` : ''}`,
    });
    // The exchange may book the last fill a moment after the event — look once more.
    this.scheduleLedger(t, 5000);
  }

  /**
   * Cancel what is left of OUR ladder (take-profits, and the stop if the
   * position was flattened some other way). Only client ids tagged with this
   * trade's VX<tradeId> prefix are ever touched. Individual cancel errors are
   * expected (a leg that already fired is no longer cancellable); the sweep
   * afterwards asks Binance what is genuinely still resting and retries once.
   */
  private async cancelLadder(t: Trade): Promise<void> {
    for (const key of ['sl', 'tp1', 'tp2', 'tp3', 'tp4', 'tp5'] as const) {
      const cid = t.orders[key];
      if (!cid) continue;
      try {
        await api.cancelAlgoOrder(t.symbol, cid);
      } catch { /* verified by the sweep below */ }
    }
    const prefix = `VX${t.id}`;
    try {
      const left = (await api.openAlgoOrders(t.symbol))
        .map((o) => String(o.clientAlgoId || ''))
        .filter((cid) => cid.startsWith(prefix));
      for (const cid of left) {
        try {
          await api.cancelAlgoOrder(t.symbol, cid);
        } catch (e: any) {
          this.log('error', `${t.symbol}: could not cancel leftover conditional order ${cid}: ${e?.message}`);
          emit('error', { message: `${t.symbol}: conditional order ${cid} may still be resting on Binance — cancel it manually` });
        }
      }
    } catch (e: any) {
      this.log('error', `${t.symbol}: could not verify that the ladder was cancelled: ${e?.message}`);
    }
  }

  /** Remove conditional orders of ours that no live trade owns (stale legs of an earlier trade). */
  private async sweepOrphanLegs(symbol: string): Promise<void> {
    const live = openTrades().filter((x) => x.symbol === symbol).map((x) => `VX${x.id}`);
    for (const o of await api.openAlgoOrders(symbol)) {
      const cid = String(o.clientAlgoId || '');
      if (!cid.startsWith('VX') || live.some((prefix) => cid.startsWith(prefix))) continue;
      this.log('error', `${symbol}: removing stale conditional order ${cid} left by an earlier trade`);
      await api.cancelAlgoOrder(symbol, cid);
    }
  }

  private async moveSL(t: Trade): Promise<void> {
    if (t.status !== 'OPEN') return;
    if (this.slBusy.has(t.id)) {
      this.slMoveRequested.add(t.id);
      return;
    }
    this.slBusy.add(t.id);
    try {
      const info = await api.exchangeInfo(t.symbol);
      do {
        this.slMoveRequested.delete(t.id);
        if (t.status !== 'OPEN') return;
        const stage = t.slStage;
        const newStop = roundToTick(t.slCurrent, info.tickSize);
        t.slCurrent = newStop;
        const oldCid = t.orders.sl;
        if (oldCid) {
          try {
            await api.cancelAlgoOrder(t.symbol, oldCid);
          } catch (e: any) {
            // The cleanup sweep in cancelLadder() removes a stop that survived.
            this.log('error', `${t.symbol}: SL cancel failed: ${e?.message} — continuing, will verify position`);
          }
        }
        const newCid = `VX${t.id}S${stage}`;
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
          this.log('info', `${t.symbol}: SL moved to ${newStop} (stage ${stage})`);
        } catch (e: any) {
          this.log('error', `${t.symbol}: SL replacement failed: ${e?.message} — FLATTENING for safety`);
          emit('error', { message: `${t.symbol}: SL replacement failed — closing bot position for safety` });
          await this.closeByMarket(t, 'KILL');
          return;
        }
        // A TP fill may have advanced the requested stop while the cancel/POST
        // was awaiting the exchange. Never leave the older (looser) stop as the
        // final resting protection after a faster follow-on fill.
        if (t.status === 'OPEN' && (t.slStage !== stage || roundToTick(t.slCurrent, info.tickSize) !== newStop)) {
          this.slMoveRequested.add(t.id);
        }
      } while (t.status === 'OPEN' && this.slMoveRequested.has(t.id));
    } finally {
      this.slBusy.delete(t.id);
      this.slMoveRequested.delete(t.id);
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
    } else {
      const level = Array.from({ length: tpCountOf(t) }, (_, i) => i + 1)
        .find((n) => t.orders[`tp${n}` as 'tp1' | 'tp2' | 'tp3' | 'tp4' | 'tp5'] === cid);
      if (level && !tpFilledOf(t, level)) {
        this.fillTP(t, level as 1 | 2 | 3 | 4 | 5, price || tpPriceOf(t, level), binance);
      } else if (cid === t.orders.entry) {
        const avg = Number(ev.ap) || 0;
        if (avg > 0 && Math.abs(avg - t.entryPrice) / t.entryPrice > 0.001) {
          this.log('info', `${t.symbol}: entry fill confirmed @ ${avg}`);
        }
      }
    }
  }

  /**
   * ALGO_UPDATE from the user data stream — the Algo Service's report on one
   * of OUR conditional legs, routed by clientAlgoId (`caid`).
   *
   * Only a FINISHED order that really executed (`aq` > 0) moves the ladder.
   * A leg that fired but executed nothing, or that expired / was rejected, is
   * handed to the REST reconcile, which asks Binance instead of trusting one
   * frame. Our own cancellations (moving the stop, closing the trade) are
   * ignored on purpose.
   */
  onAlgoUpdate(ev: any): void {
    const o = ev?.o ?? ev;
    const caid = String(o?.caid || '');
    if (!caid.startsWith('VX')) return;
    const t = openTrades().find((x) => caid.startsWith(`VX${x.id}`)) || null;
    if (!t || t.symbol !== o.s) return;
    const status = String(o.X || '').toUpperCase();
    if (status === 'FINISHED') {
      const executed = Number(o.aq) || 0;
      if (executed <= 0) {
        this.log('error', `${t.symbol}: conditional order ${caid} fired but executed nothing (${o.rm || 'no reason given'}) — verifying with Binance`);
        void this.reconcileGuarded(t);
        return;
      }
      const price = Number(o.ap) || 0;
      if (caid.startsWith(`VX${t.id}S`)) this.fillSL(t, Number(o.tp) || t.slCurrent, price || t.slCurrent);
      else {
        const level = Array.from({ length: tpCountOf(t) }, (_, i) => i + 1)
          .find((n) => t.orders[`tp${n}` as 'tp1' | 'tp2' | 'tp3' | 'tp4' | 'tp5'] === caid);
        if (level) this.fillTP(t, level as 1 | 2 | 3 | 4 | 5, price || tpPriceOf(t, level));
      }
      return;
    }
    if (status === 'EXPIRED' || status === 'REJECTED') {
      this.log('error', `${t.symbol}: conditional order ${caid} ${status.toLowerCase()} (${o.rm || 'no reason given'}) — re-checking protection`);
      void this.reconcileGuarded(t);
    }
  }

  /**
   * Periodic safety net — ONLY for bot-owned orders.
   *  • asks Binance what became of every conditional leg (resting, fired, gone)
   *    and books fills the WebSocket missed
   *  • re-arms a leg that is verifiably gone
   * It never closes, reverses or adopts anything the bot did not open.
   */
  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const mode = getSettings().mode;
      for (const t of openTrades()) {
        // A trade opened in the other environment cannot be checked with this
        // environment's keys and endpoints — leave its journal untouched.
        if (t.mode !== mode) continue;
        await this.reconcileGuarded(t);
      }
    } finally {
      this.reconciling = false;
    }
  }

  /** One trade's recovery pass, skipped while its entry / close / another pass is in flight. */
  private async reconcileGuarded(t: Trade): Promise<void> {
    // Entry + initial ladder placement is transactional under the symbol
    // reservation, and a market close owns the trade until it settles.
    if (this.entering.has(t.symbol) || this.closing.has(t.id) || this.recovering.has(t.id)) return;
    this.recovering.add(t.id);
    try {
      await this.reconcileOne(t);
    } catch (e: any) {
      this.log('error', `${t.symbol}: reconcile error: ${e?.message}`);
    } finally {
      this.recovering.delete(t.id);
    }
  }

  private async reconcileOne(t: Trade): Promise<void> {
    if (t.status !== 'OPEN') return;
    const info = await api.exchangeInfo(t.symbol);

    // ---- 1. what became of each conditional leg? ---------------------------
    // The open list is the cheap path. A leg that is not on it is looked up by
    // its client id, so "not on the list" is never mistaken for "gone".
    const resting = new Set((await api.openAlgoOrders(t.symbol)).map((o) => String(o.clientAlgoId || '')));
    const tpKeys = Array.from({ length: tpCountOf(t) }, (_, i) => `tp${i + 1}` as 'tp1' | 'tp2' | 'tp3' | 'tp4' | 'tp5');
    const legs: { key: 'sl' | 'tp1' | 'tp2' | 'tp3' | 'tp4' | 'tp5'; skip: boolean }[] = [
      { key: 'sl', skip: false },
      ...tpKeys.map((key, i) => ({ key, skip: tpFilledOf(t, i + 1) || tpQtyOf(t, i + 1) <= 0 })),
    ];
    const state = new Map<string, AlgoLegState>();
    for (const leg of legs) {
      if (leg.skip) continue;
      const cid = t.orders[leg.key];
      const st: AlgoLegState = !cid
        ? { state: 'gone' }
        : resting.has(cid)
          ? { state: 'alive' }
          : await api.algoLegState(t.symbol, cid);
      state.set(leg.key, st);
      if (st.state !== 'filled') continue;
      if (t.status !== 'OPEN') return;
      if (leg.key === 'sl') {
        this.fillSL(t, t.slCurrent, st.avgPrice || t.slCurrent);
        this.scheduleLedger(t);
        return;
      }
      const level = Number(leg.key.slice(2));
      this.fillTP(t, level as 1 | 2 | 3 | 4 | 5, st.avgPrice || tpPriceOf(t, level));
      if (t.status !== 'OPEN') return;
    }
    if (t.status !== 'OPEN') return;

    // ---- 2. is there still a bot position? ---------------------------------
    const pos = await api.positionAmount(t.symbol, t.side);
    const directionalPos = pos * dir(t.side);
    if (Math.abs(pos) < info.stepSize / 2) {
      // Flat, yet a leg that fired could not be classified (Binance could not
      // say right now): wait a few passes rather than losing the close reason.
      if (this.holdForUnknownLeg(t, state)) return;
      const allTargetsFilled = Array.from({ length: tpCountOf(t) }, (_, i) => tpFilledOf(t, i + 1)).every(Boolean);
      if (allTargetsFilled) {
        void this.finalize(t, isFiveRTrade(t) ? 'TP5' : 'TP3', tpPriceOf(t, tpCountOf(t)));
        return;
      }
      this.log('info', `${t.symbol}: position flat (external fill detected) — closing bot trade record`);
      void this.finalize(t, 'EXTERNAL', priceOf(t.symbol) || t.entryPrice);
      return;
    }
    this.unsureStrikes.delete(t.id);
    if (directionalPos <= info.stepSize / 2) {
      this.log('error', `${t.symbol}: bot-side position is gone and an opposite external leg exists — dropping bot orders`);
      void this.finalize(t, 'EXTERNAL', priceOf(t.symbol) || t.entryPrice);
      return;
    }

    // ---- 3. re-arm what is verifiably gone ---------------------------------
    // Only an explicit "gone" re-arms; "unknown" (Binance could not answer) is
    // retried on the next pass, so a flaky reply can never double a leg.
    if (this.slBusy.has(t.id) || this.closing.has(t.id)) return;
    const protectedQty = floorToStep(Math.min(remainingQtyOf(t), directionalPos), info.stepSize);
    if (protectedQty <= 0) {
      void this.finalize(t, 'EXTERNAL', priceOf(t.symbol) || t.entryPrice);
      return;
    }

    // If the trade closed while a re-arm POST was in flight, take the new leg straight back off.
    const retire = async (cid: string): Promise<void> => {
      if (t.status !== 'OPEN') await api.cancelAlgoOrder(t.symbol, cid).catch(() => null);
    };

    if (state.get('sl')?.state === 'gone' && remainingQtyOf(t) > 0) {
      this.log('error', `${t.symbol}: SL order missing while position open — re-arming SL`);
      const cid = `VX${t.id}S${t.slStage}R${Date.now().toString(36).slice(-4)}`;
      try {
        await api.protectiveStop(t.symbol, closeSide(t.side), roundToTick(t.slCurrent, info.tickSize), protectedQty, cid);
      } catch (e: any) {
        if (/-2021|immediately trigger/i.test(String(e?.message))) {
          // The market is already beyond the stop price: a stop can no longer
          // protect this position, and retrying would only fail again every
          // pass. Get out now rather than hold it naked.
          this.log('error', `${t.symbol}: stop ${t.slCurrent} is already breached while the position is open — closing at market`);
          emit('error', { message: `${t.symbol}: stop-loss level already breached and no stop is resting — closing the bot position at market` });
          await this.closeByMarket(t, 'KILL');
          return;
        }
        throw e;
      }
      t.orders.sl = cid;
      saveTrade(t);
      emit('trade', { event: 'sl-rearmed', trade: t });
      await retire(cid);
    }

    // A crash can happen after the entry journal is written but before all
    // TP legs are acknowledged. Rebuild only missing, unfilled bot legs and
    // route future fills through their newly persisted client ids.
    let capacity = protectedQty;
    const ensureTp = async (
      key: 'tp1' | 'tp2' | 'tp3' | 'tp4' | 'tp5',
      level: 1 | 2 | 3 | 4 | 5,
      filled: boolean,
      target: number,
      plannedQty: number,
    ): Promise<void> => {
      if (filled || plannedQty <= 0 || capacity < info.stepSize / 2) return;
      const qty = floorToStep(Math.min(plannedQty, capacity), info.stepSize);
      capacity = Math.max(0, capacity - qty);
      if (qty <= 0 || state.get(key)?.state !== 'gone') return;
      const cid = `VX${t.id}${level}R${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;
      this.log('error', `${t.symbol}: TP${level} order missing — re-arming ${fmtQty(qty)}`);
      await api.takeProfitMarket(t.symbol, closeSide(t.side), target, qty, { clientAlgoId: cid });
      t.orders[key] = cid;
      saveTrade(t);
      emit('trade', { event: 'tp-rearmed', level, trade: t });
      await retire(cid);
    };
    // Each leg is independent: one that cannot be re-armed (e.g. its price was
    // already crossed, -2021) must not starve the others on every pass.
    const ladder = Array.from({ length: tpCountOf(t) }, (_, i) => {
      const level = i + 1;
      return [
        `tp${level}` as 'tp1' | 'tp2' | 'tp3' | 'tp4' | 'tp5',
        level as 1 | 2 | 3 | 4 | 5,
        tpFilledOf(t, level),
        tpPriceOf(t, level),
        tpQtyOf(t, level),
      ] as const;
    });
    for (const [key, level, filled, target, planned] of ladder) {
      try {
        await ensureTp(key, level, filled, target, planned);
      } catch (e: any) {
        this.log('error', `${t.symbol}: could not re-arm TP${level}: ${e?.message}`);
      }
    }
  }

  /** True while a flat position should wait for a fired-but-unclassified leg to resolve (max 3 passes). */
  private holdForUnknownLeg(t: Trade, state: Map<string, AlgoLegState>): boolean {
    if (![...state.values()].some((x) => x.state === 'unknown')) return false;
    const strikes = (this.unsureStrikes.get(t.id) ?? 0) + 1;
    if (strikes > 3) {
      this.unsureStrikes.delete(t.id);
      return false;
    }
    this.unsureStrikes.set(t.id, strikes);
    return true;
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

  /** Switch auto-trade off from inside the executor and tell the operator why. */
  private disarm(reason: string): void {
    if (!getSettings().autoTrade) return;
    updateSettings({ autoTrade: false });
    this.log('error', `AUTO-TRADE DISARMED — ${reason}`);
    emit('error', { message: `Auto-trade disarmed: ${reason}` });
    emit('status', { autoTrade: false });
  }

  private log(level: 'info' | 'error' | 'win' | 'loss', msg: string): void {
    console.log(`[${level}] ${msg}`);
    emit('log', { level, msg, t: Date.now() });
  }
}

export const trader = new Trader();

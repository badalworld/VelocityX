/**
 * HTTP API for the dashboard UI.
 *
 * Every market/account number returned here comes from Binance (REST + WS);
 * the offline demo feed is clearly flagged as `feed: 'offline-demo'` and is
 * only ever used when the exchange is unreachable from the host.
 */
import express from 'express';
import { api } from './binance';
import { engine, mtfDashboard } from './engine';
import { computeStats } from './stats';
import { getSettings, publicSettings, updateSettings } from './settings';
import { allSignals, allTrades, openTrades, remainingQtyOf } from './store';
import { trader } from './trader';
import { scanner } from './scanner';
import { accountService } from './account';
import { candleStore } from './candles';
import { emit, getLogs } from './broadcast';
import { marketStream, userStream } from './streams';
import { limiter } from './ratelimit';

export function apiRouter(): express.Router {
  const r = express.Router();

  const feedInfo = () => {
    const offline = api.isOffline();
    const unreachable = !offline && api.reachable === false;
    return {
      feed: offline ? 'offline-demo' : unreachable ? 'binance-unreachable' : 'binance',
      source: offline ? 'offline-demo' : 'binance-usdm',
      reachable: api.reachable,
      demoFeedAllowed: api.demoAllowed(),
      lastRestOkAt: api.telemetry.lastRestOkAt,
      lastRestError: api.telemetry.lastRestError || null,
      latencyMs: api.telemetry.lastLatencyMs,
      avgLatencyMs: api.telemetry.avgLatencyMs,
      serverTimeOffsetMs: api.telemetry.serverTimeOffsetMs,
      wsLastMessageAt: api.telemetry.wsLastMessageAt,
      candles: candleStore.stats(),
    };
  };

  r.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime(), feed: api.isOffline() ? 'offline-demo' : 'binance' });
  });

  r.get('/status', async (_req, res) => {
    const s = getSettings();
    const st = engine.state();
    const price = st?.lastPrice || 0;
    const view = accountService.get();
    const scan = scanner.result();

    res.json({
      mode: s.mode,
      autoTrade: s.autoTrade,
      symbol: s.symbol,
      interval: s.interval,
      leverage: s.leverage,
      tradeSizePercent: s.tradeSizePercent,
      maxPositions: s.maxPositions,
      autoScan: s.autoScan,
      price,
      // Binance account view (equity / PNL / ROI / fees / funding) + bot attribution
      account: view
        ? {
            source: view.source,
            equity: view.equity,
            walletBalance: view.walletBalance,
            unrealizedPnl: view.unrealizedPnl,
            availableBalance: view.availableBalance,
            initialMargin: view.initialMargin,
            roiPct: view.roiPct,
            roiOnWalletPct: view.roiOnWalletPct,
            canTrade: view.canTrade,
            bot: view.bot,
            income: view.income,
            external: view.external,
            at: view.at,
            errors: view.errors,
          }
        : null,
      // Managed (bot-owned) positions — never external ones
      openTrades: openTrades().map((t) => {
        const mark = marketStream.price(t.symbol) || t.entryPrice;
        const remaining = remainingQtyOf(t);
        return {
          ...t,
          markPrice: mark,
          remainingQty: remaining,
          unrealized: view?.positions.managed.find((m) => m.trade.id === t.id)?.unrealized ?? (mark - t.entryPrice) * (t.side === 'LONG' ? 1 : -1) * remaining,
        };
      }),
      openTrade: openTrades().length === 1 ? openTrades()[0] : null,
      slots: { used: openTrades().length, max: s.maxPositions },
      scanner: scan
        ? { at: scan.at, universe: scan.universe, analysed: scan.analysed, selected: scan.selected, top: scan.rows.slice(0, 12) }
        : null,
      engine: st
        ? {
            atr: st.atr,
            ribbonBull: st.ribbonBull,
            lastSignal: st.lastSignal,
            emas: st.emas,
            emaExtra: st.emaExtra,
            lastClosedCandleTime: st.lastClosedCandleTime,
            startedAt: st.engineStartedAt,
          }
        : null,
      feed: feedInfo().feed,
      feedInfo: feedInfo(),
      limits: limiter.status(),
      streams: { market: marketStream.isConnected, user: userStream.isConnected, userLastMessageAt: userStream.lastMessage() },
      keysConfigured: {
        testnet: !!(s.keys.testnet.key && s.keys.testnet.secret),
        live: !!(s.keys.live.key && s.keys.live.secret),
      },
      logs: getLogs(60),
      now: Date.now(),
    });
  });

  r.get('/account', async (req, res) => {
    const days = req.query.days ? Number(req.query.days) : undefined;
    let view = accountService.get();
    if (!view || Date.now() - view.at > 5000) {
      try {
        view = await accountService.refresh();
      } catch (e: any) {
        return res.status(502).json({ error: e?.message || 'account refresh failed' });
      }
    }
    if (days && view) {
      try {
        view = { ...view, income: await accountService.incomeSummary(days) };
      } catch { /* keep the cached income summary */ }
    }
    res.json({ ...view, feed: feedInfo() });
  });

  r.get('/positions', async (_req, res) => {
    const view = accountService.get() ?? (await accountService.refresh());
    res.json({
      managed: accountService.managedNow(),
      external: view?.positions.external ?? [],
      slots: { used: openTrades().length, max: getSettings().maxPositions },
      note: 'external positions are never adopted, managed, closed or counted in bot PnL',
      at: view?.at ?? Date.now(),
    });
  });

  r.get('/income', async (req, res) => {
    const days = req.query.days ? Number(req.query.days) : getSettings().historyDays;
    try {
      res.json(await accountService.incomeSummary(days));
    } catch (e: any) {
      res.status(502).json({ error: e?.message });
    }
  });

  r.get('/chart', (req, res) => {
    const limit = Math.min(1500, Math.max(50, Number(req.query.limit) || 300));
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
    res.json(engine.chart(limit, symbol));
  });

  // ---------------- market scanner ----------------

  r.get('/scanner', (req, res) => {
    const result = scanner.result();
    if (!result) return res.json({ at: 0, universe: 0, analysed: 0, rows: [], selected: [], gate: null, warming: true });
    const limit = Math.min(80, Number(req.query.limit) || 40);
    res.json({ ...result, rows: result.rows.slice(0, limit), warming: false });
  });

  r.post('/scanner/scan', async (_req, res) => {
    const result = await scanner.scan();
    res.json(result ?? { error: 'scan failed — check the activity log' });
  });

  // ---------------- settings / control ----------------

  r.get('/settings', (_req, res) => res.json(publicSettings()));

  r.post('/settings', (req, res) => {
    const before = getSettings();
    const patch = req.body || {};
    const s = updateSettings(patch);
    if (patch.symbol && patch.symbol !== before.symbol) {
      emit('log', { level: 'info', msg: `Primary symbol changed to ${s.symbol}` });
    }
    if (patch.mode && patch.mode !== before.mode) {
      if (s.mode === 'paper' || s.keys[s.mode]?.key) {
        userStream.start();
        void accountService.refresh();
        emit('log', { level: 'info', msg: `Mode switched to ${s.mode.toUpperCase()}` });
      } else {
        emit('error', { message: `No API keys configured for ${s.mode} mode` });
        updateSettings({ mode: before.mode });
      }
    }
    if (patch.scanner && JSON.stringify(patch.scanner) !== JSON.stringify(before.scanner)) {
      scanner.restart();
      emit('log', { level: 'info', msg: 'Scanner settings applied — rescanning the market' });
      void scanner.scan();
    }
    if (patch.autoTrade !== undefined && patch.autoTrade !== before.autoTrade) {
      emit('log', { level: patch.autoTrade ? 'win' : 'error', msg: `Auto-trade ${patch.autoTrade ? 'ENABLED' : 'DISABLED'}` });
    }
    res.json(publicSettings());
  });

  r.post('/autotrade', (req, res) => {
    const enabled = !!req.body?.enabled;
    updateSettings({ autoTrade: enabled });
    emit('log', { level: enabled ? 'win' : 'error', msg: `Auto-trade ${enabled ? 'ENABLED' : 'DISABLED'}` });
    emit('status', { autoTrade: enabled });
    res.json({ autoTrade: enabled });
  });

  /** Close ONE bot-owned position at market (external positions are never touched). */
  r.post('/positions/close', async (req, res) => {
    const id = String(req.body?.id || '');
    const trade = openTrades().find((t) => t.id === id);
    if (!trade) return res.status(404).json({ error: 'No open bot position with that id' });
    await trader.closeByMarket(trade, 'KILL');
    void accountService.refresh();
    // hand the finalized record back so the UI/smoke tests can verify the booked PnL
    res.json({ ok: true, id, closed: allTrades().find((t) => t.id === id) || null, openTrades: openTrades() });
  });

  r.post('/kill', async (_req, res) => {
    const closed = await trader.kill();
    void accountService.refresh();
    res.json({ ok: true, closed, openTrades: openTrades() });
  });

  // ---------------- history / stats ----------------

  r.get('/trades', (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    res.json(allTrades().slice(0, limit));
  });

  r.get('/signals', (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const sym = String(req.query.symbol || '').toUpperCase();
    const rows = allSignals();
    res.json((sym ? rows.filter((x) => x.symbol === sym) : rows).slice(0, limit));
  });

  r.get('/stats', (_req, res) => {
    const stats = computeStats();
    const view = accountService.get();
    res.json({
      ...stats,
      // Binance-verified account figures (fees / funding / realised PnL)
      binance: view
        ? {
            source: view.source,
            equity: view.equity,
            walletBalance: view.walletBalance,
            unrealizedPnl: view.unrealizedPnl,
            roiPct: view.roiPct,
            fees: view.bot.fees,
            funding: view.bot.funding,
            realizedPnlBot: view.bot.realizedPnl,
            income: view.income,
          }
        : null,
    });
  });

  r.get('/mtf', async (req, res) => {
    try {
      const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
      res.json(await mtfDashboard(symbol));
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  /** Back-compat: the old screener is now the live volatility scanner. */
  r.get('/screener', (_req, res) => {
    const result = scanner.result();
    if (!result) return res.json({ rows: [] });
    res.json({
      rows: result.rows.slice(0, 12).map((row) => ({
        symbol: row.symbol.replace(/USDT$/, ''),
        full: row.symbol,
        state: row.marketType === 'TRENDING' ? `${row.trend === 'UP' ? 'Bullish' : 'Bearish'} · ADX ${row.adx.toFixed(0)}` : row.marketType,
        volatility: row.volatility,
        trend: row.trend,
        tradable: row.tradable,
      })),
    });
  });

  // ---------------- diagnostics & limits ----------------

  r.get('/limits', (_req, res) => {
    res.json({
      limiter: limiter.status(),
      telemetry: api.telemetry,
      candles: candleStore.stats(),
      note: 'Binance USD-M weight limit 2400/min — VelocityX plans at 95% and distributes it across work areas',
    });
  });

  r.get('/diagnostics', async (_req, res) => {
    const ping = await api.ping();
    const s = getSettings();
    const st = engine.state();
    res.json({
      feed: feedInfo(),
      ping,
      ws: {
        market: { connected: marketStream.isConnected, lastMessageAt: marketStream.lastMessage() },
        user: { connected: userStream.isConnected, lastMessageAt: userStream.lastMessage(), mode: s.mode },
      },
      engine: {
        activeSymbols: engine.activeSymbols(),
        lastTickAt: engine.lastTick(),
        lastClosedCandleTime: st?.lastClosedCandleTime ?? 0,
      },
      scanner: {
        at: scanner.result()?.at ?? 0,
        universe: scanner.result()?.universe ?? 0,
        analysed: scanner.result()?.analysed ?? 0,
        selected: scanner.result()?.selected ?? [],
      },
      limiter: limiter.status(),
      account: { source: accountService.get()?.source ?? null, at: accountService.get()?.at ?? 0, errors: accountService.get()?.errors ?? [] },
      now: Date.now(),
    });
  });

  return r;
}

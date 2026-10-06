/**
 * HTTP API for the strategy-free VelocityX baseline.
 *
 * Exposes exchange/account telemetry and strategy-neutral trade history.
 * There are deliberately no scanner, signal, strategy, order, position-control,
 * auto-trade, entry or backtest endpoints.
 */
import express from 'express';
import { api } from './binance';
import { authRequired, rateLimit, requireToken } from './auth';
import { engine } from './engine';
import { getSettings, publicSettings, updateSettings } from './settings';
import { allTrades, openTrades } from './store';
import { accountService } from './account';
import { candleStore } from './candles';
import { emit, getLogs } from './broadcast';
import { marketStream, userStream } from './streams';
import { limiter } from './ratelimit';
import { backtest, DEFAULT_STRATEGY } from './strategy';

export function apiRouter(): express.Router {
  const r = express.Router();
  const mutate = rateLimit({ perMinute: 60, burst: 20 });

  r.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  r.get('/health', (_req, res) => {
    res.json({
      ok: true,
      uptime: process.uptime(),
      feed: api.reachable === false ? 'binance-unreachable' : 'binance',
      authRequired: authRequired(),
      mode: getSettings().mode,
      entriesEnabled: false,
    });
  });
  r.use(requireToken);

  const feedInfo = () => ({
    feed: api.reachable === false ? 'binance-unreachable' : 'binance',
    source: 'binance-usdm',
    reachable: api.reachable,
    lastRestOkAt: api.telemetry.lastRestOkAt,
    lastRestError: api.telemetry.lastRestError || null,
    latencyMs: api.telemetry.lastLatencyMs,
    avgLatencyMs: api.telemetry.avgLatencyMs,
    serverTimeOffsetMs: api.telemetry.serverTimeOffsetMs,
    wsLastMessageAt: api.telemetry.wsLastMessageAt,
    candles: candleStore.stats(),
  });

  r.get('/status', (_req, res) => {
    const s = getSettings();
    const market = engine.state();
    const view = accountService.get();
    res.json({
      mode: s.mode,
      symbol: s.symbol,
      interval: s.interval,
      entriesEnabled: false,
      entriesDisabledReason: 'No trading strategy is installed.',
      market,
      feed: feedInfo(),
      streams: {
        market: marketStream.isConnected,
        marketLastMessageAt: marketStream.lastMessage(),
        user: userStream.isConnected,
        userLastMessageAt: userStream.lastMessage(),
      },
      engine: {
        activeSymbols: engine.activeSymbols(),
        lastTickAt: engine.lastTick(),
        lastClosedCandleTime: market?.lastClosedCandleTime ?? 0,
        startedAt: market?.engineStartedAt ?? 0,
      },
      strategy: { name: 'CryptoVN WaveTrend reversal', execution: 'paper-signal-only', ...engine.strategy() },
      account: view,
      openTrades: openTrades(),
      tradeCount: allTrades().length,
      keysConfigured: {
        testnet: !!(s.keys.testnet.key && s.keys.testnet.secret),
        live: !!(s.keys.live.key && s.keys.live.secret),
      },
      apiTokenRequired: authRequired(),
      logs: getLogs(60),
      now: Date.now(),
    });
  });

  r.get('/account', async (req, res) => {
    const days = Number(req.query.days);
    let view = accountService.get();
    if (!view || Date.now() - view.at > 5_000) {
      try {
        view = await accountService.refresh();
      } catch (e: any) {
        return res.status(502).json({ error: e?.message || 'Account refresh failed' });
      }
    }
    if (Number.isFinite(days) && days > 0 && view) {
      try { view = { ...view, income: await accountService.incomeSummary(days) }; }
      catch { /* retain last-known account data */ }
    }
    res.json({ ...view, feed: feedInfo() });
  });

  r.get('/positions', async (_req, res) => {
    try {
      const view = accountService.get() ?? await accountService.refresh();
      res.json({
        positions: view?.positions ?? [],
        openJournalEntries: openTrades(),
        at: view?.at ?? Date.now(),
        note: 'Read-only exchange positions. Legacy journal entries are archival; no positions or orders are managed by this build.'
      });
    } catch (e: any) {
      res.status(502).json({ error: e?.message || 'Position refresh failed' });
    }
  });

  r.get('/income', async (req, res) => {
    const days = Number(req.query.days) || getSettings().historyDays;
    try { res.json(await accountService.incomeSummary(days)); }
    catch (e: any) { res.status(502).json({ error: e?.message || 'Income history unavailable' }); }
  });

  r.get('/trades', (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    res.json(allTrades().slice(0, limit));
  });

  // Strategy analytics are intentionally read-only. This endpoint never
  // creates, modifies, or closes a Binance position.
  r.get('/strategy', (_req, res) => {
    const s = getSettings();
    const candles = candleStore.closed(s.symbol, s.interval);
    const result = backtest(candles, DEFAULT_STRATEGY);
    res.json({ name: 'CryptoVN WaveTrend reversal', execution: 'paper-signal-only', symbol: s.symbol, interval: s.interval, ...result });
  });

  r.get('/logs', (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    res.json(getLogs(limit));
  });

  r.get('/settings', (_req, res) => res.json(publicSettings()));
  r.post('/settings', mutate, (req, res) => {
    const before = getSettings();
    const input = req.body && typeof req.body === 'object' ? req.body : {};
    const patch: any = {};

    if (input.mode !== undefined) {
      if (!['testnet', 'live'].includes(input.mode)) {
        return res.status(400).json({ error: 'mode must be testnet or live' });
      }
      if (input.mode === 'live' && before.mode !== 'live') {
        if (input.confirmLive !== true) {
          return res.status(400).json({ error: 'Switching to the LIVE account requires confirmLive: true.' });
        }
      }
      patch.mode = input.mode;
    }

    if (input.symbol !== undefined) {
      if (!/^[A-Z0-9]{4,24}$/.test(String(input.symbol).toUpperCase())) {
        return res.status(400).json({ error: 'symbol must be a valid USD-M symbol, for example BTCUSDT' });
      }
      patch.symbol = String(input.symbol).toUpperCase();
    }
    if (input.historyDays !== undefined) patch.historyDays = input.historyDays;
    if (input.keys !== undefined) patch.keys = input.keys;

    const updated = updateSettings(patch);
    const modeChanged = updated.mode !== before.mode;
    const keysChanged = JSON.stringify(updated.keys[updated.mode]) !== JSON.stringify(before.keys[before.mode]);
    if (modeChanged || keysChanged) {
      accountService.invalidate();
      userStream.stop();
      if (updated.keys[updated.mode].key && updated.keys[updated.mode].secret) {
        userStream.start();
        void accountService.refresh();
      }
    }
    if (updated.symbol !== before.symbol) {
      emit('log', { level: 'info', msg: `Market display symbol changed to ${updated.symbol}` });
      marketStream.subscribe(engine.activeSymbols());
      void accountService.refresh();
    }
    res.json(publicSettings());
  });

  // No order, close, kill, strategy, scanner, signal, or backtest mutation routes
  // are installed. Existing exchange positions/orders are untouched and require
  // manual review in Binance after legacy journal migration.
  r.get('/limits', (_req, res) => res.json({ limiter: limiter.status(), telemetry: api.telemetry, candles: candleStore.stats() }));
  r.get('/diagnostics', (_req, res) => {
    const market = engine.state();
    res.json({
      mode: getSettings().mode,
      entriesEnabled: false,
      feed: feedInfo(),
      streams: {
        market: { connected: marketStream.isConnected, lastMessageAt: marketStream.lastMessage() },
        user: { connected: userStream.isConnected, lastMessageAt: userStream.lastMessage() },
      },
      engine: { activeSymbols: engine.activeSymbols(), lastTickAt: engine.lastTick(), lastClosedCandleTime: market?.lastClosedCandleTime ?? 0 },
      openTrades: openTrades().length,
      accountAt: accountService.get()?.at ?? 0,
      limiter: limiter.status(),
      now: Date.now(),
    });
  });

  r.use((_req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));
  return r;
}

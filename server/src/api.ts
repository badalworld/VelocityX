/**
 * HTTP API for the dashboard UI.
 *
 * Every market/account number returned here comes from Binance (REST + WS).
 * When the exchange is unreachable the feed is flagged `binance-unreachable`
 * and payloads stay empty — nothing is ever simulated.
 */
import express from 'express';
import { api } from './binance';
import { authRequired, rateLimit, requireToken } from './auth';
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

/** Single frontend/backend contract for whether a REAL entry may be sent now. */
export function currentExecutionReadiness(): {
  ready: boolean;
  infrastructureReady: boolean;
  state: 'READY' | 'DISARMED' | 'BLOCKED';
  reasons: string[];
  mode: string;
  armed: boolean;
  checks: Record<string, boolean>;
  at: number;
} {
  const now = Date.now();
  const s = getSettings();
  const keys = s.keys[s.mode];
  const account = accountService.get();
  const scan = scanner.result();
  const checks = {
    keys: !!(keys.key && keys.secret),
    exchange: api.reachable === true,
    marketStream: marketStream.isConnected && now - marketStream.lastMessage() < 30_000,
    userStream: userStream.isConnected,
    account: !!account && account.mode === s.mode && account.canTrade === true && now - account.at < 30_000,
    engine: engine.lastTick() > 0 && now - engine.lastTick() < 10_000,
    scanner: !s.autoScan || (s.scanner.enabled && !!scan && now - scan.at < Math.max(180_000, s.scanner.intervalSec * 3_000)),
  };
  const labels: Record<keyof typeof checks, string> = {
    keys: `${s.mode} API keys are not configured`,
    exchange: 'Binance REST feed is not confirmed reachable',
    marketStream: 'market stream is disconnected or stale',
    userStream: 'user-data execution stream is disconnected',
    account: 'fresh trade-enabled Binance account snapshot is unavailable',
    engine: 'signal engine heartbeat is stale',
    scanner: '50-asset scanner snapshot is stale',
  };
  const reasons = (Object.keys(checks) as (keyof typeof checks)[])
    .filter((key) => !checks[key])
    .map((key) => labels[key]);
  const infrastructureReady = reasons.length === 0;
  if (!s.autoTrade) reasons.push('auto-trade is disarmed');
  const ready = infrastructureReady && s.autoTrade;
  return {
    ready,
    infrastructureReady,
    state: ready ? 'READY' : infrastructureReady ? 'DISARMED' : 'BLOCKED',
    reasons,
    mode: s.mode,
    armed: s.autoTrade,
    checks,
    at: now,
  };
}

export function apiRouter(): express.Router {
  const r = express.Router();

  // Dashboard state is realtime execution state; an intermediary/browser must
  // never satisfy a poll from a stale cached response.
  r.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Liveness/readiness for process supervisors. Deliberately tiny and always
  // unauthenticated so a container orchestrator can probe it.
  r.get('/health', (_req, res) => {
    res.json({
      ok: true,
      uptime: process.uptime(),
      feed: api.reachable === false ? 'binance-unreachable' : 'binance',
      authRequired: authRequired(),
      mode: getSettings().mode,
    });
  });

  // Every API route is token-gated when VX_API_TOKEN is set (open by default,
  // with a loud boot warning — see index.ts).
  r.use(requireToken);
  // State-changing routes are rate limited per IP.
  const mutate = rateLimit({ perMinute: 60, burst: 20 });

  const feedInfo = () => {
    const unreachable = api.reachable === false;
    return {
      feed: unreachable ? 'binance-unreachable' : 'binance',
      source: 'binance-usdm',
      reachable: api.reachable,
      lastRestOkAt: api.telemetry.lastRestOkAt,
      lastRestError: api.telemetry.lastRestError || null,
      latencyMs: api.telemetry.lastLatencyMs,
      avgLatencyMs: api.telemetry.avgLatencyMs,
      serverTimeOffsetMs: api.telemetry.serverTimeOffsetMs,
      wsLastMessageAt: api.telemetry.wsLastMessageAt,
      candles: candleStore.stats(),
    };
  };

  r.get('/status', async (_req, res) => {
    const s = getSettings();
    const st = engine.state();
    const price = st?.lastPrice || 0;
    const view = accountService.get();
    const scan = scanner.result();
    const activeZones = scanner.activeSymbols();

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
            mode: view.mode,
            equity: view.equity,
            walletBalance: view.walletBalance,
            unrealizedPnl: view.unrealizedPnl,
            availableBalance: view.availableBalance,
            initialMargin: view.initialMargin,
            maintMargin: view.maintMargin,
            roiPct: view.roiPct,
            roiOnWalletPct: view.roiOnWalletPct,
            canTrade: view.canTrade,
            bot: view.bot,
            income: view.income,
            external: view.external,
            at: view.at,
            errors: view.errors,
            latencyMs: view.latencyMs,
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
        ? {
            at: scan.at,
            universe: scan.universe,
            target: scan.target,
            analysed: scan.analysed,
            selected: activeZones,
            opportunities: scanner.opportunities(),
            progress: scanner.progress(),
            top: scan.rows.slice(0, 12).map((row) => ({
              ...row,
              inOpportunityZone: activeZones.includes(row.symbol),
            })),
          }
        : null,
      execution: currentExecutionReadiness(),
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

  const numQuery = (v: unknown): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  r.get('/account', async (req, res) => {
    const days = numQuery(req.query.days);
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
    const days = numQuery(req.query.days) ?? getSettings().historyDays;
    try {
      res.json(await accountService.incomeSummary(days));
    } catch (e: any) {
      res.status(502).json({ error: e?.message });
    }
  });

  // ---------------- market scanner ----------------

  r.get('/scanner', (req, res) => {
    const result = scanner.result();
    if (!result) {
      return res.json({
        at: 0,
        universe: 0,
        target: scanner.progress().target,
        analysed: 0,
        rows: [],
        selected: scanner.activeSymbols(),
        opportunities: scanner.opportunities(),
        progress: scanner.progress(),
        gate: null,
        warming: true,
      });
    }
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    const selected = scanner.activeSymbols();
    const monitored = new Set(selected);
    res.json({
      ...result,
      rows: result.rows.slice(0, limit).map((row) => ({ ...row, inOpportunityZone: monitored.has(row.symbol) })),
      selected,
      opportunities: scanner.opportunities(),
      progress: scanner.progress(),
      warming: false,
    });
  });

  r.get('/execution/readiness', (_req, res) => res.json(currentExecutionReadiness()));

  r.post('/scanner/scan', async (_req, res) => {
    const result = await scanner.scan();
    res.json(result ?? { error: 'scan failed — check the activity log' });
  });

  // ---------------- settings / control ----------------

  r.get('/settings', (_req, res) => res.json(publicSettings()));

  /**
   * Update settings. Switching to LIVE (real money) needs an explicit
   * `confirmLive: true` in the body — a stray click, a stale tab or a scripted
   * POST can no longer move real funds by accident.
   */
  r.post('/settings', mutate, (req, res) => {
    const before = getSettings();
    const patch = req.body || {};
    const wantsLive = patch.mode === 'live' && before.mode !== 'live';
    const resultingMode = patch.mode ?? before.mode;
    const armsLiveViaSettings = resultingMode === 'live' && patch.autoTrade === true && before.autoTrade !== true;

    if (patch.mode !== undefined && !['testnet', 'live'].includes(patch.mode)) {
      return res.status(400).json({ error: 'mode must be testnet | live — simulation was removed' });
    }
    if (wantsLive && patch.confirmLive !== true) {
      return res.status(400).json({
        error: 'Switching to LIVE places real orders — resend with confirmLive: true after testing on Binance testnet',
      });
    }
    if (armsLiveViaSettings && !wantsLive && patch.confirmLive !== true) {
      return res.status(400).json({
        error: 'Arming LIVE auto-trade requires confirmLive: true (normally use POST /api/autotrade)',
      });
    }
    if (patch.symbol !== undefined && !/^[A-Z0-9]{4,24}$/.test(String(patch.symbol).toUpperCase())) {
      return res.status(400).json({ error: 'symbol must be a Binance USD-M symbol like BTCUSDT' });
    }
    if (wantsLive) {
      // Entering LIVE always lands DISARMED: auto-trade must be switched on
      // again deliberately (with its own confirmation) before any order is sent.
      patch.autoTrade = false;
    }

    const s = updateSettings(patch);
    if (patch.symbol && patch.symbol !== before.symbol) {
      emit('log', { level: 'info', msg: `Primary symbol changed to ${s.symbol}` });
    }
    const modeChanged = !!patch.mode && patch.mode !== before.mode;
    if (modeChanged) {
      if (s.keys[s.mode]?.key && s.keys[s.mode]?.secret) {
        accountService.invalidate();
        userStream.start();
        void accountService.refresh();
        emit('log', {
          level: s.mode === 'live' ? 'error' : 'info',
          msg:
            s.mode === 'live'
              ? 'Mode switched to LIVE — real mainnet account armed with auto-trade OFF; enable auto-trade to start executing'
              : `Mode switched to ${s.mode.toUpperCase()}`,
        });
      } else {
        emit('error', { message: `No API keys configured for ${s.mode} mode` });
        updateSettings({ mode: before.mode });
        return res.status(400).json({ error: `No API keys configured for ${s.mode} mode` });
      }
    }
    const activeKeysChanged =
      before.keys[s.mode]?.key !== s.keys[s.mode]?.key ||
      before.keys[s.mode]?.secret !== s.keys[s.mode]?.secret;
    if (!modeChanged && activeKeysChanged) {
      // User-stream listen keys and cached account data belong to one API
      // credential. Replace both atomically from the dashboard's perspective.
      accountService.invalidate();
      userStream.stop();
      userStream.start();
      if (s.keys[s.mode]?.key && s.keys[s.mode]?.secret) void accountService.refresh();
      emit('log', {
        level: 'info',
        msg: `${s.mode.toUpperCase()} credentials changed — execution stream and account snapshot refreshed`,
      });
    }
    if (patch.scanner && JSON.stringify(patch.scanner) !== JSON.stringify(before.scanner)) {
      // Threshold changes invalidate authorization immediately; a fresh batch
      // must re-qualify every retained zone under the new contract.
      scanner.clearOpportunities();
      scanner.restart();
      emit('log', {
        level: 'info',
        msg: s.scanner.enabled ? 'Scanner settings applied — rescanning the market' : 'Scanner disabled — manual symbol mode only',
      });
      if (s.scanner.enabled) void scanner.scan();
      else scanner.clearOpportunities();
    }
    if (patch.autoScan === false && before.autoScan !== false) scanner.clearOpportunities();
    if (patch.autoScan === true && before.autoScan === false && s.scanner.enabled) void scanner.scan();
    if (patch.autoTrade !== undefined && patch.autoTrade !== before.autoTrade) {
      emit('log', { level: patch.autoTrade ? 'win' : 'error', msg: `Auto-trade ${patch.autoTrade ? 'ENABLED' : 'DISABLED'}` });
    }
    res.json(publicSettings());
  });

  /**
   * Auto-trade master switch. Enabling it while LIVE is a real-money action and
   * therefore needs `confirmLive: true` too.
   */
  r.post('/autotrade', mutate, (req, res) => {
    const enabled = !!req.body?.enabled;
    const mode = getSettings().mode;
    if (enabled && mode === 'live' && req.body?.confirmLive !== true) {
      return res.status(400).json({
        error: 'Enabling auto-trade in LIVE mode executes real orders — resend with confirmLive: true',
      });
    }
    updateSettings({ autoTrade: enabled });
    emit('log', {
      level: enabled ? (mode === 'live' ? 'error' : 'win') : 'info',
      msg: `Auto-trade ${enabled ? 'ENABLED' : 'DISABLED'}${enabled && mode === 'live' ? ' in LIVE mode — real orders active' : ''}`,
    });
    emit('status', { autoTrade: enabled });
    res.json({ autoTrade: enabled, execution: currentExecutionReadiness() });
  });

  /** Close ONE bot-owned position at market (external positions are never touched). */
  r.post('/positions/close', mutate, async (req, res) => {
    const id = String(req.body?.id || '');
    const trade = openTrades().find((t) => t.id === id);
    if (!trade) return res.status(404).json({ error: 'No open bot position with that id' });
    const confirmed = await trader.closeByMarket(trade, 'KILL');
    void accountService.refresh();
    const payload = {
      ok: confirmed,
      id,
      closed: allTrades().find((t) => t.id === id) || null,
      openTrades: openTrades(),
      error: confirmed ? undefined : 'Binance did not confirm the close; the trade remains managed and protected',
    };
    // Never tell the frontend a real close succeeded when Binance did not
    // confirm the expected position delta.
    res.status(confirmed ? 200 : 502).json(payload);
  });

  r.post('/kill', mutate, async (_req, res) => {
    const attempted = openTrades().length;
    const closed = await trader.kill();
    void accountService.refresh();
    const ok = closed === attempted;
    res.status(ok ? 200 : 502).json({
      ok,
      attempted,
      closed,
      openTrades: openTrades(),
      error: ok ? undefined : `${attempted - closed} bot position(s) were not confirmed closed and remain managed`,
    });
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
        target: scanner.result()?.target ?? scanner.progress().target,
        analysed: scanner.result()?.analysed ?? 0,
        selected: scanner.activeSymbols(),
        opportunities: scanner.opportunities(),
        progress: scanner.progress(),
      },
      execution: currentExecutionReadiness(),
      limiter: limiter.status(),
      account: { source: accountService.get()?.source ?? null, at: accountService.get()?.at ?? 0, errors: accountService.get()?.errors ?? [] },
      now: Date.now(),
    });
  });

  // Unknown API route → JSON 404 (never the SPA fallback).
  r.use((_req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));

  return r;
}

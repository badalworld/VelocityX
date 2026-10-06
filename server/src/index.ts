/**
 * VelocityX — Binance USD-M Futures bot server.
 * Serves the dashboard SPA + REST API + WebSocket hub.
 *
 * Realtime data flow:
 *   Binance REST  → scanner (volatility ranking) + engine history seeds
 *   Binance WS    → bookTicker prices + kline candles + user-data fills/account
 *   95% weight budget scheduler rations every REST call across work areas.
 */
import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { apiRouter, currentExecutionReadiness } from './api';
import { closeBroadcast, emit, initBroadcast } from './broadcast';
import { authRequired, bindHost, LIVE_CONTROL_MESSAGE, liveControlProtected } from './auth';
import { api } from './binance';
import { engine } from './engine';
import { loadSettings, getSettings, updateSettings } from './settings';
import { openTradeOn, openTrades, pruneOld, remainingQtyOf } from './store';
import { trader } from './trader';
import { scanner } from './scanner';
import { accountService } from './account';
import { marketStream, userStream } from './streams';
import { limiter } from './ratelimit';

const PORT = Number(process.env.PORT) || 4000;
/** Host binding: 0.0.0.0 by default (containers/preview), override with VX_HOST. */
const HOST = bindHost();
/** Live trading must be explicitly re-armed at boot: restarting the process
 *  alone must never resume real-money execution silently. */
const ALLOW_LIVE = process.env.VX_ALLOW_LIVE === '1';

async function main(): Promise<void> {
  const settings = loadSettings();
  pruneOld(settings.historyDays);

  // ---- boot safety -------------------------------------------------------
  // Never fall back to a paper order executor: a persisted LIVE + auto-trade
  // config must not start placing real orders the second the process comes
  // back up (crash loop, deploy, restart). Historical backtesting is separate.
  // Without VX_ALLOW_LIVE the bot boots
  // on the same environment but DISARMED.
  if (settings.mode === 'live' && settings.autoTrade && !ALLOW_LIVE) {
    updateSettings({ autoTrade: false });
    console.warn('[boot] SAFETY: LIVE + auto-trade was persisted but VX_ALLOW_LIVE is not set — starting DISARMED');
    emit('log', {
      level: 'error',
      msg: 'LIVE mode was persisted with auto-trade ON but VX_ALLOW_LIVE is not set — started DISARMED (re-arm explicitly when ready)',
    });
  } else if (settings.mode === 'live' && settings.autoTrade && !liveControlProtected()) {
    // LIVE + an open, unauthenticated control API is never allowed to trade.
    updateSettings({ autoTrade: false });
    console.warn(`[boot] SAFETY: ${LIVE_CONTROL_MESSAGE} — starting DISARMED`);
    emit('log', { level: 'error', msg: `${LIVE_CONTROL_MESSAGE} — started DISARMED` });
  } else if (settings.autoTrade) {
    console.warn(`[boot] SAFETY: starting with auto-trade ON in ${settings.mode.toUpperCase()} mode`);
  }
  // Trades are only managed with the keys/endpoints of their own environment.
  const otherMode = openTrades().filter((t) => t.mode !== getSettings().mode);
  if (otherMode.length) {
    const list = otherMode.map((t) => `${t.symbol}(${t.mode})`).join(', ');
    console.warn(`[boot] WARNING: ${otherMode.length} open bot trade(s) belong to the other environment and are NOT monitored in ${getSettings().mode.toUpperCase()} mode: ${list}`);
    emit('log', { level: 'error', msg: `Open ${otherMode[0].mode.toUpperCase()} trade(s) not monitored while running ${getSettings().mode.toUpperCase()}: ${list} — switch back to manage them` });
  }
  const bootKeys = settings.keys[settings.mode];
  if (!bootKeys.key || !bootKeys.secret) {
    console.warn(`[boot] no ${settings.mode.toUpperCase()} API keys configured — add them in Settings → Connection (nothing can trade until then)`);
    emit('log', { level: 'error', msg: `No ${settings.mode.toUpperCase()} API keys configured — the dashboard shows account data as soon as keys are saved` });
  }
  if (!authRequired()) {
    console.warn('[boot] SAFETY: VX_API_TOKEN is not set — the API (orders, kill switch, keys) is open to anyone who can reach this port');
  }

  console.log(
    `[boot] VelocityX | mode=${settings.mode} primary=${settings.symbol} auto=${settings.autoTrade ? 'ON' : 'OFF'} ` +
      `maxPositions=${settings.maxPositions} scan=${settings.autoScan ? 'ON' : 'OFF'}`,
  );
  console.log(
    `[boot] Binance weight budget: ${limiter.weightCap()}/min (95% of 2400) distributed over ` +
      `scanner/market/account/orders/stream areas`,
  );

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  // Minimal security headers that never break the hosted preview / iframe
  // embedding (no X-Frame-Options / frame-ancestors restrictions).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use('/api', apiRouter());

  // static dashboard (client/dist)
  const dist = path.resolve(__dirname, '..', '..', 'client', 'dist');
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.sendFile(path.join(dist, 'index.html'), (err) => {
      if (err) res.status(200).send('VelocityX server running. Build the client (npm run build) to view the dashboard.');
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[http]', err);
    res.status(500).json({ error: err?.message || 'Internal error' });
  });

  const server = http.createServer(app);
  initBroadcast(server);

  server.listen(PORT, HOST, () => {
    console.log(`[boot] listening on http://${HOST}:${PORT}`);
  });

  // --- scanner <-> executor wiring (the bot never loses sight of its positions) ---
  scanner.holdsPosition = (symbol: string) => !!openTradeOn(symbol);
  trader.setRuntimeGate(() => {
    const readiness = currentExecutionReadiness();
    return { ready: readiness.ready, reasons: readiness.reasons };
  });
  scanner.onChange(() => {
    marketStream.subscribe(engine.activeSymbols());
    emit('scanner', {
      at: scanner.result()?.at,
      selected: scanner.activeSymbols(),
      opportunities: scanner.opportunities(),
      progress: scanner.progress(),
    });
  });

  // Long-lived timers are tracked so shutdown can stop them deterministically.
  const engineTimers: NodeJS.Timeout[] = [];

  // --- engines & streams ---
  engine.start();
  scanner.start();
  marketStream.subscribe(engine.activeSymbols());
  if (bootKeys.key && bootKeys.secret) userStream.start();
  accountService.start(12_000);

  // Signed requests carry a timestamp (recvWindow 5 s). Measure the host's clock
  // drift against Binance at boot and every 5 minutes so a drifting clock is
  // compensated instead of rejecting orders.
  void api.ping();
  engineTimers.push(setInterval(() => void api.ping(), 5 * 60_000));

  // Keep the market stream subscribed to whatever the engine watches
  // (scanner picks change, positions open/close) and refresh the account view
  // whenever the set of bot positions changes, so the dashboard never lags.
  let lastKey = '';
  let lastTradeKey = '';
  engineTimers.push(setInterval(() => {
    const key = engine.activeSymbols().sort().join(',');
    if (key !== lastKey) {
      lastKey = key;
      marketStream.subscribe(engine.activeSymbols());
    }
    const tradeKey = openTrades()
      .map((t) => `${t.id}:${t.status}:${remainingQtyOf(t).toFixed(8)}`)
      .sort()
      .join('|');
    if (tradeKey !== lastTradeKey) {
      lastTradeKey = tradeKey;
      void accountService.refresh();
    }
  }, 5000));

  // periodic housekeeping
  engineTimers.push(setInterval(() => {
    const s = getSettings();
    pruneOld(s.historyDays);
    emit('status', { t: Date.now() });
  }, 60_000));

  // safety reconcile (catch missed fills, re-arm missing SL) — 10s
  engineTimers.push(setInterval(() => {
    if (getSettings().keys[getSettings().mode].key) void trader.reconcile();
  }, 10_000));

  // funding accrual for every open bot position — 5 min (Binance income ledger)
  engineTimers.push(setInterval(() => {
    for (const t of openTrades()) void trader.refreshFunding(t);
  }, 300_000));

  // ---- error surfacing: never swallow a failure silently ------------------
  process.on('unhandledRejection', (e: any) => {
    const msg = e?.message || String(e);
    console.error('[unhandledRejection]', msg);
    emit('log', { level: 'error', msg: `Unhandled promise rejection: ${msg}` });
  });
  process.on('uncaughtException', (e: any) => {
    const msg = e?.message || String(e);
    console.error('[uncaughtException]', msg);
    emit('log', { level: 'error', msg: `Uncaught exception: ${msg}` });
    // A torn process must not keep trading on undefined state: flatten nothing
    // (protective stops stay armed on the exchange) but stop the engine loop
    // and exit so a supervisor restarts us cleanly.
    void shutdown('uncaughtException', 1);
  });

  // ---- graceful shutdown -------------------------------------------------
  let shuttingDown = false;
  async function shutdown(reason: string, code = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${reason} — stopping feeds (open positions keep their exchange SL/TP orders)`);
    // A lingering dashboard connection can keep server.close() waiting forever —
    // never let that hold the process (or a supervisor's stop timeout) hostage.
    setTimeout(() => {
      console.error('[shutdown] forced exit after 10 s');
      process.exit(code || 1);
    }, 10_000).unref();
    try {
      engine.stop();
      scanner.stop();
      accountService.stop();
      marketStream.stop();
      userStream.stop();
      closeBroadcast();
      for (const t of engineTimers) clearInterval(t);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.(); // SSE / keep-alive connections would otherwise block close()
      });
    } catch (e: any) {
      console.error('[shutdown]', e?.message || e);
    }
    console.log(`[shutdown] done — ${openTrades().length} bot position(s) left protected on the exchange`);
    process.exit(code);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();

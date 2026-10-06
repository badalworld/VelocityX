/** VelocityX — read-only Binance market/account dashboard server. */
import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { apiRouter } from './api';
import { closeBroadcast, emit, initBroadcast } from './broadcast';
import { authRequired, bindHost } from './auth';
import { api } from './binance';
import { engine } from './engine';
import { loadSettings, getSettings } from './settings';
import { allTrades, openTrades } from './store';
import { accountService } from './account';
import { marketStream, userStream } from './streams';
import { limiter } from './ratelimit';

const PORT = Number(process.env.PORT) || 4000;
const HOST = bindHost();

async function main(): Promise<void> {
  const settings = loadSettings();
  const openLegacy = openTrades();
  if (openLegacy.length) {
    console.warn(
      `[boot] ${openLegacy.length} legacy journal position(s) remain OPEN. ` +
      'This build has no position manager; review the exchange positions and protective orders manually in Binance.',
    );
  }
  const bootKeys = settings.keys[settings.mode];
  if (!bootKeys.key || !bootKeys.secret) {
    console.warn(`[boot] no ${settings.mode.toUpperCase()} API keys configured — add them in Settings → Connection to view account data`);
  }
  if (!authRequired()) {
    console.warn('[boot] VX_API_TOKEN is not set — the settings/account API is open to anyone who can reach this port');
  }

  console.log(`[boot] VelocityX | read-only | mode=${settings.mode} symbol=${settings.symbol} archivedTrades=${allTrades().length}`);
  console.log(`[boot] Binance weight budget: ${limiter.weightCap()}/min across market, account and stream data`);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use('/api', apiRouter());

  const dist = path.resolve(__dirname, '..', '..', 'client', 'dist');
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.sendFile(path.join(dist, 'index.html'), (err) => {
      if (err) res.status(200).send('VelocityX server running. Build the client (npm run build) to view the dashboard.');
    });
  });
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[http]', err);
    res.status(500).json({ error: err?.message || 'Internal error' });
  });

  const server = http.createServer(app);
  initBroadcast(server);
  server.listen(PORT, HOST, () => console.log(`[boot] listening on http://${HOST}:${PORT}`));

  const timers: NodeJS.Timeout[] = [];
  engine.start();
  marketStream.subscribe(engine.activeSymbols());
  if (bootKeys.key && bootKeys.secret) userStream.start();
  accountService.start(12_000);
  void api.ping();
  timers.push(setInterval(() => void api.ping(), 5 * 60_000));
  timers.push(setInterval(() => {
    // Broadcast liveness only; no strategy or execution state exists here.
    emit('status', { entriesEnabled: false, at: Date.now() });
  }, 60_000));

  process.on('unhandledRejection', (error: any) => {
    const message = error?.message || String(error);
    console.error('[unhandledRejection]', message);
    emit('log', { level: 'error', msg: `Unhandled promise rejection: ${message}` });
  });
  process.on('uncaughtException', (error: any) => {
    const message = error?.message || String(error);
    console.error('[uncaughtException]', message);
    emit('log', { level: 'error', msg: `Uncaught exception: ${message}` });
    void shutdown('uncaughtException', 1);
  });

  let shuttingDown = false;
  async function shutdown(reason: string, code = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${reason} — stopping market/account streams`);
    setTimeout(() => process.exit(code || 1), 10_000).unref();
    try {
      engine.stop();
      accountService.stop();
      marketStream.stop();
      userStream.stop();
      closeBroadcast();
      for (const timer of timers) clearInterval(timer);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    } catch (error: any) {
      console.error('[shutdown]', error?.message || error);
    }
    console.log('[shutdown] done — VelocityX does not place or manage orders');
    process.exit(code);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();

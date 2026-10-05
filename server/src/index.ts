/**
 * VelocityX — Binance USD-M Futures bot server.
 * Serves the dashboard SPA + REST API + WebSocket hub.
 */
import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { apiRouter } from './api';
import { initBroadcast, emit } from './broadcast';
import { engine } from './engine';
import { loadSettings, getSettings } from './settings';
import { pruneOld } from './store';
import { trader } from './trader';
import { marketStream, userStream } from './streams';
import { offlineFeed } from './offline';

const PORT = Number(process.env.PORT) || 4000;

async function main(): Promise<void> {
  const settings = loadSettings();
  pruneOld(settings.historyDays);
  console.log(`[boot] VelocityX | mode=${settings.mode} symbol=${settings.symbol} auto=${settings.autoTrade ? 'ON' : 'OFF'}`);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', apiRouter());

  // static dashboard (client/dist)
  const dist = path.resolve(__dirname, '..', '..', 'client', 'dist');
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    if (req.path.startsWith('/assets/')) return res.status(404).send('Not found');
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

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[boot] listening on http://0.0.0.0:${PORT}`);
  });

  // --- engines & streams ---
  engine.start();
  marketStream.start(getSettings().symbol);
  if (getSettings().mode !== 'paper') userStream.start();

  // offline-demo price ticker (drives paper fills + UI when Binance is unreachable)
  let offlineTicker: NodeJS.Timeout | null = null;
  setInterval(() => {
    const off = offlineFeed.active;
    if (off && !offlineTicker) {
      offlineTicker = setInterval(() => {
        try {
          const s = getSettings();
          const p = offlineFeed.tick(s.symbol, s.interval);
          trader.onPrice(p);
          emit('price', { symbol: s.symbol, price: p });
        } catch { /* ignore */ }
      }, 1000);
    } else if (!off && offlineTicker) {
      clearInterval(offlineTicker);
      offlineTicker = null;
      marketStream.start(getSettings().symbol);
    }
  }, 2000);

  // periodic housekeeping
  setInterval(() => {
    const s = getSettings();
    pruneOld(s.historyDays);
    emit('status', { t: Date.now() });
  }, 60_000);

  // live-mode safety reconcile (catch missed fills, re-arm missing SL)
  setInterval(() => {
    if (getSettings().mode !== 'paper') void trader.reconcile();
  }, 10_000);

  process.on('unhandledRejection', (e: any) => {
    console.error('[unhandledRejection]', e?.message || e);
  });
  process.on('uncaughtException', (e: any) => {
    console.error('[uncaughtException]', e?.message || e);
  });
}

void main();

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
import { apiRouter } from './api';
import { initBroadcast, emit } from './broadcast';
import { engine } from './engine';
import { loadSettings, getSettings } from './settings';
import { openTradeOn, openTrades, pruneOld, remainingQtyOf } from './store';
import { trader } from './trader';
import { scanner } from './scanner';
import { accountService } from './account';
import { marketStream, userStream } from './streams';
import { offlineFeed } from './offline';
import { candleStore } from './candles';
import { limiter } from './ratelimit';

const PORT = Number(process.env.PORT) || 4000;

async function main(): Promise<void> {
  const settings = loadSettings();
  pruneOld(settings.historyDays);
  console.log(
    `[boot] VelocityX | mode=${settings.mode} primary=${settings.symbol} auto=${settings.autoTrade ? 'ON' : 'OFF'} ` +
      `maxPositions=${settings.maxPositions} scan=${settings.autoScan ? 'ON' : 'OFF'}`,
  );
  console.log(
    `[boot] Binance weight budget: ${limiter.weightCap()}/min (95% of 2400) distributed over ` +
      `scanner/market/account/orders/stream areas`,
  );

  const app = express();
  app.use(express.json({ limit: '1mb' }));
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

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[boot] listening on http://0.0.0.0:${PORT}`);
  });

  // --- scanner <-> executor wiring (the bot never loses sight of its positions) ---
  scanner.holdsPosition = (symbol: string) => !!openTradeOn(symbol);
  scanner.onChange(() => {
    marketStream.subscribe(engine.activeSymbols());
    emit('scanner', { at: scanner.result()?.at, selected: scanner.result()?.selected ?? [] });
  });

  // --- engines & streams ---
  engine.start();
  scanner.start();
  marketStream.subscribe(engine.activeSymbols());
  if (getSettings().mode !== 'paper') {
    userStream.start();
    accountService.start(12_000);
  } else {
    accountService.start(5_000);
  }

  // Keep the market stream subscribed to whatever the engine watches
  // (scanner picks change, positions open/close) and refresh the account view
  // whenever the set of bot positions changes, so the dashboard never lags.
  let lastKey = '';
  let lastTradeKey = '';
  setInterval(() => {
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
  }, 5000);

  // offline-demo price ticker (only when Binance is unreachable from this host)
  let offlineTicker: NodeJS.Timeout | null = null;
  setInterval(() => {
    const off = offlineFeed.active;
    if (off && !offlineTicker) {
      offlineTicker = setInterval(() => {
        try {
          const s = getSettings();
          for (const sym of engine.activeSymbols()) {
            const p = offlineFeed.tick(sym, s.interval);
            trader.onPrice(p, sym);
            emit('price', { symbol: sym, price: p });
            emit('prices', { symbol: sym, price: p, t: Date.now() });
          }
        } catch { /* ignore */ }
      }, 1000);
    } else if (!off && offlineTicker) {
      clearInterval(offlineTicker);
      offlineTicker = null;
      marketStream.subscribe(engine.activeSymbols());
      candleStore.stats();
    }
  }, 2000);

  // periodic housekeeping
  setInterval(() => {
    const s = getSettings();
    pruneOld(s.historyDays);
    emit('status', { t: Date.now() });
  }, 60_000);

  // live-mode safety reconcile (catch missed fills, re-arm missing SL) — 10s
  setInterval(() => {
    if (getSettings().mode !== 'paper') void trader.reconcile();
  }, 10_000);

  // funding accrual for every open bot position — 5 min (Binance income ledger)
  setInterval(() => {
    if (getSettings().mode === 'paper') return;
    for (const t of openTrades()) void trader.refreshFunding(t);
  }, 300_000);

  process.on('unhandledRejection', (e: any) => {
    console.error('[unhandledRejection]', e?.message || e);
  });
  process.on('uncaughtException', (e: any) => {
    console.error('[uncaughtException]', e?.message || e);
  });
}

void main();

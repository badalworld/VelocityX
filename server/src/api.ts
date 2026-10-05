/**
 * HTTP API for the dashboard UI.
 */
import express from 'express';
import { api } from './binance';
import { engine, mtfDashboard, screener } from './engine';
import { computeStats } from './stats';
import { getSettings, publicSettings, updateSettings, Mode } from './settings';
import { activeTrade, allSignals, allTrades, getPaperBalance, setPaperBalance } from './store';
import { trader } from './trader';
import { emit, getLogs } from './broadcast';
import { marketStream, userStream } from './streams';

export function apiRouter(): express.Router {
  const r = express.Router();

  r.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  r.get('/status', async (_req, res) => {
    const s = getSettings();
    const st = engine.state();
    const t = activeTrade();
    let balance: any = { source: 'paper', total: getPaperBalance(s.paperBalance), available: getPaperBalance(s.paperBalance) };
    if (s.mode !== 'paper') {
      try {
        const b = await api.balanceUSDT();
        balance = { source: 'real', total: b.total, available: b.available };
      } catch (e: any) {
        balance = { source: 'real', total: null, available: null, error: e?.message || String(e) };
      }
    }
    const price = st?.lastPrice || 0;
    res.json({
      mode: s.mode,
      autoTrade: s.autoTrade,
      symbol: s.symbol,
      interval: s.interval,
      leverage: s.leverage,
      tradeSizePercent: s.tradeSizePercent,
      price,
      balance,
      openTrade: t && t.status === 'OPEN' ? { ...t, unrealized: t && price ? (price - t.entryPrice) * (t.side === 'LONG' ? 1 : -1) * t.qty : 0 } : null,
      engine: st ? {
        atr: st.atr,
        ribbonBull: st.ribbonBull,
        lastSignal: st.lastSignal,
        emas: st.emas,
        emaExtra: st.emaExtra,
        lastClosedCandleTime: st.lastClosedCandleTime,
        startedAt: st.engineStartedAt,
      } : null,
      feed: api.isOffline() ? 'offline-demo' : 'binance',
      streams: { market: !api.isOffline() },
      keysConfigured: {
        testnet: !!(s.keys.testnet.key && s.keys.testnet.secret),
        live: !!(s.keys.live.key && s.keys.live.secret),
      },
      logs: getLogs(60),
      now: Date.now(),
    });
  });

  r.get('/chart', (req, res) => {
    const limit = Math.min(1500, Math.max(50, Number(req.query.limit) || 300));
    res.json(engine.chart(limit));
  });

  r.get('/settings', (_req, res) => res.json(publicSettings()));

  r.post('/settings', (req, res) => {
    const before = getSettings();
    const patch = req.body || {};
    const s = updateSettings(patch);
    // runtime reactions
    if (patch.symbol && patch.symbol !== before.symbol) {
      if (!activeTrade()) {
        marketStream.start(s.symbol);
        emit('log', { level: 'info', msg: `Symbol changed to ${s.symbol}` });
      } else {
        emit('log', { level: 'error', msg: 'Cannot change symbol while a trade is open' });
        // revert
        updateSettings({ symbol: before.symbol });
      }
    }
    if (patch.mode && patch.mode !== before.mode) {
      if (s.mode === 'paper' || s.keys[s.mode]?.key) {
        userStream.start();
        emit('log', { level: 'info', msg: `Mode switched to ${s.mode.toUpperCase()}` });
      } else {
        emit('error', { message: `No API keys configured for ${s.mode} mode` });
        updateSettings({ mode: before.mode });
      }
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

  r.post('/kill', async (_req, res) => {
    await trader.kill();
    res.json({ ok: true, openTrade: activeTrade() });
  });

  r.get('/trades', (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    res.json(allTrades().slice(0, limit));
  });

  r.get('/signals', (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const sym = getSettings().symbol;
    res.json(allSignals().filter((x) => !req.query.all || x.symbol === sym).slice(0, limit));
  });

  r.get('/stats', (_req, res) => res.json(computeStats()));

  r.get('/mtf', async (_req, res) => {
    try {
      res.json(await mtfDashboard());
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  r.get('/screener', async (_req, res) => {
    try {
      res.json(await screener());
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  r.post('/paper/reset', (req, res) => {
    const bal = Number(req.body?.balance);
    setPaperBalance(Number.isFinite(bal) && bal > 0 ? bal : getSettings().paperBalance);
    emit('log', { level: 'info', msg: `Paper balance reset to ${getPaperBalance(1000)} USDT` });
    res.json({ balance: getPaperBalance(1000) });
  });

  return r;
}

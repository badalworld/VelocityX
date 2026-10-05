# ⚡ VelocityX

**Full-stack Binance USD-M Futures automatic trading bot driven by the SUPER INDIBOT TradingView indicator (v6).**

Web dashboard + signal engine + trade executor. It computes the indicator *itself* from Binance market data (no TradingView connection needed) and automatically executes trades on Binance Futures when the indicator fires — with your staged TP/SL money-management rules.

```
┌────────────────────────────────────────────────────────────────────┐
│  Binance REST/WS  ──►  Signal Engine (EMA11/EMA34 cross, 5m)       │
│  (klines, prices)        │  ATR(14)×2 SL · TP 1.5R/3R/4.5R         │
│                          ▼                                          │
│                   Trade Executor (paper / testnet / live)          │
│                     TP1→33%+BE · TP2→50% rest+SL→TP1 · TP3→full    │
│                          │                                          │
│   REST API + WS  ◄───────┘                                          │
│        │                                                            │
│   React dashboard: chart+ribbon, position, stats, MTF, screener,    │
│   settings, trade history, live activity feed                       │
└────────────────────────────────────────────────────────────────────┘
```

---

## Indicator port (exact)

The signal logic is a 1:1 port of the TradingView script's *non-repaint* core:

| Element | Rule |
|---|---|
| Signal | `EMA(11)` crosses `EMA(34)` on **confirmed** values (`close[1]`-based) of a closed 5m candle |
| Entry | close of the signal candle |
| Stop loss | `ATR(14) × 2` beyond entry (1R) |
| TP1 / TP2 / TP3 | `1.5R / 3R / 4.5R` (TP multiplier 1.5 per level) |
| Ribbon | EMAs 5, 11, 15, 18, 21, 24, 28, 34 + extra EMA 200 |
| Dashboard | MTF trend (5m/15m/30m by default) — EMA34 < EMA11 ⇒ Bullish |
| Screener | same EMA state per symbol (Binance perps replace NSE symbols) |
| Stats table | weekly WR, TP hit %, expectancy in R — same formulas as the script |

All defaults are pre-filled and editable in **Settings → INDICATOR**.

## Your execution rules (as specified)

| Event | Action |
|---|---|
| Signal (auto-trade ON) | Open market position — margin = **5% of balance**, **10× leverage** (one-way mode, isolated) |
| **TP1** hit | Close **33%** → move **SL to breakeven** |
| **TP2** hit | Close **50% of remaining** → move **SL to TP1** |
| **TP3** hit | Close **rest = full profit** |
| Opposite signal while open | **Close & reverse** (exactly like the indicator redraws) |
| Kill button | Market-close everything + cancel all orders |
| Other/manual positions | **Never touched** — the bot only monitors trades it opened |

Rounding is lot-step aware; on exchange minimum-lot symbols the ladder degrades gracefully to a single full exit at TP3.

---

## Quick start

```bash
npm install --prefix server && npm install --prefix client
npm run build          # tsc (server) + vite (client)
npm start              # http://localhost:4000
```

Development: `npm run dev:server` (tsc watch) + `npm run dev:client` (vite on :5173, proxies to :4000).

### Modes (Settings → CONNECTION)

1. **PAPER (default, safe)** — full logic against *live Binance prices*, fills simulated locally, balance starts at 1 000 USDT (configurable). No keys needed.
2. **TESTNET** — real orders on [testnet.binancefuture.com](https://testnet.binancefuture.com) with free test USDT. Generate keys: log in on the testnet site → *API Management*.
3. **LIVE** — real mainnet orders. Configure your Binance API keys first (enable Futures, prefer IP-restricted keys).

Keys can be entered in the dashboard or via environment variables:

```bash
BINANCE_TESTNET_KEY=...      BINANCE_TESTNET_SECRET=...
BINANCE_LIVE_KEY=...         BINANCE_LIVE_SECRET=...
BINANCE_MODE=paper           # paper | testnet | live
BINANCE_SYMBOL=BTCUSDT
PORT=4000
```

Dashboard settings override env vars. Keys are stored in `server/data/settings.json` (never committed), masked in the UI and API responses.

### Operating sequence

1. Start in **PAPER**, leave **Auto-Trading OFF**, watch signals/stats for a session.
2. Switch to **TESTNET** (paste testnet keys) → enable auto-trade → verify order placement, TP scaling, SL moves.
3. Only then switch to **LIVE**.

> ⚠️ Trading involves risk of loss. This software executes real orders when configured to do so. Test thoroughly; start small; the authors assume no liability.

---

## Project layout

```
server/src/
  index.ts        bootstrap: express + WS + engine + streams
  api.ts          REST endpoints (/api/*)
  engine.ts       candle sync, non-repaint signal detection, MTF/screener
  trader.ts       trade state machine (entries, TP ladder, SL moves, reverse, kill)
  indicators.ts   EMA / ATR(Wilder) / crossover math (Pine-exact)
  binance.ts      market data (mainnet) + signed order API (testnet/live)
  streams.ts      bookTicker price stream + user-data ORDER_TRADE_UPDATE stream
  offline.ts      offline demo feed (only used when Binance is unreachable)
  settings.ts     persisted settings (indicator defaults pre-filled)
  store.ts        trade/signal persistence (server/data/*.json)
  stats.ts        weekly stats table (indicator formulas)
client/src/
  App.tsx                 layout, live state, WS integration
  components/ChartPanel   lightweight-charts + EMA ribbon + signal markers + TP/SL lines
  components/...          position card, stats, MTF, screener, settings, history, log
```

### API surface

`GET /api/status` · `/api/chart` · `/api/settings` · `/api/trades` · `/api/signals` · `/api/stats` · `/api/mtf` · `/api/screener`
`POST /api/settings` · `/api/autotrade` · `/api/kill` · `/api/paper/reset`
`WS /ws` — price ticks, signals, trade events, activity log.

---

## Offline demo feed

If the server **cannot reach Binance** (sandboxed networks, firewalled VPS), the bot automatically switches to a clearly-labeled **OFFLINE DEMO FEED**: synthetic regime-switching candles on a 10× clock so signals, TP/SL ladders and stats can be demonstrated end-to-end. It re-baselines the engine on every feed transition (never acts on spliced candles) and returns to real data automatically as soon as Binance is reachable. Orders are never sent in this state.

## Reliability notes

- Signals act **only on candles that close after engine start** — no backfill, no repainting.
- Live/testnet: primary fill detection via `ORDER_TRADE_UPDATE` user stream + 10s REST reconciliation (missed fills caught, missing SL re-armed).
- SL replace failure ⇒ position is flattened immediately (never left unprotected).
- One position at a time, on one symbol — exactly the indicator's model.

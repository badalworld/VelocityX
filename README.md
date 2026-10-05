# ⚡ VelocityX

**Full-stack Binance USD-M Futures automatic trading bot driven by the SUPER INDIBOT TradingView indicator (v6).**

Web dashboard + signal engine + trade executor. It computes the indicator *itself* from Binance market data (no TradingView connection needed) and automatically executes trades on Binance Futures when the indicator fires — with your staged TP/SL money-management rules.

```
┌────────────────────────────────────────────────────────────────────────┐
│  Binance REST/WS ──►  Market Scanner  (volatility-first, realtime)     │
│  (universe, tickers,     │  volume + range + ATR% + ADX gates         │
│   klines, bookTicker,    ▼                                            │
│   user stream)     Signal Engine per symbol (EMA11/EMA34, 5m)         │
│                          │  ATR(14)×2 SL · TP 1.5R/3R/4.5R            │
│                          ▼                                            │
│                   Trade Executor  (paper / testnet / live)            │
│                    max 8 positions · one per market                  │
│                    TP1→33%+BE · TP2→50% rest+SL→TP1 · TP3→full        │
│                          │                                            │
│   REST API + WS  ◄───────┘   request budget = 95% of Binance's limit  │
│        │                                                              │
│   React dashboard: dashboard deck, scanner, positions + Binance       │
│   account ledger, P&L rail, scanner, journal, settings                │
└────────────────────────────────────────────────────────────────────────┘
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
| Market scan | every USDT perpetual is ranked by volatility (24h range, ATR%, trend strength); the engine watches the top `maxPositions` markets |
| Stats table | weekly WR, TP hit %, expectancy in R — same formulas as the script |

All defaults are pre-filled and editable in **Settings → INDICATOR**.

## Your execution rules (as specified)

| Event | Action |
|---|---|
| Scan (every N s) | Rank the whole USDT-perp universe by volatility, drop pegged/stable/staked/index markets, keep only trending high-volatility symbols |
| Signal (auto-trade ON) | Open market position — margin = **5% of equity**, **10× leverage** (one-way mode, isolated), **one position per symbol, never more than 8** |
| **TP1** hit | Close **33%** → move **SL to breakeven** |
| **TP2** hit | Close **50% of remaining** → move **SL to TP1** |
| **TP3** hit | Close **rest = full profit** |
| Opposite signal while open | **Close & reverse** (exactly like the indicator redraws) |
| Kill button | Market-close every *bot* position + cancel its orders |
| Other/manual positions | **Never touched, never adopted, never counted** — they are listed in the UI as *external* so there is no confusion |

Rounding is lot-step aware; on exchange minimum-lot symbols the ladder degrades gracefully to a single full exit at TP3.

---

## Quick start

```bash
npm install --prefix server && npm install --prefix client
npm run build          # tsc (server) + vite (client)
npm start              # http://localhost:4000
```

Development: `npm run dev:server` (tsc watch) + `npm run dev:client` (vite on :5173, proxies to :4000).

### Tests

```bash
npm test --prefix server            # unit smoke (indicators, ladder sizes)
npm run test:e2e --prefix server    # paper state machine + the 8-position cap
npm run test:realtime --prefix server  # 95% budget, order rate, scanner gates, ownership
npm run verify:binance --prefix server # real exchange + WS + dashboard path (needs egress)
npm run smoke:ui --prefix client    # headless dashboard render (fixtures)
VX_API=http://localhost:4000 npm run smoke:ui --prefix client -- --live
```

### Modes (Settings → CONNECTION)

1. **PAPER (default, safe)** — full logic against *live Binance prices*, fills simulated locally. No keys needed and **no manual balance input**: the equity line is always derived (paper sim is labelled `paper-sim`, live/testnet equity comes from Binance `/fapi/v2/account`).
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
  index.ts        bootstrap: express + WS + engine + scanner + streams + account
  api.ts          REST endpoints (/api/*)
  ratelimit.ts    95%-of-Binance request budget, distributed over work areas
  scanner.ts      volatility-first market scanner (universe → gates → ranking)
  engine.ts       per-symbol candle sync + non-repaint signal detection
  trader.ts       multi-position state machine (≤8, one per symbol) + TP/SL ladder
  account.ts      Binance account/PnL/fees/funding attribution, external positions
  indicators.ts   EMA / ATR(Wilder) / ADX / crossover math (Pine-exact)
  binance.ts      market data (mainnet) + signed order API (testnet/live)
  streams.ts      bookTicker price stream + user-data ORDER_TRADE_UPDATE stream
  candles.ts      WS-first candle store (REST backfill only when needed)
  offline.ts      offline demo feed (only used when Binance is unreachable)
  settings.ts     persisted settings (indicator defaults pre-filled)
  store.ts        trade/signal persistence (server/data/*.json)
  stats.ts        weekly stats table (indicator formulas)
client/src/
  App.tsx                 shell: sticky header, stable data polling, P&L rail, routing, toasts
  styles/                 liquid-glass design system (tokens, glass, motion, layout, views)
  hooks/motion.ts         reveal, count-up, media queries and glass sheen
  motion/                 calm-by-default background, SVG maths, primitives and icons
  pnl.ts                  equity-curve model derived from bot trades + account data
  components/PnlDock      responsive P&L chart and performance statistics
  components/...          position card, stats, MTF, screener, settings, history, log
```

The dashboard UI is documented in **[DESIGN.md](DESIGN.md)** — tokens, glass layers, motion vocabulary and responsive behaviour.

### API surface

`GET /api/health` · `/api/status` · `/api/account` · `/api/positions` · `/api/income` · `/api/chart` ·
`/api/scanner` · `/api/limits` · `/api/diagnostics` · `/api/settings` · `/api/trades` · `/api/signals` · `/api/stats` · `/api/mtf`

`POST /api/scanner/scan` · `/api/settings` · `/api/autotrade` · `/api/kill` · `/api/positions/close`

`WS /ws` — price ticks, account updates, scanner rows, signals, trade events, activity log.

---

## Dashboard (liquid glass edition)

Five views behind one sticky, frosted header:

| View | Contents |
|---|---|
| **Dashboard** | Metrics deck: hero summary, net P&L / win rate / expectancy / signal KPIs, open positions with the live risk ladder, weekly statistics, MTF trend, scanner summary, engine health and activity feed. |
| **Scanner** | The volatility ranking table, scan summary, trade gates and engine watchlist. |
| **Positions** | Binance account ledger, managed positions, **external positions listed read-only**, closed trades, fees, funding and risk rules. |
| **Trades** | Journal summary, full trade table, signal log and activity feed. |
| **Settings** | Connection / markets & sizing / scanner / indicator tabs, execution guardrails and motion switch. |

The large **BTCUSDT candlestick/EMA chart has been removed from the client**, including its navigation tab and chart-library dependency. The separate cumulative **P&L chart remains**: a sticky side rail on desktop and a collapsible bottom sheet on tablet/phone.

The dashboard starts with **Motion off** so it does not blink or pulse. Motion can be enabled explicitly from the header and remains subject to `prefers-reduced-motion`. Live values never trigger colour-flash animations; timestamp-aware state merging also prevents stale poll responses from painting over newer WebSocket/account data. Details: [DESIGN.md](DESIGN.md).

---

## Market scanner

Every scan ranks the *whole* USD-M universe — not a hardcoded list:

1. `exchangeInfo` → TRADING, PERPETUAL, USDT-quoted contracts.
2. Reject pegged/stack/index markets (`USDC`, `FDUSD`, `TUSD`, `DAI`, `EUR`, `BNSOL`, `WBETH`, `WBTC`, `PAXG`, `BTCDOM`, …): they are copy/stack/index products, never directional trades.
3. `ticker/24hr` + `premiumIndex` → 24h range %, |change %|, quote volume, funding.
4. Gate: quote volume ≥ 20M USDT, 24h range ≥ 3 %, ATR% ≥ 0.6 %, ADX ≥ 18, 15m and 1h trend aligned, plus a behavioural peg check (a market whose 24h range is not meaningfully larger than its own gate is treated as pegged no matter what it is called).
5. Score = `0.45·volatility + 0.30·trend + 0.25·liquidity`, sorted **high → low**; the engine loads the top `maxPositions` markets and trades only those (plus the primary symbol).

Scanner knobs live in **Settings → Market Scanner** (interval, volume/range/ATR/ADX gates, candidate count, symbols per scan).

## Request budget — 95% of Binance, spread over the work areas

Binance allows 2400 weight/min per IP on USD-M Futures. VelocityX plans **2280/min (95%)** and distributes it:

| Area | Share | Weight/min | Work |
|---|---|---|---|
| scanner | 40 % | 912 | exchangeInfo, 24h tickers, funding, scanner klines |
| market | 25 % | 570 | candle backfill, MTF, chart, price polls |
| account | 20 % | 456 | account, positionRisk, income (fees + funding) |
| orders | 10 % | 228 | order entry, SL moves, TP ladder, cancels |
| stream | 5 % | 114 | listenKey create/keepalive |

Each area has a reserved floor, may borrow up to 2× while the global pool is < 60 % loaded, and the global ceiling is never exceeded — over-budget calls are **queued**, not sent. Order endpoints are additionally limited to **285/10 s and 1140/min (95 % of 300/1200)**. `429` → 60 s cooldown, `418` → 120 s + 60 % budget for 5 minutes, and `X-MBX-USED-WEIGHT-1M` headers are folded back into local accounting. Live state: `GET /api/limits`, shown in the dashboard's engine-health panel.

## Binance-sourced P&L (nothing hand-entered)

- **Equity / PnL / ROI** come from Binance (`/fapi/v2/account`, `/fapi/v2/positionRisk`) in testnet/live; in paper mode they are explicitly labelled `paper-sim`.
- **Fees and funding** are read from `/fapi/v1/income` (`COMMISSION`, `FUNDING_FEE`) and per-trade from the user stream (`rp`, `n`), never estimated per row.
- **Closed trades** are finalised with the exchange's realised PnL and commission; the journal shows market, fees and funding per row.
- **External positions** (anything opened outside the bot) are listed read-only: `managed: false`, excluded from margin, slots, equity maths and every stat. The executor only ever addresses orders tagged `VX<tradeId>…` with `reduceOnly`, so manual positions are unreachable.
- There is no manual asset/balance input anywhere in the UI or API.

## Offline demo feed

If the server **cannot reach Binance** (sandboxed networks, firewalled VPS), the bot automatically switches to a clearly-labeled **OFFLINE DEMO FEED**: synthetic regime-switching candles on a 10× clock so signals, TP/SL ladders and stats can be demonstrated end-to-end. It re-baselines the engine on every feed transition (never acts on spliced candles) and returns to real data automatically as soon as Binance is reachable. Orders are never sent in this state.

## Reliability notes

- Signals act **only on candles that close after engine start** — no backfill, no repainting.
- Live/testnet: primary fill detection via `ORDER_TRADE_UPDATE` user stream + 10s REST reconciliation (missed fills caught, missing SL re-armed).
- SL replace failure ⇒ position is flattened immediately (never left unprotected).
- Up to **8 concurrent positions**, at most one per symbol; each symbol keeps its own signal guard, guard-rail price and SL/TP ladder.
- `botOwned` is stamped on every trade the executor opens; anything else on the account is reported as external and can never enter the journal, the PnL or the stats.

# ⚡ VelocityX

**Full-stack Binance USD-M Futures automatic trading bot driven by the SUPER INDIBOT TradingView indicator (v6).**

Web dashboard + signal engine + trade executor. It computes the indicator *itself* from Binance market data (no TradingView connection needed) and automatically executes trades on Binance Futures when the indicator fires — with your staged TP/SL money-management rules.

```
┌────────────────────────────────────────────────────────────────────────┐
│  Binance REST/WS ──►  50-Asset Scanner  (bounded parallel batch)      │
│  (universe, tickers,     │  volatility + trend + setup-quality gates  │
│   klines, bookTicker,    ▼                                            │
│   user stream)     Retained Opportunity Zone (dedicated 5m monitor)   │
│                          │ confirmed EMA11/EMA34 signal               │
│                          ▼                                            │
│                    Signal Engine (closed candles only)                 │
│                          │  ATR(14)×2 SL · TP 1.5R/3R/4.5R            │
│                          ▼                                            │
│                   Trade Executor  (testnet / live — real orders)     │
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
| Market scan | 50 liquid leaders are analysed concurrently per cycle; only aligned setups near a fresh 5m cross enter a retained opportunity zone, which is monitored while the next batch continues |
| Stats table | weekly WR, TP hit %, expectancy in R — same formulas as the script |

All defaults are pre-filled and editable in **Settings → INDICATOR**.

## Your execution rules (as specified)

| Event | Action |
|---|---|
| Scan (every N s) | Rank the whole USDT-perp universe, analyse 50 leaders with 5m/15m/1h candles, and keep high-quality pre-signal setups in the retained Opportunity Zone while the next batch scans |
| Confirmed zone signal (auto-trade ON) | Re-check the server execution bridge, then open at market — margin = **5% of equity**, **10× leverage** (isolated), **one position per symbol, never more than 8** |
| **TP1** hit | Close **33%** → move **SL to breakeven** |
| **TP2** hit | Close **50% of remaining** → move **SL to TP1** |
| **TP3** hit | Close **rest = full profit** |
| Opposite signal while open | **Close & reverse** (exactly like the indicator redraws) |
| Kill button | **Disarms auto-trade first**, then market-closes every *bot* position and cancels its conditional orders |
| Other/manual positions | **Never touched, never adopted, never counted** — they are listed in the UI as *external* so there is no confusion |

Rounding is lot-step aware; on exchange minimum-lot symbols the ladder degrades gracefully to a single full exit at TP3.

**Ownership guarantees (production hardened)**

| Guarantee | How it is enforced |
|---|---|
| The bot never touches a manual position | Stops and take-profits are exchange-side **Algo Service** orders (`STOP_MARKET` / `TAKE_PROFIT_MARKET` through `POST /fapi/v1/algoOrder` — the only endpoint Binance accepts them on since 2025-12-09). Each is `reduceOnly` (one-way) or `positionSide`-scoped (hedge) with an **explicit quantity** equal to the bot's own remaining size — `closePosition`/close-all is never used, so a stop can only ever shrink the bot's own quantity. Cancels address one `clientAlgoId`; the cancel-everything-on-symbol endpoint is never called. |
| The bot never opens a market someone else is trading | Before an entry the executor reads `positionRisk`; a non-zero position it did not open **blocks the entry** for that symbol. |
| The bot never over-leverages | `/fapi/v1/leverageBracket` clamps the configured leverage per symbol instead of failing the entry. |
| Duplicate/concurrent signals cannot over-open | Per-symbol entry locks plus global in-flight slot reservations enforce one entry per market and the 8-position cap. |
| A bad or stale connection cannot start trading | Immediately before the entry POST, the backend requires keys, reachable REST, fresh market/user streams, a fresh trade-enabled account snapshot, engine heartbeat and a current scanner snapshot. `GET /api/execution/readiness` exposes the same contract to the UI. |
| A lost HTTP response cannot duplicate an order | Every order has a unique `VX<tradeId>` client id; uncertain entry/close responses are recovered by that id (or the just-verified position snapshot), never resent blindly. |
| A reverse cannot stack positions | Close-and-reverse proceeds only after Binance confirms the old position leg is flat; failed closes remain OPEN in the journal. |
| An entry cannot disappear before protection | Ownership is persisted immediately after the market fill, before SL/TP placement; a ladder failure requests emergency flattening and remains managed if flattening is not confirmed. |
| A conditional leg cannot be lost or doubled silently | The 10 s reconcile asks Binance about every leg by its client id (`GET /fapi/v1/algoOrder`): a leg that fired is booked from REST even if the WebSocket frame was missed, a leg Binance confirms is gone is re-armed, and an unanswered/failed lookup ("unknown") never re-arms anything. A stale `VX…` leg of an earlier trade is swept before the next entry and again when a trade closes; foreign (manual) conditional orders are never touched. |
| Risk is not silently multiplied | The exchange minimum notional can demand more than `tradeSize% × leverage` on a small account. The bot rounds up only to **2× the configured margin** and otherwise skips the entry (logged) — it never quietly takes a much larger position. |

---

## Quick start

```bash
npm install --prefix server && npm install --prefix client
npm run build          # tsc (server) + vite (client)
npm start              # http://localhost:4000
```

Development: `npm run dev:server` (tsc watch) + `npm run dev:client` (vite on :5173, proxies to :4000).

> `dist/`, `node_modules/`, `server/data/` and `.env` are git-ignored: **build on the machine that runs the bot** (or ship the built `server/dist` + `client/dist` + `node_modules` together). `.env` is read from the directory you start the process in (`npm start` at the repo root → `./.env`).

### Tests

```bash
npm test --prefix server            # indicator maths vs. independent Python vectors + ladder sizes
npm run test:e2e --prefix server    # order-path state machine vs. a stub exchange that behaves like Binance's 2026 API
                                    #   (conditional types rejected on /order with -4120, Algo Service validated, missed fills, flaky answers…)
npm run test:wire --prefix server   # the REAL HTTP/WebSocket client vs. local mock servers: signing, algo endpoints, user-stream URL forms, reconnects
npm run test:realtime --prefix server  # 95% budget, order rate, scanner gates, ownership guards
npm run test:api --prefix server    # boots the real server: token auth, live arming, kill, mode pinning, restart safety
npm run test:all --prefix server    # build + all of the above
npm run verify:binance --prefix server # real exchange: public REST + both market WebSockets (needs egress)
npm run preflight --prefix server   # YOUR keys on YOUR host: key/IP/canTrade, Algo endpoint, user-stream URL probe (sends no orders)
npm run smoke:ui --prefix client    # headless dashboard render (fixtures)
VX_API=http://localhost:4000 npm run smoke:ui --prefix client -- --live
```

### Modes (Settings → CONNECTION)

There is **no simulation mode**. VelocityX is a real trading system: both modes send real orders through the Binance API and every number shown comes from the exchange.

1. **TESTNET** — Binance's *Demo Trading* futures environment (`https://demo-fapi.binance.com`) with free test USDT; the old `testnet.binancefuture.com` keys no longer work. Use it to prove keys, the ladder and the safety rails with zero risk. Create demo keys at [demo.binance.com](https://demo.binance.com/en/my/settings/api-management). The REST host can be pinned with `BINANCE_TESTNET_REST`; the user-data WebSocket host (the docs disagree: `demo-fstream.binance.com` vs. `fstream.binancefuture.com`) is discovered automatically and can be pinned with `BINANCE_TESTNET_WS`.
2. **LIVE (default)** — real mainnet orders. Configure your Binance API keys first (enable Futures, prefer IP-restricted keys). Switching to LIVE is confirmed explicitly, lands disarmed, and arming execution is its own deliberate step.

Keys can be entered in the dashboard or via environment variables (see `.env.example`):

```bash
BINANCE_TESTNET_KEY=...      BINANCE_TESTNET_SECRET=...
BINANCE_LIVE_KEY=...         BINANCE_LIVE_SECRET=...
BINANCE_MODE=live            # testnet | live (there is no paper mode)
BINANCE_SYMBOL=BTCUSDT
BINANCE_TESTNET_REST=...     # optional override of the demo REST host   (default https://demo-fapi.binance.com)
BINANCE_TESTNET_WS=...       # optional: pin the demo user-stream host   (default: tries both documented hosts)
PORT=4000
VX_HOST=0.0.0.0              # bind address
VX_API_TOKEN=...             # require this token on the API + WS — REQUIRED to arm LIVE (see below)
VX_ALLOW_LIVE=1              # required to resume auto-trading on a persisted LIVE config at boot
VX_DATA_DIR=./server/data    # journal/settings location
```

Dashboard settings override env vars (an empty value in the settings file never erases an env key). Keys typed into the dashboard are stored in `server/data/settings.json` (never committed, written `0600`); keys that come from the environment are **never copied into that file**, so rotating them in `.env` always takes effect. Secrets are masked in the UI and every API response.

### Production safety (real money)

1. **Live arming is a three-step action.** Switching to LIVE needs an explicit confirmation in the UI, which the client echoes to the server as `confirmLive: true` — and the server then forces auto-trading **OFF** no matter what the request body said. Enabling auto-trading while LIVE is a separate `POST /api/autotrade` (`enabled` must be a real boolean) that again requires `confirmLive: true`. A stray POST, a stale tab or a script cannot move real funds by itself; the bot always spends at least one deliberate action disarmed.
2. **Restarts never resume live trading silently.** If LIVE + auto-trade is persisted but `VX_ALLOW_LIVE=1` is not set, the server boots on the same environment with auto-trade **OFF** and says so in the log/activity feed. There is no simulated fallback — the bot simply does not trade until it is armed again.
3. **API token — mandatory for LIVE.** Set `VX_API_TOKEN` and every REST route (except the tiny unauthenticated `/api/health` probe) plus the WebSocket upgrade requires it (`X-VX-Token` header for REST, `?token=` for the socket). Enter the same token in **Settings → Connection**; it is kept in browser storage only. **LIVE auto-trading cannot be armed — at runtime or at boot — unless a token is set or the server binds to loopback only (`VX_HOST=127.0.0.1`)**, and the execution gate enforces the same rule: an open control API that can change leverage, arm the bot or swap the keys must never sit in front of real funds.
4. **Rate limiting** on every state-changing route (60/min, burst 20, keyed on the connection address — a forged `X-Forwarded-For` cannot mint new buckets) so a stuck client cannot hammer the kill switch or consume the exchange order budget.
5. **Graceful shutdown** on SIGINT/SIGTERM: feeds and timers stop, sockets close, and protective SL/TP orders are deliberately **left armed on the exchange** — a restart must never leave a position naked.
6. **Journals are never silently lost.** A corrupt `trades.json`/`signals.json` is moved to `<name>.corrupt-<ts>` and reported instead of being overwritten with defaults.
7. **Unhandled errors surface in the UI** activity feed, and `uncaughtException` exits the process instead of trading on undefined state — **run the server under a supervisor** (systemd `Restart=always`, pm2, Docker `restart: always`): the reconcile loop re-protects any open trade after a restart, but only if the process comes back.
8. **Kill is an emergency stop.** `POST /api/kill` **disarms auto-trade first** (so the next signal cannot re-enter) and then flattens every bot position; arm again deliberately afterwards.
9. **An open bot trade pins its environment.** Switching testnet ↔ live is refused (`409`) while a bot position is open, and the reconcile loop only ever manages trades of the active environment (a warning is logged at boot for the other one).
10. **Clock drift is compensated.** The server measures its offset against Binance at boot and every 5 minutes (signed requests use a 5 s `recvWindow`); keep NTP enabled anyway.

### Going live — checklist

Binance's side changed in 2025/26 (conditional orders moved to the Algo Service, the WebSocket was split into `/public`, `/market` and `/private`, the testnet became *Demo Trading*). The test-suite proves the bot speaks the documented protocol, but **only your host can prove the exchange still behaves as documented** — hence the preflight.

1. **Build on the host:** `npm install --prefix server && npm install --prefix client && npm run build`, then run under a supervisor (see Production safety #7).
2. **Keys:** a dedicated API key with **Futures enabled, withdrawals disabled, IP-restricted** to the server's address. The account must be in **one-way or hedge mode, USDⓈ-M, USDT-margined**; the bot refuses any symbol that already holds a position.
3. **Environment:** `VX_API_TOKEN=<long random>`; `BINANCE_MODE`; `BINANCE_LIVE_KEY/SECRET` (or `BINANCE_TESTNET_*`). Add `VX_ALLOW_LIVE=1` only if a restart should resume armed LIVE trading — leaving it unset means every restart comes back disarmed (safer).
4. **Preflight on the host — first against the demo environment:**
   `BINANCE_MODE=testnet npm run preflight --prefix server -- --algo-roundtrip`
   It must end with `PREFLIGHT: ALL CHECKS PASSED`. `--algo-roundtrip` places and immediately cancels one far-from-market conditional order to prove the exact stop/take-profit request format. Then repeat the read-only run (without `--algo-roundtrip`, or with it if you accept a one-second far-from-market order) with `BINANCE_MODE=live`.
5. **Demo session:** auto-trade ON in TESTNET for a full session — check entries, the TP1/TP2/TP3 ladder, the breakeven/TP1 stop moves, the Kill switch and the P&L against the Binance demo UI.
6. **LIVE, small:** switch to LIVE (confirmation + `confirmLive`; it lands disarmed), set a small `tradeSizePercent`, arm as a separate step, and watch the first trade end-to-end (entry → stop + three take-profits resting under *Conditional Orders* in the Binance UI → fills).
7. **Watch the activity feed** for `Protective ladder failed`, `could not cancel leftover conditional order`, `reconcile error` and `MARGIN_CALL`.

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
  binance.ts      market data (mainnet) + signed order API (testnet/live) incl. the Algo Service (conditional orders)
  streams.ts      market data over the two /public + /market sockets (managed as one) + user-data stream (ORDER_TRADE_UPDATE, ALGO_UPDATE, ACCOUNT_UPDATE)
  candles.ts      WS-first candle store (REST backfill only when needed)
  settings.ts     persisted settings (indicator defaults pre-filled)
  store.ts        trade/signal persistence (server/data/*.json)
  stats.ts        weekly stats table (indicator formulas)
server/scripts/   test harnesses (smoke, e2e-execution, verify-realtime, verify-wire, verify-api) + preflight + verify-binance
client/src/
  App.tsx                 shell: sticky header, stable data polling, P&L rail, routing, toasts
  styles/                 liquid-glass design system (tokens, glass, motion, layout, views)
  hooks/motion.ts         reveal, count-up, media queries and glass sheen
  motion/                 calm-by-default background, SVG maths, primitives and icons
  pnl.ts                  equity-curve model derived from bot trades + account data
  components/PnlDock      responsive P&L chart and performance statistics
  components/...          position book, scanner/stats/MTF panels, settings, history, activity log
```

The dashboard UI is documented in **[DESIGN.md](DESIGN.md)** — tokens, glass layers, motion vocabulary and responsive behaviour.

### API surface

`GET /api/health` (public) · `/api/status` · `/api/account` · `/api/positions` · `/api/income` ·
`/api/scanner` · `/api/execution/readiness` · `/api/limits` · `/api/diagnostics` · `/api/settings` · `/api/trades` · `/api/signals` · `/api/stats` · `/api/mtf`

Unknown `/api/*` paths answer JSON `404` (never the SPA shell). The retired `/api/chart` and
`/api/screener` endpoints were removed together with the dead client code that used to call them.

`POST /api/scanner/scan` · `/api/settings` · `/api/autotrade` · `/api/kill` · `/api/positions/close`
(all state-changing routes are rate limited; `/api/settings` and `/api/autotrade` need `confirmLive: true`
when the action arms real-money trading and a token (or loopback bind), `/api/autotrade` takes `{"enabled": true|false}`
(strict boolean), `/api/kill` also disarms auto-trade, `/api/settings` refuses a mode switch with `409` while a bot position
is open, and every `/api/*` route needs the token when `VX_API_TOKEN` is set)

`WS /ws` — price ticks, account updates, scanner rows, signals, trade events, activity log
(`?token=…` when `VX_API_TOKEN` is set).

---

## Dashboard (liquid glass edition)

Five views behind one sticky, frosted header:

| View | Contents |
|---|---|
| **Dashboard** | Metrics deck: hero summary, net P&L / win rate / expectancy / signal KPIs, open positions with the live risk ladder, weekly statistics, the MTF EMA11/EMA34 gauge across 5m/15m/30m, execution rules, scanner summary, engine health and activity feed. A red banner is shown while LIVE auto-trading is armed. |
| **Scanner** | Live 50-asset batch progress, retained Opportunity Zone, execution-readiness bridge, setup-quality ranking, trade gates and dedicated monitor. |
| **Positions** | Binance account ledger, managed positions, **external positions listed read-only**, closed trades, fees, funding and risk rules. |
| **Trades** | Journal summary, full trade table, signal log and activity feed. |
| **Settings** | Connection / markets & sizing / scanner / indicator tabs, execution guardrails and motion switch. |

The large **BTCUSDT candlestick/EMA chart has been removed from the client**, including its navigation tab and chart-library dependency. The separate cumulative **P&L chart remains**: a sticky side rail on desktop and a collapsible bottom sheet on tablet/phone.

The dashboard starts with **Motion off** so it does not blink or pulse. Motion can be enabled explicitly from the header and remains subject to `prefers-reduced-motion`. Live values never trigger colour-flash animations; timestamp-aware state merging also prevents stale poll responses from painting over newer WebSocket/account data. Details: [DESIGN.md](DESIGN.md).

---

## Market scanner

Every scan ranks the *whole* USD-M universe — not a hardcoded list — then analyses a bounded-parallel batch of **50 assets by default**:

1. `exchangeInfo` → TRADING, PERPETUAL, USDT-quoted contracts.
2. Reject pegged/stack/index markets (`USDC`, `FDUSD`, `TUSD`, `DAI`, `EUR`, `BNSOL`, `WBETH`, `WBTC`, `PAXG`, `BTCDOM`, …): they are copy/stack/index products, never directional trades.
3. `ticker/24hr` ranks candidates by 24h range and move with liquidity preference; `premiumIndex` adds funding context. Eight bounded workers fetch 5m/15m/1h history for the leading 50 without creating a 150-request burst.
4. Market gate: quote volume ≥ 20M USDT, 24h range ≥ 3 %, ATR% ≥ 0.6 %, ADX ≥ 18 and 15m/1h direction aligned, plus the behavioural peg check.
5. Opportunity gate: the 5m EMA11/EMA34 gap must be converging in the aligned direction and be ≤ `0.45 ATR`; deterministic setup quality must be ≥ `65`. This score ranks rule alignment — it is **not** a guaranteed win probability.
6. Passing setups enter a retained Opportunity Zone (16 monitor slots by default, 30-minute TTL). Those symbols stay on the realtime 5m engine while the next 50-asset batch continues. Only a fresh, confirmed zone-side crossover is execution-eligible; stale/missed signals are never replayed.
7. Auto-scan mode does **not** let the primary dashboard symbol bypass the zone. Up to eight entries may be open, independently from the larger monitor queue.

Scanner knobs live in **Settings → Market Scanner** (batch size, interval, volume/range/ATR/ADX gates, setup-quality/gap gates, zone capacity and retention).

## Request budget — 95% of Binance, spread over the work areas

Binance allows 2400 weight/min per IP on USD-M Futures. VelocityX plans **2280/min (95%)** and distributes it:

| Area | Share | Weight/min | Work |
|---|---|---|---|
| scanner | 40 % | 912 | exchangeInfo, 24h tickers, funding, scanner klines |
| market | 25 % | 570 | candle backfill, MTF, chart, price polls |
| account | 20 % | 456 | account, positionRisk, income (fees + funding) |
| orders | 10 % | 228 | order entry, SL moves, TP ladder (Algo Service orders cost IP weight 0 but still count against the order-rate limits below), cancels |
| stream | 5 % | 114 | listenKey create/keepalive |

Each area has a reserved floor, may borrow up to 2× while the global pool is < 60 % loaded, and the global ceiling is never exceeded — over-budget calls are **queued**, not sent. Order endpoints are additionally limited to **285/10 s and 1140/min (95 % of 300/1200)**. `429` → 60 s cooldown, `418` → 120 s + 60 % budget for 5 minutes, and `X-MBX-USED-WEIGHT-1M` headers are folded back into local accounting. Live state: `GET /api/limits`, shown in the dashboard's engine-health panel.

## Binance-sourced P&L (nothing hand-entered)

- **Equity / PnL / ROI** come from Binance (`/fapi/v2/account`, `/fapi/v2/positionRisk`); the dashboard labels the account source as `binance` on every screen.
- **Fees and funding** are read from `/fapi/v1/income` (`COMMISSION`, `FUNDING_FEE`) and per-trade from the user stream (`rp`, `n`), never estimated per row.
- **Closed trades** are finalised with the exchange's realised PnL and commission; the journal shows market, fees and funding per row.
- **External positions** (anything opened outside the bot) are listed read-only: `managed: false`, excluded from margin, slots, equity maths and every stat. The executor only ever addresses orders tagged `VX<tradeId>…` with `reduceOnly`, so manual positions are unreachable.
- There is no manual asset/balance input anywhere in the UI or API.

## No simulation, ever

VelocityX contains **no synthetic data path**: no demo feed, no paper fills, no virtual balance, no seeded journals. When Binance is unreachable the dashboard says so (`binance-unreachable`), the engine waits with no candles, no signal is produced and no order is sent — the bot reconnects automatically and resumes on real data.

## Reliability notes

- Signals act **only on candles that close after engine/zone monitoring starts** — no backfill, no repainting and no retroactive execution when auto-trade is armed later.
- The Scanner page and `GET /api/execution/readiness` show the same backend gate enforced immediately before a real entry; the browser never decides whether an order is safe to send.
- Fill detection via the user stream (`ALGO_UPDATE` for stop/take-profit triggers, `ORDER_TRADE_UPDATE` for market orders) **plus** a 10 s REST reconciliation that asks Binance about each leg by client id — missed fills are caught, verifiably missing legs are re-armed with persisted recovery ids, and realised PnL/fees are re-read from Binance's own ledger (a triggered algo order becomes a separate engine order; it is found through the algo order's `actualOrderId`).
- Fills are idempotent: the same trigger can arrive over several channels and is booked once.
- The WebSocket layer rebuilds itself: a silent market socket is reconnected, a rejected `listenKey` keep-alive rebuilds the user stream with a fresh key, and every (re)connect triggers an immediate reconcile pass.
- SL replace failure ⇒ position is flattened immediately (never left unprotected). A vanished stop whose price the market has already crossed (it can no longer be re-armed) also closes the position at market.
- **Circuit breaker:** two entries in a row whose protective ladder could not be placed (each is flattened again, costing fees) — or any emergency close that Binance does not confirm — **disarm auto-trade** and say why in the activity feed. A protocol change at the exchange can therefore never turn every signal into a guaranteed loss; fix the cause, then re-arm.
- Up to **8 concurrent positions**, at most one per symbol; each symbol keeps its own signal guard, guard-rail price and SL/TP ladder.
- `botOwned` is stamped on every trade the executor opens; anything else on the account is reported as external and can never enter the journal, the PnL or the stats.

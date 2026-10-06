# ⚡ VelocityX

**Binance USD-M Futures bot with a 5-minute liquidity-sweep → volume-profile POC retest strategy.** The React dashboard, signal engine, executor and historical OHLCV backtester are included. Live/testnet order execution and backtesting are separate: the backtester never imports or calls the order executor.

```
Binance 5m candles ──► 30-bar liquidity sweep ──► locked approximate POC
                                                        │
                      later reclaim ──► later retest/rejection ──► market entry
                                                                          │
              structural sweep-wick stop ──► 1R / 2R / 3R / 4R / 5R ladder
                  20% / 20% / 20% / 20% / remainder; stop ratchets BE → 1R → 2R → 3R
                                                                          │
                         Binance testnet/live executor · separate no-orders backtest
```

## Strategy rules

All signal logic uses **completed 5-minute candles**. Defaults use the 30 candles immediately preceding the sweep candle for the prior high/low and locked profile reference.

1. A wick sweeps the prior 30-bar high or low and that same candle closes back inside the prior range. Ambiguous two-sided sweeps are ignored.
2. The profile point of control (POC) is calculated from those prior candles and stays locked for that setup.
3. Price must later close through the POC in the sweep direction (reclaim), then on a subsequent candle retest the POC within the configured ATR tolerance and reject it directionally. The entry signal is recorded at that closed candle; live execution submits a market order after the close.
4. The initial stop is beyond the sweep wick plus an ATR buffer. Setups are discarded on invalidation, expiry or excessive stop distance. Target prices are based on the confirmed exchange fill and the initial entry-to-stop risk distance (1R).

**POC limitation:** Binance public klines do not contain trade-level volume-at-price. This implementation uniformly spreads each completed candle's volume across its full high-low range and bins the estimates. It is an OHLCV approximation—not an exchange volume profile built from individual trades.

## Five-target exit ladder

| Target | Close | Stop after the fill |
|---|---:|---|
| TP1 · 1R | ~20% of original quantity | Breakeven |
| TP2 · 2R | ~20% of original quantity | 1R |
| TP3 · 3R | ~20% of original quantity | 2R |
| TP4 · 4R | ~20% of original quantity | 3R |
| TP5 · 5R | Remaining quantity | Trade complete |

Exchange lot-step and minimum-notional rules may make the four slices slightly different from exactly 20%; an entry is rejected if five valid exit legs cannot be placed. Trades already in the journal without the `LIQUIDITY_5R` plan keep their legacy three-target management until flat. A new opposite POC setup **does not reverse** an open bot position.

## Historical backtest (no orders)

Run from **Settings → Strategy & Backtest** or call the authenticated `POST /api/backtest/run` route with `symbol` and `days` (1–90). The route fetches public Binance USD-M 5m klines and calls a pure simulator; it never places Binance orders or writes the live trade journal. Optional controls are starting balance, risk percent (default 1%), fee rate (default 4 bps) and slippage (default 2 bps per fill).

The simulator uses next-candle-open entry with adverse slippage, fixed risk-based sizing, taker fees and conservative OHLC stop/target ordering. It does **not** model funding, liquidation, queue priority, market impact or exchange lot constraints; an end-of-data position is marked to market with an estimated exit fee. POC remains the OHLCV approximation above. Backtest results are historical simulations, not a profit forecast or guarantee. Do not infer profitability from the deterministic synthetic unit-test fixture.

## Execution and safety

| Guarantee | Enforcement |
|---|---|
| External/manual trades stay untouched | The bot manages only its own journalled position quantity; conditional exits are reduce-only or hedge-side-scoped and always use explicit quantities. |
| Existing same-symbol positions block entry | `positionRisk` is checked before every entry. |
| Duplicate entries are prevented | Per-symbol locks plus global reservations enforce one position per symbol and the hard cap of 8. |
| Entry readiness is server-enforced | Keys, exchange reachability, fresh market/user streams, account trade permission, engine heartbeat and scanner state are checked immediately before live execution. |
| Uncertain responses never resend blindly | Unique `VX<tradeId>` ids are queried to recover ambiguous entry/close results. |
| Failed protection does not leave a silent naked trade | The trade is persisted after entry, all five exit legs are placed and emergency flattening is requested if the protective ladder fails. |
| Missed fills and missing orders are reconciled | Every leg is checked by Binance client id; confirmed fills are booked, verifiably missing legs are re-armed, and unknown responses are never treated as gone. |
| Excessive exchange minimums do not silently multiply risk | Size increases are bounded; otherwise the entry is skipped. |

Every order used by the executor goes to the configured Binance environment: **testnet** is exchange Demo Trading, **live** uses real funds. The separate historical backtest is the only simulation mode and cannot execute trades.

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
npm run test:liquidity --prefix server # POC strategy, long/short signals, five-way ladder, synthetic simulation
npm run test:backtest-api --prefix server # authenticated route, mocked candle paging, journal/order isolation
npm run test:realtime --prefix server  # 95% budget, order rate, scanner gates, ownership guards
npm run test:api --prefix server    # boots the real server: token auth, live arming, kill, mode pinning, restart safety
npm run test:all --prefix server    # build + indicator, strategy/backtest route, execution, realtime, wire and API checks
npm run verify:binance --prefix server # real exchange: public REST + both market WebSockets (needs egress)
npm run preflight --prefix server   # YOUR keys on YOUR host: key/IP/canTrade, Algo endpoint, user-stream URL probe (sends no orders)
npm run smoke:ui --prefix client    # headless dashboard render (fixtures)
VX_API=http://localhost:4000 npm run smoke:ui --prefix client -- --live
```

### Modes (Settings → CONNECTION)

There is **no simulated order-execution mode**: TESTNET and LIVE both send orders to their configured Binance environment. The separate historical backtest uses public candles only and cannot submit orders.

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
5. **Demo session:** auto-trade ON in TESTNET for a full session — check 30-bar sweep → POC reclaim/retest entries, all five 1R–5R exits, stop moves (breakeven/1R/2R/3R), the Kill switch and P&L against the Binance demo UI.
6. **LIVE, small:** switch to LIVE (confirmation + `confirmLive`; it lands disarmed), set a conservative `tradeSizePercent`, arm as a separate step, and watch the first trade end-to-end (entry → stop + five take-profits under *Conditional Orders* → fills).
7. **Watch the activity feed** for `Protective ladder failed`, `could not cancel leftover conditional order`, `reconcile error` and `MARGIN_CALL`.

> ⚠️ Trading involves risk of loss. This software executes real orders when configured to do so. Test thoroughly; start small; the authors assume no liability.

---

## Project layout

```
server/src/
  index.ts        bootstrap: express + WS + engine + scanner + streams + account
  api.ts          REST endpoints (/api/*)
  ratelimit.ts    95%-of-Binance request budget, distributed over work areas
  scanner.ts      liquid-market selection and two-sided monitoring queue
  engine.ts       per-symbol closed-candle sweep/POC/retest signal engine
  liquidityStrategy.ts  fixed-range approximate POC and stateful sweep/retest rules
  liquidityBacktest.ts  pure OHLCV backtester (does not import order execution)
  trader.ts       multi-position state machine (≤8, one per symbol) + five-R ladder
  account.ts      Binance account/PnL/fees/funding attribution, external positions
  indicators.ts   EMA / ATR(Wilder) / ADX / crossover math (Pine-exact)
  binance.ts      market data (mainnet) + signed order API (testnet/live) incl. the Algo Service (conditional orders)
  streams.ts      market data over the two /public + /market sockets (managed as one) + user-data stream (ORDER_TRADE_UPDATE, ALGO_UPDATE, ACCOUNT_UPDATE)
  candles.ts      WS-first candle store (REST backfill only when needed)
  settings.ts     persisted scanner and liquidity-strategy settings
  store.ts        trade/signal persistence with legacy/new exit-plan migration
  stats.ts        rolling realized-journal metrics for all five targets
server/scripts/   strategy/backtest fixture, e2e executor, realtime/wire/API checks, preflight + exchange verification
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

`POST /api/backtest/run` fetches public 5m history and returns a no-orders simulation; it does not affect the live journal.

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
| **Dashboard** | Metrics deck: hero summary, realized P&L / win rate / expectancy / signal KPIs, open positions with the live five-R ladder, rolling journal stats, market-context MTF gauge, execution rules, scanner summary, engine health and activity feed. A red banner is shown while LIVE auto-trading is armed. |
| **Scanner** | Live market-batch progress, retained liquid-symbol monitor, execution-readiness bridge, activity ranking, scanner gates and dedicated two-sided 5m sweep monitor. |
| **Positions** | Binance account ledger, managed positions, **external positions listed read-only**, closed trades, fees, funding and risk rules. |
| **Trades** | Journal summary, full trade table, signal log and activity feed. |
| **Settings** | Connection / markets & sizing / scanner / strategy & historical backtest tabs, execution guardrails and motion switch. |

The large **BTCUSDT candlestick/EMA chart has been removed from the client**, including its navigation tab and chart-library dependency. The separate cumulative **P&L chart remains**: a sticky side rail on desktop and a collapsible bottom sheet on tablet/phone.

The dashboard starts with **Motion off** so it does not blink or pulse. Motion can be enabled explicitly from the header and remains subject to `prefers-reduced-motion`. Live values never trigger colour-flash animations; timestamp-aware state merging also prevents stale poll responses from painting over newer WebSocket/account data. Details: [DESIGN.md](DESIGN.md).

---

## Market scanner

Each cycle ranks the USD-M perpetual universe and analyses a bounded-parallel batch of **50 assets by default**:

1. `exchangeInfo` selects trading USDT perpetual contracts. Pegged/staked/wrapped/index products (USDC, FDUSD, BNSOL, WBETH, BTCDOM, etc.) are rejected.
2. 24h ticker/range/volume and 15m ATR qualify which markets are monitored. Eight bounded workers fetch 5m/15m/1h context; ranking is for monitor priority only.
3. Retained symbols stay on the realtime 5m engine while later market batches run. The engine evaluates **both LONG and SHORT** liquidity sweeps; neither ADX, EMA alignment, nor monitor score triggers an entry.
4. Auto-scan mode only executes a fresh closed-candle strategy signal from a currently retained symbol. Manual mode watches the primary symbol. Stale/missed signals are never replayed.

Scanner knobs live in **Settings → Scanner** (batch size, scan interval, volume/range/ATR thresholds, zone capacity and retention). Strategy lookback, POC bins, retest/stop tolerances and expiry live under **Settings → Strategy & Backtest**.

## Request budget — 95% of Binance, spread over the work areas

Binance allows 2400 weight/min per IP on USD-M Futures. VelocityX plans **2280/min (95%)** and distributes it:

| Area | Share | Weight/min | Work |
|---|---|---|---|
| scanner | 40 % | 912 | exchangeInfo, 24h tickers, funding, scanner klines |
| market | 25 % | 570 | candle backfill, MTF context, historical backtest, price polls |
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

## No synthetic live feed or paper orders

VelocityX has no synthetic market-feed, paper-fill or virtual-account mode. Live/testnet execution always targets the configured Binance environment. The separate historical backtest consumes public Binance OHLCV candles, reports its assumptions and cannot submit orders or alter the live journal; synthetic candles are confined to deterministic tests. When Binance is unreachable the dashboard says so (`binance-unreachable`), the engine waits with no candles, no signal is produced and no order is sent — the bot reconnects automatically and resumes on exchange data.

## Reliability notes

- Strategy state may be primed from prior completed 5m candles after a start/restart, but only a fresh POC-retest signal on a newly closed candle can be recorded/executed; stale signals are never replayed when auto-trade is armed later.
- The Scanner page and `GET /api/execution/readiness` show the same backend gate enforced immediately before a real entry; the browser never decides whether an order is safe to send.
- Fill detection via the user stream (`ALGO_UPDATE` for stop/take-profit triggers, `ORDER_TRADE_UPDATE` for market orders) **plus** a 10 s REST reconciliation that asks Binance about each leg by client id — missed fills are caught, verifiably missing legs are re-armed with persisted recovery ids, and realised PnL/fees are re-read from Binance's own ledger (a triggered algo order becomes a separate engine order; it is found through the algo order's `actualOrderId`).
- Fills are idempotent: the same trigger can arrive over several channels and is booked once.
- The WebSocket layer rebuilds itself: a silent market socket is reconnected, a rejected `listenKey` keep-alive rebuilds the user stream with a fresh key, and every (re)connect triggers an immediate reconcile pass.
- SL replace failure ⇒ position is flattened immediately (never left unprotected). A vanished stop whose price the market has already crossed (it can no longer be re-armed) also closes the position at market.
- **Circuit breaker:** two entries in a row whose protective ladder could not be placed (each is flattened again, costing fees) — or any emergency close that Binance does not confirm — **disarm auto-trade** and say why in the activity feed. A protocol change at the exchange can therefore never turn every signal into a guaranteed loss; fix the cause, then re-arm.
- Up to **8 concurrent positions**, at most one per symbol; each symbol keeps its own signal guard, guard-rail price and SL/TP ladder.
- `botOwned` is stamped on every trade the executor opens; anything else on the account is reported as external and can never enter the journal, the PnL or the stats.

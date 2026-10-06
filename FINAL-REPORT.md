# VelocityX — Final Confirmation Audit

**Date:** 2026-10-06 · **Scope:** the whole repository (server, client, scripts, docs) · **Supersedes** the 2026-10-05 report, whose
"ready for real orders" conclusion did not hold: its test-suite passed only because the stub exchange still accepted
stop/take-profit orders on an endpoint Binance has since closed, and its "zero orphan definitions" claim was wrong.

---

## 1. Verdict

**Conditional GO — but not "upload and run with real funds".**

Per Binance's published API changes (USDⓈ-M change-log of 2025-11-06 and the 2026-04-23 WebSocket notice), the code that was in the
repository would **not have worked on the real exchange**: every entry would have opened, failed to place its stop-loss, and been
flattened again (a guaranteed fee loss per signal), and the WebSocket feeds would never have connected, so no entry would even have started. Those blockers are fixed and tested against a protocol-faithful mock. What no sandbox can prove is that
the *live* Binance still behaves exactly as its documentation says, so the go-live path is: **preflight on your host → demo session → small live size** (§7).

Please do not skip the preflight: it takes seconds and answers the questions I could not (§6).

## 2. What was actually broken (all fixed)

| # | Blocker | Evidence | Fix |
|---|---|---|---|
| 1 | **Stop-loss / take-profit orders were rejected.** `STOP_MARKET` / `TAKE_PROFIT_MARKET` were sent to `POST /fapi/v1/order`; since **2025-12-09** Binance accepts them only through the Algo Service and answers `-4120 STOP_ORDER_SWITCH_ALGO`. | Binance USDⓈ-M change-log (2025-11-06 notice) | Whole conditional-order path rebuilt on `POST/DELETE/GET /fapi/v1/algoOrder`, `GET /fapi/v1/openAlgoOrders`, `ALGO_UPDATE` (§3) |
| 2 | **WebSockets could not connect.** The bot used the legacy `/stream` and `/ws/<listenKey>` roots, decommissioned on **2026-04-23**; the market/user readiness checks would stay false forever and block every entry. | Binance WebSocket change notice | Market data over `/public` + `/market` (two sockets managed as one); user stream over `/private` with URL-form (and testnet host) discovery |
| 3 | **A successful reply was treated as an error.** `request()` threw on *any* `code` field, but Binance answers `{"code":200,"msg":"success"}` to `marginType` (and `"code":"200"` to an algo cancel) — the first entry on every cross-margin symbol aborted. | the wire test fails when the old check is restored | Only a non-zero, non-200 code is an error |
| 4 | **Testnet no longer exists** at `testnet.binancefuture.com`; it is *Demo Trading* (`demo-fapi.binance.com`). | Binance docs / announcement | New defaults, env overrides, README/UI copy |
| 5 | **Process crash on re-subscribe.** Closing a market socket that was still CONNECTING made `ws` emit an unhandled `error`; `index.ts` turns any uncaught exception into a shutdown — plausible right after boot when the scanner changes the symbol set. | reproduced in the sandbox | Sockets are detached with a no-op error listener |
| 6 | **Reconcile loop re-entrancy / wrong-environment trades.** The 10 s loop had no guard (duplicate re-arms) and also processed trades opened in the *other* mode with the wrong keys/endpoint (could "close" a live trade's record). | code review + e2e | Re-entrancy + per-trade guards; other-mode trades skipped |

## 3. What changed

**Order path (`binance.ts`, `trader.ts`, `streams.ts`)**
- Stop and take-profit legs are exchange-side Algo orders (`algoType=CONDITIONAL`, `triggerPrice`, `clientAlgoId`, `reduceOnly` in one-way mode / `positionSide` in hedge mode, explicit quantity). `closePosition` and the cancel-everything endpoint are never used; only `VX…`-tagged ids are ever cancelled.
- Fills arrive via `ALGO_UPDATE` and are **double-checked by REST** every 10 s (`GET /fapi/v1/algoOrder` → `actualOrderId` → the engine order's real fill). A leg is re-armed only when Binance says it is *gone*; an unanswered lookup ("unknown") never re-arms. Fills are idempotent across WebSocket, REST and replayed frames.
- A lost POST response is resolved by client id (never repeated); stale `VX…` legs are swept before an entry and at close; a stop that vanished *and* was already crossed closes the position instead of leaving it naked; each take-profit re-arm is independent.
- Fees/PnL are read from Binance's ledger, including the engine orders spawned by triggered legs.
- Circuit breaker: two entries in a row that could not be protected, or any unconfirmed emergency close, **disarm auto-trade**.
- WebSocket layer: silent-socket watchdog, listenKey keep-alive failure rebuilds the stream, immediate reconcile on every (re)connect, rotation through documented URL forms, throttled error logging.
- Clock drift: offset measured at boot and every 5 min; `-1021` always resyncs.

**Hardening (`api.ts`, `auth.ts`, `settings.ts`, `store.ts`, `index.ts`)** — see §4 for the behavior changes this implies. Also: strict-boolean `autoTrade`, scan route rate-limited, `GET /positions` can no longer hang, rate limiter keyed on the socket address (not a forgeable header) with a bounded map, `deepMerge` skips prototype keys, the trade journal cap never drops an OPEN trade, shutdown force-exits after 10 s.

**Dead code removed** — `stopMarket()` (+ its `closePosition` branch), `cancelOrder()`, `openOrders()`, the legacy `marketStreamUrl()`, `TESTNET_*` constants, `ExchangeSymbol.minNotional` (mis-parsed *and* unused), `AccountSnapshot.crossWalletBalance` (read from a key that does not exist) and `openOrderInitialMargin`, `Trader.priceOf()/lastPrice()`, `AccountService.closedStats()/lastUserPushAt()/lastUserEventAt` and a no-op re-export, `CandleStore.lastClosed()/isFresh()`, `Engine.states()`, `ENDPOINT_WEIGHT.klines/openOrders`, the `AREA_DISTRIBUTION` alias, a literal no-op in the rate limiter, a back-compat `start()` shim and an unused import, the broken `userTrades`-by-clientOrderId entry-price lookup (those rows carry no client id), and a placeholder in a test. The client has none (strict unused-flags clean; `esbuild`/`jsdom` are used by the UI smoke test).

## 4. Behavior changes you should know about

| Change | Why |
|---|---|
| `POST /api/kill` **disarms auto-trade first**, then flattens | otherwise the next signal re-enters within minutes of an emergency stop |
| **LIVE auto-trading cannot be armed or resumed at boot unless `VX_API_TOKEN` is set** (or `VX_HOST` is loopback); the execution gate enforces it too | an open control API in front of live keys can change leverage/size, arm the bot, swap keys |
| Switching testnet ↔ live is refused (`409`) while a bot trade is open | the trade lives on the other environment's exchange and could no longer be monitored |
| The exchange minimum notional may raise a position at most to **2× the configured margin**; otherwise the entry is skipped (logged) | it used to round up silently, multiplying risk on small accounts |
| `autoTrade` / `enabled` must be real booleans (`"false"` is truthy!) | defence against arming by accident |
| Env-supplied keys are never copied into `settings.json`; empty file keys no longer erase env keys | a key rotated in `.env` was silently overridden by a stale file copy |
| Reconcile uses fewer request weights (≈6 vs 11 per open trade per pass) | no more `allOrders` + `openOrders` on every pass |

## 5. Verification evidence (this tree, 2026-10-06)

| Check | Result |
|---|---|
| `tsc --noEmit --noUnusedLocals --noUnusedParameters` — server and client | clean |
| `npm run build` (server `tsc` + client `vite build`) | OK |
| `smoke` — indicator maths vs. independent Python vectors | 35 checks |
| `test:e2e` — real order-shaping code vs. a stub that **behaves like Binance 2026** (`-4120` on `/order`, validated Algo endpoints, `-2021`, hedge/one-way rules, lost responses, flaky answers, missed frames…) | 141 checks |
| `test:wire` — the **real HTTP/WebSocket client** vs. local mock servers: HMAC signing, query parameters, error mapping, algo endpoints, user-stream URL rotation, key rotation, both market sockets, crash regressions | 68 checks |
| `test:realtime` — 95 % budget, order-rate, scanner gates, ownership guards | 79 checks |
| `test:api` — boots the real server (9 instances): token auth, live arming rules, kill, mode pinning, restart safety, settings hygiene | 83 checks |
| `smoke:ui` (headless dashboard) | 58 / 58 |
| Soak: real server with no egress (every call fails) for 28 s, then SIGTERM | no crash, honest `BLOCKED` readiness, retries with backoff, exit in 9 ms |
| **Mutation check:** 32 defects injected into the compiled output, one at a time | **31 caught**; the survivor is an equivalent mutant (a second redundant guard covers it) |

I deliberately attacked the tests as well as the code: every new guard above has a mutant that makes a named check fail, including re-introducing the original `request()` and WebSocket-crash bugs.

## 6. What I could NOT verify — and how to close it

This sandbox has **no network path to Binance**, so these rest on the published documentation and on mocks that follow it:

1. That the live/demo exchange accepts the exact `algoOrder` parameters (`algoType`, `triggerPrice`, `clientAlgoId`, `reduceOnly`/`positionSide`) and replies as documented.
2. **Which user-data WebSocket URL form and host your environment accepts.** Binance's docs show `/private/ws/<listenKey>` and `/private/ws?listenKey=…&events=…`; for demo trading two documents disagree on the host (`demo-fstream.binance.com` vs `fstream.binancefuture.com`). The bot tries them all, in order, and remembers the one that works.
3. Whether a triggered algo order's engine order keeps the `clientAlgoId` (the code never relies on it) and whether `ALGO_UPDATE.aq` is populated (if not, the REST reconcile books the fill instead).
4. Strategy profitability — not assessed; there is no backtest in the repo. Real money can be lost.

`npm run preflight --prefix server` answers 1–3 **from your host, with your keys, without sending any order** (key/IP/`canTrade`, one-way vs hedge, the Algo endpoint, every user-stream URL form against a real listenKey, both market sockets). Add `-- --algo-roundtrip` to place and immediately cancel one far-from-market conditional order — it proves item 1 end-to-end (run it on the demo environment first).

Known limitation: a take-profit leg that was cancelled externally *and* whose price the market has already crossed cannot be re-armed (`-2021`); it is logged every 10 s and the stop keeps protecting the position.

## 7. Go-live checklist

1. **Build on the host** (`dist/`, `node_modules/`, `server/data/` and `.env` are git-ignored): `npm install --prefix server && npm install --prefix client && npm run build`. Run under a supervisor (systemd `Restart=always`, pm2, Docker `restart: always`) — an uncaught exception exits the process; protective orders stay armed on the exchange and the reconcile loop re-protects on restart.
2. **Binance key:** Futures enabled, **withdrawals disabled**, **IP-restricted** to the server. A symbol that already holds a position is never traded by the bot.
3. **Environment:** `VX_API_TOKEN=<long random>` (required for LIVE), `BINANCE_LIVE_KEY/SECRET`, `BINANCE_MODE`. `VX_ALLOW_LIVE=1` **only** if a restart should resume armed LIVE trading (unset = every restart comes back disarmed).
4. **Preflight:** `BINANCE_MODE=testnet npm run preflight --prefix server -- --algo-roundtrip` → must end `PREFLIGHT: ALL CHECKS PASSED`; then the read-only run with `BINANCE_MODE=live`.
5. **Demo session:** auto-trade ON in TESTNET for a full session; confirm entry, the stop and three take-profits resting under *Conditional Orders* in the Binance UI, TP1 → breakeven, TP2 → stop at TP1, TP3, the Kill switch.
6. **LIVE, small:** switch to LIVE (confirmation; it lands disarmed), set a small `tradeSizePercent`, arm, and watch the first trade from entry to exit.
7. Watch the activity feed for `Protective ladder failed`, `AUTO-TRADE DISARMED`, `could not cancel leftover conditional order`, `reconcile error`, `MARGIN_CALL`.

## 8. Notes

- Nothing was committed or pushed; the changes are in the working tree of branch `arena/89cabb3b-velocityx`.
- The 2400/min weight assumption is the default VIP-0 IP limit (`server/src/ratelimit.ts` is the one place to change it).
- The dashboard is single-operator (one shared token): put it behind a VPN or an authenticating reverse proxy if exposed.

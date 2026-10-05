# VelocityX — Real-Trade Readiness & Dead-Code Audit

**Date:** 2026-10-05 · **Branch:** `arena/ae918cd1-velocityx` · **Base:** `4dd27ec`
**Scope:** remove every simulated data path, make the execution stack production-ready for real orders, audit the whole tree for dead code and bugs, and verify the result end-to-end.

---

## 1. Executive summary

VelocityX is now a **real-trade-only** Binance USD-M Futures execution system:

- **No simulation lives in the product.** There is no synthetic/demo price feed, no paper fill engine, no virtual balance, no seeded journal and no fallback that invents numbers. Every price, fill, fee, funding payment, equity value and PnL figure comes from Binance (mainnet market data; testnet or live mainnet for orders and account state).
- **When Binance is unreachable nothing is fabricated.** The feed is reported as `binance-unreachable`, the engine holds no candles, no signal fires, no order is sent, and the dashboard says so. The server reconnects on its own and resumes on real data.
- **Modes are `testnet | live`.** Testnet is Binance's own exchange environment (real API, real order shapes, test funds) — the rehearsal ground before mainnet. Live is real money. A stale `BINANCE_MODE=paper` or `mode: 'paper'` request is rejected (`400`), and legacy persisted configs are migrated.
- **Live can never be entered or resumed by accident.** LIVE needs an explicit UI confirmation → `confirmLive: true` → the server forces auto-trading **OFF** on entry; arming is a second deliberate action; and a restart of a persisted LIVE + armed config boots **disarmed** unless `VX_ALLOW_LIVE=1` is set.
- **The full verification suite is green** — indicator vectors, execution E2E on the real order-shaping path, realtime invariants, API hardening, UI smoke (54/54) and the Binance reachability probe — plus strict type-checks and production builds on both sides.

---

## 2. What was removed (simulation, data by data)

| Simulated path | Where it lived | What replaced it |
| --- | --- | --- |
| Synthetic regime-switching candle feed (10× clock) | `server/src/offline.ts` (263 lines) + hooks in `binance.ts`, `engine.ts`, `streams.ts`, `index.ts`, `account.ts`, `api.ts` | File deleted. No feed → no candles, no signals, no orders; `feed: 'binance-unreachable'` is surfaced in `/api/health`, `/api/diagnostics` and the UI |
| Paper mode (simulated fills on live prices) | `settings.ts` (`Mode`), `trader.ts` (`checkPaperFills`, paper branches everywhere), `store.ts` (`paper.json`, balances), `account.ts` (`paper-sim` equity), client mode selector | Removed. `Mode = 'testnet' \| 'live'`; `PAPER_START_BALANCE`, `feeRate`, `get/set/adjustPaperBalance`, `resetPaper`, `usedPaperBalance` are gone; legacy keys are stripped by the settings sanitizer |
| Virtual starting balance in the P&L model | `client/src/pnl.ts` `fallbackBase: 1000` | Removed. The curve is anchored to Binance account equity when reported, otherwise to **cumulative realised PnL only**; the dock states which of the two is on screen |
| `demoFeedAllowed` / `offline-demo` feed states | `api.ts`, `types.ts`, `Header`, `Overview`, `PositionsView`, `SettingsView` | Removed; feed is `binance` or `binance-unreachable` |
| Demo fixtures presented as real in tests | `server/scripts/e2e-paper.js`, `verify-realtime.js`, `verify-api.js`, `verify-binance.js`, `client/scripts/ui-smoke.mjs` | `e2e-paper.js` deleted → new `e2e-execution.js` drives the **real order-shaping code** against a stubbed exchange; the other harnesses were rewritten to assert the no-simulation contract (e.g. verify-binance now proves the board stays empty and honest without egress) |
| "Enter your balance" style copy / manual asset input | client views | Removed; `ui-smoke.mjs` asserts no `paper`/`demo feed`/`offline demo`/`simulated mode` text and no manual-equity input |

`VX_OFFLINE_DEMO` no longer exists in the codebase or in `.env.example`.

---

## 3. Bugs found & fixed

| # | Bug | Fix |
| --- | --- | --- |
| 1 | Hedge-mode TP legs sent `reduceOnly` (Binance rejects it in hedge mode) | `takeProfitMarket()` detects dual-side mode and switches between `reduceOnly` (one-way) and `positionSide` (hedge); the ladder passes the trade's own side. Covered by a new hedge-mode E2E section |
| 2 | `createListenKey` / keep-alive could hang forever on a stalled connection | `AbortSignal.timeout(10_000)` on both requests; the user-data stream can always retry |
| 3 | `verify-realtime.js` hung: the first `trader.kill()` of section 7 ran **before** the exchange stubs were installed, hitting the unstubbed order path whose promise never settled | Stub installation (and the testnet settings switch) moved above the first live-path call; the KILL close is classified as `kind:'market-close'` so the entry invariant stays strict |
| 4 | The client P&L model invented a 1000 USDT base when Binance equity was missing | Virtual base removed; null equity is handled explicitly with truthful copy (`realised + live unrealised · account equity pending`) |
| 5 | `e2e-execution.js` hedge assertions could match stale orders from earlier sections | Assertions scope to the trade's own `VX<tradeId>` client-order-id prefix |
| 6 | `verify-binance.js` reported false failures when the host cannot egress to Binance (status/scanner/WS checks) | Without egress the script now skips exchange-data checks and instead asserts the empty-but-truthful behaviour (feed `binance-unreachable`, 0 scanner rows, WS hub alive but no fabricated ticks) |
| 7 | `verify-api.js` still expected a paper fallback on boot | Now asserts a persisted LIVE config boots **LIVE but disarmed** without `VX_ALLOW_LIVE`, and that `mode:'paper'` is rejected with `testnet \| live` |
| 8 | The UI smoke asserted the real-money banner was absent even against a server legitimately running on mainnet | The check is now environment-aware: the `LIVE MONEY` banner is **required** whenever `/api/status` reports `mode: live` (armed or disarmed) and forbidden on testnet |
| 9 | Engine logged `candles … fetch failed` on every 2 s tick during an exchange outage | Throttled to once/60 s per symbol; the reachability flip itself is still logged immediately by `binance.ts` |

Earlier hardening retained and re-verified: duplicate-entry guard, external-position ownership guard, `canTrade=false` abort, leverage clamp to the symbol bracket, WS reconnect on token change, 401 → "enter the API token" copy, JSON 404s for removed endpoints, capped scanner payloads, atomic `0600` settings writes, corrupt-journal quarantine, and graceful SIGTERM with exchange-side stops left armed.

---

## 4. Real-money safety chain (verified)

1. Switching to LIVE requires the UI confirmation, echoed as `confirmLive: true` — otherwise `400`.
2. Entering LIVE always lands `autoTrade: false`, whatever the request body said.
3. Enabling auto-trading while LIVE is a separate `POST /api/autotrade` that again requires `confirmLive: true`.
4. A restart never resumes arming silently: persisted LIVE + auto-trade boots disarmed unless `VX_ALLOW_LIVE=1`.
5. Entries are refused on a symbol that already carries an external/manual position (ambiguous `reduceOnly`).
6. `canTrade=false` blocks entries; leverage is clamped to `api.maxLeverage(symbol)`.
7. Every order carries a `VX<tradeId>…` client order id; protective stops are explicit-size `reduceOnly` (one-way) or `positionSide`-scoped (hedge), never `closePosition:true`.
8. The Kill switch flattens **bot-owned** positions only; external positions are listed read-only and can never enter the journal, PnL or stats.
9. `VX_API_TOKEN` gates every REST route (except `/api/health`) and the WebSocket upgrade; keys are masked, stored `0600` and never returned in clear text.
10. When the exchange is unreachable there is no trading and no invented data.

---

## 5. Verification evidence

All commands executed on this tree:

| Command | Result |
| --- | --- |
| `tsc --noEmit --noUnusedLocals --noUnusedParameters` (server + client) | clean, both sides |
| `npm run build` (root: server `tsc` + client `vite build`) | OK — `dist/index.html` 2.69 kB, CSS 58.06 kB (gzip 12.35), JS 268.58 kB (gzip 78.54), 52 modules |
| `npm test --prefix server` | **ALL TESTS PASSED** — EMA/ATR/ADX vectors vs. an independent Python reference, signal logic, ladder splits |
| `npm run test:e2e --prefix server` | **E2E: ALL TESTS PASSED** — real order shaping against a stub exchange: ladder placement, TP1/TP2/TP3, breakeven, reverse, kill, 8-position cap, hedge mode, ownership guards |
| `npm run test:realtime --prefix server` | **REALTIME INVARIANTS: ALL CHECKS PASSED** — 95 % (2280/min) weight budget split over 5 areas, order budget 1140/min + 285/10 s, pegged-symbol rejection, ADX gates, volatility ranking, external positions never touched, live-entry production guards |
| `npm run test:api --prefix server` | **API HARDENING: ALL CHECKS PASSED** — token on REST + WS, JSON 404s, live-arming rules, masked secrets, SIGTERM exit, persisted LIVE is not resumed by a restart |
| `npm run smoke:ui --prefix client` | **54/54 checks passed** (deterministic fixtures) and against the running server (data-dependent checks skip when the account has nothing open) |
| `npm run verify:binance --prefix server` (and `-- --server` against a live boot) | **ALL CHECKS PASSED** — without egress it reports `binance-unreachable`, 0 invented rows and exits 0; with the server running it also proves the WS hub is alive without fabricating ticks |

---

## 6. Dead-code audit

- **Server:** `offline.ts` (263 lines) deleted with all its hooks; paper-mode branches removed from `trader.ts` (−387/+… net deletion across the file), `account.ts`, `store.ts`, `settings.ts`, `events`/feed helpers. Every remaining export is referenced (server + scripts cross-checked).
- **Client:** no unused exports/locals under `--noUnusedLocals --noUnusedParameters`; CSS scan found zero unreferenced selectors after removing the dead `.badge-mode.warn` rule (two false positives were data-URI/comment matches).
- **Scripts:** `e2e-paper.js` deleted; `verify-*.js` updated so none of them rely on a simulated feed.
- **Repo hygiene:** no `TODO`/`FIXME`/`debugger`/stray `console.debug` in `server/src`, `client/src` or the scripts.

---

## 7. Going live — operator checklist

```bash
cp .env.example .env
VX_API_TOKEN=<long random string>      # locks REST + WS
# VX_ALLOW_LIVE=1                      # only if a restart should resume armed LIVE
BINANCE_MODE=testnet                   # prove the loop on testnet first
npm install && npm run build && npm start
```

1. Add IP-restricted Binance Futures keys (Futures enabled) in **Settings → Connection** or via env.
2. Run **TESTNET** with auto-trading for a full session; verify entries, the TP/SL ladder, the breakeven move, Kill switch and the P&L figures against the Binance testnet app.
3. Switch to **LIVE** (confirmation + `confirmLive`) — the bot lands **disarmed**.
4. Arm auto-trading as a separate, deliberate action. Start with a small `tradeSizePercent`.
5. Consider `VX_ALLOW_LIVE` **unset** so restarts always come back disarmed.

---

## 8. Known limitations & notes

- `verify:binance` needs egress to `fapi.binance.com` for the exchange-data checks; sandboxed hosts get the honest offline report and exit 0.
- The dashboard is single-operator: the API token is one shared secret. Put it behind a VPN/Tailscale or an authenticating reverse proxy if exposed publicly.
- The 2400/min Binance weight assumption matches the default VIP-0 IP limit (`server/src/ratelimit.ts` is the single place to change it).
- A manual position on a symbol disqualifies that symbol for the bot until it is flat; external positions are never adopted or closed.

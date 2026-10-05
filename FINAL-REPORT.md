# VelocityX — Full-Code Audit & Production-Readiness Report

**Date:** 2026-10-05 · **Branch:** `arena/5a6ef675-velocityx` · **Base:** `bb3d6dd`
**Scope:** complete audit of the server (execution, risk, exchange I/O) and the client (dashboard UI/UX), dead-code removal, bug fixes, real-money hardening, verification.

---

## 1. Executive summary

VelocityX was already a working paper/testnet bot; it is now a **production-ready, live-trading-capable** Binance USD-M Futures execution system, with the real-money path defended at every layer:

- **LIVE can never be entered by accident.** It takes an explicit UI confirmation → `confirmLive: true` on the API → and the server *forces auto-trading OFF* while entering LIVE. Arming execution is a second, deliberate action (`POST /api/autotrade` with `confirmLive: true`), and disarming never needs confirmation.
- **A restart never resumes real trading silently.** A persisted `live` config boots as PAPER with auto-trade OFF unless `VX_ALLOW_LIVE=1` is set, and says so in the log + activity feed.
- **The API that can place orders is locked.** `VX_API_TOKEN` gates every REST route (incl. the WebSocket upgrade) with a timing-safe compare; only `/api/health` stays public for process supervisors. Mutating routes are rate-limited per IP, secrets are write-only/`0600`/masked, and rate-limit weights are split into five independent areas within a 95 % budget.
- **Orders can only touch bot-owned positions.** Entries refuse symbols that already carry a position, every protective stop is explicit-size + `reduceOnly`, closes are tagged with the bot's own client order IDs, and the Kill switch flattens bot positions only.
- **The full test suite is green** — 6 verification programs (indicator vectors, paper E2E, realtime invariants, API hardening, UI smoke, Binance path) plus type-checks and builds.

In the same pass the codebase was **de-screened** (the abandoned screener UI/API was removed), dead code was deleted on both sides (246 deleted CSS lines and 4 orphan keyframes, 0 unreferenced selectors left), the paper fill model was made gap-honest, and the position ladder gained live progress bars.

---

## 2. What was audited

| Area | Files |
| --- | --- |
| Server | `index.ts`, `api.ts`, `auth.ts`, `settings.ts`, `store.ts`, `engine.ts`, `trader.ts`, `scanner.ts`, `indicators.ts`, `binance.ts`, `account.ts`, `stats.ts`, `streams.ts`, `broadcast.ts`, `candles.ts`, `prices.ts`, `ratelimit.ts`, `offline.ts` |
| Server scripts | `smoke.js`, `e2e-paper.js`, `verify-realtime.js`, `verify-api.js`, `verify-binance.js`, `gen-reference.py` |
| Client | `App.tsx`, `api.ts`, `ws.ts`, `types.ts`, `pnl.ts`, `hooks/motion.ts`, all `components/`, `views/`, `motion/`, `styles/` |
| Tooling | Vite/TS config, `ui-smoke.mjs` (53 DOM assertions), package scripts, README/DESIGN |

Every source file was read end-to-end; every exported symbol was cross-checked against its consumers (including the test scripts); all six stylesheets were scanned for selectors that no longer render.

---

## 3. Real-money safety (the core of "production ready")

### 3.1 Arming ladder (defence in depth)

| Step | Where | What it guarantees |
| --- | --- | --- |
| 1 | Client confirm | Switching to LIVE asks for confirmation in Settings and in the header auto-trade switch. |
| 2 | `POST /api/settings` | `mode: 'live'` without `confirmLive: true` → `400`, mode unchanged. |
| 3 | Server | **Entering LIVE always lands `autoTrade: false`**, whatever the body asked for. The UI shows “LIVE armed — auto-trading is OFF”. |
| 4 | `POST /api/autotrade` | Enabling auto-trade while LIVE needs its own `confirmLive: true`. |
| 5 | Boot | `mode: live` persisted without `VX_ALLOW_LIVE=1` → boots PAPER, auto-trade OFF, `VX_ALLOW_LIVE` warning logged. |
| 6 | Symbols | Live/testnet entries are refused when the market already carries a non-bot position. |
| 7 | Exchange | `canTrade=false` blocks entries; requested leverage is clamped to the symbol's bracket. |

### 3.2 Order safety

- Protective stops are **explicit size + `reduceOnly`** (never `closePosition:true`), so a stop can only shrink the bot's own position and stays armed on the exchange across restarts/shutdowns.
- Entry/close/TP/SL orders carry deterministic `VX<tradeId>…` client order IDs; ownership is re-derived from the journal, not assumed.
- Duplicate/retried signals can't double-open: one entry round-trip per symbol at a time.
- Kill switch closes **bot-owned positions only**, at market, and is journaled.

### 3.3 API surface

- Token auth (`X-VX-Token` for REST, `?token=` for WS) with timing-safe comparison; loud boot warning if unset.
- `/api/health` is public and deliberately tiny (supervisors); everything else is 404-JSON for unknown paths (never the SPA shell, never a stub).
- Per-IP rate limits on state-changing routes (60/min, burst 20).
- Binance weight scheduler: 2280/min (95 % of 2400) split across scanner / market / account / orders / stream areas with per-area caps and telemetry at `/api/limits`.

### 3.4 Data integrity

- Corrupt journals/settings are **quarantined** (`*.corrupt-<ts>`), never silently dropped.
- `settings.json` is written atomically with mode `0600`; API keys never leave the server in clear text (masked in every response).
- Graceful SIGTERM: feeds stop, pending work drains, **exchange-side SL/TP stay armed**, and the shutdown path logs how many positions remain protected.

---

## 4. Bugs fixed

| # | Bug | Fix |
| --- | --- | --- |
| 1 | Paper TP/SL fills booked at the *level price* — unrealistically precise PnL | Fills now book the observed market tick (gap-through realism); stop fills clamp to `min/max(stop, market)` |
| 2 | Paper entries never charged commission | Entry taker fee is booked like Binance's fee model (`fees` + realised PnL + balance) |
| 3 | A duplicated signal could open two positions on one symbol | `entering` guard: one entry round-trip per symbol at a time |
| 4 | Live entries could be attempted on a symbol with an existing manual position | Ownership guard refuses the market (ambiguous reduceOnly ladder) |
| 5 | `canTrade=false` keys were used anyway | Entry aborts with a clear executor error |
| 6 | Leverage above the exchange bracket failed the whole entry | Auto-clamp to `api.maxLeverage(symbol)` with a log line |
| 7 | WebSocket reconnect after a token change kept the old socket/token | `reconnect()` re-opens with the current token; Settings → Connection triggers it |
| 8 | 401 responses surfaced as raw “HTTP 401” | Client maps them to “Unauthorised — enter the API token in Settings → Connection” |
| 9 | The header auto-trade switch could arm LIVE without confirmation | Confirmation dialog + `confirmLive` echo; server-side arming rules above |
| 10 | `/api/chart` (dead) returned the SPA shell | All removed endpoints now answer JSON 404 |
| 11 | Scanner payload could be unbounded | `?limit` capped at 80 rows |
| 12 | `verify-binance.js` indentation/consistency | Fixed; script still never pretends the feed is live when egress is absent |

---

## 5. Dead code removed

**Client**

- `components/PositionCard.tsx` — deleted (superseded by the managed/external book split).
- Screener surface: `ScreenerGrid`/`ScreenerPanel`, the `/api/screener` fetch + `ScreenerData` state, `ScreenerData`/`Diagnostics` types.
- 7 never-rendered icons (`IconArrowUp`, `IconArrowDown`, `IconChevron`, `IconClose`, `IconGrid`, `IconPause`, `IconPlay`), the unused `Mini` primitive, unused `PnlChart` locals, `wsConnected`, `Panels.tsx` leftovers.
- **CSS:** 36 unused selectors across all six stylesheets (`.sr-only`, `.hint.err`, `.scroll-x`, `.num`/`.mono`, `.glass-sm` + pseudo-elements, `.panel-body.tight`, `.skel` + shimmer, `.liquid-div`, `.glow-ring` + pseudo-element, `.anim-*`, `.d1`–`.d6`, `.shimmer-line`, `.grid-3`, `.grid-auto`, `.span-2`, `.trend`, `.t-cyan`/`.t-green`/`.t-red`/`.t-amber`/`.t-violet`, `.kpi-delta`, `.pnl-mini .mini-spark`, tone-amber KPI variants) **plus 4 orphan `@keyframes`** (`slide-in-right`, `ring-sweep`, `bar-grow`, `candle-breathe`). CSS bundle: 61.87 kB → **58.25 kB**; 246 deletion lines vs 16 insertions across the six sheets (the insertions are the new ladder-progress styling).

**Server**

- `indicators.screenerState()` (only consumer was the removed screener).
- Dead `intentionalCancel` reconciliation suppression and `closePosition:true` stop path replaced by the explicit-size `protectiveStop`; `remainingQtyOf`/ownership helpers consolidated.

**Verification of the sweep:** 0 exported symbols unused (client + server, incl. scripts), 0 orphan modules, 0 unreferenced CSS selectors, no `TODO/FIXME`, no stray debug logging.

---

## 6. UI/UX improvements

- **Position ladder progress bars.** Each SL/TP rung now shows how far price has travelled from entry toward that level, computed from the live mark price (`progressTo`), with a wet-glass sheen; hit rungs fill 100 %. The breakeven stop turns amber (`lvl-be`) once the SL is moved to BE, matching the existing design system.
- **LIVE banner** (`role="alert"`): red and explicit while LIVE auto-trading is armed, amber when LIVE but disarmed (with the exact Kill-switch consequences spelled out).
- **MTF gauge panel** (new `MtfPanel.tsx`): gradient arc + needle rotated by the bullish share of the 5m/15m/30m ribbon, `tf-chip` rows, ATR hint.
- **Execution Rules panel** on Overview: entry, SL, TP1–3, opposite-signal handling, sizing, ownership — visible in one glance.
- **API token field** in Settings → Connection (localStorage only, never sent anywhere else) with “Token saved — reconnecting”.
- Truthful feed banners (live / unreachable / offline-demo), scanner-only marquee, and copy that states the bot never adopts or closes external positions.

---

## 7. Verification evidence

All commands executed on the final tree:

| Command | Result |
| --- | --- |
| `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` (client + server) | clean |
| `npm run build` | client built (html 2.69 kB, css 58.25 kB, js 269.59 kB) |
| `npm test --prefix server` | **ALL TESTS PASSED** (indicator vectors vs. independent Python reference, signal logic, TP ladder splits) |
| `npm run test:e2e --prefix server` | **E2E: ALL TESTS PASSED** — 8-position cap, TP1/TP2/TP3, breakeven, reverse, kill; final paper balance 997.54 USDT |
| `npm run test:realtime --prefix server` | **REALTIME INVARIANTS: ALL CHECKS PASSED** — weight budget/areas, order rate, scanner gates/pegged rejection, ownership guards |
| `npm run test:api --prefix server` | **API HARDENING: ALL CHECKS PASSED** — token on REST+WS, 401s, JSON 404s, live-arming rules incl. force-disarm, masked secrets, SIGTERM exit, persisted-live downgrade |
| `npm run smoke:ui --prefix client` | **53/53 checks passed** (fixtures) and **53/53** live against the running server |
| `npm run verify:binance --prefix server` | **ALL CHECKS PASSED** (skips exchange probes without egress — by design, never fakes a live feed) |

The UI smoke suite asserts the visual contract, including: 4 KPI pods, 3 stat rings, ≥5 hit-rate bars, 4 PnL-dock segments, 5 PnL stats, 5 nav segments, MTF gauge fill, ≥3 timeframe chips, Execution Rules text, no LIVE banner in paper, API-token field, ladder fills with valid widths, no `NaN/Infinity`, no `/api/chart` request.

---

## 8. Going live — operator checklist

```bash
cp .env.example .env                 # then edit
VX_API_TOKEN=<long random string>    # required: locks REST + WS
VX_ALLOW_LIVE=1                      # only when you intend to resume LIVE after restarts
BINANCE_MODE=testnet                 # prove the loop on testnet first, then switch to live in the UI
npm run build && npm start
```

1. Add IP-restricted Binance Futures keys (futures enabled) in **Settings → Connection** or via env.
2. Run **TESTNET** with auto-trading for a full session; confirm entries, TP/SL ladder, breakeven move, Kill switch.
3. Enter the API token in the dashboard if you set `VX_API_TOKEN` (otherwise the API is open — the boot log warns loudly).
4. Switch to **LIVE** (confirmation + `confirmLive`) — the bot lands **disarmed**.
5. Enable auto-trading as a separate, deliberate action.
6. Keep `VX_ALLOW_LIVE` unset if you want a restart to fall back to PAPER.

---

## 9. Known limitations & operational notes

- `verify:binance` needs egress to `fapi.binance.com`; in sandboxed/offline hosts it reports that and exits 0. The labelled `VX_OFFLINE_DEMO=1` feed is for demos only.
- The dashboard is single-operator: token auth is a shared secret, not per-user accounts. Put it behind a VPN/Tailscale or an authenticating reverse proxy if exposed publicly.
- Binance endpoint weight budget assumes the default 2400/min IP limit (VIP tiers can raise it; `ratelimit.ts` is the single place to change).
- No automated exchange-side reconciliation beyond the ownership/stop guards described; a manual position on a symbol permanently disqualifies that symbol until it is flat.

---

## 10. Change inventory

40 files modified, 1 deleted, 6 added (before this report):

- **Server:** `api.ts` (public health, `confirmLive`, force-disarm on LIVE, JSON 404s, rate limits), `auth.ts` (new), `index.ts` (`VX_ALLOW_LIVE` downgrade, shutdown), `trader.ts` (ownership gates, canTrade/leverage guards, duplicate-entry guard, gap-honest fills, entry fees, explicit-qty stops), `store.ts` (quarantine, `remainingQtyOf`), `settings.ts` (atomic `0600` write, mode validation), `binance.ts`, `ratelimit.ts` (areas), `broadcast.ts` (token-gated WS), `account.ts`, `engine.ts`, `scanner.ts`, `candles.ts`, `prices.ts`, `indicators.ts`, plus `scripts/verify-api.js` (new), `scripts/fixtures/` + `gen-reference.py` (new).
- **Client:** `App.tsx`, `api.ts`, `ws.ts`, `types.ts`, `views/Overview.tsx`, `components/{MtfPanel(new),SettingsPanel,Positions,Panels,PnlChart}`, `motion/{Icons,primitives}`, six stylesheets, `index.html`, `scripts/ui-smoke.mjs`.
- **Docs:** `README.md` (production safety, env vars, ownership guarantees), `DESIGN.md` (hardening UI contract), `.env.example` (new), this report.

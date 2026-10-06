# VelocityX — strategy-free exchange monitor

VelocityX is a read-only Binance USDⓈ-M market and account dashboard. The previous trading strategy and its connected execution rules have been removed. **This repository does not generate signals, place orders, manage positions, or substitute a new strategy.** The operator will provide the next strategy separately.

## Important: existing exchange positions

This build does not close, cancel, monitor, reconcile, or restore orders for positions opened by an earlier version. Exchange-side conditional orders are left untouched. If the old bot has any open positions, review and manage both the positions and their orders directly in Binance before relying on this build. The old local trade journal is retained as a strategy-neutral archive; open journal records are visibly marked as archival/manual-review items.

## What remains

- Public Binance market price and 5-minute candle data for one selected symbol.
- Read-only Binance account, position, balance and income snapshots when account credentials are configured.
- A small dashboard with exchange connectivity, positions, account values, activity messages, settings and a neutral trade archive.
- Token-protected REST and WebSocket access through `VX_API_TOKEN`.
- Settings and trade-journal migration that removes obsolete strategy parameters and target/stop/order metadata without deleting archived trade history or exchange orders.

There is no scanner, signal engine, auto-trade switch, entry/exit algorithm, sizing rule, target/stop rule, backtester, order-placement API, close/kill API, or order-writing client in this build. Old strategy routes return JSON 404s.

## Requirements and start

Node.js 20+ is recommended.

```bash
npm install --prefix server
npm install --prefix client
npm run build
npm start                 # http://localhost:4000
```

For development, run `npm run dev:server` and `npm run dev:client` in separate terminals. Vite proxies `/api` and `/ws` to the server.

Build output, dependencies, private settings and journals are ignored by Git. Build on the machine that runs VelocityX. The server stores data in `server/data` by default; set `VX_DATA_DIR` to move it.

## Configuration

Copy `.env.example` to `.env` if you use environment variables. Dashboard settings are also available.

```dotenv
PORT=4000
VX_HOST=0.0.0.0
VX_API_TOKEN=use-a-long-random-token
BINANCE_MODE=testnet
BINANCE_SYMBOL=BTCUSDT
BINANCE_TESTNET_KEY=
BINANCE_TESTNET_SECRET=
BINANCE_LIVE_KEY=
BINANCE_LIVE_SECRET=
```

- `BINANCE_MODE=testnet` selects Binance Demo Trading account data. `live` selects real-account data; switching to LIVE in the dashboard requires explicit confirmation.
- Public market data is sourced from Binance mainnet in either account mode.
- Credentials are used only for signed account reads and the account WebSocket. They are masked in API responses. Environment-supplied credentials are not copied into `settings.json`.
- `VX_API_TOKEN` protects all `/api` routes except `/api/health`, and the `/ws` socket. Enter it in the dashboard's Settings page; the browser stores it locally.
- Never enable withdrawal permission for an API key. Prefer read-only account permissions and IP restrictions.

## Read-only API

All routes except `/api/health` require `X-VX-Token` when `VX_API_TOKEN` is set.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Process liveness |
| GET | `/api/status` | Combined market, account and stream status |
| GET | `/api/settings` | Masked connection settings |
| POST | `/api/settings` | Update mode, display symbol or credentials |
| GET | `/api/account` | Binance account snapshot and income summary |
| GET | `/api/positions` | Exchange-reported open positions and legacy journal notices |
| GET | `/api/trades` | Strategy-neutral trade archive |
| GET | `/api/logs` | Recent server activity |
| GET | `/api/income` | Binance income history summary |
| GET | `/api/limits` | Read-request budget and exchange telemetry |
| GET | `/api/diagnostics` | Read-only connectivity diagnostics |

No endpoint submits or cancels exchange orders. Requests to removed strategy, scanner, signal, backtest, close, kill, or auto-trade routes return 404.

## Checks

```bash
npm test --prefix server
npm run test:api --prefix server
npm run test:wire --prefix server
npm run build --prefix client
npm run smoke:ui --prefix client
```

The server tests use isolated data directories and local mocks; they do not require Binance credentials or submit orders. `verify:binance` is an optional live read-only connectivity check and requires network access. Never run old releases or old test scripts that still contain the removed order-writing code against a real account.

## Strategy handoff

The dashboard and service are intentionally left without a trading strategy. No new entry, exit, sizing, risk, or market-selection behavior has been designed. Provide the new strategy when ready; it can then be implemented against this clean read-only baseline.

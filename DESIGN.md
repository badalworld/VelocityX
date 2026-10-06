# Architecture — read-only baseline

## Process shape

- **Server (`server/src`)** — Express REST API, a WebSocket broadcast hub, public market data, read-only signed Binance account reads, and small file-backed settings/trade archive.
- **Client (`client/src`)** — React dashboard for market status, account values, open exchange positions, archive records and connection settings.
- **No execution layer** — strategy, signals, scanner, sizing, order writing, conditional-order management, position reconciliation and backtesting are absent.

## Server modules

| Module | Responsibility |
|---|---|
| `index.ts` | Server bootstrap, market/account streams and shutdown |
| `api.ts` | Read-only dashboard routes and connection settings |
| `auth.ts` | Optional dashboard token and settings mutation rate limiting |
| `binance.ts` | Public klines/time and signed account, positions, income and listen-key reads |
| `streams.ts` | Market WebSockets and read-only account updates |
| `candles.ts` | In-memory OHLCV cache |
| `engine.ts` | Market-data refresh heartbeat only; no signal generation |
| `account.ts` | Binance account, position and income snapshots |
| `settings.ts` | Mode, display symbol, account keys and income-history range; migrates away old keys |
| `store.ts` | Strategy-neutral trade archive; strips obsolete strategy/order fields on load |
| `ratelimit.ts` | Conservative request-weight budget for data reads |
| `broadcast.ts` | Server activity and realtime dashboard events |
| `prices.ts` | Latest market price per symbol |

## Data and migration

- `settings.json` is rewritten to a small allowlisted shape at startup. Old scanner, strategy, auto-trade, sizing, target/stop and execution-policy values are not retained.
- `trades.json` is migrated to a strategy-neutral archive with identity, side, status, quantity, entry/close timestamps, P&L, fees, funding and account mode. Legacy target, stop, signal, order-ID and strategy fields are stripped.
- Trade history is not used to authorize exchange activity. Open legacy rows remain archival and are shown with a manual-review warning.
- `signals.json`, if present from an old release, is not read or written by this build.
- Existing exchange positions and conditional orders are never touched. This build will not monitor, reconcile, cancel, restore or close them.
- Keys supplied through environment variables are not written into the settings file. Dashboard values are masked before serialization.

## API surface

The API provides health/status, settings, account, positions, income, trade archive, logs, limits and diagnostics. Removed scanner, strategy, signal, backtest, auto-trade, order, close and kill routes return JSON 404 responses.

`VX_API_TOKEN` protects every API route except `/api/health`, and the WebSocket hub. Bind and reverse-proxy configuration should be chosen for the installation environment.

## Deliberate extension boundary

A future strategy should be introduced only after the operator supplies its rules. Nothing in this baseline provides defaults for market selection, signals, entries, position sizing, leverage, protective orders, exits, retries or reversals.

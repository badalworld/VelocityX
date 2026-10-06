# VelocityX — Professional 5m Liquidity-Sweep / Volume-Profile POC Retest Strategy

This bot implements the strategy you described, hardened for live crypto futures execution on Binance USD-M.

---

## 1. Timeframe
- **5-minute** closed candles only (no repainting).

## 2. Entry Setup (3 steps on closed bars)

1. **Liquidity Sweep** — A 5m candle wicks beyond the high **or** low of the prior 30 bars by at least `sweepMinAtr × ATR(14)`, and closes back inside the prior range. The sweep candle must print volume ≥ `sweepVolumeMultiplier ×` average volume over the same 30 bars (filters fake probes).
2. **POC Lock** — At the moment of the sweep the bot calculates an approximate fixed-range volume profile over the preceding 30 bars (24 bins, volume spread uniformly across each candle's OHLC range) and locks the **Point of Control** (POC) — the price bin with the highest transacted volume. The POC bin must carry at least `pocVolumeMinRatio ×` the average bin volume (a true consensus level, not noise). The initial stop is placed `stopBufferAtr × ATR` beyond the sweep wick.
3. **POC Reclaim → Retest** — After the sweep, price must close back through the locked POC ("reclaim"). Within the next `retestWindowBars` candles (default 8), price comes back to touch the POC zone (tolerance `retestToleranceAtr × ATR`) and prints a **strong rejection candle** whose close sits in the top 55% (longs) or bottom 55% (shorts) of its own range, in the trade direction. Entry is at that retest candle's close.
4. **Optional Trend Filter** — When `trendFilterEma = 200`, longs only fire above EMA200 and shorts only below it, trading with the macro bias.

## 3. Position Management — 1:5 RRR, five 20% tranches

The stop is fixed at the sweep wick + ATR buffer; distance from entry to stop = **1R**. Five take-profits are placed simultaneously:

| Level | TP Distance | Exit Size | After fill, SL moves to… |
|-------|-------------|-----------|--------------------------|
| TP1   | **+1R**     | 20%       | Entry price (**breakeven**) |
| TP2   | **+2R**     | 20%       | +1R |
| TP3   | **+3R**     | 20%       | +2R |
| TP4   | **+4R**     | 20%       | +3R |
| TP5   | **+5R**     | remaining 20% (full close) | n/a |

This produces a **risk-free runner** after TP1 and a mathematically guaranteed +3R average win when all five legs fill, even though the worst-case loss is only 1R.

## 4. Risk Controls

- **Risk per trade**: 1% of current equity in the backtest; configurable `tradeSizePercent` (default 5% margin × 10× leverage ≈ 0.5% equity risk) in production.
- **Max stop**: skip the trade if entry-to-stop exceeds `maxStopAtr × ATR` (avoids oversized stops from long wicks).
- **Cooldown after loss**: after any stop-out, the bot suppresses new entries on that symbol for `cooldownBarsAfterLoss` bars (default 6 = 30 min) — eliminates revenge trading after a loss.
- **Hard position cap**: up to 8 concurrent bot positions (one per symbol).
- **Kill switch**: dashboard button market-closes every bot position.
- **Boot safety**: auto-trade is **never** re-armed by a restart; you must explicitly re-arm it each boot (`VX_ALLOW_LIVE=1` + dashboard toggle).
- **Protective ladder failure circuit breaker**: if 2 entries in a row can't place their SL/TP ladder (e.g. exchange protocol change), the bot disarms itself rather than paying fees on naked entries.
- **Orphan order sweep**: at every entry the bot cancels any stale `VX…` conditional orders it finds with no matching open trade.
- **No position adoption**: if a symbol already carries a position the bot didn't open, it refuses to trade it (no ambiguous reduce-only).
- **Algo-service SL/TP**: conditional orders are posted to Binance's Algo Service (`STOP_MARKET` / `TAKE_PROFIT_MARKET`), filled by the exchange even if the bot is offline.
- **Recovery reconciliation**: a 10-second loop cross-checks Binance's open orders and fills, re-arming any missing SL/TP leg and booking fills a missed WebSocket frame could have lost.

## 5. Scanning (auto mode)

With `autoScan = true` (default), the bot ranks the Binance USD-M universe by 24h quote volume, 24h range, and ATR%(15m), monitors up to `topN = 16` opportunity zones at a time, and evaluates both long and short POC setups on each.

## 6. Default Parameters

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `lookbackBars` | 30 | Bars used for sweep detection and POC profile |
| `profileBins` | 24 | Price bins for the fixed-range volume profile |
| `sweepMinAtr` | 0.05 | Minimum wick excursion past the prior extreme (ATR) |
| `sweepVolumeMultiplier` | 1.1 | Sweep bar volume must exceed avg × this |
| `retestWindowBars` | 8 | Max bars between POC reclaim and retest |
| `retestToleranceAtr` | 0.25 | POC zone width around the locked POC (ATR) |
| `retestCloseStrength` | 0.55 | Retest bar close must be in this percentile of the bar's range |
| `stopBufferAtr` | 0.1 | ATR padding beyond sweep wick for the stop |
| `maxStopAtr` | 6 | Skip trades with stop farther than this |
| `pocVolumeMinRatio` | 1.2 | Minimum POC-bin / avg-bin volume ratio |
| `trendFilterEma` | 200 | Higher-TF bias filter (0 = off) |
| `cooldownBarsAfterLoss` | 6 | Bars paused after a stop-out |
| `leverage` | 10× | Per-trade leverage |
| `tradeSizePercent` | 5% | Margin per trade as % of equity |
| `maxPositions` | 8 | Hard cap on concurrent trades |

All parameters are tunable live from **Settings → Strategy & Backtest**, and a built-in historical backtester pulls Binance public 5m klines to report win rate, average R, profit factor, max drawdown, and TP1–TP5 hit counts before you risk capital.

## 7. Deployment Checklist

1. Start the server: `npm start` (listens on `0.0.0.0:4000`).
2. Open the dashboard. Go to **Settings → Connection** and enter your Binance Demo Trading keys first (testnet), or Live keys when ready.
3. Go to **Strategy & Backtest**, click **Run Backtest** against 30+ days of BTCUSDT 5m data to validate the parameter set.
4. Enable auto-trade **only** after confirming behavior on testnet.
5. For LIVE: set `VX_ALLOW_LIVE=1` in `.env` (or environment) AND toggle Auto-Trade ON in the dashboard.

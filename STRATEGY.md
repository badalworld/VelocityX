# CryptoVN WaveTrend strategy

VelocityX implements the public signal behavior described on the protected TradingView CryptoVN_WaveTrend page. The implementation is signal-only and never sends exchange orders.

## Rules

- Calculate WaveTrend FEMA from typical price with channel length 10 and average length 21. FSMA is a 4-period SMA of FEMA.
- **BUY** when FEMA is in the oversold zone at or below -53, turns upward, and crosses above FSMA.
- **SELL** when FEMA is in the overbought zone at or above +53, turns downward, and crosses below FSMA.
- On entry, the stop is 3 × ATR(14): below entry for LONG and above entry for SHORT.
- Close 100% at the next opposite zone: +53 for LONG or -53 for SHORT.
- The strategy evaluates closed candles. If stop and opposite-zone exit occur within one OHLC candle, the backtest conservatively assumes the stop happened first.

## API

`GET /api/strategy` returns the current indicator, latest signal, strategy parameters, and a closed-candle backtest. The dashboard status payload exposes the current point under `strategy`.

This build intentionally remains paper-signal-only. Binance positions and orders are not opened, modified, or closed.

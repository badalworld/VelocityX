# VelocityX simulation harness

The Monte-Carlo study behind **[SIMULATION-REPORT.md](SIMULATION-REPORT.md)** (and the richer
**[report.html](report.html)**): **20 independent one-year markets × 11 paired configurations**, plus a
fee-tier sweep and combined-configuration probes. Everything is reproducible from this directory — no
network access, no exchange keys.

```bash
cd simulation
node run.js            # 20 worlds × 11 configs → results/*.json     (~14 min single-threaded)
node merge.js          # (optional) merge shard checkpoints into the canonical results
node validate.js       # signal-rate test on a random walk + market calibration   (~2 min)
node curves.js         # daily equity paths for the fan chart        (~6 min)
node fee_sweep.js      # 6 fee tiers on 8 worlds                     (~3 min)
node probe.js          # combined configurations (15m+maker, 1h defensive, …)     (~2 min)
node report.js         # SIMULATION-REPORT.md + report.html
```

Sharding / resume (used on a 2-vCPU box): any run can be split and restarted —

```bash
node run.js --only 0,1,2,3,4,5,6 --partial results/partial-a.jsonl   # one shard
node run.js --only 7,8,9,10,11,12,13 --partial results/partial-b.jsonl
node run.js --only 14,15,16,17,18,19 --partial results/partial-c.jsonl
node merge.js
```

## Headline results

| configuration | mean 12-mo return | median | expR / trade | trades/mo | profitable worlds | ruined |
|---|---|---|---|---|---|---|
| **shipped default** (5m, 8 slots, taker 0.05 %) | −99.9 % | −100.0 % | −0.072 R | 1,013 | 0/20 | 20/20 |
| 15m candles | −21.7 % | −59.7 % | −0.030 R | 286 | 2/20 | 9/20 |
| maker fee 0.02 % | +138.9 % | −60.4 % | −0.008 R | 2,031 | 7/20 | 6/20 |
| 15m + no reverse | +124.3 % | −69.3 % | −0.018 R | 211 | 5/20 | 7/20 |
| **15m + maker fee** (probe, 6 worlds) | +443 % | **+104 %** | +0.018 R | 299 | 4/6 | 0/6 |
| signals **inverted** (null test) | −99.6 % | −100.0 % | −0.070 R | 1,324 | 0/20 | 20/20 |
| **random** entries (null test) | −99.2 % | −100.0 % | −0.063 R | 1,054 | 0/20 | 20/20 |

* The confirmed EMA(11)/EMA(34) cross fires **9.2×/day/symbol** on 5-minute candles — a property of the
  filter, measured identically at 40 %, 100 % and 200 % annualised volatility. That churn × the 0.05 %
  taker fee (~0.07 R per round trip) is what the P&L is really made of.
* Inverting every signal gives the **same** expectancy as the original → no usable directional edge at
  this timeframe and cost level.
* Break-even fee for the 5m strategy: **≈ 0.017 %/side**. The bot sends market orders, so it pays 0.05 %.
* The first configuration with a **positive median** year: **15m candles + maker fills** — which needs an
  execution change (post-only limit entries, limit TP reductions), not just a setting.

⚠️ Synthetic markets (the study host had no route to Binance). The generator is calibrated to crypto-perp
stylised facts and the calibration is measured in `results/validation.json`; confirm on real data with
`node run.js --data ./klines` before trusting any of it with money.

## Why simulations instead of a backtest on Binance history

The sandbox that produced this study has **no route to `fapi.binance.com`**, so real klines could not be
downloaded. Rather than fabricate a "backtest" from remembered prices, the study generates markets from an
explicitly documented data-generating process, validates that the generated data reproduces the stylised
facts of crypto perpetuals, and reports those measurements next to the results.

**Real-data mode** (same harness, same reports): put one CSV per symbol — `SYMBOL.csv`, columns
`time,open,high,low,close,volume` on 5-minute bars — into a directory and run

```bash
node run.js --data ./klines --primary BTCUSDT
node report.js          # or inspect results/summary.json directly
```

## What the engine mirrors (1:1 from `server/src`)

| Bot behaviour | Where in the bot | Mirror |
|---|---|---|
| EMA(11)/EMA(34) confirmed cross on closed candles | `indicators.signalAt` | the **compiled repo function itself** is imported by the harness |
| Entry at the signal candle close | `trader.placeEntry` | market fill + 1 bp slippage |
| Stop = 2 × ATR(14) (1R) | `settings.atrSlMultiplier` | same |
| TP1 33 % @1.5R → SL breakeven; TP2 50 % of rest @3R → SL to TP1; TP3 rest @4.5R | `trader.fillTP` / `splitQty` | same, including lot-step degradation |
| Opposite signal → close & reverse | `trader.onSignal` | same (plus a `noreverse` variant to price it) |
| Margin 5 % of equity, 10× isolated, ≤ 8 positions, one per symbol | `trader.placeEntry` | same, including the 95 % free-margin cap and slot reservation |
| Scanner gates: 24h quote volume ≥ 20 M, 24h range ≥ 3 %, 15m ATR ≥ 0.6 %, 15m ADX ≥ 18, 15m/1h trend alignment, peg detection | `scanner.ts` | recomputed every hour from the generated candles |
| Taker fee 0.05 %/side, funding every 8 h | `settings.feeRate`, `refreshFunding` | same |
| Isolated-margin liquidation | exchange | modelled at 1/leverage − 0.5 % maintenance margin |

Deliberately **conservative**: inside a candle the stop is assumed hit *before* the take-profit (measured to
matter in only 0.02 % of trades); a stop that gapped through fills at the open, never better than the stop.

Not modelled (each would make live results worse): order rejections, latency, downtime, partial fills,
rate limits, notional-tiered fees, funding spikes.

## The 20 worlds

| | |
|---|---|
| Length | 12 months, 105,120 × 5-minute bars per symbol |
| Universe | 40 symbols: 3 majors, 26 alts, 8 high-vol, 1 pegged pair, 1 illiquid pair, 1 quiet pair |
| Types | bull, bear-tilted, chop, volatile, crisis — 4 worlds each |
| Volatility multiplier | 0.85 / 1.00 / 1.25 / 1.55 |
| Generator | regime switching (6 regimes, mean durations 1.3–9.5 days) × GARCH(1,1) × slow log-AR(1) vol level, standardised Student-t(5) bar shocks, Poisson jumps, 8 sub-step intrabar path |

## Configurations (all paired on the same price paths)

`default` · `tf15` · `tf60` · `flip` (signals inverted) · `random` (null) · `noreverse` · `slots2` ·
`maker` (0.02 % fee) · `sl3_tp2` (3×ATR stop, 2R ladder) · `size2` (2 % margin) · `tf15_norev`
plus probes: `15m+maker`, `15m+maker+no reverse`, `1h+maker+no reverse+3 slots+2 % margin`.

## Output files (`results/`)

| file | contents | committed |
|---|---|---|
| `worlds.json` | per-world parameters, market benchmark | yes |
| `summary.json` | aggregates: mean/median/percentiles, ruin counts, alpha/beta, method notes | yes |
| `validation.json` | signal-rate test on a pure random walk + calibration table | yes |
| `fee-sweep.json` | 6 fee tiers × 8 worlds | yes |
| `probe-*.json` | combined-configuration probes | yes |
| `curves.json` | daily equity paths + buy & hold benchmark | yes |
| `simulations.json` | every metric of every config in every world | no (regenerate, ~0.7 MB) |
| `trades-default.json` | sampled trade journal (R multiple, reason, excursions) | no (~1.4 MB) |
| `partial-*.jsonl` | shard checkpoints | no |

## Validation built into the study

* **Signal rate**: 9.2 crossings/day/symbol on 5m, independent of volatility — the mechanism behind the fee drag.
* **Calibration**: annualised vol, kurtosis, |return| ACF(1), 24h range and turnover measured on the
  generated data and compared with published crypto-perp ranges (`results/validation.json`).
* **Trap symbols**: a pegged pair, an illiquid pair and a quiet pair are always present; the scanner
  rejects them in every scan of every world.

## Bug the study found

`server/src/trader.ts` paper-mode sizing counted realised P&L twice (`paperBalance + Σ realised`, while
`adjustPaperBalance()` already books every fill) — fixed on this branch. See `SIMULATION-REPORT.md` §9.

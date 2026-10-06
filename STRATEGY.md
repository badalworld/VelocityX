# Strategy handoff

**No trading strategy is implemented in this repository.** The prior strategy, its signal rules, entry/exit logic, sizing policy, scanner, targets, stops, backtester and execution code were removed at the operator's request.

No replacement strategy has been invented. The next strategy will be supplied by the operator after this cleanup is complete.

## Current behavior

VelocityX is a read-only Binance USDⓈ-M market/account monitor. It fetches public market data and, when configured, private account snapshots. There is no code path for opening, modifying or closing an exchange order or position.

## Existing positions

This build does not manage positions or protective orders left by an earlier release. Existing exchange positions and orders are not changed; open legacy journal entries are preserved in a neutral archive and surfaced for manual review in Binance.

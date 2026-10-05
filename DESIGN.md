# 🌊 VelocityX — Dashboard UI/UX system

This document describes the VelocityX dashboard layout, retained P&L chart, calm realtime updates, accessibility, and responsive behaviour.

---

## 1. Design principles

| # | Principle | How it appears |
|---|---|---|
| 1 | **Metrics before market charts** | Dashboard cards show account, risk, scanner, trend and execution data without a BTCUSDT candlestick stage. |
| 2 | **Keep the useful P&L chart** | The cumulative bot P&L rail remains sticky on desktop and becomes a collapsible sheet on smaller screens. |
| 3 | **Calm by default** | Motion is off on first load. Existing legacy `vx.motion` preferences are ignored through the new `vx.motion.v2` key. |
| 4 | **Realtime without blinking** | Values update in place, do not colour-flash, and stale HTTP responses cannot overwrite newer WebSocket/account data. |
| 5 | **Never blank the desk** | Each active view and the P&L dock are isolated by an `ErrorBoundary`. |
| 6 | **Truthful data** | Live and unreachable feeds are labelled (there is no synthetic feed); external positions stay read-only and never enter bot P&L. |

---

## 2. Information architecture

```
Topbar       brand · mode · feed · price · equity · open P&L · KILL
Nav row      Dashboard | Scanner | Positions | Trades | Settings
Ticker       scanner ranking marquee
Shell        responsive content + retained P&L rail/sheet
Footer       connection state + risk reminder
```

The previous **Chart** navigation item and its BTCUSDT candlestick/EMA stage were removed. The client no longer imports `lightweight-charts` or requests `/api/chart`. Signal history remains available under **Trades**.

Views:

* **Dashboard** — feed status, hero, KPIs, managed positions, scanner, statistics, **MTF trend gauge** (EMA11/EMA34 across 5m/15m/30m with timeframe chips), **execution rules**, engine health and activity. A full-width alert banner (`role="alert"`) appears only while LIVE auto-trading is armed so real-money mode can never be mistaken for a safe environment.
* **Scanner** — volatility ranking, score distribution, trade gates and watchlist.
* **Positions** — Binance account ledger, bot positions, external read-only positions, closed trades, fees and funding.
* **Trades** — journal, signals and executor activity.
* **Settings** — connection (mode, keys, **API token**), sizing, scanner, indicator, guardrail and motion controls. Arming LIVE asks for an explicit confirmation before the request is sent.

---

## 3. Retained P&L chart

`client/src/components/PnlDock.tsx`, `PnlChart.tsx`, and `client/src/pnl.ts`

The chart is bot-specific:

```
start equity = current equity − live unrealised − recorded realised P&L
closed trade = one realised step
open managed position = live unrealised tail
external position = excluded
```

It retains:

* 24H / 7D / 30D / ALL ranges;
* realised and unrealised totals;
* trade histogram and cumulative curve;
* win rate, average R, best/worst result and maximum drawdown;
* crosshair details when motion is explicitly enabled;
* an explanatory empty state before the first closed trade.

Responsive behaviour:

| Viewport | P&L behaviour |
|---|---|
| Desktop (`>1080px`) | Sticky side rail beside the active view. |
| Tablet / phone | Fixed bottom sheet, collapsed by default; tap the P&L control or sheet header to open it. |

The default motion-off state makes chart updates immediate and static instead of morphing or pulsing.

---

## 4. Stable realtime updates

`client/src/App.tsx` separates data transport from presentation:

* loaders return real promises, so actions wait for refresh completion;
* account snapshots merge by `at`, and older snapshots are ignored;
* compact `/status.account` data cannot erase fields from the full `/account` response;
* unchanged account, position, scanner, trade, signal, statistics and log payloads preserve their previous state object;
* a WebSocket price received while `/status` is in flight wins over that stale HTTP price;
* status logs merge by stable identity instead of disappearing during a poll;
* the client makes no `/api/chart` request.

The server’s `/status.account` snapshot includes `mode`, maintenance margin and latency fields required by the client.

---

## 5. Motion and blink prevention

Motion state is initialized before React paints:

```html
<html data-motion="off">
```

The application stores explicit choices under `vx.motion.v2`, defaulting to `false`. Therefore an older browser value that previously forced motion on cannot keep the dashboard blinking after this update.

When motion is off:

* CSS animation and transition durations collapse to a no-op;
* animated numbers paint their target immediately;
* the liquid canvas renders one static frame;
* P&L curve updates render immediately;
* live values have no up/down flash classes;
* the boot indicator is static.

The background canvas persists through tab visibility changes instead of being cleared and recreated. Users who want ambient animation can enable it from the header.

---

## 6. Glass and tokens

`client/src/styles/tokens.css` defines surfaces, strokes, radii, colours, gradients, shadows, timing and layout dimensions. `glass.css` composes each panel from a translucent tint, blur/saturation, border and depth shadows.

`prefers-reduced-transparency` swaps blurred panels for more opaque surfaces. `prefers-reduced-motion` remains authoritative even if the in-app Motion switch is enabled.

---

## 7. Accessibility and robustness

* Tabs expose `role="tablist"` and `aria-selected`.
* Interactive controls have visible `:focus-visible` styling.
* The mobile P&L sheet header supports Enter and Space as well as pointer input.
* Numeric fields use tabular numerals and layouts use `minmax(0, 1fr)`.
* Feed labels never claim Binance is live while the exchange is unreachable.
* UI smoke tests assert five navigation items, absence of the BTCUSDT chart and `/api/chart` requests, presence of the P&L chart, the MTF gauge with timeframe chips, the execution-rules panel, absence of the live banner in testnet mode, no simulation copy anywhere, the API-token field on the connection tab, default motion-off state, no flash classes, and no `NaN` / `Infinity` output.

---

## 8. Production hardening (UI contract)

| Surface | Behaviour |
|---|---|
| Live trading | Red `role="alert"` banner while LIVE auto-trading is armed; the auto-trade switch asks for confirmation in LIVE mode and sends `confirmLive`. Entering LIVE always lands disarmed (server forces `autoTrade: false`), so arming execution is a second, deliberate action. |
| Auth | The API token is stored in browser storage and attached to REST (`X-VX-Token`) and WS (`?token=`) calls; a 401 renders a single actionable toast. |
| Errors | Every panel is inside an `ErrorBoundary`; server-side failures arrive as `error` events and become toasts plus activity-feed rows. |
| Data honesty | Testnet/live/unreachable states are labelled and every account number is read from Binance; external positions are shown read-only and never merged into bot numbers. |

## 9. Extending

```tsx
<Panel title="My module" icon={<IconPulse />} meta="live">
  <div className="grid-4" data-reveal-group>
    <article className="panel kpi tone-violet">…</article>
  </div>
</Panel>
```

* New tokens → `tokens.css`; surfaces → `glass.css`; responsive layout → `layout.css`.
* Reusable elements live in `motion/primitives.tsx`.
* P&L/sparkline path helpers live in `motion/chart.ts`.
* Do not attach an animation to ordinary polling updates. Continuous motion must remain opt-in.

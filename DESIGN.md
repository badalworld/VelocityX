# 🌊 VelocityX — Liquid Glass UI/UX system

This document is the design spec for the VelocityX dashboard: a **super liquid glass, fluid, motion-first** trading desk. It covers the visual language, the motion vocabulary, the responsive pinned P&L chart, accessibility and how to extend the system.

> Motion reference: the interaction language follows the structure of the [LottieFiles motion templates](https://lottiefiles.com/motion-templates) library — morphing blob shapes, staggered reveals, spring easing, looping micro-animations and travelling highlights. Every effect here is implemented **natively** (CSS keyframes + tiny rAF hooks + hand-written SVG/canvas), so there is no animation-runtime dependency and the whole deck stays under ~400 kB gzipped with the trading libraries included.

---

## 1. Design principles

| # | Principle | How it shows up |
|---|---|---|
| 1 | **Glass is a physical sheet** | Five stacked optical layers per panel: tint, backdrop blur + saturation, hairline ring, specular top edge, cursor-tracked sheen. |
| 2 | **Liquid, never static** | A canvas colour field, drifting aurora bands, morphing metaball blobs, a faint technical mesh, film grain and a vignette — all continuously in motion. |
| 3 | **Metrics before charts** | The Dashboard holds **no candlestick chart** and no manual-asset tiles. It is a metrics deck (KPIs, rings, gauges, hit-rate bars) fed by the scanner + Binance account. The trading chart lives in its own *Chart* tab. |
| 4 | **The P&L chart is always on screen** | Pinned rail on desktop, docked sheet on tablet/phone — see §5. |
| 5 | **Every section animates** | Scroll reveal, staggered groups, count-ups, draw-in sparklines, morphing equity curve, sliding segmented thumb, liquid ripples, log slide-ins. |
| 6 | **Motion is a setting** | A header switch (persisted in `localStorage`, `html[data-motion="off"]`) plus `prefers-reduced-motion` and `prefers-reduced-transparency` support. |
| 7 | **Never blank the desk** | Every view and the P&L dock render inside an `ErrorBoundary`; the chart library is failure-tolerant with an inline fallback. |

---

## 2. Tokens

`client/src/styles/tokens.css` is the single source of truth.

```
surfaces   --glass-1/2/3, --glass-deep, --glass-frost, --blur-s/m/l/xl, --sat, --specular
strokes    --stroke-1/2/3                       radii   --r-xs … --r-pill
spectrum   --cyan --mint --green --red --amber --violet --blue (+ -dim variants)
gradients  --grad-brand, --grad-bull, --grad-bear, --grad-glass(-strong)
depth      --shadow-s/m/l, --inner-lit, --inner-dim, --glow-cyan
motion     --ease-liquid (gooey rise), --ease-spring (overshoot), --ease-snap,
           --ease-inout, --t-fast 140ms … --t-lazy 820ms
layout     --topbar-h, --rail-w, --shell-max, z-bands --z-bg … --z-toast
```

Two automatic overrides ship with the tokens:

* `@media (prefers-reduced-transparency: reduce)` → swaps translucent glass for near-opaque surfaces and drops blur.
* `html[data-motion="off"]` → collapses every duration and easing to a no-op.

---

## 3. The glass recipe

`client/src/styles/glass.css`

```css
.glass / .panel {
  background-image: var(--grad-glass);         /* 1 tint gradient        */
  background-color: rgba(10,15,28,.34);
  backdrop-filter: blur(32px) saturate(165%);  /* 2 backdrop optics      */
  border: 1px solid var(--stroke-1);           /* 3 hairline ring        */
  box-shadow: shadow + inner-lit + inner-dim;  /*   depth                */
}
.glass::before { /* 4 specular top edge, masked ring */ }
.glass::after  { /* 5 cursor sheen at var(--mx)/var(--my) */ }
```

`useGlassSheen()` feeds pointer coordinates into `--mx/--my` on hovered glass elements (rAF-throttled, disabled on touch, and off when motion is disabled).

Variants: `.glass-sm` (chips/cells), `.glass-frost` (bars, sheets, the P&L rail), `.panel-head` (chrome + travelling gradient rule), `.glow-ring` (conic animated border driven by an `@property` angle), `.liquid-div`, `.skel` shimmer.

---

## 4. Motion vocabulary

`client/src/styles/motion.css` + `client/src/hooks/motion.ts` + `client/src/motion/primitives.tsx`

| Effect | Implementation |
|---|---|
| Section reveal | `[data-reveal]` → fade + rise + blur-out, driven by `useReveal()` (IntersectionObserver, with a viewport failsafe so nothing can stay hidden). |
| Staggered groups | `[data-reveal-group] > *` runs `rise-in` with per-child delays; paused until the group is on screen. |
| Number count-up | `useAnimatedNumber()` (expo ease over rAF) wrapped in `<AnimatedNumber/>`, with green/red flash on change (`useFlash`). |
| Sparklines | `<Sparkline/>` draws with `pathLength=1` + `stroke-dashoffset` transition, gradient fill fades in after the draw, live end dot. |
| Equity curve | `<PnlChart/>` re-samples + smooths the ladder into a liquid line and **morphs** from the previous shape over 640 ms on every data update. |
| Rings / bars | `stroke-dashoffset` and `width` transitions with staggered delays. |
| Segmented control | `<Segmented/>` measures the active item and slides a liquid `seg-thumb` (spring easing). |
| Buttons | Liquid specular sweep on hover, magnetic pull toward the cursor, material ripple on press. |
| Nav / tabs | Same sliding thumb; view changes replay the reveal choreography (`key={view}`). |
| Activity feed | New lines animate in with a cyan wash (`log-in`), staggered in the journal tables. |
| Ticker | Screener states scroll as an infinite marquee, paused on hover (masked edges). |
| Toasts | Liquid drop-in with a coloured filament, spring easing. |
| Live markers | Pulsing LED for streams, breathing chips, ping ring on the chart's live tail, flashing price pod. |

Keyframes available for reuse: `liquid-slide`, `shimmer`, `rise-in`, `drop-in`, `pop-in`, `slide-in-right`, `log-in`, `marquee`, `led-pulse`, `chip-breathe`, `dot-ping`, `blob-morph`, `aurora-drift`, `brand-draw`, `brand-flare`, `goo-bounce`, `float-y`, `hue-drift`.

### Ambient background

`client/src/motion/LiquidBackground.tsx` + `.bg-stack` in `layout.css`:

1. **Canvas colour field** — 5 additive radial blobs on Lissajous paths at ~30 fps, blurred by CSS (GPU) and hue-drifting slowly.
2. **Aurora** — three drifting radial waves in `screen` blend mode.
3. **Metaball blobs** — `border-radius` morphing shapes (`blob-morph`), each blurred 58 px.
4. **Mesh grid** — masked tech grid with a breathing opacity.
5. **Grain + vignette** — inline SVG fractal noise at 5 % and a radial falloff for depth.

All layers are `pointer-events: none`, pause when the tab is hidden, render a single static frame when motion is off, and never block text selection.

---

## 5. The pinned P&L chart (fixed position, responsive)

`client/src/components/PnlDock.tsx` + `PnlChart.tsx` + `client/src/pnl.ts`

**Data model.** The server stores raw trades *and* the Binance account view, so the curve is derived client-side from **Binance-sourced** numbers:

```
equity        = Binance account equity (or the labelled paper-sim balance)
start equity  = equity − unrealised − Σ realised
each closed trade  → a step in the curve (realised PnL, fees and funding booked from Binance)
open positions     → live unrealised tail (one tail per managed position)
```

External (non-bot) positions never enter this model — they are shown read-only in *Positions* so the curve always describes exactly what the bot did.

`buildPnl()` windows the series (24H / 7D / 30D / ALL), computes net / realised / unrealised, win-rate, average R, best/worst trade, peak and max drawdown, and samples a smoothed curve (`equityCurve()` with a 3-pass smoother) so a short log still reads as a flowing line.

**Chart.** Hand-written SVG (no chart library), so it is razor sharp and frame-animatable:

* liquid morph between data updates (lerp over 640 ms),
* profit segments filled cyan/green, drawdown segments filled rose (two clip paths split at the start-equity line),
* per-trade P&L histogram anchored under the curve,
* `START` baseline, dashed grid + compact axis labels, time axis that adapts 24 H → dates → years,
* pointer/touch crosshair with a glass tooltip that flips below the cursor near the top edge,
* pulsing live tail dot and a `LIVE` badge while a position is open,
* empty state ("waiting for the first closed trade") when there is nothing to plot yet.

**Fixed position per breakpoint**

| Viewport | Behaviour |
|---|---|
| ≥ 1081 px | Third column of the shell, `position: sticky` under the header — it stays on screen for the whole scroll (the shell grid deliberately keeps `align-items: stretch` so the sticky rail has travel room). |
| 1081–721 px | The rail becomes a **docked sheet** fixed to the bottom edge, collapsed to a live mini-readout (total P&L + trade count); tap the handle to expand the chart. |
| ≤ 720 px | Same sheet, safe-area aware, 176–200 px chart height, 2-column stat tiles, chart padded so the page never hides behind it. |

The dock also reacts to the environment: sticky rail scrolls internally when vertical space is tight, tooltips are clamped inside the plot, and the sheet never covers toasts (toasts move to bottom-left on desktop).

---

## 6. Information architecture

```
Topbar       brand · mode badge · feed badge (live / offline / unreachable) · price pod · equity pod · open-P&L pod · KILL
Nav row      Dashboard | Scanner | Positions | Chart | Trades | Settings  ·  stream LEDs · Motion switch · Auto-Trade switch
Ticker       scanner rows as an infinite marquee (top volatility first)
Shell        content column  +  pinned P&L rail (see §5)
Footer       build identity + connection state + risk reminder
```

* **Dashboard** (no candlestick chart): hero summary (equity, total P&L, open R, engine uptime + equity sparkline) → four KPI pods (net P&L, win rate, expectancy, signals) → feed banner when the data is not live Binance → managed position cards with the risk ladder → weekly statistics (rings, hit-rate bars, metric grid) → trend engine (semi-circle gauge + timeframe chips) → scanner summary + top picks → engine health (request budget per area) → live activity feed.
* **Scanner**: ranking table for the whole volatility scan (24h range, ATR%, ADX, trend, funding, score, verdict), score distribution + scan summary, the trade gates as configured, and the engine watchlist.
* **Positions**: Binance account ledger (equity, available, margin used, unrealised, and the raw `/fapi/v1/income` ledger), bot positions with margin / fees / funding / liquidation ladder and a per-position close button, **external positions read-only**, closed trade table with fees + funding, risk rules, executor feed.
* **Chart**: candlestick stage with the EMA ribbon (5→34) + EMA 200, signal markers, entry/SL/TP price lines, candle-count selector, per-layer visibility toggles, legend, position card and the signal log.
* **Trades**: journal summary, full trade table (market / fees / funding), signal log, activity feed.
* **Settings**: connection / markets & sizing / market scanner / indicator tabs, guardrails panel, motion panel — **no manual asset or balance entry field exists**.

---

## 7. Accessibility & robustness

* Visible focus rings on every interactive element (`:focus-visible`), tabs use `role="tablist"`/`aria-selected`.
* Motion switch + OS `prefers-reduced-motion`; transparency fallback for `prefers-reduced-transparency`.
* Gradient text degrades to solid colour when `background-clip: text` is unsupported; `backdrop-filter` unsupported → opaque surfaces; `structuredClone` missing → JSON clone.
* Layout uses `minmax(0, 1fr)` everywhere so long numbers never blow out the grid; numeric columns are tabular.
* `ErrorBoundary` isolates the chart module, each view and the P&L dock; chart-library init is wrapped in `try/catch` with a retry.
* Safe-area insets respected on phones (`env(safe-area-inset-bottom)`).
* Product copy always states what the bot is doing ("executing signals" vs "signals logged only") and paper/testnet/live is colour-coded.
* The feed badge is tri-state and never lies: `Binance live feed` only when the exchange WS/REST answered recently, `Offline demo feed` for the labelled synthetic feed, `Feed stale/unreachable` when data cannot be refreshed — with the reason in the banner.

---

## 8. Extending

```tsx
// new section with reveal + stagger, in any view
<Panel title="My module" icon={<IconPulse />} meta="live">
  <div className="grid-4" data-reveal-group>
    <article className="panel kpi tone-violet"> … </article>
  </div>
</Panel>
```

* New tokens → `tokens.css`; new keyframes → `motion.css`; new surfaces → `glass.css`.
* Reusable pieces live in `motion/primitives.tsx` (`AnimatedNumber`, `Btn`, `Panel`, `Segmented`, `Sparkline`, `Ring`, `BarRow`, `Mini`, `LiquidLoader`).
* Chart maths (`smoothPath`, `equityCurve`, `niceTicks`, `fmtClock`) live in `motion/chart.ts` and are dependency-free.
* Animation performance rule of thumb: animate `transform`/`opacity`/`filter`, keep loops ≥ 2 s for ambient layers, and never animate layout in a rAF loop except the two chart components (≤ 132 points).

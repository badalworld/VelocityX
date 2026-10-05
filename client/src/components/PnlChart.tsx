import { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { motionOff, useElementSize } from '../hooks/motion';
import { compact, equityCurve, fmtClock, niceTicks, Pt, r, resample, smoothPath } from '../motion/chart';

/* ============================================================================
   PnlChart — the fixed-position equity chart.
   ---------------------------------------------------------------------------
   Pure SVG (no chart library) so it stays razor sharp at every size and can be
   animated frame-by-frame:
     • the curve is re-sampled + smoothed into a liquid line,
     • every data update morphs from the previous shape (lerp over ~640ms),
     • profit segments fill cyan/green, drawdown segments fill rose,
     • per-trade P&L histogram sits under the curve,
     • pointer (mouse + touch) drives a crosshair with glass tooltip.
   ========================================================================== */

export interface PnlTradeBar {
  t: number;
  pnl: number;
  side: 'LONG' | 'SHORT';
}

export interface PnlChartProps {
  start: number;
  end: number;
  base: number;
  /** cumulative equity points (t → equity) sorted ascending */
  series: { t: number; v: number }[];
  bars: PnlTradeBar[];
  live?: boolean;
  height?: number;
  /** changing this restarts the draw-in animation */
  drawKey?: string;
}

interface Frame {
  vals: number[];
  start: number;
  end: number;
  base: number;
}

const N = 124;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 4);

export default function PnlChart({ start, end, base, series, bars, live, height = 218, drawKey }: PnlChartProps) {
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ x: number; y: number; i: number } | null>(null);
  const [drawn, setDrawn] = useState(() => motionOff());
  const dispRef = useRef<Frame | null>(null);
  const [frame, setFrame] = useState<Frame>(() => ({
    vals: equityCurve(series, { start, end, base, n: N }),
    start,
    end,
    base,
  }));

  /* ---------- morph between data states ---------------------------------- */
  useEffect(() => {
    const target: Frame = { vals: equityCurve(series, { start, end, base, n: N }), start, end, base };
    const from: Frame = dispRef.current ?? target;
    const fromVals = resample(from.vals, N);
    const duration = motionOff() ? 0 : 640;
    const t0 = performance.now();
    let raf = 0;

    const step = (now: number) => {
      const p = duration ? Math.min(1, (now - t0) / duration) : 1;
      const e = easeOut(p);
      const vals = target.vals.map((v, i) => fromVals[i] + (v - fromVals[i]) * e);
      const next: Frame = {
        vals,
        start: from.start + (target.start - from.start) * e,
        end: from.end + (target.end - from.end) * e,
        base: from.base + (target.base - from.base) * e,
      };
      dispRef.current = next;
      setFrame(next);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, start, end, base]);

  /* ---------- draw-in when the range changes ----------------------------- */
  useEffect(() => {
    if (motionOff()) {
      setDrawn(true);
      return;
    }
    setDrawn(false);
    const id = window.setTimeout(() => setDrawn(true), 60);
    return () => window.clearTimeout(id);
  }, [drawKey]);

  /* ---------- geometry --------------------------------------------------- */
  const w = Math.max(180, size.w);
  const h = Math.max(120, size.h || height);
  const padL = 8;
  const padR = 58;
  const padT = 12;
  const padB = 26;
  const histH = 30;
  const plotBottom = h - padB - histH;
  const innerW = Math.max(20, w - padL - padR);
  const innerH = Math.max(20, plotBottom - padT);

  const { vals, start: fStart, end: fEnd, base: fBase } = frame;
  const span = Math.max(1, fEnd - fStart);

  const stats = useMemo(() => {
    const all = [...vals, fBase];
    const min = Math.min(...all);
    const max = Math.max(...all);
    const pad = (max - min || Math.abs(max) * 0.02 || 1) * 0.16;
    return { lo: min - pad, hi: max + pad, min, max };
  }, [vals, fBase]);

  const xOf = (t: number) => padL + ((t - fStart) / span) * innerW;
  const yOf = (v: number) => padT + (1 - (v - stats.lo) / (stats.hi - stats.lo)) * innerH;

  const pts: Pt[] = useMemo(
    () => vals.map((v, i) => ({ x: xOf(fStart + (span * i) / (vals.length - 1)), y: yOf(v) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vals, fStart, span, innerW, stats.lo, stats.hi, innerH, padL, padT],
  );

  const line = useMemo(() => smoothPath(pts), [pts]);
  const areaPath = useMemo(
    () => (pts.length ? `${line} L ${r(pts[pts.length - 1].x)} ${r(plotBottom)} L ${r(pts[0].x)} ${r(plotBottom)} Z` : ''),
    [line, pts, plotBottom],
  );

  const baseY = yOf(fBase);
  const ticks = useMemo(() => niceTicks(stats.lo, stats.hi, 4), [stats.lo, stats.hi]);

  const barMax = useMemo(() => Math.max(1e-9, ...bars.map((b) => Math.abs(b.pnl))), [bars]);

  const net = (vals.length ? vals[vals.length - 1] : fBase) - fBase;
  const up = net >= 0;
  const accent = up ? '#34f0b2' : '#ff6b8b';
  const accent2 = up ? '#3ef0ff' : '#ff9a6b';
  const uid = useMemo(() => `pnl-${Math.random().toString(36).slice(2, 8)}`, []);

  const plotStartX = pts.length ? pts[0].x : padL;
  const plotEndX = pts.length ? pts[pts.length - 1].x : padL + innerW;
  const last = pts.length ? pts[pts.length - 1] : { x: padL, y: padT };

  const timeTicks = useMemo(() => {
    const count = w < 380 ? 3 : w < 620 ? 4 : 5;
    return Array.from({ length: count }, (_, i) => fStart + (span * i) / (count - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fStart, span, w]);

  /* ---------- pointer ---------------------------------------------------- */
  const onMove = (clientX: number, clientY: number, rect: DOMRect) => {
    const x = clientX - rect.left;
    const i = Math.max(0, Math.min(vals.length - 1, Math.round(((x - padL) / innerW) * (vals.length - 1))));
    setHover({ x: pts[i]?.x ?? x, y: pts[i]?.y ?? 0, i });
  };

  const hoverPt = hover ? pts[hover.i] : null;
  const hoverT = hover ? fStart + (span * hover.i) / Math.max(1, vals.length - 1) : 0;
  const hoverV = hover ? vals[hover.i] : 0;
  const hoverDelta = hover ? hoverV - fBase : 0;
  const hoverTrade = useMemo(() => {
    if (!hover) return null;
    let best: PnlTradeBar | null = null;
    let bestD = Infinity;
    for (const b of bars) {
      const d = Math.abs(xOf(b.t) - (hoverPt?.x ?? 0));
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return bestD < 22 ? best : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover, bars, hoverPt]);

  // Empty state: nothing booked in the window and no live P&L drifting the
  // curve, so the panel explains itself instead of drawing a flat line.
  const showEmpty = bars.length === 0 && Math.abs(net) < 1e-6;

  return (
    <div
      className="pnl-chart"
      ref={wrapRef}
      style={{ height }}
      onPointerMove={(e) => onMove(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect())}
      onPointerDown={(e) => onMove(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect())}
      onPointerLeave={() => setHover(null)}
      onPointerCancel={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${r(w)} ${r(h)}`} preserveAspectRatio="none" role="img" aria-label="Cumulative P&L">
        <defs>
          <linearGradient id={`${uid}-line`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={accent2} stopOpacity="0.55" />
            <stop offset="45%" stopColor={accent} stopOpacity="1" />
            <stop offset="100%" stopColor={up ? '#3ef0ff' : '#ff4f74'} stopOpacity="1" />
          </linearGradient>
          <linearGradient id={`${uid}-fill-up`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.34" />
            <stop offset="60%" stopColor={accent} stopOpacity="0.08" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${uid}-fill-down`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#ff4f74" stopOpacity="0.38" />
            <stop offset="70%" stopColor="#ff4f74" stopOpacity="0.06" />
            <stop offset="100%" stopColor="#ff4f74" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${uid}-hist`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34f0b2" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#34f0b2" stopOpacity="0.15" />
          </linearGradient>
          <clipPath id={`${uid}-clip-up`}>
            <rect x="0" y="0" width={w} height={Math.max(0, baseY)} />
          </clipPath>
          <clipPath id={`${uid}-clip-down`}>
            <rect x="0" y={Math.max(0, baseY)} width={w} height={Math.max(0, h - baseY)} />
          </clipPath>
          <filter id={`${uid}-glow`} x="-30%" y="-60%" width="160%" height="260%">
            <feGaussianBlur stdDeviation="4.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* horizontal grid + price labels */}
        {ticks.map((tv, i) => {
          const y = yOf(tv);
          if (y < padT - 4 || y > plotBottom + 4) return null;
          return (
            <g key={i}>
              <line
                x1={padL}
                x2={padL + innerW}
                y1={y}
                y2={y}
                stroke="rgba(255,255,255,.07)"
                strokeWidth="1"
                strokeDasharray="2 6"
              />
              <text x={w - 6} y={y + 3.4} textAnchor="end" fontSize="9.5" fill="rgba(255,255,255,.42)" className="tx-num">
                {compact(tv)}
              </text>
            </g>
          );
        })}

        {/* window baseline */}
        <line
          x1={padL}
          x2={padL + innerW}
          y1={baseY}
          y2={baseY}
          stroke="rgba(255,255,255,.3)"
          strokeWidth="1"
          strokeDasharray="5 5"
        />
        <text x={padL + 2} y={baseY - 5} fontSize="8.6" fill="rgba(255,255,255,.4)" letterSpacing="0.8">
          START
        </text>

        {/* per-trade P&L histogram */}
        {bars.map((b, i) => {
          const x = xOf(b.t);
          if (x < padL - 6 || x > padL + innerW + 6) return null;
          const mag = Math.abs(b.pnl) / barMax;
          const bh = Math.max(1.5, mag * (histH - 4));
          const zero = h - padB;
          const up2 = b.pnl >= 0;
          const bw = Math.max(2.5, Math.min(8, innerW / Math.max(6, bars.length) - 2));
          const hot = hoverTrade === b || (hover != null && Math.abs(x - (hoverPt?.x ?? -99)) < bw);
          return (
            <rect
              key={i}
              x={r(x - bw / 2)}
              y={up2 ? r(zero - bh) : r(zero)}
              width={r(bw)}
              height={r(bh)}
              rx={Math.min(2, bw / 2)}
              fill={up2 ? `url(#${uid}-hist)` : 'rgba(255,79,116,.55)'}
              opacity={hot ? 1 : 0.72}
              style={{ transition: 'opacity .18s ease' }}
            />
          );
        })}
        <line x1={padL} x2={padL + innerW} y1={h - padB} y2={h - padB} stroke="rgba(255,255,255,.12)" strokeWidth="1" />

        {/* area fills split by the baseline: profit vs drawdown */}
        {!showEmpty && (
          <>
            <path d={areaPath} fill={`url(#${uid}-fill-up)`} clipPath={`url(#${uid}-clip-up)`} />
            <path d={areaPath} fill={`url(#${uid}-fill-down)`} clipPath={`url(#${uid}-clip-down)`} />
            <path
              d={line}
              fill="none"
              stroke={`url(#${uid}-line)`}
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={drawn ? 0 : 1}
              filter={`url(#${uid}-glow)`}
              style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(.22,1,.36,1)' }}
            />
            {/* baseline-crossing guides for the current value */}
            <line
              x1={last.x}
              x2={last.x}
              y1={last.y}
              y2={plotBottom}
              stroke="rgba(255,255,255,.16)"
              strokeWidth="1"
              strokeDasharray="3 5"
            />
            <circle cx={last.x} cy={last.y} r="4.6" fill={accent} opacity="0.22" className="pnl-live-ring" />
            <circle cx={last.x} cy={last.y} r="2.6" fill={accent} stroke="rgba(4,7,14,.9)" strokeWidth="1.4" />
          </>
        )}

        {/* crosshair */}
        {hoverPt && !showEmpty && (
          <g>
            <line x1={hoverPt.x} x2={hoverPt.x} y1={padT} y2={h - padB} stroke="rgba(255,255,255,.34)" strokeWidth="1" />
            <circle cx={hoverPt.x} cy={hoverPt.y} r="5.4" fill="none" stroke="rgba(255,255,255,.5)" strokeWidth="1.2" />
            <circle cx={hoverPt.x} cy={hoverPt.y} r="2.8" fill="#fff" />
          </g>
        )}

        {/* x-axis time labels */}
        {timeTicks.map((t, i) => (
          <text
            key={i}
            x={r(xOf(t))}
            y={h - 8}
            textAnchor={i === 0 ? 'start' : i === timeTicks.length - 1 ? 'end' : 'middle'}
            fontSize="9.4"
            fill="rgba(255,255,255,.38)"
          >
            {fmtClock(t, span)}
          </text>
        ))}
      </svg>

      {showEmpty && (
        <div className="pnl-empty">
          <strong style={{ color: 'var(--text-soft)' }}>Waiting for the first closed trade</strong>
          <span>The equity curve draws itself the moment the bot books a result.</span>
        </div>
      )}

      {hoverPt && !showEmpty && (
        <div
          className={`pnl-tip ${hoverPt.y < 62 ? 'below' : ''}`}
          style={{
            left: `${Math.max(78, Math.min(w - 78, hoverPt.x))}px`,
            top: `${hoverPt.y < 62 ? hoverPt.y + 6 : hoverPt.y - 4}px`,
          } as CSSProperties}
        >
          <div className="tip-v" style={{ color: hoverDelta >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {hoverDelta >= 0 ? '+' : ''}
            {hoverDelta.toFixed(2)} USDT
          </div>
          <div className="tip-t">
            {new Date(hoverT).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            {' · '}
            {((hoverDelta / (Math.abs(fBase) || 1)) * 100).toFixed(2)}%
          </div>
          {hoverTrade && (
            <div className="tip-t" style={{ color: hoverTrade.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {hoverTrade.side} trade {hoverTrade.pnl >= 0 ? '+' : ''}
              {hoverTrade.pnl.toFixed(2)}
            </div>
          )}
        </div>
      )}

      {live && !showEmpty && (
        <span className="pnl-live-badge" title="Live — updates with the market">
          <i />
          LIVE
        </span>
      )}
    </div>
  );
}

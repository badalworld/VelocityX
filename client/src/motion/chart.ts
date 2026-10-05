/* ============================================================================
   Chart maths — shared helpers for the liquid SVG charts (PNL + sparklines).
   ========================================================================== */

export interface Pt {
  x: number;
  y: number;
}

export interface Series {
  t: number;
  v: number;
}

/** Catmull-Rom → cubic bezier smoothing. Produces the "liquid" curve the whole
 *  design language is built on (no sharp elbows, no overshoot artefacts). */
export function smoothPath(pts: Pt[], tension = 0.42): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;

  let d = `M ${r(pts[0].x)} ${r(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension * 2;
    const c1y = p1.y + ((p2.y - p0.y) / 6) * tension * 2;
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension * 2;
    const c2y = p2.y - ((p3.y - p1.y) / 6) * tension * 2;
    d += ` C ${r(c1x)} ${r(c1y)}, ${r(c2x)} ${r(c2y)}, ${r(p2.x)} ${r(p2.y)}`;
  }
  return d;
}

/** Box-to-3-pass exponential smoother — rounds the step edges of an equity
 *  curve into a flowing line without shifting the endpoints. */
export function smoothValues(values: number[], passes = 3): number[] {
  let out = values.slice();
  const n = out.length;
  if (n < 3) return out;
  for (let p = 0; p < passes; p++) {
    const next = out.slice();
    for (let i = 0; i < n; i++) {
      const a = out[Math.max(0, i - 1)];
      const b = out[i];
      const c = out[Math.min(n - 1, i + 1)];
      next[i] = (a + 2 * b + c) / 4;
    }
    next[0] = out[0];
    next[n - 1] = out[n - 1];
    out = next;
  }
  return out;
}

/** Samples an equity curve across [start, end]: cumulative realised PnL with a
 *  live unrealised tail, resampled to `n` points and smoothed so it reads as a
 *  flowing line even when only a handful of trades exist in the window. */
export function equityCurve(
  trades: Series[],
  opts: { start: number; end: number; base: number; n?: number; smooth?: number },
): number[] {
  const { start, end, base } = opts;
  const n = Math.max(8, opts.n ?? 132);
  const span = Math.max(1, end - start);
  const sorted = trades.filter((s) => Number.isFinite(s.t) && Number.isFinite(s.v)).sort((a, b) => a.t - b.t);

  const raw: number[] = [];
  let acc = base;
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const t = start + (span * i) / (n - 1);
    while (idx < sorted.length && sorted[idx].t <= t) {
      acc = sorted[idx].v;
      idx++;
    }
    raw.push(acc);
  }
  // ensure the final sample reflects the full tail (live unrealised point)
  if (sorted.length) raw[n - 1] = sorted[sorted.length - 1].v;
  return smoothValues(raw, opts.smooth ?? 3);
}

/** Resample an arbitrary value array to a new length (used for chart morphing). */
export function resample(values: number[], n: number): number[] {
  if (values.length === 0) return new Array(n).fill(0);
  if (values.length === n) return values.slice();
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i / Math.max(1, n - 1)) * (values.length - 1);
    const i0 = Math.floor(p);
    const i1 = Math.min(values.length - 1, i0 + 1);
    const f = p - i0;
    out[i] = values[i0] + (values[i1] - values[i0]) * f;
  }
  return out;
}

/** Human-friendly axis ticks covering [min,max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const raw = (max - min) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
  const norm = raw / mag;
  const step = (norm <= 1.2 ? 1 : norm <= 2.2 ? 2 : norm <= 3.2 ? 2.5 : norm <= 6 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.001 && out.length < 12; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

export function compact(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

export function fmtClock(ts: number, span: number): string {
  const d = new Date(ts);
  if (span <= 1000 * 60 * 60 * 36) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  if (span <= 1000 * 60 * 60 * 24 * 45) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
}

export const r = (v: number) => Math.round(v * 100) / 100;

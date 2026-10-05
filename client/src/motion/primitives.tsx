import { PointerEvent as RPointerEvent, ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motionOff, useAnimatedNumber, useElementSize } from '../hooks/motion';
import { smoothPath, Pt, r } from './chart';
import type { CSSProperties } from 'react';

/* ============================================================================
   Primitives — the reusable liquid-glass building blocks.
   ========================================================================== */

/* ---------- animated number ------------------------------------------------ */
export function AnimatedNumber({
  value,
  decimals = 2,
  signed = false,
  unit,
  className,
  duration = 950,
}: {
  value: number | null | undefined;
  decimals?: number;
  signed?: boolean;
  unit?: string;
  className?: string;
  duration?: number;
}) {
  const target = Number.isFinite(value as number) ? (value as number) : 0;
  const animated = useAnimatedNumber(target, duration);
  const show = value == null || !Number.isFinite(value) ? null : animated;

  const text =
    show == null
      ? '—'
      : show.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

  return (
    <span className={`tx-num ${className ?? ''}`}>
      {signed && show != null && show > 0 ? '+' : ''}
      {text}
      {unit ? <span className="cur">{unit}</span> : null}
    </span>
  );
}

/* ---------- button with liquid ripple + magnetic pull --------------------- */
type BtnVariant = 'default' | 'primary' | 'danger' | 'ghost';

export function Btn({
  children,
  variant = 'default',
  size,
  block,
  icon,
  className = '',
  magnetic = true,
  title,
  onClick,
  disabled,
  active,
  type = 'button',
}: {
  children?: ReactNode;
  variant?: BtnVariant;
  size?: 'sm';
  block?: boolean;
  icon?: ReactNode;
  className?: string;
  magnetic?: boolean;
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  type?: 'button' | 'submit';
}) {
  const ref = useRef<HTMLButtonElement>(null);

  const onDown = useCallback((e: RPointerEvent<HTMLButtonElement>) => {
    const el = ref.current;
    if (!el || motionOff()) return;
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const span = document.createElement('span');
    span.className = 'ripple';
    span.style.width = `${size}px`;
    span.style.height = `${size}px`;
    span.style.left = `${e.clientX - rect.left}px`;
    span.style.top = `${e.clientY - rect.top}px`;
    el.appendChild(span);
    window.setTimeout(() => span.remove(), 640);
  }, []);

  const onMove = useCallback(
    (e: RPointerEvent<HTMLButtonElement>) => {
      const el = ref.current;
      if (!el || !magnetic || motionOff()) return;
      if (window.matchMedia && window.matchMedia('(hover: none)').matches) return;
      const rect = el.getBoundingClientRect();
      const px = (e.clientX - rect.left) / Math.max(1, rect.width) - 0.5;
      const py = (e.clientY - rect.top) / Math.max(1, rect.height) - 0.5;
      el.style.transform = `translate(${px * 5}px, ${py * 4 - 2}px)`;
    },
    [magnetic],
  );

  const reset = useCallback(() => {
    const el = ref.current;
    if (el) el.style.transform = '';
  }, []);

  return (
    <button
      ref={ref}
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerLeave={reset}
      onBlur={reset}
      className={`btn ${variant !== 'default' ? variant : ''} ${size === 'sm' ? 'sm' : ''} ${
        block ? 'block' : ''
      } ${active ? 'is-active' : ''} ${className}`}
    >
      {icon ? <span className="btn-ico">{icon}</span> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

/* ---------- panel --------------------------------------------------------- */
export function Panel({
  title,
  sub,
  icon,
  meta,
  children,
  className = '',
  bodyClass = '',
  reveal = true,
  delay,
  headSlot,
  id,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClass?: string;
  reveal?: boolean;
  delay?: number;
  headSlot?: ReactNode;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={`panel ${className}`}
      data-reveal={reveal ? 'true' : undefined}
      data-reveal-delay={delay}
    >
      {(title || meta || headSlot) && (
        <header className="panel-head">
          <div className="panel-title">
            {icon ? <span className="ico">{icon}</span> : null}
            <span>{title}</span>
            {sub ? <span className="tx-sub">{sub}</span> : null}
          </div>
          {headSlot ?? (meta ? <div className="panel-meta">{meta}</div> : null)}
        </header>
      )}
      <div className={`panel-body ${bodyClass}`}>{children}</div>
    </section>
  );
}

/* ---------- segmented control with sliding liquid thumb ------------------- */
export function Segmented<T extends string>({
  value,
  onChange,
  items,
  className = '',
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: string; icon?: ReactNode }[];
  className?: string;
  ariaLabel?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ left: 0, width: 0, ready: false });
  const key = items.map((i) => i.value).join('|');

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const idx = items.findIndex((i) => i.value === value);
      const nodes = el.querySelectorAll<HTMLElement>('.seg-item');
      const node = nodes[idx];
      if (!node) return;
      const wrapRect = el.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      setThumb({ left: rect.left - wrapRect.left + el.scrollLeft, width: rect.width, ready: true });
      // (jsdom / display:none guard — the thumb simply stays hidden when 0 wide)
    };
    measure();
    // re-measure once the browser has finished layout / font metrics
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(measure) : 0;
    const t = window.setTimeout(measure, 60);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => {
        ro.disconnect();
        window.clearTimeout(t);
        if (raf) cancelAnimationFrame(raf);
      };
    }
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.clearTimeout(t);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, key]);

  return (
    <div className={`seg ${className}`} ref={wrapRef} role="tablist" aria-label={ariaLabel}>
      {thumb.ready && thumb.width > 2 && (
        <span
          className="seg-thumb"
          style={{ transform: `translateX(${r(thumb.left)}px)`, width: `${r(thumb.width)}px` }}
          aria-hidden="true"
        />
      )}
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={it.value === value}
          className={`seg-item ${it.value === value ? 'is-active' : ''}`}
          onClick={() => onChange(it.value)}
        >
          {it.icon}
          <span className="seg-label">{it.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------- sparkline ------------------------------------------------------ */
export function Sparkline({
  data,
  className = '',
  color = 'var(--cyan)',
  fill = true,
  strokeWidth = 1.8,
  animate = true,
}: {
  data: number[];
  className?: string;
  color?: string;
  fill?: boolean;
  strokeWidth?: number;
  animate?: boolean;
}) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const [drawn, setDrawn] = useState(!animate || motionOff());
  const uid = useMemo(() => `sp-${Math.random().toString(36).slice(2, 8)}`, []);

  useEffect(() => {
    if (drawn) return;
    const t = window.setTimeout(() => setDrawn(true), 80);
    return () => window.clearTimeout(t);
  }, [drawn]);

  const w = Math.max(20, size.w);
  const h = Math.max(16, size.h);
  const pad = strokeWidth + 1;
  const values = data.length > 1 ? data : [0, 0];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = (w - pad * 2) / (values.length - 1);
  const pts: Pt[] = values.map((v, i) => ({
    x: pad + i * step,
    y: pad + (1 - (v - min) / span) * (h - pad * 2),
  }));
  const line = smoothPath(pts);
  const area = `${line} L ${r(pts[pts.length - 1].x)} ${h} L ${r(pts[0].x)} ${h} Z`;
  const last = pts[pts.length - 1];

  return (
    <div ref={ref} className={`kpi-spark ${className}`}>
      <svg width="100%" height="100%" viewBox={`0 0 ${r(w)} ${r(h)}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={`${uid}-f`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.34" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {fill && drawn && <path d={area} fill={`url(#${uid}-f)`} style={{ transition: 'opacity .6s ease' }} />}
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={drawn ? 0 : 1}
          style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(.22,1,.36,1)' }}
        />
        <circle cx={last.x} cy={last.y} r={2.4} fill={color} opacity={drawn ? 1 : 0} style={{ transition: 'opacity .5s ease .6s' }} />
      </svg>
    </div>
  );
}

/* ---------- progress ring ------------------------------------------------- */
export function Ring({
  pct,
  label,
  value,
  color = 'var(--cyan)',
  glow = 'rgba(62,240,255,.8)',
  size = 104,
  delay = 0,
}: {
  pct: number;
  label: string;
  value: string;
  color?: string;
  glow?: string;
  size?: number;
  delay?: number;
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const R = 42;
  const C = 2 * Math.PI * R;
  const [go, setGo] = useState(motionOff());

  useEffect(() => {
    const t = window.setTimeout(() => setGo(true), 90 + delay);
    return () => window.clearTimeout(t);
  }, [delay]);

  return (
    <div className="ring" style={{ width: size }}>
      <svg viewBox="0 0 100 100">
        <circle className="ring-track" cx="50" cy="50" r={R} />
        <circle
          className="ring-fill"
          cx="50"
          cy="50"
          r={R}
          style={{
            stroke: color,
            strokeDasharray: `${C}`,
            strokeDashoffset: go ? `${C * (1 - clamped / 100)}` : `${C}`,
            transitionDelay: `${delay}ms`,
            '--ring-glow': glow,
          } as CSSProperties}
        />
      </svg>
      <div className="ring-mid">
        <b>{value}</b>
        <span>{label}</span>
      </div>
    </div>
  );
}

/* ---------- goo loader --------------------------------------------------- */
export function LiquidLoader({ label }: { label?: string }) {
  return (
    <div className="loading">
      <span className="goo-loader" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{label ?? 'Syncing…'}</span>
    </div>
  );
}

/* ---------- mini stat tile ---------------------------------------------- */
export function Mini({
  k,
  v,
  tone,
  hint,
  reveal,
}: {
  k: ReactNode;
  v: ReactNode;
  tone?: 'green' | 'red' | 'cyan' | 'amber' | 'violet';
  hint?: ReactNode;
  reveal?: boolean;
}) {
  return (
    <div className="mini" data-reveal={reveal ? 'true' : undefined}>
      <div className="k">{k}</div>
      <div className={`v ${tone ? `t-${tone}` : ''}`}>{v}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

/* ---------- distribution bar ------------------------------------------- */
export function BarRow({
  label,
  pct,
  value,
  tone = 'cyan',
}: {
  label: ReactNode;
  pct: number;
  value: ReactNode;
  tone?: 'cyan' | 'green' | 'red';
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const [go, setGo] = useState(motionOff());
  useEffect(() => {
    const t = window.setTimeout(() => setGo(true), 120);
    return () => window.clearTimeout(t);
  }, [clamped]);
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <span className="bar-track">
        <span className={`bar-fill ${tone === 'cyan' ? '' : tone}`} style={{ width: go ? `${clamped}%` : '0%' }} />
      </span>
      <span className="bar-val">{value}</span>
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/* ============================================================================
   Motion / layout hooks — the shared engine behind the liquid glass UI.
   ========================================================================== */

export function motionOff(): boolean {
  if (typeof document === 'undefined') return true;
  const attr = document.documentElement.dataset.motion;
  if (attr === 'off') return true;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return false;
}

/* ---------- scroll reveal -------------------------------------------------- */
/** Adds `.is-in` to every [data-reveal] / [data-reveal-group] node as it enters
 *  the viewport. Re-runs whenever `key` changes (view switches). */
export function useReveal(key?: unknown): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('[data-reveal]:not(.is-in), [data-reveal-group]:not(.is-in)'),
    );
    if (nodes.length === 0) return;

    if (motionOff() || typeof IntersectionObserver === 'undefined') {
      nodes.forEach((n) => n.classList.add('is-in'));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          const delay = Number(el.dataset.revealDelay || 0);
          if (delay > 0) window.setTimeout(() => el.classList.add('is-in'), delay);
          else el.classList.add('is-in');
          io.unobserve(el);
        }
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.05 },
    );
    nodes.forEach((n) => io.observe(n));

    // Failsafe: anything already inside the viewport must never stay invisible,
    // even if the observer is starved (background tab, exotic engine).
    const failsafe = window.setTimeout(() => {
      nodes.forEach((n) => {
        if (n.classList.contains('is-in')) return;
        const r = n.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0) n.classList.add('is-in');
      });
    }, 2600);

    return () => {
      io.disconnect();
      window.clearTimeout(failsafe);
    };
  }, [key]);
}

/* ---------- eased number tween -------------------------------------------- */
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -9 * t));

/** Animates a number towards `target` with an expo-out ease — count-ups,
 *  drifting P&L read-outs, metric pods. Jumps instantly when motion is off so
 *  values are never stale. */
export function useAnimatedNumber(target: number, duration = 950): number {
  const safeTarget = Number.isFinite(target) ? target : 0;
  const [display, setDisplay] = useState<number>(() => (motionOff() ? safeTarget : 0));
  const fromRef = useRef<number>(motionOff() ? safeTarget : 0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (motionOff()) {
      fromRef.current = safeTarget;
      setDisplay(safeTarget);
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / Math.max(1, duration));
      const v = from + (safeTarget - from) * easeOutExpo(t);
      fromRef.current = v;
      setDisplay(v);
      if (t < 1) rafRef.current = requestAnimationFrame(step);
      else {
        fromRef.current = safeTarget;
        setDisplay(safeTarget);
      }
    };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [safeTarget, duration]);

  return display;
}

/* ---------- media query --------------------------------------------------- */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const on = () => setMatches(mql.matches);
    on();
    if (mql.addEventListener) mql.addEventListener('change', on);
    else mql.addListener(on);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', on);
      else mql.removeListener(on);
    };
  }, [query]);
  return matches;
}

/* ---------- element size -------------------------------------------------- */
export interface Size {
  w: number;
  h: number;
}

export function useElementSize<T extends HTMLElement>(): [React.RefObject<T>, Size] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) =>
        Math.abs(s.w - r.width) < 0.5 && Math.abs(s.h - r.height) < 0.5 ? s : { w: r.width, h: r.height },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, size];
}

/* ---------- cursor-tracked glass sheen ----------------------------------- */
/** Feeds the pointer position into `--mx` / `--my` on every glass surface so
 *  the specular highlight follows the cursor like light on wet glass. */
export function useGlassSheen(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || motionOff()) return;
    if (window.matchMedia && window.matchMedia('(hover: none)').matches) return;

    let raf = 0;
    let last: { el: HTMLElement; x: number; y: number } | null = null;

    const apply = () => {
      raf = 0;
      if (!last) return;
      const r = last.el.getBoundingClientRect();
      last.el.style.setProperty('--mx', `${(((last.x - r.left) / Math.max(1, r.width)) * 100).toFixed(2)}%`);
      last.el.style.setProperty('--my', `${(((last.y - r.top) / Math.max(1, r.height)) * 100).toFixed(2)}%`);
    };

    const onMove = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      const el = t && t.closest ? (t.closest('.glass, .panel, .kpi, .cell, .mini, .pnl-stat, .stat-pod') as HTMLElement | null) : null;
      if (!el) return;
      last = { el, x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(apply);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
}

export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => (typeof document === 'undefined' ? true : !document.hidden));
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

/* ---------- scroll progress ------------------------------------------- */
export function useScrollProgress(): number {
  const [p, setP] = useState(0);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = document.documentElement;
        const max = el.scrollHeight - el.clientHeight;
        setP(max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return p;
}

/* ---------- local storage ---------------------------------------------- */
export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof localStorage === 'undefined') return initial;
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  };
  return [value, set];
}

import { useEffect, useRef } from 'react';
import { motionOff, useDocumentVisible } from '../hooks/motion';

/* ============================================================================
   LiquidBackground — the flowing backdrop.
   ---------------------------------------------------------------------------
   Layer 1  canvas: additive colour blobs drifting on Lissajous paths (GPU
            composited, blurred by CSS → a real liquid colour field)
   Layer 2  aurora: slow drifting radial waves in screen blend mode
   Layer 3  blobs: morphing border-radius metaball shapes, heavily blurred
   Layer 4  mesh grid + film grain + vignette for depth
   All layers pause when the tab is hidden and collapse to a static frame when
   the user disables motion (or asks for reduced motion at OS level).
   ========================================================================== */

const BLOBS = [
  { hue: 186, r: 0.44, ax: 0.32, ay: 0.22, sx: 0.000070, sy: 0.00011, ph: 0.0, a: 0.55 }, // cyan
  { hue: 268, r: 0.5, ax: 0.38, ay: 0.26, sx: 0.000052, sy: -0.00009, ph: 1.7, a: 0.5 }, // violet
  { hue: 158, r: 0.38, ax: 0.3, ay: 0.34, sx: -0.000083, sy: 0.000061, ph: 3.1, a: 0.42 }, // mint
  { hue: 218, r: 0.46, ax: 0.26, ay: 0.3, sx: 0.000096, sy: 0.00012, ph: 4.4, a: 0.5 }, // blue
  { hue: 196, r: 0.3, ax: 0.22, ay: 0.2, sx: -0.00012, sy: -0.00007, ph: 5.6, a: 0.36 }, // teal spark
];

export default function LiquidBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visible = useDocumentVisible();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let raf = 0;
    const scale = 0.28;

    const resize = () => {
      w = Math.max(320, Math.floor(window.innerWidth * scale));
      h = Math.max(240, Math.floor(window.innerHeight * scale));
      canvas.width = w;
      canvas.height = h;
    };
    resize();

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      const base = Math.max(w, h);
      for (const b of BLOBS) {
        const x = w * (0.5 + Math.cos(t * b.sx * 6.283 + b.ph) * b.ax);
        const y = h * (0.5 + Math.sin(t * b.sy * 6.283 + b.ph * 1.3) * b.ay);
        const rad = base * b.r * (1 + 0.08 * Math.sin(t * 0.00021 + b.ph));
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, `hsla(${b.hue}, 96%, 64%, ${b.a})`);
        g.addColorStop(0.45, `hsla(${b.hue + 12}, 92%, 56%, ${b.a * 0.42})`);
        g.addColorStop(1, `hsla(${b.hue + 24}, 90%, 50%, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    };

    if (motionOff()) {
      draw(12000);
      return;
    }

    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible) return;
      if (now - last < 33) return; // ~30fps is plenty for a blurred field
      last = now;
      draw(now);
    };
    raf = requestAnimationFrame(loop);

    const onResize = () => {
      resize();
      draw(performance.now());
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [visible]);

  return (
    <div className="bg-stack" aria-hidden="true">
      <canvas ref={canvasRef} className="liquid-canvas" />
      <div className="aurora" />
      <div className="goo-layer">
        <span className="goo-blob b1" />
        <span className="goo-blob b2" />
        <span className="goo-blob b3" />
      </div>
      <div className="grid-layer" />
      <div className="grain" />
      <div className="vignette" />
    </div>
  );
}

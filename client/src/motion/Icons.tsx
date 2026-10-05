import { SVGProps } from 'react';

/* ============================================================================
   Icons — one stroke-consistent family (24px grid, 1.8 stroke, round caps).
   Each icon accepts a `className` so CSS can animate the strokes (draw-in,
   wiggle, pulse) exactly like a Lottie icon template.
   ========================================================================== */

type P = SVGProps<SVGSVGElement>;

function Base({ children, ...p }: P & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...p}
    >
      {children}
    </svg>
  );
}

export const IconBolt = (p: P) => (
  <Base {...p}>
    <path d="M13 2 4.5 13.2h6L11 22l8.5-11.2h-6L13 2Z" />
  </Base>
);

export const IconPulse = (p: P) => (
  <Base {...p}>
    <path d="M2 12h4l2.5-6 3 12 3-8 2 2h5.5" />
  </Base>
);

export const IconChart = (p: P) => (
  <Base {...p}>
    <path d="M4 20V9M9.3 20V4M14.7 20v-8M20 20v-5" />
  </Base>
);

export const IconWallet = (p: P) => (
  <Base {...p}>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a1 1 0 0 1 1 1v2" />
    <rect x="3" y="7.5" width="18" height="11.5" rx="2.6" />
    <path d="M16.5 13.2h.01" />
  </Base>
);

export const IconTarget = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.6" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
  </Base>
);

export const IconShield = (p: P) => (
  <Base {...p}>
    <path d="M12 3 5 5.7v5.6c0 4.3 2.9 7.7 7 9.2 4.1-1.5 7-4.9 7-9.2V5.7L12 3Z" />
    <path d="m9.2 12.3 2 2 3.6-4" />
  </Base>
);

export const IconTrend = (p: P) => (
  <Base {...p}>
    <path d="M3 17.5 8.5 11l4 3.4L21 6" />
    <path d="M15.5 6H21v5.3" />
  </Base>
);

export const IconLayers = (p: P) => (
  <Base {...p}>
    <path d="m12 3 8.5 4.6L12 12.2 3.5 7.6 12 3Z" />
    <path d="m4 12.3 8 4.3 8-4.3" />
    <path d="m4 16.6 8 4.3 8-4.3" />
  </Base>
);

export const IconSettings = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </Base>
);

export const IconHistory = (p: P) => (
  <Base {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3.5 4.5V9h4.4" />
    <path d="M12 8v4.4l3 1.8" />
  </Base>
);

export const IconSparkles = (p: P) => (
  <Base {...p}>
    <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.8L12 18l-1.7-5.5L4.8 10.7 10.3 9 12 3.5Z" />
    <path d="M18.5 4v2.4M20 5.2h-3" />
  </Base>
);

export const IconActivity = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 7.6v4.7l3.1 1.9" />
  </Base>
);

export const IconRadar = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <circle cx="12" cy="12" r="4.6" />
    <path d="M12 12 18.4 6.4" />
  </Base>
);

export const IconGauge = (p: P) => (
  <Base {...p}>
    <path d="M4 17a9 9 0 1 1 16 0" />
    <path d="m12 12.6 3.8-3.1" />
    <circle cx="12" cy="13.4" r="1.6" />
  </Base>
);

export const IconWaves = (p: P) => (
  <Base {...p}>
    <path d="M2.5 8.5c2.4-2.6 6-2.6 8.4 0s6 2.6 8.4 0" />
    <path d="M2.5 13.4c2.4-2.6 6-2.6 8.4 0s6 2.6 8.4 0" />
    <path d="M2.5 18.3c2.4-2.6 6-2.6 8.4 0s6 2.6 8.4 0" />
  </Base>
);

export const IconKill = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M6.4 6.4 17.6 17.6" />
  </Base>
);





export const IconInfo = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 11v5.4M12 7.9h.01" />
  </Base>
);

export const IconCheck = (p: P) => (
  <Base {...p}>
    <path d="m4.5 12.8 4.7 4.6L19.5 6.8" />
  </Base>
);

export const IconAlert = (p: P) => (
  <Base {...p}>
    <path d="M12 4.2 2.8 19.6h18.4L12 4.2Z" />
    <path d="M12 10v4.2M12 17h.01" />
  </Base>
);



export const IconCoins = (p: P) => (
  <Base {...p}>
    <ellipse cx="12" cy="7" rx="7.5" ry="3.3" />
    <path d="M4.5 7v10c0 1.8 3.4 3.3 7.5 3.3s7.5-1.5 7.5-3.3V7" />
    <path d="M4.5 12c0 1.8 3.4 3.3 7.5 3.3s7.5-1.5 7.5-3.3" />
  </Base>
);

export const IconScale = (p: P) => (
  <Base {...p}>
    <path d="M12 4v16M6 8h12" />
    <path d="M6 8 3.5 14h5L6 8ZM18 8l-2.5 6h5L18 8Z" />
  </Base>
);


export const IconCrown = (p: P) => (
  <Base {...p}>
    <path d="M3.5 8.2 7 13l5-7 5 7 3.5-4.8-1.4 11H4.9L3.5 8.2Z" />
  </Base>
);

export const IconDrop = (p: P) => (
  <Base {...p}>
    <path d="M12 3.5s6 6.2 6 10.2a6 6 0 0 1-12 0C6 9.7 12 3.5 12 3.5Z" />
  </Base>
);

/* ---------- brand mark: liquid "V" with velocity trail -------------------- */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="vx-brand-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3ef0ff" />
          <stop offset="55%" stopColor="#8fd7ff" />
          <stop offset="100%" stopColor="#a874ff" />
        </linearGradient>
      </defs>
      <path
        d="M5 6.5 16 26 27 6.5"
        fill="none"
        stroke="url(#vx-brand-g)"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1}
        className="brand-draw"
      />
      <path
        d="M12.4 5.4h7.2"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.75"
        strokeWidth="2.2"
        strokeLinecap="round"
        className="brand-flare"
      />
    </svg>
  );
}

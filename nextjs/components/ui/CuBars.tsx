'use client';

import { useEffect, useRef } from 'react';

// Decorative compute-unit bars that idle-breathe and grow on scroll — the
// signature background of the deployed OPEN site. Ported 1:1 from the rAF loop
// in web/landing.html so the motion reads identically.

const BAR_COUNT = 64;

// Deterministic per-bar pseudo-random so server and client render the same
// markup (no hydration mismatch) and each bar keeps a stable peak/phase.
function seeded(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

const BARS = Array.from({ length: BAR_COUNT }, (_, i) => ({
  i,
  high: seeded(i + 100) > 0.78,
  peak: 28 + seeded(i) * 64,
  phase: seeded(i + 50) * 1.2,
  jitter: 0.85 + seeded(i + 7) * 0.3,
  breatheFreq: 0.6 + seeded(i + 200) * 0.9,
  breatheOff: seeded(i + 300) * Math.PI * 2,
}));

export function CuBars(): React.JSX.Element {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;

    const state = BARS.map((b) => ({ ...b, current: 0.03 }));
    const docEl = document.documentElement;
    const SMOOTH = 0.22;
    let raf = 0;

    function frame(): void {
      const scrollTop = window.scrollY || docEl.scrollTop;
      const scrollMax = docEl.scrollHeight - window.innerHeight;
      const progress = scrollMax > 0 ? Math.min(1, scrollTop / scrollMax) : 0;

      const idleFloor = 0.22;
      const now = performance.now();
      const t = now * 0.001;
      const sweepPos = ((now * 0.00025) % 1) * state.length;

      for (let i = 0; i < state.length; i += 1) {
        const b = state[i];
        const el = barsRef.current[i];
        if (!b || !el) continue;

        const localProgress = Math.max(0, Math.min(1, progress * 1.6 - b.phase * 0.5));
        const scrollEased = 1 - Math.pow(1 - localProgress, 3);
        const activity = idleFloor + (1 - idleFloor) * scrollEased;
        const breathe = 1 + Math.sin(t * b.breatheFreq + b.breatheOff) * 0.14;
        const dist = Math.abs(i - sweepPos);
        const wrap = Math.min(dist, state.length - dist);
        const sweepBoost = Math.exp(-Math.pow(wrap / 5.5, 2)) * 0.32;

        const target = Math.max(
          0.03,
          (activity * b.peak * b.jitter * breathe * (1 + sweepBoost)) / 100,
        );

        b.current += (target - b.current) * SMOOTH;
        el.style.transform = `scaleY(${b.current})`;
      }

      raf = requestAnimationFrame(frame);
    }

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="cu-bg" aria-hidden="true">
      <div className="cu-bars">
        {BARS.map((bar) => (
          <span
            key={bar.i}
            ref={(el) => {
              barsRef.current[bar.i] = el;
            }}
            className={bar.high ? 'cu-bar high' : 'cu-bar'}
            style={{ '--bar-i': bar.i } as React.CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}

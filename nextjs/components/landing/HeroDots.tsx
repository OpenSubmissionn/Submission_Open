'use client';

import { useEffect, useState, type CSSProperties } from 'react';

// Scattered green dots that pulse and slowly drift behind the hero title —
// like log blips. Generated on the client (random per-dot timing) so there is
// no server/client markup to reconcile. Ported from web/landing.html.

const COUNT = 70;

export function HeroDots(): React.JSX.Element {
  const [dots, setDots] = useState<CSSProperties[]>([]);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const next = Array.from({ length: COUNT }, () => {
      const size = 2 + Math.random() * 3;
      const drift = 7 + Math.random() * 7;
      return {
        width: `${size}px`,
        height: `${size}px`,
        left: `${Math.random() * 100}%`,
        top: `${Math.random() * 100}%`,
        ['--dur']: `${2 + Math.random() * 3}s`,
        ['--delay']: `${-Math.random() * 4}s`,
        ['--max-op']: `${0.3 + Math.random() * 0.5}`,
        ['--dx']: `${((Math.random() - 0.5) * 50).toFixed(1)}px`,
        ['--dy']: `${((Math.random() - 0.5) * 50).toFixed(1)}px`,
        ['--drift']: `${drift}s`,
        ['--drift-delay']: `${-Math.random() * drift}s`,
      } as CSSProperties;
    });
    setDots(next);
  }, []);

  return (
    <div className="hero-dots" aria-hidden="true">
      {dots.map((style, index) => (
        <span key={index} className="hero-dot" style={style} />
      ))}
    </div>
  );
}

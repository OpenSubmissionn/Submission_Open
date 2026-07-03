'use client';

import { useEffect, useRef, useState } from 'react';

interface SectionHeadProps {
  eyebrow: string;
  title: string;
  subtitle: string;
}

// Section heading with the deployed site's word-by-word cascade reveal. The
// title is split into `.word` spans (each with a staggered `--i`) and the whole
// block fades in once it scrolls into view.
export function SectionHead({ eyebrow, title, subtitle }: SectionHeadProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  const words = title.split(/\s+/);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!('IntersectionObserver' in window)) {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
          }
        });
      },
      { threshold: 0.18, rootMargin: '0px 0px -8% 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={inView ? 'section-head in-view' : 'section-head'}>
      <div className="section-eyebrow">{eyebrow}</div>
      <h2>
        {words.map((word, index) => (
          <span key={`${word}-${index}`} className="word" style={{ '--i': index } as React.CSSProperties}>
            {word}
            {index < words.length - 1 ? ' ' : ''}
          </span>
        ))}
      </h2>
      <p>{subtitle}</p>
    </div>
  );
}

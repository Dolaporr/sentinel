import React, { useEffect, useRef, useState } from 'react';

interface ScrollRevealProps {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  direction?: 'up' | 'none';
}

/**
 * ScrollReveal: Reveals elements smoothly and eagerly as they scroll into view.
 * Detects initial viewport presence immediately and uses positive rootMargin (180px)
 * so elements animate in smoothly BEFORE reaching the bottom fold, eliminating any dragging requirement.
 */
export const ScrollReveal: React.FC<ScrollRevealProps> = ({
  children,
  className = '',
  delay = 0,
  direction = 'up',
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // If user prefers reduced motion, show immediately
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) {
      setIsVisible(true);
      return;
    }

    const element = ref.current;
    if (!element) return;

    // Immediate check: if already near or within viewport on mount, reveal instantly
    const rect = element.getBoundingClientRect();
    if (rect.top <= window.innerHeight + 180) {
      setIsVisible(true);
      return;
    }

    // Eager positive bottom rootMargin triggers 180px before entering viewport
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.unobserve(entry.target);
        }
      },
      {
        threshold: 0,
        rootMargin: '0px 0px 180px 0px',
      }
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  const transformClass =
    direction === 'up'
      ? isVisible
        ? 'translate-y-0 opacity-100'
        : 'translate-y-3 opacity-0'
      : isVisible
      ? 'opacity-100'
      : 'opacity-0';

  return (
    <div
      ref={ref}
      className={`transition-[opacity,transform] duration-500 ease-out ${transformClass} ${className}`}
      style={{
        transitionDelay: isVisible && delay > 0 ? `${Math.min(delay, 100)}ms` : '0ms',
        willChange: isVisible ? 'auto' : 'transform, opacity',
      }}
    >
      {children}
    </div>
  );
};

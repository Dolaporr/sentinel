import React, { useEffect, useState } from 'react';

interface SentinelBackdropProps {
  mode?: 'landing' | 'replay';
  className?: string;
}

export const SentinelBackdrop: React.FC<SentinelBackdropProps> = ({
  mode = 'landing',
  className = '',
}) => {
  const [hasEntered, setHasEntered] = useState(false);
  const [isReducedMotion, setIsReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setIsReducedMotion(mq.matches);

    const handler = (e: MediaQueryListEvent) => setIsReducedMotion(e.matches);
    mq.addEventListener('change', handler);

    // Initial entrance fade-in
    const timer = setTimeout(() => {
      setHasEntered(true);
    }, 100);

    return () => {
      mq.removeEventListener('change', handler);
      clearTimeout(timer);
    };
  }, []);

  const isLanding = mode === 'landing';

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none fixed inset-0 overflow-hidden select-none z-0 ${className}`}
    >
      {/* Ambient background light pools (radial gradients for 60fps GPU rendering without costly blur passes) */}
      <div
        className="absolute top-[-10%] right-[5%] w-[550px] h-[550px] pointer-events-none"
        style={{
          background: 'radial-gradient(circle, rgba(59, 130, 246, 0.04) 0%, transparent 65%)',
        }}
      />
      <div
        className="absolute top-[25%] left-[-5%] w-[450px] h-[450px] pointer-events-none"
        style={{
          background: 'radial-gradient(circle, rgba(148, 163, 184, 0.025) 0%, transparent 65%)',
        }}
      />

      {/* Sentinel Figure Container:
          Positioned in upper-right / hero background so on mobile it frames the headline and header
          rather than being buried behind the opaque terminal.
          Opacity tuned so visitors catch a clear, badass glimpse of it in the background without washed-out text. */}
      <div
        className={`absolute transition-opacity duration-700 ease-out transform-gpu ${
          isLanding
            ? 'top-[-10px] -right-8 sm:right-0 md:right-[2%] lg:right-[6%] xl:right-[10%] w-[380px] sm:w-[500px] md:w-[620px] lg:w-[720px] xl:w-[820px]'
            : 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[120%] max-w-[900px]'
        }`}
        style={{
          opacity: hasEntered ? (isLanding ? 0.48 : 0.12) : 0,
        }}
      >
        {/* Atmospheric Floating Wrapper */}
        <div
          className={`relative w-full transform-gpu ${
            !isReducedMotion ? 'sentinel-float-motion' : ''
          }`}
          style={{ aspectRatio: '800 / 652' }}
        >
          {/* Base Sentinel Image with Vignette Feathering */}
          <div
            className={`w-full h-full relative ${
              !isReducedMotion && isLanding ? 'sentinel-breathe-cycle' : ''
            }`}
            style={{
              maskImage:
                'radial-gradient(ellipse 75% 70% at 62% 44%, black 30%, rgba(0,0,0,0.75) 60%, transparent 92%)',
              WebkitMaskImage:
                'radial-gradient(ellipse 75% 70% at 62% 44%, black 30%, rgba(0,0,0,0.75) 60%, transparent 92%)',
            }}
          >
            <img
              src="/sentinel-bg.png"
              alt=""
              className="w-full h-full object-cover select-none pointer-events-none filter contrast-110 brightness-95"
              loading="eager"
            />
          </div>

          {/* Directional gradient fades to blend naturally into dark chassis */}
          <div className="absolute inset-0 bg-gradient-to-t from-chassis via-transparent to-transparent pointer-events-none" />
          <div className="absolute inset-0 bg-gradient-to-r from-chassis/40 via-transparent to-chassis/40 pointer-events-none" />
        </div>
      </div>
    </div>
  );
};

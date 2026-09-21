import React from 'react';

interface SentinelLogoProps {
  size?: number;
  state?: 'shut' | 'clear' | 'auto';
  isAdmitted?: boolean;
  className?: string;
}

/**
 * Sentinel "The Gate" Logo
 * Brand Specification:
 * - A bracket pair with the bar dropped.
 * - Shut: [ | ] with amber center bar (#E9A13B)
 * - Clear: [   ] when a call is admitted (the bar lifts).
 */
export const SentinelLogo: React.FC<SentinelLogoProps> = ({
  size = 20,
  state = 'shut',
  isAdmitted = false,
  className = '',
}) => {
  const isClear = state === 'clear' || (state === 'auto' && isAdmitted);

  return (
    <span
      className={`inline-flex items-center justify-center relative select-none shrink-0 ${className}`}
      style={{ width: size, height: size }}
      title={isClear ? 'Sentinel: Call Admitted [Clear]' : 'Sentinel: Gate Shut [Armed]'}
      role="img"
      aria-label="Sentinel Logo"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="overflow-visible"
      >
        {/* Left Bracket */}
        <path
          d="M 0 0 H 35 V 12 H 12 V 88 H 35 V 100 H 0 Z"
          fill="currentColor"
          className="transition-colors duration-200"
        />

        {/* Right Bracket */}
        <path
          d="M 100 0 H 65 V 12 H 88 V 88 H 65 V 100 H 100 Z"
          fill="currentColor"
          className="transition-colors duration-200"
        />

        {/* Center Gate Bar: Amber (#E9A13B), lifts when call is admitted */}
        <rect
          x="44"
          y="12"
          width="12"
          height="76"
          rx="6"
          fill="#E9A13B"
          style={{
            transform: isClear ? 'translateY(-30px) scaleY(0.4)' : 'translateY(0) scaleY(1)',
            opacity: isClear ? 0.15 : 1,
            transformOrigin: '50% 12%',
            transition: 'transform 260ms cubic-bezier(0.16, 1, 0.3, 1), opacity 220ms ease-out',
          }}
        />
      </svg>
    </span>
  );
};

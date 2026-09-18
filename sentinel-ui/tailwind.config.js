/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Neutral palette (canvas, panels, rules, text)
        chassis: {
          DEFAULT: '#0B0D10',
          surface: '#101318',
        },
        ledger: {
          DEFAULT: '#13161C',
          plate: '#171B22',
          border: '#212630',
          subtle: '#2B323F',
        },
        rule: {
          DEFAULT: '#6F7B8C',
          dim: '#47505E',
          bright: '#98A5B6',
        },
        argent: {
          DEFAULT: '#F1F3F5',
          muted: '#C5CBD3',
        },
        // Semantic Token 1: Decision (governor intervention only)
        decision: {
          DEFAULT: '#2563EB',
          bright: '#3B82F6',
          border: '#60A5FA',
          subtle: 'rgba(37, 99, 235, 0.12)',
        },
        governor: {
          DEFAULT: '#2563EB',
          bright: '#3B82F6',
          border: '#60A5FA',
          subtle: 'rgba(37, 99, 235, 0.12)',
        },
        // Semantic Token 2: Breach (unprotected runner exceeding ceiling only)
        breach: {
          DEFAULT: '#DC2626',
          bright: '#EF4444',
          border: '#F87171',
          subtle: 'rgba(220, 38, 38, 0.15)',
        },
        crimson: {
          DEFAULT: '#DC2626',
          bright: '#EF4444',
          border: '#F87171',
          subtle: 'rgba(220, 38, 38, 0.15)',
        },
        // Solvency & warning aliases collapsed to clean neutral / subtle
        solvency: {
          DEFAULT: '#98A5B6',
          dim: '#6F7B8C',
        },
        warning: {
          DEFAULT: '#98A5B6',
          bright: '#F1F3F5',
          border: '#47505E',
          subtle: 'rgba(111, 123, 140, 0.15)',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
        sans: ['"Inter"', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

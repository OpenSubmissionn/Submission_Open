import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Official OPEN palette (from landing.html :root). The names the
        // existing components already use are preserved; `accent` maps to the
        // official blue so `bg-accent` / `text-accent-soft` stay on-brand.
        bg: '#07070d',
        'bg-soft': '#0d0d18',
        fg: '#e8e8f0',
        'fg-dim': '#9a9ab0',
        'fg-mute': '#5a5a72',
        border: '#1f1f2e',
        'border-bright': '#2c2c44',
        purple: '#9945ff',
        'purple-soft': '#b07cff',
        green: '#14f195',
        'green-soft': '#4dffba',
        yellow: '#ffc857',
        red: '#ff4d6d',
        blue: '#1e7fff',
        'blue-bright': '#3b9eff',
        'blue-soft': '#60a5fa',
        orange: '#f59e0b',
        accent: '#1e7fff',
        'accent-soft': '#60a5fa',
      },
      borderRadius: {
        card: '14px',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', 'ui-monospace', 'monospace'],
      },
      screens: {
        tablet: { max: '820px' },
        mobile: { max: '540px' },
      },
      keyframes: {
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        growX: {
          from: { transform: 'scaleX(0)' },
          to: { transform: 'scaleX(1)' },
        },
        panelFade: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'fadeUp 0.4s cubic-bezier(0.2, 0.7, 0.2, 1) forwards',
        'grow-x': 'growX 0.5s cubic-bezier(0.2, 0.7, 0.2, 1) forwards',
        'panel-fade': 'panelFade 0.35s ease-out',
      },
    },
  },
  plugins: [],
};

export default config;

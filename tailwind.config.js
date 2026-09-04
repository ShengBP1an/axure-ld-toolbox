/** @type {import('tailwindcss').Config} */

// 生成 0..100 的完整不透明度刻度。
// 默认刻度只有 0/5/10/20/25/… ，而本工具的深色面板需要
// 6%/8%/12%/18%/35%/45% 这类细粒度叠加色，缺失会导致类名静默失效。
const fineOpacity = Object.fromEntries(
  Array.from({ length: 101 }, (_, i) => [String(i), String(i / 100)]),
);

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      opacity: fineOpacity,
      fontFamily: {
        sans: ['Roboto', 'Inter', 'Segoe UI', 'Microsoft YaHei', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'Menlo', 'monospace'],
      },
      fontSize: {
        body: ['13px', { lineHeight: '1.6' }],
        sub: ['14px', { lineHeight: '1.5' }],
        head: ['20px', { lineHeight: '1.4' }],
      },
      colors: {
        ink: {
          900: '#0A0E14',
          800: '#111823',
          700: '#1A2331',
          600: '#232F3F',
          500: '#2E3D50',
        },
        fg: {
          DEFAULT: '#E6EDF3',
          muted: '#9AA9BC',
          dim: '#5A6979',
        },
        brand: {
          DEFAULT: '#22D3EE',
          sky: '#0EA5E9',
          indigo: '#6366F1',
        },
        ok: '#34D399',
        warn: '#FBBF24',
        danger: '#F87171',
        accent2: '#A78BFA',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(34,211,238,0.35), 0 0 20px -4px rgba(34,211,238,0.45)',
        panel: '0 8px 32px -8px rgba(0,0,0,0.65)',
        paper: '0 16px 48px -12px rgba(0,0,0,0.8)',
      },
      backgroundImage: {
        'brand-grad': 'linear-gradient(135deg, #22D3EE 0%, #0EA5E9 50%, #6366F1 100%)',
        'panel-grad': 'linear-gradient(180deg, rgba(35,47,63,0.72) 0%, rgba(17,24,35,0.72) 100%)',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scan-band': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(300%)' },
        },
        'pulse-ring': {
          '0%,100%': { opacity: '0.25' },
          '50%': { opacity: '1' },
        },
        breathe: {
          '0%,100%': { opacity: '0.35', transform: 'scale(1)' },
          '50%': { opacity: '0.7', transform: 'scale(1.06)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 220ms ease-out both',
        'scan-band': 'scan-band 1.6s linear infinite',
        'pulse-ring': 'pulse-ring 800ms ease-in-out 2',
        breathe: 'breathe 3.4s ease-in-out infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

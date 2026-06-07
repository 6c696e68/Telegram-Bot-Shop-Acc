/**
 * Tailwind config — Telegram Mini App ("Obsidian Glass").
 *
 * Hệ token màu Material-3 (giá trị hex CỐ ĐỊNH theo design `obsidian_glass/DESIGN.md`).
 * Dark-only: lớp `.dark` luôn bật trên <html>. Safe-area do Telegram WebApp cấp lúc runtime.
 * Typography: Inter (UI/headline) + JetBrains Mono (label/metadata).
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'on-error-container': '#ffdad6',
        'surface-container-highest': '#31353d',
        'surface-tint': '#adc6ff',
        'tertiary-fixed-dim': '#ffb595',
        'surface-container-low': '#181c23',
        'on-tertiary-fixed-variant': '#7c2e00',
        'surface-container-lowest': '#0b0e16',
        'secondary-container': '#3630bf',
        'on-surface': '#e0e2ed',
        error: '#ffb4ab',
        'on-background': '#e0e2ed',
        'surface-container-high': '#272a32',
        'error-container': '#93000a',
        'surface-container': '#1c2028',
        'on-secondary-fixed-variant': '#332dbc',
        'primary-container': '#4b8eff',
        outline: '#8b90a0',
        'tertiary-container': '#ef6719',
        surface: '#10131b',
        'on-primary-fixed': '#001a41',
        primary: '#adc6ff',
        'surface-dim': '#10131b',
        'secondary-fixed-dim': '#c2c1ff',
        secondary: '#c2c1ff',
        'tertiary-fixed': '#ffdbcc',
        'inverse-on-surface': '#2d3039',
        'primary-fixed-dim': '#adc6ff',
        'surface-variant': '#31353d',
        'on-tertiary': '#571e00',
        'on-error': '#690005',
        'inverse-surface': '#e0e2ed',
        'on-tertiary-fixed': '#351000',
        'on-secondary-container': '#b1b1ff',
        'primary-fixed': '#d8e2ff',
        'secondary-fixed': '#e2dfff',
        'on-primary': '#002e69',
        'on-tertiary-container': '#4c1a00',
        'inverse-primary': '#005bc1',
        'on-secondary-fixed': '#0c006b',
        tertiary: '#ffb595',
        'on-secondary': '#1800a7',
        'on-primary-fixed-variant': '#004493',
        'on-primary-container': '#00285c',
        'outline-variant': '#414755',
        'surface-bright': '#363942',
        background: '#10131b',
        'on-surface-variant': '#c1c6d7',
      },
      borderRadius: {
        DEFAULT: '0.25rem',
        lg: '0.5rem',
        xl: '0.75rem',
        '2xl': '1rem',
        full: '9999px',
      },
      spacing: {
        unit: '8px',
        'stack-sm': '8px',
        'stack-md': '16px',
        'stack-lg': '32px',
        gutter: '16px',
        'container-margin': '24px',
        'safe-top': 'var(--safe-top)',
        'safe-bottom': 'var(--safe-bottom)',
        'safe-left': 'var(--safe-left)',
        'safe-right': 'var(--safe-right)',
      },
      fontFamily: {
        'headline-lg-mobile': ['Inter', 'system-ui', 'sans-serif'],
        'label-sm': ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        'body-md': ['Inter', 'system-ui', 'sans-serif'],
        'headline-lg': ['Inter', 'system-ui', 'sans-serif'],
        'display-lg': ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        'display-lg': ['48px', { lineHeight: '1.1', letterSpacing: '-0.02em', fontWeight: '700' }],
        'headline-lg': ['32px', { lineHeight: '1.2', letterSpacing: '-0.01em', fontWeight: '600' }],
        'headline-lg-mobile': ['28px', { lineHeight: '1.2', fontWeight: '600' }],
        'body-md': ['16px', { lineHeight: '1.5', letterSpacing: '0', fontWeight: '400' }],
        'label-sm': ['12px', { lineHeight: '1.0', letterSpacing: '0.05em', fontWeight: '500' }],
      },
      transitionTimingFunction: {
        ios: 'cubic-bezier(0.32, 0.72, 0, 1)',
        'ios-fade': 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      transitionDuration: {
        ios: '280ms',
      },
      keyframes: {
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
    },
  },
  plugins: [],
}

import type { Config } from 'tailwindcss';

/**
 * The design system lives in CSS custom properties (see src/styles/tokens.css
 * and theme.css), driven by `data-theme` / `data-density` on <html>. We surface
 * the most-used tokens as Tailwind utilities so new UI can use `bg-surface`,
 * `text-fg-muted`, `border-line`, `font-mono`, etc. — while existing components
 * keep reading the variables directly.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: 'var(--accent)',
          fg: 'var(--accent-fg)',
          fill: 'var(--accent-fill)',
          border: 'var(--accent-border)',
        },
        app: 'var(--app-bg)',
        panel: 'var(--panel-bg)',
        surface: {
          DEFAULT: 'var(--surface)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
        },
        fg: {
          DEFAULT: 'var(--fg)',
          muted: 'var(--fg-muted)',
          subtle: 'var(--fg-subtle)',
          faint: 'var(--fg-faint)',
        },
        line: {
          DEFAULT: 'var(--border)',
          strong: 'var(--border-strong)',
          divider: 'var(--divider)',
        },
        status: {
          running: 'var(--st-running)',
          queued: 'var(--st-queued)',
          success: 'var(--st-success)',
          warning: 'var(--st-warning)',
          failed: 'var(--st-failed)',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        xl: '12px',
      },
    },
  },
  plugins: [],
} satisfies Config;

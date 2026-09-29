/**
 * Every color here resolves to a theme token defined in src/app/globals.css.
 * Tokens are stored as RGB channels so Tailwind opacity modifiers work
 * (`bg-af-accent/15`). Themes (Midnight, Vanilla, Charcoal) only swap the
 * channel values; no component should reach for raw palette colors.
 */
const token = (name) => `rgb(var(--af-${name}-rgb) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/utils/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/lib/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        af: {
          bg: token('bg'),
          panel: token('panel'),
          'panel-2': token('panel-2'),
          elevated: token('elevated'),
          hover: token('hover'),
          active: token('active'),
          raised: token('raised'),
          border: token('border'),
          'border-strong': token('border-strong'),
          text: token('text'),
          'text-2': token('text-2'),
          'text-3': token('text-3'),
          'text-4': token('text-4'),
          accent: token('accent'),
          'accent-hover': token('accent-hover'),
          'on-accent': token('on-accent'),
          record: token('record'),
          danger: token('danger'),
          'on-danger': token('on-danger'),
          success: token('success'),
          warning: token('warning'),
        },
        // shadcn/ui names, mapped onto the same tokens so Radix primitives and
        // BlockNote follow the active theme.
        background: token('panel'),
        foreground: token('text'),
        border: token('border'),
        input: token('border-strong'),
        ring: token('accent'),
        primary: { DEFAULT: token('accent'), foreground: token('on-accent') },
        secondary: { DEFAULT: token('panel-2'), foreground: token('text') },
        card: { DEFAULT: token('panel'), foreground: token('text') },
        popover: { DEFAULT: token('elevated'), foreground: token('text') },
        muted: { DEFAULT: token('panel-2'), foreground: token('text-3') },
        accent: { DEFAULT: token('hover'), foreground: token('text') },
        destructive: { DEFAULT: token('danger'), foreground: token('on-danger') },
      },
      borderRadius: {
        sm: '6px',
        DEFAULT: '8px',
        md: '9px',
        lg: '12px',
        xl: '14px',
        '2xl': '18px',
        '3xl': '24px',
      },
      boxShadow: {
        sm: 'var(--af-shadow-sm)',
        DEFAULT: 'var(--af-shadow-md)',
        md: 'var(--af-shadow-md)',
        lg: 'var(--af-shadow-lg)',
        xl: 'var(--af-shadow-lg)',
        '2xl': 'var(--af-shadow-xl)',
      },
      transitionTimingFunction: {
        af: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'af-rise': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'af-pop': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'none' },
        },
        'af-shimmer': {
          from: { backgroundPosition: '200% 0' },
          to: { backgroundPosition: '-200% 0' },
        },
        'af-flash': {
          '0%': { backgroundColor: 'rgb(var(--af-accent-rgb) / 0.28)' },
          '100%': { backgroundColor: 'rgb(var(--af-accent-rgb) / 0)' },
        },
        'af-breathe': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'af-rise': 'af-rise 260ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'af-pop': 'af-pop 180ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'af-shimmer': 'af-shimmer 1.6s linear infinite',
        'af-flash': 'af-flash 2.4s ease-out 1',
        'af-breathe': 'af-breathe 1.8s ease-in-out infinite',
      },
      typography: () => {
        const c = (name) => `rgb(var(--af-${name}-rgb))`;
        const colors = {
          '--tw-prose-body': c('text-2'),
          '--tw-prose-headings': c('text'),
          '--tw-prose-lead': c('text-2'),
          '--tw-prose-links': c('accent'),
          '--tw-prose-bold': c('text'),
          '--tw-prose-counters': c('text-3'),
          '--tw-prose-bullets': c('text-4'),
          '--tw-prose-hr': c('border'),
          '--tw-prose-quotes': c('text'),
          '--tw-prose-quote-borders': c('border-strong'),
          '--tw-prose-captions': c('text-3'),
          '--tw-prose-code': c('text'),
          '--tw-prose-pre-code': c('text'),
          '--tw-prose-pre-bg': c('panel-2'),
          '--tw-prose-th-borders': c('border-strong'),
          '--tw-prose-td-borders': c('border'),
        };
        // `prose-invert` must not flip to Tailwind's stock palette: the tokens
        // already follow the active theme.
        const invert = Object.fromEntries(
          Object.entries(colors).map(([key, value]) => [key.replace('--tw-prose-', '--tw-prose-invert-'), value]),
        );
        return {
          DEFAULT: {
            css: {
              ...colors,
              ...invert,
              maxWidth: 'none',
              a: { textDecoration: 'none', fontWeight: '500' },
              'a:hover': { textDecoration: 'underline' },
              'code::before': { content: 'none' },
              'code::after': { content: 'none' },
              code: {
                backgroundColor: c('panel-2'),
                borderRadius: '6px',
                padding: '0.1em 0.35em',
                fontWeight: '500',
              },
            },
          },
        };
      },
    },
  },
  plugins: [require('tailwindcss-animate'), require('@tailwindcss/typography')],
};

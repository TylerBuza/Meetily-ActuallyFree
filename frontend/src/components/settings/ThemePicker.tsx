'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { THEMES, useAppTheme, type ThemeInfo } from '@/lib/app-theme';

/** A tiny rendition of the app in the theme's own colors. */
function ThemePreview({ theme }: { theme: ThemeInfo }) {
  const [canvas, panel, raised, text, accent] = theme.swatch;
  return (
    <div className="relative h-24 overflow-hidden rounded-lg" style={{ background: canvas }}>
      <div className="absolute inset-y-0 left-0 w-[28%] border-r" style={{ background: panel, borderColor: `${text}14` }}>
        <div className="mx-2 mt-2.5 h-2.5 rounded-full" style={{ background: '#ef4444', opacity: 0.9 }} />
        {[0, 1, 2].map((row) => (
          <div key={row} className="mx-2 mt-2 h-1.5 rounded-full" style={{ background: text, opacity: 0.18 + (row === 0 ? 0.14 : 0) }} />
        ))}
      </div>
      <div className="absolute inset-y-0 left-[28%] right-0 p-2.5" style={{ background: panel }}>
        <div className="h-2 w-2/3 rounded-full" style={{ background: text, opacity: 0.85 }} />
        <div className="mt-1.5 h-1.5 w-1/2 rounded-full" style={{ background: text, opacity: 0.3 }} />
        <div className="mt-3 rounded-md p-2" style={{ background: raised }}>
          <div className="h-1.5 w-5/6 rounded-full" style={{ background: text, opacity: 0.35 }} />
          <div className="mt-1.5 h-1.5 w-3/5 rounded-full" style={{ background: text, opacity: 0.25 }} />
        </div>
        <div className="absolute bottom-2.5 right-2.5 h-3 w-10 rounded-full" style={{ background: accent }} />
      </div>
    </div>
  );
}

export function ThemePicker() {
  const [current, setTheme] = useAppTheme();

  return (
    <div role="radiogroup" aria-label="Theme" className="grid gap-3 sm:grid-cols-3">
      {THEMES.map((theme) => {
        const selected = theme.id === current;
        return (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(theme.id)}
            className={cn(
              'group relative rounded-xl border p-2 text-left transition-[border-color,box-shadow,transform] duration-200 ease-af',
              'hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60',
              selected
                ? 'border-af-accent shadow-[0_0_0_1px_rgb(var(--af-accent-rgb))]'
                : 'border-af-border hover:border-af-border-strong hover:shadow-md',
            )}
          >
            <ThemePreview theme={theme} />
            <div className="flex items-start justify-between gap-2 px-1 pb-0.5 pt-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-af-text">{theme.label}</p>
                <p className="mt-0.5 text-xs text-af-text-3">{theme.description}</p>
              </div>
              <span
                className={cn(
                  'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-200',
                  selected ? 'border-af-accent bg-af-accent text-af-on-accent' : 'border-af-border-strong text-transparent',
                )}
              >
                <Check className="h-3 w-3" strokeWidth={3} />
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

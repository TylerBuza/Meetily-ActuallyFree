'use client';

import { useEffect, useState } from 'react';

/**
 * App themes. Colors live in globals.css as channel tokens under
 * `:root[data-theme='…']`; this module only decides which theme is active.
 *
 * The choice is stored in localStorage, which the main window and the minibar
 * share, so a change in Settings repaints both.
 */
export type AppTheme = 'midnight' | 'vanilla' | 'charcoal';

export interface ThemeInfo {
  id: AppTheme;
  label: string;
  description: string;
  dark: boolean;
  /** Canvas, panel, raised surface, text, accent: used for theme previews. */
  swatch: [string, string, string, string, string];
}

export const THEMES: ThemeInfo[] = [
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'Deep navy. The default.',
    dark: true,
    swatch: ['#0a0c10', '#0f1218', '#181d27', '#e6edf5', '#3b7cf0'],
  },
  {
    id: 'vanilla',
    label: 'Vanilla',
    description: 'Warm cream with ink-blue accents.',
    dark: false,
    swatch: ['#efe8dc', '#faf6ef', '#fffcf7', '#2a2319', '#2f5ecf'],
  },
  {
    id: 'charcoal',
    label: 'Charcoal',
    description: 'Warm charcoal with clay accents.',
    dark: true,
    swatch: ['#141211', '#1b1917', '#262321', '#f0ede9', '#de8462'],
  },
];

export const DEFAULT_THEME: AppTheme = 'midnight';
const THEME_STORAGE_KEY = 'meetily_theme';
const THEME_EVENT = 'af-theme-change';

function normalizeTheme(value: string | null): AppTheme {
  if (value === 'midnight' || value === 'vanilla' || value === 'charcoal') return value;
  // Stored by the old light/dark toggle.
  if (value === 'light') return 'vanilla';
  return DEFAULT_THEME;
}

export function themeInfo(theme: AppTheme): ThemeInfo {
  return THEMES.find((entry) => entry.id === theme) ?? THEMES[0];
}

export function getSavedAppTheme(): AppTheme {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** Paint the document with `theme`. `persist` also saves it and tells other windows. */
export function applyAppTheme(theme: AppTheme, persist = false) {
  if (typeof window === 'undefined') return;
  const info = themeInfo(theme);
  const root = document.documentElement;
  root.setAttribute('data-theme', info.id);
  root.classList.toggle('dark', info.dark);

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, info.id);
    } catch {
      // Storage can be unavailable in locked-down webviews; the paint still applies.
    }
  }
  window.dispatchEvent(new CustomEvent<AppTheme>(THEME_EVENT, { detail: info.id }));

  if ('__TAURI_INTERNALS__' in window) {
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(info.dark ? 'dark' : 'light'))
      .catch((error) => console.warn('Failed to sync the native window theme:', error));
  }
}

/**
 * Runs in <head> before the first paint so the window never flashes the
 * default theme. Kept dependency-free because it is inlined as a string.
 */
export const THEME_BOOT_SCRIPT = `
(function () {
  try {
    var saved = localStorage.getItem('${THEME_STORAGE_KEY}');
    var theme = saved === 'vanilla' || saved === 'charcoal' || saved === 'midnight'
      ? saved
      : (saved === 'light' ? 'vanilla' : 'midnight');
    var root = document.documentElement;
    root.setAttribute('data-theme', theme);
    if (theme === 'vanilla') root.classList.remove('dark');
    else root.classList.add('dark');
  } catch (_) {}
})();
`;

/** Current theme, kept in sync with Settings and with the other app window. */
export function useAppTheme(): [AppTheme, (theme: AppTheme) => void] {
  const [theme, setTheme] = useState<AppTheme>(DEFAULT_THEME);

  useEffect(() => {
    setTheme(getSavedAppTheme());
    const onLocal = (event: Event) => setTheme((event as CustomEvent<AppTheme>).detail);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = normalizeTheme(event.newValue);
      applyAppTheme(next);
      setTheme(next);
    };
    window.addEventListener(THEME_EVENT, onLocal);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(THEME_EVENT, onLocal);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return [theme, (next: AppTheme) => applyAppTheme(next, true)];
}

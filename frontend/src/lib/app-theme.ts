export type AppTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'meetily_theme';

export function getSavedAppTheme(): AppTheme {
  if (typeof window === 'undefined') return 'dark';
  return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
}

export function applyAppTheme(theme: AppTheme, persist = false) {
  if (typeof window === 'undefined') return;

  if (persist) localStorage.setItem(THEME_STORAGE_KEY, theme);
  document.documentElement.classList.toggle('dark', theme === 'dark');

  if ('__TAURI_INTERNALS__' in window) {
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme))
      .catch((error) => console.warn('Failed to sync the native window theme:', error));
  }
}

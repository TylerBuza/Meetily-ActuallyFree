/**
 * Locale registry and persistence.
 *
 * The interface language is a display preference only: it does not change the
 * transcription language, the summary output language, or date handling in
 * saved data. It is stored in `localStorage`, which WebView2 keeps per app
 * origin, so it survives restarts and is shared by the compact recorder window.
 */

export const LOCALES = [
  { id: 'en', label: 'English', nativeLabel: 'English' },
  { id: 'zh-CN', label: 'Chinese (Simplified)', nativeLabel: '简体中文' },
] as const

export type Locale = (typeof LOCALES)[number]['id']

/** English stays the default so existing behaviour is unchanged until a user
 *  picks another language. */
export const DEFAULT_LOCALE: Locale = 'en'

export const LOCALE_STORAGE_KEY = 'meetily_ui_locale'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALES.some((locale) => locale.id === value)
}

/** Reads the saved locale, or the default when it is unset or unreadable. */
export function getSavedLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    return isLocale(saved) ? saved : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

export function saveLocale(locale: Locale): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // A full or unavailable storage quota only loses the preference.
  }
}

/** Keeps the document language in sync for screen readers and browser hints. */
export function applyDocumentLocale(locale: Locale): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
  if (locale === DEFAULT_LOCALE) {
    document.documentElement.removeAttribute('data-locale')
  } else {
    document.documentElement.setAttribute('data-locale', locale)
  }
}

export function localeNativeLabel(locale: Locale): string {
  return LOCALES.find((entry) => entry.id === locale)?.nativeLabel ?? locale
}

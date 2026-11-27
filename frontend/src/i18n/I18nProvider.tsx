'use client'

/**
 * Interface-language provider.
 *
 * The initial render uses English so the hydrating client markup matches the
 * static export; the saved preference is applied in an effect immediately after
 * mount. Rendering `html` content in the saved language during hydration would
 * otherwise produce a mismatch, because the exported HTML is built once in
 * English.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { MessageKey } from './messages/en'
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  applyDocumentLocale,
  getSavedLocale,
  isLocale,
  saveLocale,
  type Locale,
} from './locales'
import { setCurrentLocale, translate } from './translate'
import type { TranslateValues } from './types'

export interface I18nContextValue {
  /** Active interface language. */
  locale: Locale
  /** Changes the language immediately, persists it, and updates `<html lang>`. */
  setLocale: (locale: Locale) => void
  t: (key: MessageKey, values?: TranslateValues) => string
}

/**
 * Components rendered without the provider (isolated tests, previews) keep
 * working in English instead of throwing.
 */
const fallbackValue: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  setLocale: () => undefined,
  t: (key, values) => translate(DEFAULT_LOCALE, key, values),
}

const I18nContext = createContext<I18nContextValue>(fallbackValue)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE)

  const apply = useCallback((next: Locale) => {
    setLocaleState(next)
    setCurrentLocale(next)
    applyDocumentLocale(next)
  }, [])

  const setLocale = useCallback(
    (next: Locale) => {
      apply(next)
      saveLocale(next)
    },
    [apply],
  )

  useEffect(() => {
    const saved = getSavedLocale()
    if (saved !== DEFAULT_LOCALE) apply(saved)
    else setCurrentLocale(DEFAULT_LOCALE)
  }, [apply])

  // The compact recorder is a separate window: keep it in step when the main
  // window changes the language.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== LOCALE_STORAGE_KEY) return
      apply(isLocale(event.newValue) ? event.newValue : DEFAULT_LOCALE)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [apply])

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, values) => translate(locale, key, values),
    }),
    [locale, setLocale],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/** Access the active language and its `t()` function. */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}

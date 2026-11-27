import { DEFAULT_LOCALE, type Locale } from './locales'
import { en, type MessageKey } from './messages/en'
import { zhCN } from './messages/zh-CN'
import { flattenMessages, type TranslateValues } from './types'

/** Flattened `{ "namespace.key": "text" }` dictionaries, built once at import. */
export const MESSAGES: Record<Locale, Record<string, string>> = {
  en: flattenMessages(en),
  'zh-CN': flattenMessages(zhCN),
}

const PLACEHOLDER = /\{(\w+)\}/g

/** Substitutes `{name}` placeholders; unknown placeholders are left untouched
 *  so a copied message cannot silently lose text. */
export function interpolate(text: string, values?: TranslateValues): string {
  if (!values) return text
  return text.replace(PLACEHOLDER, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  )
}

// Module-level locale for non-React callers (services, IPC event handlers).
// `I18nProvider` keeps it in sync with the React state.
let currentLocale: Locale = DEFAULT_LOCALE

export function getCurrentLocale(): Locale {
  return currentLocale
}

export function setCurrentLocale(locale: Locale): void {
  currentLocale = locale
}

const warnedKeys = new Set<string>()

/**
 * Resolves a message for an explicit locale, falling back to English and then
 * to the key itself. Translations are checked by TypeScript and by
 * `tests/i18n/messages.test.ts`; the runtime fallback protects a packaged build
 * from a gap that slips through.
 */
export function translate(locale: Locale, key: MessageKey, values?: TranslateValues): string {
  const dictionary = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE]
  let text = dictionary[key]
  if (text === undefined) {
    if (process.env.NODE_ENV !== 'production' && !warnedKeys.has(key)) {
      warnedKeys.add(key)
      console.warn(`[i18n] Missing message "${key}" for "${locale}"`)
    }
    text = MESSAGES[DEFAULT_LOCALE][key]
  }
  return interpolate(text ?? key, values)
}

/** Translates with the locale last applied by `I18nProvider`. */
export function tNow(key: MessageKey, values?: TranslateValues): string {
  return translate(currentLocale, key, values)
}

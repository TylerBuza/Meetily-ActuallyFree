/**
 * Guards the message catalogues: every English message needs a Simplified
 * Chinese translation with the same placeholders, so a UI string cannot quietly
 * fall back to English in a packaged build.
 */
import { expect, test } from 'bun:test'
import { LOCALES, DEFAULT_LOCALE } from '../../src/i18n/locales'
import type { MessageKey } from '../../src/i18n/messages/en'
import { MESSAGES, interpolate, translate } from '../../src/i18n/translate'

const enKeys = Object.keys(MESSAGES.en).sort()
const zhKeys = Object.keys(MESSAGES['zh-CN']).sort()

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

test('the locale registry offers English and Simplified Chinese with English as default', () => {
  expect(LOCALES.map((locale) => locale.id)).toEqual(['en', 'zh-CN'])
  expect(DEFAULT_LOCALE).toBe('en')
})

test('both locales are populated', () => {
  expect(enKeys.length).toBeGreaterThan(100)
  expect(zhKeys.length).toBe(enKeys.length)
})

test('every English message has a Chinese translation and no extra Chinese keys exist', () => {
  const missing = enKeys.filter((key) => !zhKeys.includes(key))
  const extra = zhKeys.filter((key) => !enKeys.includes(key))
  expect({ missing, extra }).toEqual({ missing: [], extra: [] })
})

test('no message is empty', () => {
  const empty = [
    ...enKeys.filter((key) => MESSAGES.en[key].trim() === '').map((key) => `en:${key}`),
    ...zhKeys.filter((key) => MESSAGES['zh-CN'][key].trim() === '').map((key) => `zh-CN:${key}`),
  ]
  expect(empty).toEqual([])
})

test('each translation uses exactly the placeholders of its English message', () => {
  const mismatched = enKeys
    .map((key) => {
      const en = placeholders(MESSAGES.en[key])
      const zh = placeholders(MESSAGES['zh-CN'][key] ?? '')
      const same = en.length === zh.length && en.every((name, index) => name === zh[index])
      return same ? null : { key, en, zh }
    })
    .filter((entry) => entry !== null)
  expect(mismatched).toEqual([])
})

test('interpolation replaces known placeholders and leaves unknown braces alone', () => {
  expect(interpolate('{count} meetings for {name}', { count: 3, name: 'Ada' })).toBe('3 meetings for Ada')
  expect(interpolate('{count} meetings', {})).toBe('{count} meetings')
  expect(interpolate('plain text')).toBe('plain text')
})

test('translate resolves the active locale and falls back to English, then to the key', () => {
  const firstKey = enKeys[0] as MessageKey
  expect(translate('en', firstKey)).toBe(MESSAGES.en[firstKey])
  expect(translate('zh-CN', firstKey)).toBe(MESSAGES['zh-CN'][firstKey])

  // A locale without a dictionary falls back to English rather than throwing.
  expect(translate('zh-TW' as never, firstKey)).toBe(MESSAGES.en[firstKey])

  // A key missing from both catalogues degrades to the key itself.
  expect(translate('en', 'no.such.message' as MessageKey)).toBe('no.such.message')
})

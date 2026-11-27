/**
 * Date wording follows the interface language. English keeps its previous
 * output; the Chinese locale switches relative wording, units and calendar
 * formatting explicitly instead of relying on the OS locale.
 */
import { afterEach, expect, test } from 'bun:test'
import { setCurrentLocale } from '../../src/i18n/translate'
import {
  dateSection,
  formatClockTime,
  formatDuration,
  formatLongDate,
  formatRelativeFuture,
  formatRelativePast,
  formatShortDate,
  formatWeekdayShort,
  formatWhen,
} from '../../src/lib/dates'

const now = new Date(2026, 8, 28, 12, 0, 0)
const at = (days: number, hours = 12) => new Date(2026, 8, 28 + days, hours, 0, 0)

afterEach(() => setCurrentLocale('en'))

test('English keeps the previous wording and units', () => {
  expect(dateSection(now, now)).toBe('Today')
  expect(dateSection(at(-1), now)).toBe('Yesterday')
  expect(dateSection(at(-3), now)).toBe('Previous 7 days')
  expect(formatRelativeFuture(new Date(now.getTime() + 2 * 3600_000), now)).toBe('in 2 hours')
  expect(formatRelativeFuture(at(1), now)).toBe('tomorrow')
  expect(formatRelativePast(at(-3), now)).toBe('3 days ago')
  expect(formatDuration(45)).toBe('45s')
  expect(formatDuration(65)).toBe('1m')
  expect(formatDuration(38)).toBe('38s')
  expect(formatDuration(3900)).toBe('1h 05m')
  expect(formatWhen(now, now)).toMatch(/^Today, /)
})

test('Simplified Chinese switches relative wording, units and formatting', () => {
  setCurrentLocale('zh-CN')
  expect(dateSection(now, now)).toBe('今天')
  expect(dateSection(at(-1), now)).toBe('昨天')
  expect(dateSection(at(-3), now)).toBe('过去 7 天')
  expect(dateSection(at(-10), now)).toBe('本月早些时候')
  expect(formatRelativeFuture(new Date(now.getTime() + 2 * 3600_000), now)).toBe('2 小时后')
  expect(formatRelativeFuture(new Date(now.getTime() + 20 * 60_000), now)).toBe('20 分钟后')
  expect(formatRelativeFuture(at(1), now)).toBe('明天')
  expect(formatRelativePast(at(-3), now)).toBe('3 天前')
  expect(formatRelativePast(at(-14), now)).toBe('2 周前')
  expect(formatDuration(45)).toBe('45秒')
  expect(formatDuration(65)).toBe('1分钟')
  expect(formatDuration(38)).toBe('38秒')
  expect(formatDuration(3900)).toBe('1小时05分')
  expect(formatWhen(now, now)).toMatch(/^今天 /)
  expect(formatShortDate(now, now)).toBe('9月28日')
  expect(formatLongDate(now)).toBe('9月28日星期一')
  expect(formatClockTime(now)).toBe('12:00')
  expect(formatWeekdayShort(now)).toBe('周一')
})

test('switching back to English restores the English wording', () => {
  setCurrentLocale('zh-CN')
  expect(dateSection(now, now)).toBe('今天')
  setCurrentLocale('en')
  expect(dateSection(now, now)).toBe('Today')
})

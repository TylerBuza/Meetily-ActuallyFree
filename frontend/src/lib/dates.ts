/** Date wording shared by lists, headers, and search. */
import { formatDistanceToNow } from 'date-fns'
import { zhCN as dateFnsZhCN } from 'date-fns/locale'
import { getCurrentLocale, tNow } from '@/i18n/translate'

const DAY_MS = 86_400_000;

/**
 * Chinese interface dates use Chinese calendar wording even when the OS locale
 * is different. English keeps the system locale, which is what the app used
 * before the interface language existed.
 */
function intlLocale(): string | undefined {
  return getCurrentLocale() === 'zh-CN' ? 'zh-CN' : undefined;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Section a date falls in, relative to now: Today, Yesterday, Previous 7 days, … */
export function dateSection(date: Date, now: Date = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (days <= 0) return tNow('dates.today');
  if (days === 1) return tNow('dates.yesterday');
  if (days < 7) return tNow('dates.previous7Days');
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return tNow('dates.earlierThisMonth');
  return date.toLocaleDateString(intlLocale(), {
    month: 'long',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/** True when the date belongs to the Today or Yesterday section. Callers use this
 *  instead of comparing `dateSection()` output, which is language-dependent. */
export function isRecentDateSection(date: Date, now: Date = new Date()): boolean {
  return Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS) <= 1;
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString(intlLocale(), { hour: 'numeric', minute: '2-digit' });
}

/** Large clock time on the recording-ready screen. */
export function formatClockTime(date: Date): string {
  return formatTime(date).replace(/\u202f/g, ' ');
}

/** "Saturday, November 28" / "11月28日星期六". */
export function formatLongDate(date: Date): string {
  return date.toLocaleDateString(intlLocale(), { weekday: 'long', month: 'long', day: 'numeric' });
}

/** "Nov 28" / "11月28日". */
export function formatMonthDay(date: Date): string {
  return date.toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric' });
}

/** "Thu" / "周四". */
export function formatWeekdayShort(date: Date): string {
  return date.toLocaleDateString(intlLocale(), { weekday: 'short' });
}

/** Long date line written into exported documents and copied Markdown. */
export function formatDocumentDate(date: Date): string {
  return date.toLocaleDateString(intlLocale(), {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** "Thu, Nov 19, 2026" style stamp used beside a meeting title. */
export function formatDateStamp(date: Date, now: Date = new Date()): string {
  return date.toLocaleDateString(intlLocale(), {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

export function formatShortDate(date: Date, now: Date = new Date()): string {
  return date.toLocaleDateString(intlLocale(), {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/** "Today, 2:30 PM", "Yesterday, 9:00 AM", "Sep 12, 4:15 PM". */
export function formatWhen(date: Date, now: Date = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  const time = formatTime(date);
  if (days === 0) return tNow('dates.todayWithTime', { time });
  if (days === 1) return tNow('dates.yesterdayWithTime', { time });
  if (days > 1 && days < 7) {
    return `${date.toLocaleDateString(intlLocale(), { weekday: 'long' })}, ${time}`;
  }
  return `${formatShortDate(date, now)}, ${time}`;
}

/** "in 2 days", "tomorrow", "in 3 hours", "in 12 min", "now". */
export function formatRelativeFuture(target: Date, now: Date = new Date()): string {
  const diff = target.getTime() - now.getTime();
  if (diff <= 5 * 60_000) return diff > -60 * 60_000 ? tNow('dates.now') : tNow('dates.earlier');
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return tNow('dates.inMinutes', { minutes });
  const days = Math.round((startOfDay(target) - startOfDay(now)) / DAY_MS);
  if (days === 0) {
    const hours = Math.round(minutes / 60);
    return hours === 1 ? tNow('dates.inHoursOne', { hours }) : tNow('dates.inHoursOther', { hours });
  }
  if (days === 1) return tNow('dates.tomorrow');
  return tNow('dates.inDaysOther', { days });
}

/** "Last seen 3 days ago" style: "today", "yesterday", "3 days ago", "Sep 12". */
export function formatRelativePast(date: Date, now: Date = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (days <= 0) return tNow('dates.today');
  if (days === 1) return tNow('dates.yesterday');
  if (days < 7) return tNow('dates.daysAgoOther', { days });
  if (days < 28) {
    const weeks = Math.round(days / 7);
    return weeks === 1 ? tNow('dates.weeksAgoOne', { weeks }) : tNow('dates.weeksAgoOther', { weeks });
  }
  return formatShortDate(date, now);
}

/** "45m", "1h 05m", "38s". */
export function formatDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return tNow('dates.durationHoursMinutes', { hours: h, minutes: String(m).padStart(2, '0') });
  if (m > 0) return tNow('dates.durationMinutes', { minutes: m });
  return tNow('dates.durationSeconds', { seconds: total });
}

/** "5 minutes ago" style text that follows the interface language. English keeps
 *  date-fns' default English wording, which is what this app showed before. */
export function formatTimeAgo(date: Date): string {
  return formatDistanceToNow(date, {
    addSuffix: true,
    locale: getCurrentLocale() === 'zh-CN' ? dateFnsZhCN : undefined,
  });
}

/** Recording timer: "4:05", "12:34", "1:02:03". */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

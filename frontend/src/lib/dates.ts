import { useEffect, useState } from 'react';

/** Date wording shared by lists, headers, and search. */

const DAY_MS = 86_400_000;

/** Returns a stable key for the current calendar day (e.g. "2026-10-01"),
 * updating automatically when midnight passes or the window regains focus. */
export function useCurrentDayKey(): string {
  const getTodayKey = () => {
    const now = new Date();
    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  };

  const [todayKey, setTodayKey] = useState(getTodayKey);

  useEffect(() => {
    const checkDay = () => {
      const current = getTodayKey();
      setTodayKey((prev) => (prev !== current ? current : prev));
    };

    const interval = setInterval(checkDay, 30_000);
    window.addEventListener('focus', checkDay);
    document.addEventListener('visibilitychange', checkDay);

    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', checkDay);
      document.removeEventListener('visibilitychange', checkDay);
    };
  }, []);

  return todayKey;
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
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return 'Earlier this month';
  return date.toLocaleDateString(undefined, {
    month: 'long',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatShortDate(date: Date, now: Date = new Date()): string {
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/** "Today, 2:30 PM", "Yesterday, 9:00 AM", "Sep 12, 4:15 PM". */
export function formatWhen(date: Date, now: Date = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  const time = formatTime(date);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  if (days > 1 && days < 7) return `${date.toLocaleDateString(undefined, { weekday: 'long' })}, ${time}`;
  return `${formatShortDate(date, now)}, ${time}`;
}

/** "in 2 days", "tomorrow", "in 3 hours", "in 12 min", "now". */
export function formatRelativeFuture(target: Date, now: Date = new Date()): string {
  const diff = target.getTime() - now.getTime();
  if (diff <= 5 * 60_000) return diff > -60 * 60_000 ? 'now' : 'earlier';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const days = Math.round((startOfDay(target) - startOfDay(now)) / DAY_MS);
  if (days === 0) {
    const hours = Math.round(minutes / 60);
    return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** "Last seen 3 days ago" style: "today", "yesterday", "3 days ago", "Sep 12". */
export function formatRelativePast(date: Date, now: Date = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 28) {
    const weeks = Math.round(days / 7);
    return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  }
  return formatShortDate(date, now);
}

/** "45m", "1h 05m", "38s". */
export function formatDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
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

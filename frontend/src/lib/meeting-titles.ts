/**
 * Default meeting titles. A title the user hasn't chosen should still tell
 * meetings apart at a glance, so it carries the day and the time slot.
 *
 *   "Meeting · Mon, Sep 28 · 2:30 PM"        while recording
 *   "Meeting · Mon, Sep 28 · 2:30–3:15 PM"   once it ends
 *   "Weekly Standup — Sep 28"                for a group's meeting
 *
 * Rust records titles starting with DEFAULT_PREFIX as automatic (see
 * is_default_meeting_title). Summaries never rename a meeting; only the user does.
 */

export const DEFAULT_PREFIX = 'Meeting · ';

const dayLabel = (date: Date) =>
  date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const shortDay = (date: Date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
// Newer ICU puts a narrow no-break space before AM/PM; titles are typed and
// searched, so keep a plain space.
const timeLabel = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/\u202f/g, ' ');

/** "2:30–3:15 PM", or "11:30 AM–12:15 PM" when the meridiem changes. */
export function timeRange(start: Date, end: Date): string {
  const from = timeLabel(start);
  const to = timeLabel(end);
  if (from === to) return from;
  const meridiem = /\s?(AM|PM)$/i;
  const fromMeridiem = meridiem.exec(from)?.[1];
  const toMeridiem = meridiem.exec(to)?.[1];
  if (fromMeridiem && fromMeridiem === toMeridiem) return `${from.replace(meridiem, '')}–${to}`;
  return `${from}–${to}`;
}

export function defaultMeetingTitle(start: Date): string {
  return `${DEFAULT_PREFIX}${dayLabel(start)} · ${timeLabel(start)}`;
}

/** Adds the end of the time slot to an untouched default title. */
export function finalizeDefaultTitle(title: string, start: Date, end: Date): string {
  if (title !== defaultMeetingTitle(start)) return title;
  if (end.getTime() - start.getTime() < 60_000) return title;
  return `${DEFAULT_PREFIX}${dayLabel(start)} · ${timeRange(start, end)}`;
}

/** "Weekly Standup — Sep 28"; adds the time if that name is already taken. */
export function groupMeetingTitle(groupName: string, start: Date, existingTitles: string[] = []): string {
  const base = `${groupName.trim()} — ${shortDay(start)}`;
  return existingTitles.includes(base) ? `${base}, ${timeLabel(start)}` : base;
}

const LEGACY_DEFAULT = [
  /^\+ New Call$/,
  /^New Meeting$/,
  /^Meeting \d{2}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/,
  /^Meeting \d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/,
];

export function isDefaultTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed.startsWith(DEFAULT_PREFIX) || LEGACY_DEFAULT.some((pattern) => pattern.test(trimmed));
}

/**
 * What to show for a stored title. Older auto titles such as
 * "Meeting 27_09_26_23_05_13" read as the new format instead.
 */
export function displayTitle(title: string | null | undefined, createdAt?: string | null): string {
  const trimmed = (title ?? '').trim();
  if (!trimmed) return 'Untitled meeting';
  if (LEGACY_DEFAULT.some((pattern) => pattern.test(trimmed)) && createdAt) {
    const date = new Date(createdAt);
    if (!Number.isNaN(date.getTime())) return defaultMeetingTitle(date);
  }
  return trimmed;
}

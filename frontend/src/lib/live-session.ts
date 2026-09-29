/**
 * What the app (not Rust) owns about the recording in progress: the title
 * shown in the header, and notes typed during the call. Rust keeps the name
 * the recording started with, so changes made mid-call live here until the
 * meeting is saved, then land on the saved meeting.
 */
import { defaultMeetingTitle, finalizeDefaultTitle, groupMeetingTitle } from '@/lib/meeting-titles';

const TITLE_KEY = 'af-live-title';
const NOTES_KEY = 'af-live-notes';
const CHANGE_EVENT = 'af-live-session';

export interface LiveTitle {
  title: string;
  /** The user typed it, so picking a group no longer retitles the meeting. */
  manual: boolean;
  /** When the recording started (ms), for the default title's time slot. */
  startedAt: number;
}

export interface LiveNotes {
  markdown: string;
  json: unknown[] | null;
  updatedAt: number;
}

function read<T>(storage: Storage | undefined, key: string): T | null {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(storage: Storage | undefined, key: string, value: unknown) {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is best effort; the header still shows the title in memory.
  }
}

const session = () => (typeof window === 'undefined' ? undefined : window.sessionStorage);
// Notes survive a crash or reload of the window.
const local = () => (typeof window === 'undefined' ? undefined : window.localStorage);

export function readLiveTitle(): LiveTitle | null {
  const value = read<LiveTitle>(session(), TITLE_KEY);
  return value && typeof value.title === 'string' && value.title.trim() ? value : null;
}

export function writeLiveTitle(value: LiveTitle | null) {
  write(session(), TITLE_KEY, value);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** "Meeting · Mon, Sep 28 · 2:30 PM", or the group's "Weekly Standup — Sep 28". */
export function automaticTitle(startedAt: Date, groupName?: string | null, existingTitles: string[] = []): string {
  return groupName?.trim() ? groupMeetingTitle(groupName, startedAt, existingTitles) : defaultMeetingTitle(startedAt);
}

/**
 * The title to save when the recording ends: the user's own if they typed
 * one, otherwise the automatic title with its time slot completed.
 */
export function finalLiveTitle(fallback: string, endedAt: Date = new Date()): string {
  const live = readLiveTitle();
  if (!live) return fallback;
  if (live.manual) return live.title.trim();
  return finalizeDefaultTitle(live.title, new Date(live.startedAt), endedAt);
}

export function readLiveNotes(): LiveNotes | null {
  const value = read<LiveNotes>(local(), NOTES_KEY);
  return value && typeof value.markdown === 'string' ? value : null;
}

export function writeLiveNotes(notes: { markdown: string; json: unknown[] | null } | null) {
  write(local(), NOTES_KEY, notes ? { ...notes, updatedAt: Date.now() } : null);
}

/** A new recording starts with its automatic title and an empty page. */
export function beginLiveSession(title: string, startedAt: number) {
  writeLiveNotes(null);
  writeLiveTitle({ title, manual: false, startedAt });
}

export function endLiveSession() {
  writeLiveNotes(null);
  writeLiveTitle(null);
}

/** Subscribe to title changes made anywhere in this window. */
export function onLiveSessionChange(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

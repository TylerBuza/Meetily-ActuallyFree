/**
 * The group the next (or current) recording is filed under. It lives in
 * session storage so the choice survives navigating to the recorder, and is
 * applied when the meeting is saved.
 */
export const PENDING_GROUP_KEY = 'pendingRecordingGroup';
export const PENDING_GROUP_EVENT = 'af-pending-group';

export interface PendingGroup {
  id: string;
  name: string;
}

export function readPendingGroup(): PendingGroup | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(PENDING_GROUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingGroup;
    if (!parsed?.id || !parsed?.name?.trim()) return null;
    return { id: parsed.id, name: parsed.name.trim() };
  } catch {
    return null;
  }
}

export function writePendingGroup(group: PendingGroup | null) {
  if (typeof window === 'undefined') return;
  try {
    if (!group) sessionStorage.removeItem(PENDING_GROUP_KEY);
    else sessionStorage.setItem(PENDING_GROUP_KEY, JSON.stringify(group));
  } catch {
    // Without storage the group simply isn't remembered.
  }
  window.dispatchEvent(new CustomEvent(PENDING_GROUP_EVENT));
}

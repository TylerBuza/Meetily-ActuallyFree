/**
 * (Removed) Recording-start "inform participants this meeting is being recorded" reminder.
 *
 * This fork intentionally does not show that compliance reminder — users already know
 * to inform participants, so there's no need to prompt them every time. Kept as a
 * no-op so existing callers (e.g. useRecordingStart) don't need to change.
 */
export async function showRecordingNotification(): Promise<void> {
  return;
}

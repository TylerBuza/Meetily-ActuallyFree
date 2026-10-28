import { beforeEach, expect, mock, test } from 'bun:test';

const results = new Map<string, unknown>();
const toasts: Array<[string, string, unknown?]> = [];
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (_name: string, args: { meetingId: string }) => {
    const result = results.get(args.meetingId);
    if (result instanceof Error) throw result;
    return result;
  },
}));
mock.module('sonner', () => ({
  toast: {
    success: (title: string) => toasts.push(['success', title]),
    warning: (title: string, options?: unknown) => toasts.push(['warning', title, options]),
    error: (title: string) => toasts.push(['error', title]),
  },
}));
mock.module('@/lib/analytics', () => ({ default: { trackMeetingDeleted() {} } }));
mock.module('@/lib/workspace-api', () => ({ announceChange() {}, setMeetingsGroup: async () => {} }));
const { deleteMeetings } = await import('../../src/lib/meeting-actions');

beforeEach(() => {
  results.clear();
  toasts.length = 0;
});

test('trashed or folderless audio needs no notice', async () => {
  results.set('a', { audio_trashed: true, audio_kept_reason: null });
  results.set('b', { audio_trashed: false, audio_kept_reason: null });
  results.set('c', null);
  expect(await deleteMeetings(['a', 'b', 'c'])).toBe(3);
  expect(toasts).toEqual([['success', '3 meetings deleted']]);
});

test('kept audio is reported with its reason', async () => {
  results.set('a', { audio_trashed: false, audio_kept_reason: 'another meeting still uses its folder' });
  expect(await deleteMeetings(['a'])).toBe(1);
  expect(toasts).toEqual([
    ['success', 'Meeting deleted'],
    ['warning', "The meeting's audio was kept", { description: 'Not moved to the Trash because another meeting still uses its folder.' }],
  ]);
});

test('multi-delete reports each distinct reason once', async () => {
  results.set('a', { audio_kept_reason: 'it is outside the recordings folders' });
  results.set('b', { audio_kept_reason: 'it is outside the recordings folders' });
  results.set('c', { audio_trashed: true });
  results.set('d', new Error('boom'));
  expect(await deleteMeetings(['a', 'b', 'c', 'd'])).toBe(3);
  expect(toasts).toEqual([
    ['success', '3 meetings deleted'],
    ['warning', 'Audio for 2 meetings was kept', { description: 'Not moved to the Trash because it is outside the recordings folders.' }],
    ['error', 'Could not delete 1 meeting'],
  ]);
});

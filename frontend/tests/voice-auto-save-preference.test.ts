import { beforeEach, expect, mock, test } from 'bun:test';
const values = new Map<string, string>();
let refused = false;
const calls: Array<[string, unknown]> = [];
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args?: unknown) => {
  calls.push([command, args]);
  if (command === 'set_voice_profiles_auto_save' && refused) throw new Error('Could not persist');
  if (command === 'get_voice_profiles_auto_save') return true;
  return false;
} }));
const { setLabsFeature, syncLabsFromBackend } = await import('../src/lib/labs-features');
const { loadLabsPreferences } = await import('../src/lib/labs');
beforeEach(() => {
  values.clear(); calls.length = 0; refused = false;
  Object.assign(globalThis, {
    window: { dispatchEvent: () => true },
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
  });
});
test('automatic enrollment is opt-in and persists natively before mirroring', async () => {
  expect(loadLabsPreferences().autoSaveVoiceProfiles).toBe(false);
  await setLabsFeature('autoSaveVoiceProfiles', true);
  expect(calls).toEqual([['set_voice_profiles_auto_save', { value: true }]]);
  expect(loadLabsPreferences().autoSaveVoiceProfiles).toBe(true);
});
test('a failed native preference save retains the previous state', async () => {
  refused = true;
  await expect(setLabsFeature('autoSaveVoiceProfiles', true)).rejects.toThrow('Could not persist');
  expect(loadLabsPreferences().autoSaveVoiceProfiles).toBe(false);
});
test('a WebView reload restores the native automatic-enrollment preference', async () => {
  await syncLabsFromBackend();
  expect(loadLabsPreferences().autoSaveVoiceProfiles).toBe(true);
  expect(loadLabsPreferences().voiceProfiles).toBe(false);
});

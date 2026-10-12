import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

// macOS Audio Capture banner: TCC's status decides when readable; the audible
// tap probe is only the fallback when it is not.
const storage = new Map<string, string>();
let permission: string | Error;
let probeHeardAudio: boolean;
let permissionAfterProbe: string | null;
const calls: string[] = [];
Object.assign(globalThis, { React,
  window: { sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } },
});
mock.module('../../src/hooks/usePlatform', () => ({ usePlatform: () => 'macos' }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string) => {
  calls.push(command);
  if (command === 'get_audio_devices') return [
    { name: 'Built-in Microphone', device_type: 'Input' },
    { name: 'Built-in Speakers', device_type: 'Output' },
  ];
  if (command === 'get_system_audio_permission_status') {
    if (permission instanceof Error) throw permission;
    return permission;
  }
  if (command === 'trigger_microphone_permission') return undefined;
  if (command === 'trigger_system_audio_permission_command') {
    if (permissionAfterProbe) permission = permissionAfterProbe; // user answered the prompt
    return probeHeardAudio;
  }
  throw new Error(`unexpected ${command}`);
} }));
const { usePermissionCheck } = await import('../../src/hooks/usePermissionCheck');

let current: ReturnType<typeof usePermissionCheck>;
const roots: ReactTestRenderer[] = [];
function Probe() { current = usePermissionCheck(); return null; }
async function mount() {
  let root!: ReactTestRenderer;
  await act(async () => { root = create(<Probe />); });
  roots.push(root);
}
beforeEach(() => { storage.clear(); calls.length = 0; permission = 'granted'; probeHeardAudio = false; permissionAfterProbe = null; });
afterEach(async () => { await act(async () => { roots.splice(0).forEach(root => root.unmount()); }); });

test('granted Audio Capture needs no audible proof on launch', async () => {
  await mount();
  expect(current.systemAudioPermission).toBe('granted');
  expect(current.hasSystemAudio).toBe(true);
  expect(calls).not.toContain('trigger_system_audio_permission_command');
});

test('denied and not-yet-asked Audio Capture keep the banner', async () => {
  permission = 'denied';
  await mount();
  expect(current.hasSystemAudio).toBe(false);
  expect(current.systemAudioPermission).toBe('denied');

  permission = 'not_determined';
  await act(async () => { await current.checkPermissions(); });
  expect(current.hasSystemAudio).toBe(false);
  expect(current.systemAudioPermission).toBe('not_determined');
});

test('this session\'s audible probe counts while TCC\'s cached status lags', async () => {
  storage.set('macos_system_audio_verified', 'true');
  permission = 'not_determined';
  await mount();
  expect(current.hasSystemAudio).toBe(true);
});

test('unreadable status falls back to the session probe result', async () => {
  permission = new Error('preflight unavailable');
  await mount();
  expect(current.systemAudioPermission).toBe('unknown');
  expect(current.hasSystemAudio).toBe(false);

  storage.set('macos_system_audio_verified', 'true');
  await act(async () => { await current.checkPermissions(); });
  expect(current.hasSystemAudio).toBe(true);
});

test('Check again clears the banner once the prompt is allowed, even in silence', async () => {
  permission = 'not_determined';
  permissionAfterProbe = 'granted';
  probeHeardAudio = false;
  await mount();
  expect(current.hasSystemAudio).toBe(false);

  await act(async () => { await current.requestPermissions(); });
  expect(calls).toContain('trigger_system_audio_permission_command');
  expect(current.systemAudioPermission).toBe('granted');
  expect(current.hasSystemAudio).toBe(true);
  expect(current.isChecking).toBe(false);
});

test('a grant hidden by TCC\'s per-process cache is proven by audible samples', async () => {
  permission = 'not_determined'; // stays stale after the prompt, as on macOS 26
  probeHeardAudio = true;
  await mount();
  await act(async () => { await current.requestPermissions(); });
  expect(current.systemAudioPermission).toBe('not_determined');
  expect(current.hasSystemAudio).toBe(true);
});

test('a silent probe with a stale status keeps the banner', async () => {
  permission = 'not_determined';
  probeHeardAudio = false;
  await mount();
  await act(async () => { await current.requestPermissions(); });
  expect(current.hasSystemAudio).toBe(false);
});

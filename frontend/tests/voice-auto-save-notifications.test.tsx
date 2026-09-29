import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

let receive: ((event: { payload: { name?: string; personId?: string; status?: string; error?: string } }) => void) | undefined;
const calls: Array<{ kind: string; message: string; options?: { id?: string; description?: string } }> = [];
const stop = mock(() => {});
mock.module('@tauri-apps/api/event', () => ({ listen: async (_event: string, listener: typeof receive) => { receive = listener; return stop; } }));
mock.module('sonner', () => ({ toast: Object.fromEntries(['loading', 'success', 'error'].map((kind) => [kind,
  (message: string, options?: { id?: string; description?: string }) => calls.push({ kind, message, options })])) }));
const { VoiceProfileNotifications } = await import('../src/components/VoiceProfileNotifications');
const { VOICE_PROFILES_CHANGED_EVENT } = await import('../src/lib/voice-profiles');
let root: ReactTestRenderer | undefined;
let changes = 0;
beforeEach(() => {
  calls.length = 0; changes = 0; stop.mockClear();
  const target = new EventTarget();
  target.addEventListener(VOICE_PROFILES_CHANGED_EVENT, () => changes++);
  Object.assign(globalThis, { window: target });
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; });

test('learning stays pending and completion refreshes profiles with the same notification', async () => {
  await act(async () => { root = create(<VoiceProfileNotifications />); });
  receive!({ payload: { name: 'Alice', personId: 'p1', status: 'learning' } });
  expect(calls[0].kind).toBe('loading');
  expect(changes).toBe(0);
  receive!({ payload: { name: 'Alice', personId: 'p1', status: 'saved' } });
  expect(calls[1].kind).toBe('success');
  expect(calls[1].options?.id).toBe(calls[0].options?.id);
  expect(changes).toBe(1);
});
test('failure replaces pending progress without claiming a saved voice', async () => {
  await act(async () => { root = create(<VoiceProfileNotifications />); });
  receive!({ payload: { name: 'Alice', personId: 'p1', status: 'learning' } });
  receive!({ payload: { personId: 'p1', status: 'failed', error: 'Not enough call audio' } });
  expect(calls[1].kind).toBe('error');
  expect(calls[1].options).toEqual({ id: 'voice-auto-p1', description: 'Not enough call audio' });
  expect(changes).toBe(0);
});
test('a disposed listener cannot publish late learning results', async () => {
  await act(async () => { root = create(<VoiceProfileNotifications />); });
  await act(async () => root!.unmount()); root = undefined;
  receive!({ payload: { name: 'Alice', status: 'saved' } });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(0);
  expect(changes).toBe(0);
});

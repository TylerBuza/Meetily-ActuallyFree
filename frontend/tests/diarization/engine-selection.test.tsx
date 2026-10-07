import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, mock, test } from 'bun:test';

// The hook refreshes again after listener registration to close the subscription gap.
// Resolve the newest request; earlier startup lookups are intentionally stale.
const pending: Array<{ resolve: (value: { active_engine: string }) => void; reject: (error: Error) => void }> = [];
let engineChanged: (() => void) | undefined;
mock.module('@tauri-apps/api/event', () => ({
  listen: async (_name: string, callback: () => void) => {
    engineChanged = callback;
    return () => { engineChanged = undefined; };
  },
}));
mock.module('@tauri-apps/api/core', () => ({
  invoke: (command: string) => {
    expect(command).toBe('diarization_get_status');
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  },
}));
const { useDiarizationEngine } = await import('../../src/hooks/useDiarizationEngine');
let current: ReturnType<typeof useDiarizationEngine>;
let root: ReactTestRenderer | undefined;
function Probe({ active }: { active: boolean }) {
  current = useDiarizationEngine(active);
  return null;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  pending.length = 0;
});

test('reopening refreshes the engine and discards an earlier dialog response', async () => {
  await act(async () => { root = create(<Probe active />); });
  const old = pending.pop()!;
  await act(async () => root!.update(<Probe active={false} />));
  await act(async () => root!.update(<Probe active />));
  expect(current.engine).toBeNull();
  await act(async () => pending.pop()!.resolve({ active_engine: 'nemotron' }));
  await act(async () => old.resolve({ active_engine: 'pyannote' }));
  expect(current.isNemotron).toBe(true);
});

test('native activation refreshes an open dialog and supersedes a stale lookup', async () => {
  await act(async () => { root = create(<Probe active />); });
  const old = pending.pop()!;
  await act(async () => engineChanged!());
  await act(async () => pending.pop()!.resolve({ active_engine: 'nemotron' }));
  await act(async () => old.resolve({ active_engine: 'pyannote' }));
  expect(current.isNemotron).toBe(true);
});

test('failed status lookup does not enable a guessed engine', async () => {
  await act(async () => { root = create(<Probe active />); });
  await act(async () => pending.pop()!.reject(new Error('IPC failed')));
  expect(current.engine).toBeNull();
  expect(current.error).toContain('Could not load');
});

import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

const listeners = new Map<string, (event: { payload: any }) => void>();
const selected = mock(() => {});
const succeeded = mock(() => {});
let commands: string[];
mock.module('sonner', () => ({ toast: { success: succeeded, error: () => {} } }));
mock.module('@tauri-apps/api/event', () => ({ listen: async (name: string, callback: any) => {
  listeners.set(name, callback); return () => listeners.delete(name);
} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string) => {
  commands.push(command);
  if (command === 'whisper_get_available_models') return [];
  if (command === 'whisper_init' || command === 'api_save_transcript_config') return;
  throw new Error(command);
} }));
const { ModelManager } = await import('../../src/components/WhisperModelManager');
let root: ReactTestRenderer;
beforeEach(() => {
  commands = []; selected.mockClear(); succeeded.mockClear();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
});
afterEach(async () => { await act(async () => root?.unmount()); listeners.clear(); });

test('optional native completion does not let another Whisper manager change live selection', async () => {
  await act(async () => { root = create(<ModelManager autoSave onModelSelect={selected} />); });
  await act(async () => listeners.get('model-download-complete')!({ payload: { modelName: 'large-v3-turbo-q5_0', postCallManaged: true } }));
  expect(selected).not.toHaveBeenCalled();
  expect(commands).not.toContain('api_save_transcript_config');
  expect(succeeded).not.toHaveBeenCalled();
});

test('ordinary manual download completion retains its selection behavior', async () => {
  await act(async () => { root = create(<ModelManager autoSave onModelSelect={selected} />); });
  await act(async () => listeners.get('model-download-complete')!({ payload: { modelName: 'tiny' } }));
  expect(selected).toHaveBeenCalledWith('tiny');
  expect(commands).toContain('api_save_transcript_config');
});

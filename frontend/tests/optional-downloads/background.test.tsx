import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

const listeners = new Map<string, (event: { payload: any }) => void>();
let calls: string[];
let argumentsByCommand: Array<[string, any]>;
let activationFails = false;
let whisperStatus: unknown = 'Missing';
let nemotronAvailable = false;
let pending: Map<string, { resolve: () => void; reject: (error: Error) => void }>;
mock.module('@tauri-apps/api/event', () => ({ listen: async (name: string, cb: any) => {
  listeners.set(name, cb);
  return () => listeners.delete(name);
} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args: any) => {
  calls.push(command);
  argumentsByCommand.push([command, args]);
  if (command === 'whisper_get_available_models') return [{ name: 'large-v3-turbo-q5_0', status: whisperStatus }];
  if (command === 'diarization_get_status') return { nemotron_available: nemotronAvailable, active_engine: 'pyannote' };
  if (command === 'uninstall_optional_model') {
    await new Promise<void>((resolve, reject) => pending.set(command, { resolve, reject }));
    if (args.model === 'whisper') whisperStatus = 'Missing'; else nemotronAvailable = false;
    return;
  }
  if (command === 'api_get_post_call_transcript_config') return { provider: 'live', model: '' };
  if (command === 'set_diarization_engine' || command === 'api_save_post_call_transcript_config') {
    if (activationFails) throw new Error('Could not save preferences');
    return;
  }
  if (command === 'whisper_download_model' || command === 'download_diarization_models') {
    if (command === 'whisper_download_model' && whisperStatus === 'Available') {
      if (activationFails) throw 'Model downloaded, but could not enable it: Could not save preferences';
      return;
    }
    return new Promise<void>((resolve, reject) => pending.set(command, { resolve, reject }));
  }
  throw new Error(`Unexpected command ${command}`);
} }));
mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));
const { OptionalModelDownloadsProvider, useOptionalModelDownloads } = await import('../../src/contexts/OptionalModelDownloadsContext');
let current: ReturnType<typeof useOptionalModelDownloads>;
let root: ReactTestRenderer;
function View({ page }: { page: string }) { current = useOptionalModelDownloads(); return <span>{page}</span>; }
function App({ page }: { page: string }) {
  return <OptionalModelDownloadsProvider><View key={page} page={page} /></OptionalModelDownloadsProvider>;
}
beforeEach(() => {
  calls = []; argumentsByCommand = []; pending = new Map(); activationFails = false; whisperStatus = 'Missing'; nemotronAvailable = false;
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: new EventTarget() });
});
afterEach(async () => { await act(async () => root?.unmount()); listeners.clear(); });

test('optional downloads do not gate navigation and survive leaving onboarding', async () => {
  await act(async () => { root = create(<App page="setup" />); });
  expect(pending.size).toBe(0);
  await act(async () => { current.startDownload('nemotron'); current.startDownload('whisper'); current.startDownload('nemotron'); });
  expect(pending.size).toBe(2);
  expect(calls).not.toContain('set_diarization_engine');
  expect(calls).not.toContain('api_save_post_call_transcript_config');
  expect(calls.filter(c => c === 'download_diarization_models')).toHaveLength(1);
  await act(async () => root.update(<App page="main" />));
  expect(root.root.findByType('span').children).toEqual(['main']);
  expect(current.jobs.nemotron.status).toBe('downloading');
  await act(async () => listeners.get('diarization-download-progress')!({ payload: { file: 'nemotron3_diar_v3.onnx', percent: 47, status: 'downloading' } }));
  expect(current.jobs.nemotron.progress).toBe(47);
  await act(async () => pending.get('download_diarization_models')!.resolve());
  expect(current.jobs.nemotron.status).toBe('ready');
  expect(current.jobs.nemotron.enabled).toBe(true);
  expect(argumentsByCommand).toContainEqual(['download_diarization_models', { engine: 'nemotron' }]);
  expect(calls).not.toContain('set_diarization_engine');
  expect(current.jobs.whisper.status).toBe('downloading');
  await act(async () => pending.get('whisper_download_model')!.resolve());
  expect(current.jobs.whisper.status).toBe('ready');
  expect(current.jobs.whisper.enabled).toBe(true);
  expect(argumentsByCommand).toContainEqual(['whisper_download_model', { modelName: 'large-v3-turbo-q5_0', enablePostCall: true }]);
  expect(calls).not.toContain('api_save_post_call_transcript_config');
});

test('a failed optional download can be retried without restarting setup', async () => {
  await act(async () => { root = create(<App page="settings" />); });
  await act(async () => current.startDownload('nemotron'));
  await act(async () => pending.get('download_diarization_models')!.reject(new Error('Network unavailable')));
  expect(current.jobs.nemotron.status).toBe('error');
  expect(calls).not.toContain('set_diarization_engine');
  await act(async () => current.startDownload('nemotron'));
  expect(calls.filter(c => c === 'download_diarization_models')).toHaveLength(2);
  await act(async () => pending.get('download_diarization_models')!.resolve());
  expect(current.jobs.nemotron.status).toBe('ready');
});

test('activation errors stay retryable without reporting the model enabled', async () => {
  whisperStatus = 'Available';
  activationFails = true;
  await act(async () => { root = create(<App page="setup" />); });
  await act(async () => current.startDownload('whisper'));
  expect(current.jobs.whisper.status).toBe('activation-error');
  expect(current.jobs.whisper.enabled).not.toBe(true);
  expect(argumentsByCommand).toContainEqual(['whisper_download_model', { modelName: 'large-v3-turbo-q5_0', enablePostCall: true }]);
  activationFails = false;
  await act(async () => current.startDownload('whisper'));
  expect(current.jobs.whisper.enabled).toBe(true);
});

test('an existing native Whisper download hands activation ownership to the native request', async () => {
  whisperStatus = { Downloading: 20 };
  await act(async () => { root = create(<App page="setup" />); });
  await act(async () => current.startDownload('whisper'));
  expect(argumentsByCommand).toContainEqual(['whisper_download_model', { modelName: 'large-v3-turbo-q5_0', enablePostCall: true }]);
  expect(calls).not.toContain('api_save_post_call_transcript_config');
  whisperStatus = 'Available';
  await act(async () => listeners.get('model-download-complete')!({ payload: { modelName: 'large-v3-turbo-q5_0' } }));
  expect(current.jobs.whisper.enabled).not.toBe(true);
  await act(async () => pending.get('whisper_download_model')!.resolve());
  expect(current.jobs.whisper.enabled).toBe(true);
});

test('a remounted provider observes native Nemotron activation without an owning JS callback', async () => {
  await act(async () => { root = create(<App page="setup" />); });
  await act(async () => current.startDownload('nemotron'));
  await act(async () => root.unmount());
  await act(async () => { root = create(<App page="settings" />); });
  await act(async () => listeners.get('diarization-engine-changed')!({ payload: 'nemotron' }));
  expect(current.jobs.nemotron.status).toBe('ready');
  expect(current.jobs.nemotron.enabled).toBe(true);
  expect(calls).not.toContain('set_diarization_engine');
});

test('native activation failure offers activation retry', async () => {
  await act(async () => { root = create(<App page="setup" />); });
  await act(async () => current.startDownload('nemotron'));
  await act(async () => pending.get('download_diarization_models')!.reject('Model downloaded, but could not enable it: disk error' as any));
  expect(current.jobs.nemotron.status).toBe('activation-error');
  expect(current.jobs.nemotron.enabled).not.toBe(true);
});

test('uninstall disables and clears the model and blocks duplicate operations until native completion', async () => {
  whisperStatus = 'Available';
  await act(async () => { root = create(<App page="settings" />); });
  await act(async () => { current.uninstallModel('whisper'); current.uninstallModel('whisper'); current.startDownload('whisper'); });
  expect(current.jobs.whisper.status).toBe('uninstalling');
  expect(calls.filter(c => c === 'uninstall_optional_model')).toHaveLength(1);
  expect(calls).not.toContain('whisper_download_model');
  await act(async () => pending.get('uninstall_optional_model')!.resolve());
  expect(current.jobs.whisper).toMatchObject({ status: 'idle', enabled: false, progress: 0 });
  expect(argumentsByCommand).toContainEqual(['uninstall_optional_model', { model: 'whisper' }]);
});

test('failed removal re-reads the disabled selection and keeps the installed model retryable', async () => {
  nemotronAvailable = true;
  await act(async () => { root = create(<App page="settings" />); });
  await act(async () => current.uninstallModel('nemotron'));
  await act(async () => pending.get('uninstall_optional_model')!.reject(new Error('File is in use')));
  expect(current.jobs.nemotron).toMatchObject({ status: 'ready', enabled: false });
  expect(current.jobs.nemotron.error).toContain('File is in use');
  await act(async () => current.uninstallModel('nemotron'));
  await act(async () => pending.get('uninstall_optional_model')!.resolve());
  expect(current.jobs.nemotron.status).toBe('idle');
});

import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

const listeners = new Map<string, (event: { payload: any }) => void>();
let calls: string[];
let argumentsByCommand: Array<[string, any]>;
let activationFails = false;
let whisperStatus: unknown = 'Missing';
let pending: Map<string, { resolve: () => void; reject: (error: Error) => void }>;
mock.module('@tauri-apps/api/event', () => ({ listen: async (name: string, cb: any) => {
  listeners.set(name, cb);
  return () => listeners.delete(name);
} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args: any) => {
  calls.push(command);
  argumentsByCommand.push([command, args]);
  if (command === 'whisper_get_available_models') return [{ name: 'large-v3-turbo-q5_0', status: whisperStatus }];
  if (command === 'diarization_get_status') return { nemotron_available: false };
  if (command === 'api_get_post_call_transcript_config') return { provider: 'live', model: '' };
  if (command === 'set_diarization_engine' || command === 'api_save_post_call_transcript_config') {
    if (activationFails) throw new Error('Could not save preferences');
    return;
  }
  if (command === 'whisper_download_model' || command === 'download_diarization_models') {
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
beforeEach(() => { calls = []; argumentsByCommand = []; pending = new Map(); activationFails = false; whisperStatus = 'Missing'; });
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
  expect(argumentsByCommand).toContainEqual(['set_diarization_engine', { engine: 'nemotron' }]);
  expect(current.jobs.whisper.status).toBe('downloading');
  await act(async () => pending.get('whisper_download_model')!.resolve());
  expect(current.jobs.whisper.status).toBe('ready');
  expect(current.jobs.whisper.enabled).toBe(true);
  expect(argumentsByCommand).toContainEqual(['api_save_post_call_transcript_config', { provider: 'whisper', model: 'large-v3-turbo-q5_0' }]);
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
  expect(calls).not.toContain('whisper_download_model');
  activationFails = false;
  await act(async () => current.startDownload('whisper'));
  expect(current.jobs.whisper.enabled).toBe(true);
});

test('an existing native Whisper download is activated only after its completion event', async () => {
  whisperStatus = { Downloading: 20 };
  await act(async () => { root = create(<App page="setup" />); });
  await act(async () => current.startDownload('whisper'));
  expect(calls).not.toContain('whisper_download_model');
  expect(calls).not.toContain('api_save_post_call_transcript_config');
  await act(async () => listeners.get('model-download-complete')!({ payload: { modelName: 'large-v3-turbo-q5_0' } }));
  expect(current.jobs.whisper.enabled).toBe(true);
});

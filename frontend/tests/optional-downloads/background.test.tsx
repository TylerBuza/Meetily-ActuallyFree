import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

const listeners = new Map<string, (event: { payload: any }) => void>();
let calls: string[];
let pending: Map<string, { resolve: () => void; reject: (error: Error) => void }>;
mock.module('@tauri-apps/api/event', () => ({ listen: async (name: string, cb: any) => {
  listeners.set(name, cb);
  return () => listeners.delete(name);
} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string) => {
  calls.push(command);
  if (command === 'whisper_get_available_models') return [];
  if (command === 'diarization_get_status') return { nemotron_available: false };
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
beforeEach(() => { calls = []; pending = new Map(); });
afterEach(async () => { await act(async () => root?.unmount()); listeners.clear(); });

test('optional downloads do not gate navigation and survive leaving onboarding', async () => {
  await act(async () => { root = create(<App page="setup" />); });
  expect(pending.size).toBe(0);
  await act(async () => { current.startDownload('nemotron'); current.startDownload('whisper'); current.startDownload('nemotron'); });
  expect(pending.size).toBe(2);
  expect(calls.filter(c => c === 'download_diarization_models')).toHaveLength(1);
  await act(async () => root.update(<App page="main" />));
  expect(root.root.findByType('span').children).toEqual(['main']);
  expect(current.jobs.nemotron.status).toBe('downloading');
  await act(async () => listeners.get('diarization-download-progress')!({ payload: { file: 'nemotron3_diar_v3.onnx', percent: 47, status: 'downloading' } }));
  expect(current.jobs.nemotron.progress).toBe(47);
  await act(async () => pending.get('download_diarization_models')!.resolve());
  expect(current.jobs.nemotron.status).toBe('ready');
  expect(current.jobs.whisper.status).toBe('downloading');
  await act(async () => pending.get('whisper_download_model')!.resolve());
  expect(current.jobs.whisper.status).toBe('ready');
});

test('a failed optional download can be retried without restarting setup', async () => {
  await act(async () => { root = create(<App page="settings" />); });
  await act(async () => current.startDownload('nemotron'));
  await act(async () => pending.get('download_diarization_models')!.reject(new Error('Network unavailable')));
  expect(current.jobs.nemotron.status).toBe('error');
  await act(async () => current.startDownload('nemotron'));
  expect(calls.filter(c => c === 'download_diarization_models')).toHaveLength(2);
  await act(async () => pending.get('download_diarization_models')!.resolve());
  expect(current.jobs.nemotron.status).toBe('ready');
});

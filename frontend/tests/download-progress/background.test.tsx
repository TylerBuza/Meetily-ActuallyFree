import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

const listeners = new Map<string, (event: { payload: any }) => void>();
const pending = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();
let whisperStatus: unknown;
let step: number;
let calls: string[];
const success = mock(() => {});
const error = mock(() => {});
const custom = mock(() => {});
mock.module('sonner', () => ({ toast: { success, error, custom } }));
mock.module('@/contexts/OnboardingContext', () => ({ useOnboarding: () => ({ currentStep: step }) }));
mock.module('@tauri-apps/api/event', () => ({
  listen: async (name: string, callback: any) => {
    listeners.set(name, callback);
    return () => listeners.delete(name);
  },
}));
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    calls.push(command);
    if (command === 'whisper_get_available_models') return [{ name: 'large-v3-turbo-q5_0', status: whisperStatus }];
    if (command === 'diarization_get_status') return { nemotron_available: false, active_engine: 'pyannote' };
    if (command === 'api_get_post_call_transcript_config') return { provider: 'live', model: '' };
    if (['whisper_download_model', 'download_diarization_models', 'api_save_post_call_transcript_config'].includes(command)) {
      await new Promise<void>((resolve, reject) => pending.set(command, { resolve, reject }));
      if (command === 'whisper_download_model') {
        await new Promise<void>((resolve, reject) => pending.set('native-whisper-activation', { resolve, reject }));
      }
      return;
    }
    throw new Error(`Unexpected command ${command}`);
  },
}));

const { OptionalModelDownloadsProvider, useOptionalModelDownloads } = await import('../../src/contexts/OptionalModelDownloadsContext');
const { DownloadProgressToastProvider } = await import('../../src/components/shared/DownloadProgressToast');
let current: ReturnType<typeof useOptionalModelDownloads>;
let root: ReactTestRenderer;
function Page({ page }: { page: string }) {
  current = useOptionalModelDownloads();
  return <span>{page}</span>;
}
function App({ page = 'home', panel = true }: { page?: string; panel?: boolean }) {
  return (
    <OptionalModelDownloadsProvider>
      <Page key={page} page={page} />
      {panel && <DownloadProgressToastProvider />}
    </OptionalModelDownloadsProvider>
  );
}
const bars = () => root.root.findAllByProps({ role: 'progressbar' });
const bar = (name: string) => bars().find(node => String(node.props['aria-label']).startsWith(name));
async function emit(name: string, payload: any) {
  await act(async () => listeners.get(name)!({ payload }));
}
beforeEach(() => {
  calls = []; step = 6; whisperStatus = 'Missing';
  pending.clear(); success.mockClear(); error.mockClear(); custom.mockClear();
});
afterEach(async () => { await act(async () => root?.unmount()); listeners.clear(); });

test('optional jobs started before the panel mounts share the main model stack across navigation', async () => {
  await act(async () => { root = create(<App page="setup" panel={false} />); });
  await act(async () => { current.startDownload('whisper'); current.startDownload('nemotron'); });
  await emit('model-download-progress', { modelName: 'large-v3-turbo-q5_0', progress: 36 });
  await emit('diarization-download-progress', { file: 'nemotron3_diar_v3.onnx', percent: 47, status: 'downloading' });
  await act(async () => root.update(<App page="home" />));
  expect(bar('Whisper')!.props['aria-valuenow']).toBe(36);
  expect(bar('Nemotron')!.props['aria-valuenow']).toBe(47);
  expect(JSON.stringify(root.toJSON())).not.toContain('0.0 / 0.0');

  await emit('parakeet-model-download-progress', { modelName: 'parakeet', progress: 21, downloaded_mb: 138, total_mb: 639 });
  await emit('builtin-ai-download-progress', { model: 'qwen3.5:4b', progress: 15, status: 'downloading', total_mb: 3000 });
  await act(async () => root.update(<App page="settings" />));
  expect(bars()).toHaveLength(4);
  expect(bar('Whisper')!.props['aria-valuenow']).toBe(36);
  expect(bar('Nemotron')!.props['aria-valuenow']).toBe(47);
  expect(calls.filter(command => command === 'download_diarization_models')).toHaveLength(1);
  expect(calls.filter(command => command === 'whisper_download_model')).toHaveLength(1);
});

test('verification and activation stay visible until the owning jobs actually finish', async () => {
  await act(async () => { root = create(<App />); });
  await act(async () => { current.startDownload('whisper'); current.startDownload('nemotron'); });
  await emit('diarization-download-progress', { file: 'nemotron3_diar_v3.onnx', percent: 99, status: 'verifying' });
  expect(bar('Nemotron')!.props['aria-valuetext']).toContain('Verifying download');
  await emit('diarization-download-progress', { file: '', percent: 100, status: 'done', message: 'Nemotron-3 Diarization model installed successfully' });
  expect(bar('Nemotron')!.props['aria-valuetext']).toContain('Enabling model');
  expect(current.jobs.nemotron.enabled).not.toBe(true);
  await emit('model-download-activating', { modelName: 'large-v3-turbo-q5_0' });
  expect(bar('Whisper')!.props['aria-valuetext']).toContain('Enabling model');
  await act(async () => pending.get('whisper_download_model')!.resolve());
  expect(bar('Whisper')).toBeDefined();
  expect(current.jobs.whisper.enabled).not.toBe(true);
  await act(async () => pending.get('native-whisper-activation')!.resolve());
  expect(bar('Whisper')).toBeUndefined();
  await emit('diarization-engine-changed', 'nemotron');
  await act(async () => pending.get('download_diarization_models')!.resolve());
  expect(bars()).toHaveLength(0);
  expect(success).toHaveBeenCalledTimes(2);
  expect(custom).not.toHaveBeenCalled();
});

test('errors clear active cards and retries restore them without duplicate notifications', async () => {
  await act(async () => { root = create(<App />); });
  await act(async () => current.startDownload('nemotron'));
  await act(async () => pending.get('download_diarization_models')!.reject(new Error('Network unavailable')));
  expect(bars()).toHaveLength(0);
  expect(error).toHaveBeenCalledTimes(1);
  await act(async () => current.startDownload('nemotron'));
  expect(bar('Nemotron')!.props['aria-valuenow']).toBe(0);
  await act(async () => pending.get('download_diarization_models')!.reject('Model downloaded, but could not enable it: disk error'));
  expect(current.jobs.nemotron.status).toBe('activation-error');
  expect(bars()).toHaveLength(0);
  expect(custom).not.toHaveBeenCalled();
});

test('restored native Whisper progress appears after leaving the dedicated setup download step', async () => {
  step = 3; whisperStatus = { Downloading: 62 };
  await act(async () => { root = create(<App />); });
  expect(bars()).toHaveLength(0);
  step = 4;
  await act(async () => root.update(<App page="next-setup-step" />));
  expect(bar('Whisper')!.props['aria-valuenow']).toBe(62);
  expect(calls).not.toContain('whisper_download_model');
  await emit('model-download-complete', { modelName: 'large-v3-turbo-q5_0' });
  expect(bars()).toHaveLength(0);
  expect(calls).not.toContain('api_save_post_call_transcript_config');
});

import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, afterEach, expect, mock, test } from 'bun:test';

let jobs: any;
let nativeWhisperAvailable: boolean;
let nativeNemotronAvailable: boolean;
let activeEngine: string;
let postCall: { provider: string; model: string };
const startDownload = mock(() => {});
const uninstallModel = mock(() => {});
mock.module('@/contexts/OptionalModelDownloadsContext', () => ({
  useOptionalModelDownloads: () => ({ jobs, startDownload, uninstallModel }),
}));
mock.module('@/hooks/useLabs', () => ({ useLabs: () => ({ labs: {} }) }));
mock.module('@/components/WhisperModelManager', () => ({ ModelManager: () => null }));
mock.module('@/components/ParakeetModelManager', () => ({ ParakeetModelManager: () => null }));
mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string) => {
  if (command === 'diarization_get_status') return { active_engine: activeEngine, nemotron_available: nativeNemotronAvailable, pyannote_available: true, model_dir: 'fixture-models', nemotron_threshold: 0.5 };
  if (command === 'whisper_get_available_models') return [{ name: 'large-v3-turbo-q5_0', status: nativeWhisperAvailable ? 'Available' : 'Missing' }];
  if (command === 'parakeet_get_available_models') return [{ name: 'parakeet-tdt-0.6b-v3-int8', status: 'Available' }];
  if (command === 'api_get_post_call_transcript_config') return postCall;
  if (command === 'api_get_whisper_vocabulary') return { global: '', meeting: '' };
  if (command === 'get_recording_preferences') return { real_time_transcription: false };
  throw new Error(command);
} }));

const { DiarizationSettings } = await import('../../src/components/DiarizationSettings');
const { TranscriptSettings } = await import('../../src/components/TranscriptSettings');
const { OptionalModelDownloads } = await import('../../src/components/OptionalModelDownloads');
let root: ReactTestRenderer;
const setLive = mock(() => {});
function App() {
  return <>
    <DiarizationSettings />
    <TranscriptSettings transcriptModelConfig={{ provider: 'parakeet', model: 'parakeet-tdt-0.6b-v3-int8' }} setTranscriptModelConfig={setLive} />
    <OptionalModelDownloads allowUninstall />
  </>;
}
beforeEach(() => {
  jobs = { whisper: { status: 'idle', progress: 0 }, nemotron: { status: 'idle', progress: 0 } };
  activeEngine = 'pyannote'; nativeWhisperAvailable = false; nativeNemotronAvailable = false;
  postCall = { provider: 'live', model: '' };
  startDownload.mockClear(); uninstallModel.mockClear(); setLive.mockClear();
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: Object.assign(new EventTarget(), { setTimeout, clearTimeout }) });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => null, removeItem: () => {} } });
});
afterEach(async () => { await act(async () => root?.unmount()); });

test('Settings shows both background downloads before they are selected and refreshes installed/active status on completion', async () => {
  jobs.whisper = { status: 'downloading', progress: 64 };
  jobs.nemotron = { status: 'downloading', progress: 37, file: 'nemotron3_diar_v3.onnx', downloadedBytes: 1048576, totalBytes: 2097152 };
  await act(async () => { root = create(<App />); });
  expect(root.root.findByProps({ 'aria-label': 'Whisper download progress' }).props['aria-valuenow']).toBe(64);
  expect(root.root.findByProps({ 'aria-label': 'Nemotron download progress' }).props['aria-valuenow']).toBe(37);
  expect(JSON.stringify(root.toJSON())).toContain('Current file: ');
  expect(JSON.stringify(root.toJSON())).not.toContain('Install Whisper model');
  nativeWhisperAvailable = true; nativeNemotronAvailable = true; activeEngine = 'nemotron';
  postCall = { provider: 'whisper', model: 'large-v3-turbo-q5_0' };
  jobs.whisper = { status: 'ready', progress: 100, enabled: true };
  jobs.nemotron = { status: 'ready', progress: 100, enabled: true };
  await act(async () => {
    root.update(<App />);
    window.dispatchEvent(new Event('optional-model-preferences-changed'));
  });
  expect(JSON.stringify(root.toJSON())).toContain('Selected for post-call');
  expect(JSON.stringify(root.toJSON())).toContain('Nemotron-3 Sortformer model ready on-device.');
  expect(root.root.findAllByProps({ role: 'progressbar' })).toHaveLength(0);
  expect(root.root.findByProps({ 'aria-label': 'Uninstall Whisper' })).toBeDefined();
  expect(root.root.findByProps({ 'aria-label': 'Uninstall Nemotron' })).toBeDefined();
  expect(setLive).not.toHaveBeenCalled();
});

test('optional Settings uninstall actions target only the chosen model', async () => {
  jobs.whisper = { status: 'ready', progress: 100, enabled: true };
  jobs.nemotron = { status: 'ready', progress: 100, enabled: true };
  await act(async () => { root = create(<App />); });
  await act(async () => root.root.findByProps({ 'aria-label': 'Uninstall Whisper' }).props.onClick());
  expect(uninstallModel).toHaveBeenCalledWith('whisper');
  await act(async () => root.root.findByProps({ 'aria-label': 'Uninstall Nemotron' }).props.onClick());
  expect(uninstallModel).toHaveBeenCalledWith('nemotron');
});

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

const storage = new Map<string, string>();
const events = new Map<string, (event: any) => void>();
const keys = new Set<(event: any) => void>();
const calls: Array<[string, any]> = [];
Object.assign(globalThis, { React,
  sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  window: { addEventListener: (_: string, fn: any) => keys.add(fn), removeEventListener: (_: string, fn: any) => keys.delete(fn) },
});
mock.module('@tauri-apps/api/event', () => ({ listen: async (name: string, fn: any) => {
  events.set(name, fn); return () => events.delete(name);
} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (name: string, args: any) => {
  calls.push([name, args]);
  if (name === 'api_get_post_call_transcript_config') return { provider: 'parakeet', model: 'parakeet-tdt-0.6b-v2' };
  if (name === 'parakeet_get_available_models') return [{ name: 'parakeet-tdt-0.6b-v2', status: 'Available' }];
  if (name === 'whisper_get_available_models') return [];
} }));
mock.module('@/hooks/useDiarizationEngine', () => ({ useDiarizationEngine: () => ({ engine: 'nemotron', isNemotron: true }) }));
mock.module('@/contexts/ConfigContext', () => ({ useConfig: () => ({ selectedLanguage: null, transcriptModelConfig: {} }) }));
mock.module('@/lib/parakeet', () => ({ isVisibleParakeetModel: () => true }));
mock.module('@/lib/workspace-api', () => ({ announceChange: () => {} }));
mock.module('sonner', () => ({ toast: { success() {}, error() {}, info() {} } }));
mock.module('@/components/PostCallHandoffCard', () => ({ PostCallHandoffCard: ({ children, detail, onDismiss }: any) => <section onKeyDown={(event: any) => { if (event.key === 'Escape') onDismiss?.(); }}>{detail}{children}</section> }));
mock.module('@/components/ui/button', () => ({ Button: (props: any) => <button {...props} /> }));
const { PostCallJobsProvider } = await import('../src/contexts/PostCallJobsContext');
const { PostCallProcessingDialog } = await import('../src/components/MeetingDetails/PostCallProcessingDialog');
let root: ReactTestRenderer;
const refreshA = mock(async () => {});
const refreshB = mock(async () => {});
const completeA = mock(() => {});
const completeB = mock(() => {});
function App({ page = 'a', enabled = true }: { page?: string; enabled?: boolean }) {
  return <PostCallJobsProvider>{page !== 'settings' && <PostCallProcessingDialog
    enabled={enabled} meetingId={page} meetingFolderPath={`/${page}`}
    onRefetchTranscripts={page === 'a' ? refreshA : refreshB}
    onComplete={page === 'a' ? completeA : completeB} />}</PostCallJobsProvider>;
}
const button = (label: string) => root.root.findAllByType('button').find(node => node.children.includes(label))!;
beforeEach(() => { storage.clear(); calls.length = 0; refreshA.mockClear(); refreshB.mockClear(); completeA.mockClear(); completeB.mockClear(); });
afterEach(async () => { await act(async () => root?.unmount()); events.clear(); });

test('navigation retains work; completion refreshes only its meeting on return', async () => {
  await act(async () => { root = create(<App />); });
  await act(async () => button('Auto-detect & continue').props.onClick());
  expect(calls.filter(([name]) => name === 'start_retranscription_command')).toHaveLength(1);
  await act(async () => root.update(<App page="b" enabled={false} />));
  expect(button('Cancel processing')).toBeDefined();
  await act(async () => events.get('retranscription-complete')!({ payload: { meeting_id: 'a' } }));
  expect(refreshA).not.toHaveBeenCalled();
  expect(refreshB).not.toHaveBeenCalled();
  expect(completeB).not.toHaveBeenCalled();
  await act(async () => root.update(<App enabled={false} />));
  expect(refreshA).toHaveBeenCalledTimes(1);
  expect(completeA).toHaveBeenCalledTimes(1);
  expect(root.root.findAllByType('section')).toHaveLength(0);
});

test('keep-live dismisses without enhancement or diarization', async () => {
  await act(async () => { root = create(<App />); });
  await act(async () => button('Keep live transcript').props.onClick());
  expect(calls).toHaveLength(0);
  expect(completeA).toHaveBeenCalledTimes(1);
});

test('Escape dismisses the prompt without starting work', async () => {
  await act(async () => { root = create(<App />); });
  await act(async () => root.root.findByType('section').props.onKeyDown({ key: 'Escape' }));
  expect(calls).toHaveLength(0);
  expect(completeA).toHaveBeenCalledTimes(1);
});

test('returning to an active meeting does not reopen or duplicate its job', async () => {
  await act(async () => { root = create(<App />); });
  await act(async () => button('Auto-detect & continue').props.onClick());
  await act(async () => root.update(<App page="settings" />));
  await act(async () => root.update(<App />));
  expect(button('Auto-detect & continue')).toBeUndefined();
  expect(calls.filter(([name]) => name === 'start_retranscription_command')).toHaveLength(1);
  await act(async () => events.get('retranscription-complete')!({ payload: { meeting_id: 'a' } }));
  expect(completeA).toHaveBeenCalledTimes(1);
});

test('cancel targets the meeting and retains ownership until native completion', async () => {
  await act(async () => { root = create(<App />); });
  await act(async () => button('Auto-detect & continue').props.onClick());
  await act(async () => button('Cancel processing').props.onClick());
  expect(calls.find(([name]) => name === 'cancel_retranscription_command')?.[1]).toEqual({ meetingId: 'a' });
  expect(button('Cancelling…').props.disabled).toBe(true);
  expect(completeA).not.toHaveBeenCalled();
  await act(async () => events.get('retranscription-error')!({ payload: { meeting_id: 'a', error: 'cancelled' } }));
  expect(calls.some(([name]) => name === 'diarize_meeting')).toBe(false);
  await act(async () => button('Keep live transcript').props.onClick());
  expect(completeA).toHaveBeenCalledTimes(1);
});

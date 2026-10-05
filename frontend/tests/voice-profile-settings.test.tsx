import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, mock, test } from 'bun:test';
const calls: Array<[string, any]> = [];
let receive: (event: { payload: { status: string } }) => void;
let ready = true;
const profiles = [{ person_id: 'alice', name: 'Alice', samples: 4, meetings: 1 }, { person_id: 'bob', name: 'Bob', samples: 8, meetings: 2 }];
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args: any) => {
  calls.push([command, args]);
  if (command === 'diarization_get_status') return { pyannote_available: ready };
  if (command === 'get_voice_profile_learning_busy') return false;
  return null;
} }));
mock.module('@tauri-apps/api/event', () => ({ listen: async (_event: string, listener: typeof receive) => { receive = listener; return () => {}; } }));
mock.module('@/hooks/useVoiceProfiles', () => ({ useVoiceProfiles: () => profiles }));
mock.module('@/hooks/useLabs', () => ({ useLabs: () => ({ labs: { voiceProfiles: true } }) }));
mock.module('@/components/FeatureSettingsSwitch', () => ({ FeatureSettingsSwitch: ({ title }: any) => <div>{title}</div> }));
mock.module('@/components/ui/button', () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
mock.module('@/components/ui/avatar', () => ({ Avatar: () => <span /> }));
mock.module('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));
const { VoiceProfilesSettings } = await import('../src/components/VoiceProfilesSettings');
let root: ReactTestRenderer;
afterEach(async () => { await act(async () => root?.unmount()); calls.length = 0; ready = true; });

test('individual and bulk learning use native jobs and wait for completion', async () => {
  await act(async () => { root = create(<VoiceProfilesSettings />); });
  const individual = () => root.root.findAllByType('button').filter(button => button.props.children === 'Learn more turns');
  expect(individual()).toHaveLength(2);
  await act(async () => individual()[0].props.onClick());
  expect(calls).toContainEqual(['queue_voice_profile_learning', { personId: 'alice' }]);
  expect(individual()[1].props.disabled).toBe(true);
  await act(async () => receive({ payload: { status: 'complete' } }));
  expect(individual()[1].props.disabled).toBe(false);
  const all = root.root.findAllByType('button').find(button => button.props.children === 'Learn all profiles')!;
  await act(async () => all.props.onClick());
  expect(calls).toContainEqual(['queue_voice_profile_learning', { personId: null }]);
});
test('missing speaker models disable learning and provide setup guidance', async () => {
  ready = false;
  await act(async () => { root = create(<VoiceProfilesSettings />); });
  expect(root.root.findAllByType('button').filter(button => String(button.props.children).startsWith('Learn')).every(button => button.props.disabled)).toBe(true);
  expect(root.root.findAllByType('a').some(link => link.props.href === '/settings?section=transcription')).toBe(true);
});

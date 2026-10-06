import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, mock, test } from 'bun:test';
const calls: Array<[string, any]> = [];
let receive: (event: { payload: { status: string } }) => void;
let ready = true;
let rejectScore = false;
let rejectLimit = false;
let profileLimit = 50;
const profiles = [{ person_id: 'alice', name: 'Alice', samples: 4, meetings: 1 }, { person_id: 'bob', name: 'Bob', samples: 8, meetings: 2 }];
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args: any) => {
  calls.push([command, args]);
  if (command === 'get_voice_profiles_limit') return profileLimit;
  if (command === 'set_voice_profiles_limit') { if (rejectLimit) throw new Error('Disk unavailable'); profileLimit = args.value; return null; }
  if (command === 'get_voice_profiles_auto_samples') return 12;
  if (command === 'get_voice_profiles_match_threshold') return 0.55;
  if (command === 'set_voice_profiles_match_threshold' && rejectScore) throw new Error('Disk unavailable');
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
afterEach(async () => { await act(async () => root?.unmount()); calls.length = 0; ready = true; rejectScore = false; rejectLimit = false; profileLimit = 50; });

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

test('matching threshold loads, validates, saves, and reports failed persistence', async () => {
  await act(async () => { root = create(<VoiceProfilesSettings />); });
  const input = () => root.root.findByProps({ id: 'voice-match-score' });
  const save = () => root.root.findAllByType('button').find(button => button.props.children === 'Save score')!;
  expect(input().props.value).toBe('0.55');
  await act(async () => input().props.onChange({ target: { value: '0.2' } }));
  expect(save().props.disabled).toBe(true);
  await act(async () => input().props.onChange({ target: { value: '0.65' } }));
  await act(async () => save().props.onClick());
  expect(calls).toContainEqual(['set_voice_profiles_match_threshold', { value: 0.65 }]);
  expect(save().props.disabled).toBe(true);
  rejectScore = true;
  await act(async () => input().props.onChange({ target: { value: '0.70' } }));
  await act(async () => save().props.onClick());
  expect(root.root.findByProps({ role: 'alert' }).props.children).toBe('Disk unavailable');
  expect(save().props.disabled).toBe(false);
});

test('automatic sample budget defaults to twelve and saves valid bounded values', async () => {
  await act(async () => { root = create(<VoiceProfilesSettings />); });
  const input = () => root.root.findByProps({ id: 'automatic-voice-samples' });
  const save = () => root.root.findAllByType('button').find(button => button.props.children === 'Save limit')!;
  expect(input().props.value).toBe('12');
  await act(async () => input().props.onChange({target:{value:'13'}}));
  expect(save().props.disabled).toBe(true);
  await act(async () => input().props.onChange({target:{value:'6'}}));
  await act(async () => save().props.onClick());
  expect(calls).toContainEqual(['set_voice_profiles_auto_samples',{value:6}]);
});

test('promoted matching remains explicitly beta with uncertainty guidance', async () => {
  await act(async () => { root = create(<VoiceProfilesSettings />); });
  const text = JSON.stringify(root.toJSON());
  expect(text).toContain('Recognize saved voices (beta)');
  expect(text).toContain('off by default');
  expect(text).toContain('not verified identities');
});

test('saved profile limit accepts custom values and zero, rejects invalid input, and reports failed saves', async () => {
  await act(async () => {root = create(<VoiceProfilesSettings />);});
  const input = () => root.root.findByProps({id:'saved-voice-profile-limit'});
  const save = () => root.root.findAllByType('button').find(button => button.children.includes('Save profile limit'))!;
  expect(input().props.value).toBe('50');
  for (const value of ['', '-1', '1.5']) {
    await act(async () => input().props.onChange({target:{value}}));
    expect(save().props.disabled).toBe(true);
  }
  for (const value of ['125', '0']) {
    await act(async () => input().props.onChange({target:{value}}));
    await act(async () => save().props.onClick());
    expect(calls).toContainEqual(['set_voice_profiles_limit', {value:Number(value)}]);
    expect(save().props.disabled).toBe(true);
  }
  rejectLimit = true;
  await act(async () => input().props.onChange({target:{value:'200'}}));
  await act(async () => save().props.onClick());
  expect(root.root.findByProps({role:'alert'}).children.join('')).toContain('Disk unavailable');
  expect(save().props.disabled).toBe(false);
});

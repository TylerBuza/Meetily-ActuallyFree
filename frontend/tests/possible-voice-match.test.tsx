import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, mock, test } from 'bun:test';
let result: any = { person_id: 'a', name: 'Alice', score: 0.48 };
const calls: any[] = [];
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args: any) => { calls.push([command, args]); return result; } }));
mock.module('@/hooks/useLabs', () => ({ useLabs: () => ({ labs: { voiceProfiles: true } }) }));
mock.module('@/components/ui/button', () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
const { PossibleVoiceMatch } = await import('../src/components/people/PossibleVoiceMatch');
let root: ReactTestRenderer;
afterEach(async () => { await act(async () => root?.unmount()); calls.length = 0; });
test('tentative identity needs explicit acceptance and leaves source untouched', async () => {
  const accepted: string[] = [];
  await act(async () => { root = create(<PossibleVoiceMatch speaker="Speaker 3" meetingId="meeting" onAccept={name => accepted.push(name)} />); });
  expect(accepted).toHaveLength(0);
  expect(calls).toEqual([['get_possible_voice_match', { meetingId: 'meeting', speaker: 'Speaker 3' }]]);
  expect(root.root.findByType('span').props.children).toEqual(['Maybe ', 'Alice', '?']);
  await act(async () => root.root.findByType('button').props.onClick());
  expect(accepted).toEqual(['Alice']);
});
test('microphone and combined labels are not guessed', async () => {
  await act(async () => { root = create(<PossibleVoiceMatch speaker="Speaker 3 + Speaker 4" meetingId="meeting" onAccept={() => {}} />); });
  expect(calls).toHaveLength(0);
  expect(root.toJSON()).toBeNull();
});

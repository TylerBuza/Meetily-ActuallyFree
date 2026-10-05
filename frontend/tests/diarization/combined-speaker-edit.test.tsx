import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, mock, test } from 'bun:test';
const calls: Array<[string, any]> = [];
mock.module('@tauri-apps/api/core', () => ({invoke: async (command: string, args: any) => {
  calls.push([command, args]); return {speaker: args.to, count: 1, removedName: false};
}}));
mock.module('@/contexts/WorkspaceContext', () => ({useWorkspace: () => ({people: [{id:'host', displayName:'Host', meetingCount:1}]})}));
mock.module('@/hooks/useUserName', () => ({useUserName: () => 'Andrew'}));
mock.module('@/lib/workspace-api', () => ({announceChange: () => {}}));
mock.module('sonner', () => ({toast: {success: () => {}, error: () => {}}}));
const wrap = ({children}: any) => <div>{children}</div>;
mock.module('@/components/ui/dialog', () => ({Dialog:wrap, DialogContent:wrap, DialogDescription:wrap, DialogTitle:wrap}));
mock.module('@/components/ui/command', () => ({Command:wrap, CommandEmpty:wrap, CommandGroup:wrap, CommandInput:wrap, CommandList:wrap, CommandItem: (props:any) => <button data-choice={props.value} onClick={props.onSelect}>{props.children}</button>}));
mock.module('@/components/ui/avatar', () => ({Avatar:wrap}));
mock.module('@/components/ui/button', () => ({Button: (props:any) => <button {...props}/> }));
const { SpeakerIdentityDialog } = await import('../../src/components/people/SpeakerIdentityDialog');
let root: ReactTestRenderer;
afterEach(async () => {await act(async () => root?.unmount()); calls.length=0;});
async function render() {
  await act(async () => {root=create(<SpeakerIdentityDialog open onOpenChange={() => {}} speaker="You + Speaker 3 + Speaker 6" transcriptId="turn" meetingId="meeting"/>);});
  await act(async () => root.root.findByType('select').props.onChange({target:{value:'Speaker 3'}}));
}
async function chooseHost() {
  await act(async () => root.root.findAllByType('button').find(button => button.props['data-choice']==='Host host')!.props.onClick());
}
test('meeting rename from an overlap sends only the selected speaker', async () => {
  await render(); await chooseHost();
  expect(calls).toEqual([['rename_meeting_speaker', {meetingId:'meeting', from:'Speaker 3', to:'Host'}]]);
});
test('per-line edit sends the selected component and transcript identity', async () => {
  await render();
  await act(async () => root.root.findAllByType('button').find(button => button.children.includes('Just this line'))!.props.onClick());
  await chooseHost();
  expect(calls).toEqual([['reassign_transcript_speaker', {meetingId:'meeting', transcriptId:'turn', from:'Speaker 3', to:'Host'}]]);
});

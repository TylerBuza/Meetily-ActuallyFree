import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, mock, test } from 'bun:test';
const events = new EventTarget();
(globalThis as any).window = events;
let stored = false; let fail = false;
const calls: Array<[string, any]> = [];
mock.module('@tauri-apps/api/core', () => ({invoke: async (command: string, args: any) => {
  calls.push([command, args]);
  if (command.startsWith('get_')) return stored;
  if (fail) throw new Error('write failed');
  stored = args.value;
}}));
mock.module('@/components/ui/switch', () => ({Switch: (props: any) => <button {...props}/>}));
const {parseAISpeakerNames, summarySpeakerNames, projectAISpeakerLabel} = await import('../src/lib/summary-speaker-names');
const {SummarySpeakerNamesSetting} = await import('../src/components/SummarySpeakerNamesSetting');
const {AISpeakerHint} = await import('../src/components/people/AISpeakerHint');
const {useMeetingData} = await import('../src/hooks/meeting-details/useMeetingData');
let root: ReactTestRenderer | undefined;
afterEach(async () => {await act(async () => root?.unmount()); root=undefined; calls.length=0; stored=false; fail=false;});

test('only explicit pairs qualify; conflicting names and incidental mentions are omitted', () => {
  const names = parseAISpeakerNames('## AI speaker suggestions (unverified)\n- Tony (Speaker 7)\n| Task | **José Álvarez (Speaker 2)** |\n- Bob (Speaker 3)\n- Alice (Speaker 3)\nTony (Speaker 8) should call Bob.\n- You (Speaker 1)\n- Unknown (Speaker 4)');
  expect(names).toEqual({'Speaker 7':'Tony','Speaker 2':'José Álvarez'});
});
test('canonical English suggestions survive translation; edited summaries are excluded', () => {
  const summary = {markdown:'translated',english_cache:{markdown:'- Tony (Speaker 7)'}};
  expect(summarySpeakerNames(summary)).toEqual({'Speaker 7':'Tony'});
  expect(summarySpeakerNames(summary,true)).toEqual({});
  expect(summarySpeakerNames(null)).toEqual({});
});
test('projection leaves raw rows, saved names, source identity and overlap components intact', () => {
  const row = Object.freeze({speaker:'You + Speaker 7 + Host',text:'Hello',start:10,sourceId:'original'});
  const names = {'Speaker 7':'Tony',Host:'Wrong',You:'Wrong'};
  expect(projectAISpeakerLabel(row.speaker,names)).toBe('You + Tony (Speaker 7) + Host');
  expect(row).toEqual({speaker:'You + Speaker 7 + Host',text:'Hello',start:10,sourceId:'original'});
});
test('unsaved badge is visible and reviewing it never writes a speaker', async () => {
  let reviewed=0;
  await act(async () => {root=create(<AISpeakerHint speaker="Speaker 7" names={{'Speaker 7':'Tony'}} onReview={()=>reviewed++}/>);});
  expect(JSON.stringify(root!.toJSON())).toContain('AI · unsaved');
  await act(async () => root!.root.findByType('button').props.onClick());
  expect(reviewed).toBe(1); expect(calls).toEqual([]);
});
test('setting defaults off and changes only after native persistence succeeds', async () => {
  await act(async () => {root=create(<SummarySpeakerNamesSetting/>);});
  const toggle=()=>root!.root.findByType('button');
  expect(toggle().props.checked).toBe(false);
  fail=true;
  await act(async () => toggle().props.onCheckedChange(true));
  expect(toggle().props.checked).toBe(false);
  expect(root!.root.findByProps({role:'alert'}).children.join('')).toContain('write failed');
  fail=false;
  await act(async () => toggle().props.onCheckedChange(true));
  expect(toggle().props.checked).toBe(true);
  expect(calls).toContainEqual(['set_summary_speaker_names_enabled',{value:true}]);
});
test('navigation never projects the previous meeting summary or a stale completion', async () => {
  let data: any;
  function Harness({id,summary}:any) {data=useMeetingData({meeting:{id,transcripts:[]},summaryData:summary}); return null;}
  await act(async () => {root=create(<Harness id="first" summary={null}/>);});
  const oldSetter=data.setAiSummary;
  await act(async () => oldSetter({markdown:'- Tony (Speaker 7)'}));
  expect(summarySpeakerNames(data.aiSummary)).toEqual({'Speaker 7':'Tony'});
  await act(async () => root!.update(<Harness id="second" summary={null}/>));
  expect(data.aiSummary).toBeNull();
  await act(async () => oldSetter({markdown:'- Wrong (Speaker 7)'}));
  expect(data.aiSummary).toBeNull();
});

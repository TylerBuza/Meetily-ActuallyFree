import React from 'react';
import { act, create } from 'react-test-renderer';
import { expect, mock, test } from 'bun:test';
const exported: string[] = [];
const copied: string[] = [];
mock.module('@tauri-apps/api/core', () => ({ invoke: async (_: string, args: any) => args.limit === 1
  ? { total_count: 2 } : { transcripts: [
    { speaker: 'You + Alice + Speaker 2', audio_start_time: 11, text: 'First line' },
    { speaker: 'Alice', audio_start_time: 12, text: 'Second line' },
  ] } }));
mock.module('@/lib/exportSummary', () => ({ exportSummaryAs: async (_: string, text: string) => exported.push(text) }));
mock.module('@/hooks/useUserName', () => ({ useUserName: () => 'Tyler' }));
mock.module('@/lib/analytics', () => ({ default: { trackFeatureUsed: async () => {}, trackCopy: async () => {} } }));
mock.module('sonner', () => ({ toast: { error: (message: string) => { throw new Error(message); }, success() {} } }));
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string) => copied.push(text) } } });
const { useCopyOperations } = await import('../src/hooks/meeting-details/useCopyOperations');
test('only Markdown gets frontmatter and per-component links; clipboard and TXT retain attribution', async () => {
  let hook!: ReturnType<typeof useCopyOperations>;
  function Probe() { hook = useCopyOperations({ meeting: { id: 'm1', title: 'Meeting', created_at: '2026-10-06T12:00:00Z' }, aiSummary: null }); return null; }
  let root: ReturnType<typeof create>;
  await act(async () => { root = create(<Probe />); });
  try {
    expect(await hook.handleExportMeeting('transcript', 'markdown', 'obsidian')).toBe(true);
    expect(exported[0].startsWith('---\n')).toBe(true);
    expect(exported[0]).toContain('  - "[[Alice]]"');
    expect(exported[0]).not.toContain('[[You');
    expect(exported[0]).toContain('Tyler (You) + [[Alice]] + Speaker 2');
    await hook.handleExportMeeting('transcript', 'txt', 'obsidian');
    await hook.handleExportMeeting('transcript', 'clipboard', 'obsidian');
    expect(exported[1]).toBe(copied[0]);
    expect(exported[1]).not.toContain('[[Alice]]');
    expect(exported[1]).not.toContain('meeting_id:');
    expect(exported[1]).toContain('Tyler (You) + Alice + Speaker 2');
  } finally { await act(async () => root!.unmount()); }
});

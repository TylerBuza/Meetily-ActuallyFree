// Run with: pnpm dlx bun@1.3.10 test tests/lib/meeting-automation.test.ts
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

// The helpers hand off through sessionStorage and announce on window.
const store = new Map<string, string>();
const announced: string[] = [];
Object.assign(globalThis, {
  sessionStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  },
  window: { dispatchEvent: (event: Event) => announced.push(event.type) },
});

const {
  automatedRecording,
  beginAutomatedRecording,
  endAutomatedRecording,
  markAutomatedStart,
  takeAutomatedStart,
} = await import('../../src/lib/meeting-automation.ts');

const zoom = { app: 'Zoom', process: 'Zoom.exe' };

describe('meeting automation hand-off', () => {
  beforeEach(() => {
    store.clear();
    announced.length = 0;
  });

  test('a start request is taken once, by the next start', () => {
    markAutomatedStart(zoom);
    assert.deepEqual(takeAutomatedStart(), zoom);
    assert.equal(takeAutomatedStart(), null);
  });

  test('a stale start request is ignored', () => {
    store.set('labsAutoStartPending', JSON.stringify({ ...zoom, at: Date.now() - 120_000 }));
    assert.equal(takeAutomatedStart(), null);
  });

  test('only the recording automation started is stopped for its call', () => {
    assert.equal(automatedRecording(), null);
    beginAutomatedRecording(zoom);
    assert.deepEqual(automatedRecording(), zoom);
    endAutomatedRecording();
    assert.equal(automatedRecording(), null);
    assert.deepEqual(announced, ['meetily-automation-changed', 'meetily-automation-changed']);
  });

  test('reads the bare process name that #38 stored', () => {
    store.set('labsAutoRecordingProcess', 'Teams.exe');
    assert.deepEqual(automatedRecording(), { app: 'Teams.exe', process: 'Teams.exe' });
  });

  test('ending with nothing running announces nothing', () => {
    endAutomatedRecording();
    assert.deepEqual(announced, []);
  });
});

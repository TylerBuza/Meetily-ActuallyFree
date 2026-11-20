import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

let platform = 'linux';
let reads: string[];
let resolveRead: (bytes: Uint8Array<ArrayBuffer>) => void;
let readResult: Promise<Uint8Array<ArrayBuffer>>;
const created: Blob[] = [];
const revoked: string[] = [];
const elements: FakeAudio[] = [];
class FakeAudio {
  src = '';
  preload = '';
  duration = 20;
  currentTime = 0;
  paused = true;
  playbackRate = 1;
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onended: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  loads = 0;
  constructor() { elements.push(this); }
  pause() { this.paused = true; this.onpause?.(); }
  async play() { this.paused = false; this.onplay?.(); }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() { this.loads++; }
}
Object.assign(globalThis, {
  React, Audio: FakeAudio,
  requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
});
URL.createObjectURL = (blob) => { created.push(blob as Blob); return `blob:audio-${created.length}`; };
URL.revokeObjectURL = (url) => { revoked.push(url); };
mock.module('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => `asset:${path}` }));
mock.module('../../src/hooks/usePlatform', () => ({ detectPlatformFromUserAgent: () => platform }));
mock.module('../../src/lib/workspace-api', () => ({
  getMeetingAudio: async (id: string) => ({ path: `/recordings/${id}/audio.mp4` }),
  readMeetingAudio: (id: string) => { reads.push(id); return readResult; },
}));
const { useMeetingAudio } = await import('../../src/hooks/useMeetingAudio');
let controls: ReturnType<typeof useMeetingAudio>;
let tree: ReactTestRenderer | undefined;
function Probe({ id }: { id: string }) { controls = useMeetingAudio(id); return null; }
async function mount(id = 'one') {
  await act(async () => { tree = create(<Probe id={id} />); });
}
beforeEach(() => {
  platform = 'linux';
  reads = [];
  created.length = revoked.length = elements.length = 0;
  readResult = new Promise((resolve) => { resolveRead = resolve; });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; });

test('Linux reads by meeting ID and releases the decoder before revoking its blob', async () => {
  await mount();
  expect(reads).toEqual(['one']);
  expect(elements).toHaveLength(0);
  await act(async () => { resolveRead(new Uint8Array([1, 2])); });
  expect(created[0].type).toBe('audio/mp4');
  expect(elements[0].src).toBe('blob:audio-1');
  await act(async () => elements[0].onloadedmetadata?.());
  expect(controls.status).toBe('ready');
  expect(controls.duration).toBe(20);
  await act(async () => tree!.unmount());
  expect(elements[0].src).toBe('');
  expect(elements[0].loads).toBe(1);
  expect(elements[0].onloadedmetadata).toBeNull();
  expect(revoked).toEqual(['blob:audio-1']);
});

test('leaving during IPC never constructs an orphaned audio element or blob', async () => {
  await mount();
  await act(async () => tree!.unmount());
  await act(async () => resolveRead(new Uint8Array([1])));
  expect(created).toHaveLength(0);
  expect(elements).toHaveLength(0);
});

test('switching meetings ignores an old read and releases the previous loaded blob', async () => {
  await mount();
  const oldRead = resolveRead;
  readResult = Promise.resolve(new Uint8Array([2]));
  await act(async () => tree!.update(<Probe id="two" />));
  await act(async () => oldRead(new Uint8Array([1])));
  expect(created).toHaveLength(1);
  expect(controls.path).toContain('/two/');
  await act(async () => tree!.update(<Probe id="three" />));
  expect(revoked).toEqual(['blob:audio-1']);
  expect(elements[0].src).toBe('');
  expect(elements[1].src).toBe('blob:audio-2');
});

test('Windows and macOS keep asset streaming without reading the entire recording', async () => {
  platform = 'windows';
  await mount();
  expect(reads).toHaveLength(0);
  expect(created).toHaveLength(0);
  expect(elements[0].src).toBe('asset:/recordings/one/audio.mp4');
});

test('an IPC limit error remains visible instead of claiming no audio was saved', async () => {
  readResult = Promise.reject('Recording exceeds the 256 MiB Linux in-app playback limit');
  await mount();
  expect(controls.status).toBe('error');
  expect(controls.errorMessage).toContain('256 MiB');
  expect(created).toHaveLength(0);
});

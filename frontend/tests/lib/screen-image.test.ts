import { expect, test } from 'bun:test';
import { screenImage } from '../../src/lib/screen-image';

test('one-frame capture bounds image size and releases the display stream', async () => {
  let stopped = 0;
  let size: [number, number] = [0, 0];
  const blob = new Blob(['frame'], { type: 'image/jpeg' });
  const video = { videoWidth: 3840, videoHeight: 2160, srcObject: null as unknown, play: async () => {} };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: () => { size = [canvas.width, canvas.height]; } }), toBlob: (done: (value: Blob) => void) => done(blob) };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getDisplayMedia: async () => ({ getTracks: () => [{ stop: () => { stopped++; } }] }) } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => tag === 'video' ? video : canvas } });
  expect(await screenImage()).toBe(blob);
  expect(size).toEqual([1920, 1080]);
  expect(stopped).toBe(1);
  expect(video.srcObject).toBeNull();
  video.play = async () => { throw new Error('playback failed'); };
  await expect(screenImage()).rejects.toThrow('playback failed');
  expect(stopped).toBe(2);
  expect(video.srcObject).toBeNull();
});

import { expect, test } from 'bun:test';
import { SystemAudioLevelMonitor } from '../../src/lib/system-audio-level';

test('sustained weak signal warns, a brief quiet passage does not', () => {
  const monitor = new SystemAudioLevelMonitor();
  for (let ms = 0; ms < 5000; ms += 40) expect(monitor.update(0.002, 0.008, ms)).toBe(false);
  expect(monitor.update(0.002, 0.008, 5000)).toBe(true);
  expect(monitor.update(0.04, 0.2, 5040)).toBe(false);
  expect(monitor.update(0.002, 0.008, 5080)).toBe(false);
});

test('silence, numerical noise and invalid samples do not warn', () => {
  for (const [rms, peak] of [[0, 0], [0.000001, 0.000002], [NaN, 0.1], [0.1, Infinity], [-1, 0]]) {
    const monitor = new SystemAudioLevelMonitor();
    for (let ms = 0; ms < 10000; ms += 100) expect(monitor.update(rms, peak, ms)).toBe(false);
  }
});

test('missing callbacks and reset do not count as sustained quiet input', () => {
  const monitor = new SystemAudioLevelMonitor();
  for (let ms = 0; ms <= 5000; ms += 100) monitor.update(0.002, 0.008, ms);
  expect(monitor.update(0.002, 0.008, 5100)).toBe(true);
  expect(monitor.update(0.002, 0.008, 8000)).toBe(false);
  for (let ms = 8100; ms <= 13000; ms += 100) monitor.update(0.002, 0.008, ms);
  monitor.reset();
  expect(monitor.update(0.002, 0.008, 13100)).toBe(false);
});

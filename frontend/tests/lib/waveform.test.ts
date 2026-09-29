// Run with: pnpm dlx bun@1.3.10 test tests/lib/waveform.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { waveformBars } from '../../src/hooks/useWaveform.ts';

describe('waveformBars', () => {
  test('each bar is the loudest second it covers', () => {
    const bars = waveformBars([0.1, 0.4, 0.2, 0.8], 2);
    assert.equal(bars.length, 2);
    // Scaled to the loudest moment, then square-rooted so quiet talk shows.
    assert.equal(bars[1], 1);
    assert.ok(Math.abs(bars[0] - Math.sqrt(0.4 / 0.8)) < 1e-9);
  });

  test('never draws more bars than there are seconds', () => {
    assert.equal(waveformBars([0.5, 0.5, 0.5], 40).length, 3);
  });

  test('a silent recording stays flat instead of dividing by zero', () => {
    assert.deepEqual(waveformBars([0, 0, 0], 3), [0, 0, 0]);
    assert.deepEqual(waveformBars([], 10), []);
  });
});

import { describe, expect, test } from 'bun:test';
import { describeStartError } from '../../src/lib/recording-start-errors';

describe('describeStartError', () => {
  test('advises opening an app only when none of the chosen apps runs', () => {
    expect(describeStartError('Failed to start recording: No target application is currently running').title)
      .toBe('None of your chosen apps is open');
    expect(describeStartError('No target application is running with audio').title)
      .toBe('Could not start recording');
  });

  test('shows the backend reason for unrecognised errors', () => {
    expect(describeStartError('Failed to start recording: Disk is full')).toEqual({
      title: 'Could not start recording',
      message: 'Disk is full',
    });
  });

  test('reads Error objects and serialized objects instead of "[object Object]"', () => {
    expect(describeStartError(new Error('Disk is full')).message).toBe('Disk is full');
    expect(describeStartError({ message: 'Disk is full' }).message).toBe('Disk is full');
    expect(describeStartError({ code: 7 }).message).toBe('{"code":7}');
  });

  test('falls back to generic advice when there is no reason at all', () => {
    expect(describeStartError(undefined).message).toBe('Check your audio devices in the recording card and try again.');
  });
});

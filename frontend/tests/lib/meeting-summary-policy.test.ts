import { describe, expect, test } from 'bun:test';
import { shouldSetUpAutoSummary } from '../../src/lib/meeting-summary-policy';

describe('shouldSetUpAutoSummary', () => {
  test('allows recording summaries when Auto Summary is enabled', () => {
    expect(shouldSetUpAutoSummary('recording', true)).toBe(true);
  });

  test('blocks recording summaries when Auto Summary is disabled', () => {
    expect(shouldSetUpAutoSummary('recording', false)).toBe(false);
  });

  test('does not auto-generate when opening an existing meeting', () => {
    expect(shouldSetUpAutoSummary(null, true)).toBe(false);
  });
});

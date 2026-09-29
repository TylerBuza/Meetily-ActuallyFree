// Run with: node --test tests/lib/meeting-titles.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PREFIX,
  defaultMeetingTitle,
  displayTitle,
  finalizeDefaultTitle,
  groupMeetingTitle,
  isDefaultTitle,
  timeRange,
} from '../../src/lib/meeting-titles.ts';

const start = new Date(2026, 8, 28, 14, 30);

test('default titles carry the day and start time', () => {
  const title = defaultMeetingTitle(start);
  assert.ok(title.startsWith(DEFAULT_PREFIX));
  assert.match(title, /Sep 28/);
  assert.match(title, /2:30/);
  assert.ok(isDefaultTitle(title));
});

test('finishing a recording adds the end of the slot, once', () => {
  const end = new Date(2026, 8, 28, 15, 15);
  const finished = finalizeDefaultTitle(defaultMeetingTitle(start), start, end);
  assert.match(finished, /2:30.3:15/);
  assert.ok(finished.startsWith(DEFAULT_PREFIX));
  // A title the user changed is left alone.
  assert.equal(finalizeDefaultTitle('Budget review', start, end), 'Budget review');
});

test('group titles use the group name and date, adding time on a clash', () => {
  const first = groupMeetingTitle('Weekly Standup', start);
  assert.match(first, /^Weekly Standup — Sep 28$/);
  assert.match(groupMeetingTitle('Weekly Standup', start, [first]), /^Weekly Standup — Sep 28, 2:30/);
  assert.equal(isDefaultTitle(first), false);
});

test('legacy auto titles display in the new format', () => {
  assert.ok(isDefaultTitle('Meeting 27_09_26_23_05_13'));
  assert.ok(displayTitle('Meeting 27_09_26_23_05_13', start.toISOString()).startsWith(DEFAULT_PREFIX));
  assert.equal(displayTitle('Q4 planning', start.toISOString()), 'Q4 planning');
  assert.equal(displayTitle('', null), 'Untitled meeting');
});

describe('timeRange', () => {
  test('a range inside one minute is just that time', () => {
    const start = new Date(2026, 8, 28, 13, 50, 5);
    assert.equal(timeRange(start, new Date(2026, 8, 28, 13, 50, 40)), timeRange(start, start));
    assert.doesNotMatch(timeRange(start, new Date(2026, 8, 28, 13, 50, 40)), /–/);
  });
});

// Run with: node --test tests/lib/schedule.test.ts   (Node 22.6+ strips the types)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSchedule,
  describeSchedule,
  effectiveSchedule,
  nextOccurrence,
  parseTypedTime,
  upcomingGroupMeetings,
  MIN_OCCURRENCES,
  type GroupSchedule,
} from '../../src/lib/schedule.ts';

/** Local date helper: month is 1-based here for readability. */
const at = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute);

/** Every `stepDays` from a start, `count` times, at the same local time. */
function series(start: Date, stepDays: number, count: number, jitterMinutes: number[] = []): Date[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index * stepDays, start.getHours(), start.getMinutes());
    date.setMinutes(date.getMinutes() + (jitterMinutes[index] ?? 0));
    return date;
  });
}

// Thursday, October 1 2026.
const THU = at(2026, 10, 1, 12, 0);

describe('detectSchedule: refuses weak evidence', () => {
  test('a single meeting is never a pattern', () => {
    assert.equal(detectSchedule([THU], at(2026, 10, 2)), null);
  });

  test('two weekly meetings are not enough', () => {
    assert.equal(MIN_OCCURRENCES, 3);
    assert.equal(detectSchedule(series(THU, 7, 2), at(2026, 10, 9)), null);
  });

  test('meetings on random days and times are not a pattern', () => {
    const starts = [at(2026, 9, 1, 9), at(2026, 9, 3, 15), at(2026, 9, 9, 11), at(2026, 9, 16, 17), at(2026, 9, 22, 8)];
    assert.equal(detectSchedule(starts, at(2026, 9, 25)), null);
  });

  test('same weekday but wildly different times is not a pattern', () => {
    const starts = [at(2026, 9, 3, 9), at(2026, 9, 10, 13), at(2026, 9, 17, 17)];
    assert.equal(detectSchedule(starts, at(2026, 9, 20)), null);
  });

  test('three meetings a month apart are not weekly', () => {
    const starts = [at(2026, 7, 2), at(2026, 8, 6), at(2026, 9, 3)];
    assert.equal(detectSchedule(starts, at(2026, 9, 5)), null);
  });

  test('a series that stopped weeks ago is stale', () => {
    const starts = series(at(2026, 6, 4), 7, 6);
    assert.equal(detectSchedule(starts, at(2026, 9, 1)), null);
  });

  test('too many skipped weeks drops below the coverage bar', () => {
    // Weekly spacing for three weeks, then one more meeting seven weeks later:
    // 4 of 10 expected Thursdays (40%) is under the 60% bar.
    const starts = [at(2026, 7, 2), at(2026, 7, 9), at(2026, 7, 16), at(2026, 9, 3)];
    assert.equal(detectSchedule(starts, at(2026, 9, 4)), null);
  });

  test('future-dated and invalid inputs are ignored', () => {
    const starts: Array<Date | string> = [...series(THU, 7, 2), at(2027, 1, 7), 'not a date'];
    assert.equal(detectSchedule(starts, at(2026, 10, 9)), null);
  });
});

describe('detectSchedule: finds real patterns', () => {
  test('three weekly meetings make a weekly schedule', () => {
    const detected = detectSchedule(series(THU, 7, 3), at(2026, 10, 16));
    assert.ok(detected);
    assert.deepEqual(detected.weekdays, [4]);
    assert.equal(detected.time, '12:00');
    assert.equal(detected.cadence, 'weekly');
    assert.equal(detected.occurrences, 3);
  });

  test('small start-time drift is tolerated and summarised by the median, to five minutes', () => {
    const detected = detectSchedule(series(THU, 7, 5, [2, -3, 5, 0, 1]), at(2026, 10, 30));
    assert.ok(detected);
    assert.equal(detected.time, '12:00');
    const late = detectSchedule(series(THU, 7, 4, [7, 8, 6, 9]), at(2026, 10, 30));
    assert.equal(late?.time, '12:10');
  });

  test('an occasional skipped week still counts as weekly', () => {
    const starts = series(THU, 7, 8).filter((_, index) => index !== 2 && index !== 5);
    const detected = detectSchedule(starts, at(2026, 11, 20));
    assert.ok(detected);
    assert.equal(detected.cadence, 'weekly');
    assert.ok(detected.coverage >= 0.6);
  });

  test('every other week is biweekly', () => {
    const detected = detectSchedule(series(at(2026, 9, 7, 9, 30), 14, 4), at(2026, 10, 20));
    assert.ok(detected);
    assert.equal(detected.cadence, 'biweekly');
    assert.deepEqual(detected.weekdays, [1]);
    assert.equal(detected.time, '09:30');
  });

  test('Mon/Wed/Fri standups merge into one schedule', () => {
    const monday = at(2026, 9, 7, 9, 0);
    const starts = [...series(monday, 7, 4), ...series(at(2026, 9, 9, 9, 5), 7, 4), ...series(at(2026, 9, 11, 8, 58), 7, 4)];
    const detected = detectSchedule(starts, at(2026, 10, 3));
    assert.ok(detected);
    assert.deepEqual(detected.weekdays, [1, 3, 5]);
    assert.equal(detected.cadence, 'weekly');
  });

  test('a strong pattern wins over unrelated one-off meetings in the same group', () => {
    const starts = [...series(THU, 7, 4), at(2026, 10, 6, 16), at(2026, 10, 13, 10)];
    const detected = detectSchedule(starts, at(2026, 10, 23));
    assert.ok(detected);
    assert.deepEqual(detected.weekdays, [4]);
  });

  test('two meetings on the same day count once', () => {
    const starts = [THU, at(2026, 10, 1, 12, 40), at(2026, 10, 8), at(2026, 10, 15)];
    const detected = detectSchedule(starts, at(2026, 10, 16));
    assert.ok(detected);
    assert.equal(detected.occurrences, 3);
  });
});

describe('nextOccurrence', () => {
  const weekly: GroupSchedule = { weekdays: [4], time: '12:00', cadence: 'weekly' };

  test('returns the upcoming slot', () => {
    const next = nextOccurrence(weekly, at(2026, 10, 5, 9));
    assert.deepEqual(next, at(2026, 10, 8, 12, 0));
  });

  test('a slot stays due for an hour after it starts', () => {
    assert.deepEqual(nextOccurrence(weekly, at(2026, 10, 8, 12, 40)), at(2026, 10, 8, 12, 0));
    assert.deepEqual(nextOccurrence(weekly, at(2026, 10, 8, 13, 30)), at(2026, 10, 15, 12, 0));
  });

  test('a slot that already has a meeting is skipped', () => {
    const next = nextOccurrence(weekly, at(2026, 10, 8, 12, 30), { heldAt: [at(2026, 10, 8, 12, 5)] });
    assert.deepEqual(next, at(2026, 10, 15, 12, 0));
  });

  test('biweekly respects the anchor parity', () => {
    const biweekly: GroupSchedule = { weekdays: [1], time: '09:30', cadence: 'biweekly', anchorDate: '2026-09-07' };
    assert.deepEqual(nextOccurrence(biweekly, at(2026, 9, 8)), at(2026, 9, 21, 9, 30));
    assert.deepEqual(nextOccurrence(biweekly, at(2026, 9, 22)), at(2026, 10, 5, 9, 30));
  });

  test('crosses a daylight-saving change without drifting', () => {
    // US DST ends Nov 1 2026; local 12:00 must stay 12:00.
    const next = nextOccurrence(weekly, at(2026, 10, 30, 13));
    assert.ok(next);
    assert.equal(next.getHours(), 12);
    assert.equal(next.getDay(), 4);
  });

  test('invalid schedules produce nothing', () => {
    assert.equal(nextOccurrence({ weekdays: [], time: '12:00', cadence: 'weekly' }), null);
    assert.equal(nextOccurrence({ weekdays: [2], time: '25:00', cadence: 'weekly' }), null);
  });
});

describe('effectiveSchedule and describeSchedule', () => {
  test('a schedule the user set wins over detection', () => {
    const user: GroupSchedule = { weekdays: [2], time: '15:00', cadence: 'weekly' };
    const result = effectiveSchedule(user, series(THU, 7, 4), at(2026, 10, 23));
    assert.equal(result?.source, 'user');
    assert.deepEqual(result?.schedule.weekdays, [2]);
  });

  test('falls back to a detected pattern, else nothing', () => {
    assert.equal(effectiveSchedule(null, series(THU, 7, 4), at(2026, 10, 23))?.source, 'detected');
    assert.equal(effectiveSchedule(null, [THU], at(2026, 10, 2)), null);
  });

  test('reads naturally', () => {
    assert.match(describeSchedule({ weekdays: [4], time: '12:00', cadence: 'weekly' }), /^Every Thursday at /);
    assert.match(describeSchedule({ weekdays: [1, 2, 3, 4, 5], time: '09:00', cadence: 'weekly' }), /^Every weekday at /);
    assert.match(describeSchedule({ weekdays: [1, 3], time: '09:00', cadence: 'biweekly' }), /^Every other Mon, Wed at /);
  });
});

describe('upcomingGroupMeetings', () => {
  // Monday, October 5 2026, 9:00.
  const now = at(2026, 10, 5, 9, 0);
  const standups = series(at(2026, 9, 10, 12, 0), 7, 4).map((date) => ({ groupId: 'standup', startedAt: date }));

  test('lists detected and user schedules, soonest first', () => {
    const groups = [
      { id: 'standup', schedule: null },
      { id: 'review', schedule: { weekdays: [2], time: '15:00', cadence: 'weekly' } as GroupSchedule },
    ];
    const upcoming = upcomingGroupMeetings(groups, standups, now);
    assert.deepEqual(
      upcoming.map((entry) => [entry.group.id, entry.source, entry.at.getDate(), entry.at.getHours()]),
      [
        ['review', 'user', 6, 15],
        ['standup', 'detected', 8, 12],
      ],
    );
  });

  test('leaves out groups without a pattern, and one-off meetings', () => {
    const groups = [{ id: 'standup', schedule: null }, { id: 'once', schedule: null }];
    const meetings = [...standups, { groupId: 'once', startedAt: at(2026, 10, 1, 10, 0) }, { groupId: null, startedAt: now }];
    assert.deepEqual(upcomingGroupMeetings(groups, meetings, now).map((entry) => entry.group.id), ['standup']);
  });

  test('skips a slot already recorded today', () => {
    const thursday = at(2026, 10, 8, 12, 30);
    const held = [...standups, { groupId: 'standup', startedAt: at(2026, 10, 8, 12, 2) }];
    const [next] = upcomingGroupMeetings([{ id: 'standup', schedule: null }], held, thursday);
    assert.equal(next.at.getDate(), 15);
  });
});

describe('parseTypedTime', () => {
  const minutes = (hours: number, mins = 0) => hours * 60 + mins;

  test('reads hours, minutes and am/pm in the usual spellings', () => {
    assert.equal(parseTypedTime('9'), minutes(9));
    assert.equal(parseTypedTime('930'), minutes(9, 30));
    assert.equal(parseTypedTime('9:30'), minutes(9, 30));
    assert.equal(parseTypedTime('9:30 pm'), minutes(21, 30));
    assert.equal(parseTypedTime('9.30 P.M.'), minutes(21, 30));
    assert.equal(parseTypedTime('9p'), minutes(21));
    assert.equal(parseTypedTime('12am'), minutes(0));
    assert.equal(parseTypedTime('12 pm'), minutes(12));
    assert.equal(parseTypedTime('21:30'), minutes(21, 30));
    assert.equal(parseTypedTime('0930'), minutes(9, 30));
    assert.equal(parseTypedTime('9h30'), minutes(9, 30));
    assert.equal(parseTypedTime('noon'), minutes(12));
    assert.equal(parseTypedTime('midnight'), 0);
  });

  test('a lone 1 to 6 means the afternoon on a 12-hour clock only', () => {
    assert.equal(parseTypedTime('3'), minutes(15));
    assert.equal(parseTypedTime('330'), minutes(15, 30));
    assert.equal(parseTypedTime('3am'), minutes(3));
    assert.equal(parseTypedTime('03'), minutes(3));
    assert.equal(parseTypedTime('7'), minutes(7));
    assert.equal(parseTypedTime('3', false), minutes(3));
  });

  test('rejects anything that is not a time', () => {
    for (const text of ['', ' ', 'soon', '24', '9:60', '13pm', '0am', '12345', '9:5', 'nine']) {
      assert.equal(parseTypedTime(text), null, text);
    }
  });
});

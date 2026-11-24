import { expect, test } from 'bun:test';
import { displaySpeaker, isUserSpeaker, meetingSpeakerRoster, speakerKey, replaceSpeakerComponent, resolveSpeaker } from '../../src/utils/speakerUtils';

test('overlaps retain all speakers in display/export and distinct identity keys', () => {
  expect(displaySpeaker('You + Speaker 1 + Speaker 2', 'Andrew')).toBe('Andrew (You) + Speaker 1 + Speaker 2');
  expect(displaySpeaker('Host + Andrew (You)', 'Andrew')).toBe('Host + Andrew (You)');
  expect(isUserSpeaker('You + Speaker 1')).toBe(false);
  expect(isUserSpeaker('Host + Andrew (You)')).toBe(false);
  expect(isUserSpeaker('YouTube host')).toBe(false);
  expect(isUserSpeaker('Andrew (You)')).toBe(true);
  expect(speakerKey('You + Speaker 1')).not.toBe(speakerKey('You'));
});

test('component renames preserve overlap, exact boundaries and merge duplicates', () => {
  expect(replaceSpeakerComponent('Speaker 3 + Speaker 6', 'Speaker 3', 'Host')).toBe('Host + Speaker 6');
  expect(replaceSpeakerComponent('Speaker 30 + Speaker 6', 'Speaker 3', 'Host')).toBe('Speaker 30 + Speaker 6');
  expect(replaceSpeakerComponent('Host + Speaker 6', 'Speaker 6', 'Host')).toBe('Host');
  expect(resolveSpeaker('You + Speaker 3 + Speaker 6', {'Speaker 3': 'Host'})).toBe('You + Host + Speaker 6');
});

test('the five labels in a finished meeting produce three people, counting shared lines for both', () => {
  expect(meetingSpeakerRoster([
    { label: 'Speaker 3', count: 8 },
    { label: 'Speaker 1', count: 7 },
    { label: 'Speaker 1 + Speaker 3', count: 4 },
    { label: 'Speaker 2', count: 3 },
    { label: 'Speaker 1 + Speaker 2', count: 2 },
  ])).toEqual([
    { label: 'Speaker 1', count: 13 },
    { label: 'Speaker 3', count: 12 },
    { label: 'Speaker 2', count: 5 },
  ]);
});

test('overlap-only voices, aliases and literal plus signs survive roster normalization', () => {
  expect(meetingSpeakerRoster([
    { label: 'You + Pat (You) + C++', count: 3 },
    { label: 'c++ + Sam', count: 1 },
    { label: '   ', count: 5 },
  ])).toEqual([
    { label: 'C++', count: 4 },
    { label: 'You', count: 3 },
    { label: 'Sam', count: 1 },
  ]);
});

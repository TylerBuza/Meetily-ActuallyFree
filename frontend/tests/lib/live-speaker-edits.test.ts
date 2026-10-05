import { beforeEach, expect, test } from 'bun:test';
import { editedSpeaker, persistSpeakerRename, persistTurnSpeaker, persistForwardSpeaker } from '../../src/lib/live-speaker-edits';

beforeEach(() => {
  const values = new Map<string, string>();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(), key: () => null, get length() { return values.size; },
  };
});

test('raw native history and future turns recover names only for their meeting', () => {
  persistSpeakerRename('one', 'Speaker 1', 'Alice');
  persistSpeakerRename('one', 'Alice', 'Bob');
  expect(editedSpeaker('one', 0, 'Speaker 1')).toBe('Bob');
  expect(editedSpeaker('one', 10, 'Speaker 1')).toBe('Bob');
  expect(editedSpeaker('two', 0, 'Speaker 1')).toBe('Speaker 1');
  expect(editedSpeaker('one', 1, 'You')).toBe('You');
});

test('sequence overrides survive changing UI IDs, merges and clearing a label', () => {
  persistTurnSpeaker('one', 0, 'Alice');
  persistSpeakerRename('one', 'Alice', 'Bob');
  expect(editedSpeaker('one', 0, 'Speaker 2')).toBe('Bob');
  expect(editedSpeaker('one', 1, 'Speaker 2')).toBe('Speaker 2');
  persistTurnSpeaker('one', 0, '');
  expect(editedSpeaker('one', 0, 'Speaker 2')).toBeUndefined();
});

test('restoring a previous name does not create alias cycles', () => {
  persistSpeakerRename('one', 'Speaker 1', 'Alice');
  persistSpeakerRename('one', 'Alice', 'Speaker 1');
  expect(editedSpeaker('one', 0, 'Speaker 1')).toBe('Speaker 1');
});

test('failed persistence is surfaced before UI edit acknowledgement', () => {
  localStorage.setItem = () => { throw new Error('quota'); };
  expect(() => persistSpeakerRename('one', 'Speaker 1', 'Alice')).toThrow('quota');
});

test('overlap names survive live history, reload and per-turn overrides', () => {
  persistSpeakerRename('one', 'Speaker 3', 'Host');
  expect(editedSpeaker('one', 0, 'You + Speaker 3 + Speaker 6')).toBe('You + Host + Speaker 6');
  persistTurnSpeaker('one', 1, 'You + Host + Speaker 6');
  persistSpeakerRename('one', 'Speaker 6', 'Guest name');
  expect(editedSpeaker('one', 1, 'Speaker 3')).toBe('You + Host + Guest name');
  expect(editedSpeaker('two', 0, 'Speaker 3 + Speaker 6')).toBe('Speaker 3 + Speaker 6');
});

test('forward separation keeps earlier matches and other channels through history replay', () => {
  persistSpeakerRename('one', 'Speaker 1', 'Alice');
  persistForwardSpeaker('one', 'Speaker 1', 20, 'Bob');
  expect(editedSpeaker('one', 19, 'Alice', 'Speaker 1')).toBe('Alice');
  expect(editedSpeaker('one', 20, 'Alice', 'Speaker 1')).toBe('Bob');
  expect(editedSpeaker('one', 40, 'Speaker 1', 'Speaker 1')).toBe('Bob');
  expect(editedSpeaker('one', 40, 'Alice', 'Speaker 2')).toBe('Alice');
  expect(editedSpeaker('two', 40, 'Alice', 'Speaker 1')).toBe('Alice');
  persistTurnSpeaker('one', 25, 'Carol');
  expect(editedSpeaker('one', 25, 'Alice', 'Speaker 1')).toBe('Carol');
  persistForwardSpeaker('one', 'Speaker 1', 30, 'Dave');
  expect(editedSpeaker('one', 29, 'Speaker 1', 'Speaker 1')).toBe('Bob');
  expect(editedSpeaker('one', 30, 'Speaker 1', 'Speaker 1')).toBe('Dave');
});

test('forward separation replaces an existing assignment on the selected boundary line', () => {
  persistTurnSpeaker('one', 12, 'Wrong name');
  persistForwardSpeaker('one', 'Speaker 2', 12, 'Correct name');
  expect(editedSpeaker('one', 12, 'Wrong name', 'Speaker 2')).toBe('Correct name');
  expect(editedSpeaker('one', 13, 'Speaker 2', 'Speaker 2')).toBe('Correct name');
  expect(editedSpeaker('one', 11, 'Earlier name', 'Speaker 2')).toBe('Earlier name');
});

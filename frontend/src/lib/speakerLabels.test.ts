import { describe, expect, test } from 'bun:test';
import { isGeneratedSpeakerLabel, isLinkableSpeakerName } from './speakerLabels';

describe('isGeneratedSpeakerLabel', () => {
  test('matches auto-generated "Speaker N" labels case-insensitively', () => {
    expect(isGeneratedSpeakerLabel('Speaker 2')).toBe(true);
    expect(isGeneratedSpeakerLabel('speaker 12')).toBe(true);
  });

  test('does not match assigned names', () => {
    expect(isGeneratedSpeakerLabel('Jordan Alvarez')).toBe(false);
    expect(isGeneratedSpeakerLabel('You')).toBe(false);
  });

  test('handles null and empty input', () => {
    expect(isGeneratedSpeakerLabel(null)).toBe(false);
    expect(isGeneratedSpeakerLabel('')).toBe(false);
  });
});

describe('isLinkableSpeakerName', () => {
  test('rejects generated labels', () => {
    expect(isLinkableSpeakerName('Speaker 3')).toBe(false);
  });

  test('rejects placeholder labels regardless of case/whitespace', () => {
    expect(isLinkableSpeakerName('You')).toBe(false);
    expect(isLinkableSpeakerName(' guest ')).toBe(false);
  });

  test('rejects empty or missing input', () => {
    expect(isLinkableSpeakerName('')).toBe(false);
    expect(isLinkableSpeakerName(undefined)).toBe(false);
    expect(isLinkableSpeakerName(null)).toBe(false);
  });

  test('accepts a real assigned name', () => {
    expect(isLinkableSpeakerName('Jordan Alvarez')).toBe(true);
  });
});

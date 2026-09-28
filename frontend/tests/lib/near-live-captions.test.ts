import { describe, expect, test } from 'bun:test';
import { mergeInterleavedSpeakerTurns } from '../../src/lib/nearLiveCaptions';

describe('near-live display', () => {
  test('keeps both overlapping source lines and extends the first speaker', () => {
    const turns = [
      { id: 'a1', speaker: 'You', timestamp: 0, endTime: 2, text: 'I am' },
      { id: 'b1', speaker: 'Speaker 1', timestamp: 1, endTime: 3, text: 'Hello' },
      { id: 'a2', speaker: 'You', timestamp: 2, endTime: 4, text: 'still talking' },
    ];
    expect(mergeInterleavedSpeakerTurns(turns)).toEqual([
      { id: 'a1', speaker: 'You', timestamp: 0, endTime: 4, text: 'I am still talking' },
      { id: 'b1', speaker: 'Speaker 1', timestamp: 1, endTime: 3, text: 'Hello' },
    ]);
    expect(turns[0].text).toBe('I am');
  });

  test('starts a new line after a gap or speaker change', () => {
    const turns = [
      { id: 'a1', speaker: 'Speaker 1', timestamp: 0, endTime: 1, text: 'One' },
      { id: 'a2', speaker: 'Speaker 2', timestamp: 1, endTime: 2, text: 'Two' },
      { id: 'a3', speaker: 'Speaker 1', timestamp: 6, endTime: 7, text: 'Three' },
    ];
    expect(mergeInterleavedSpeakerTurns(turns)).toHaveLength(3);
  });

  test('updates a provisional line without mutating final transcript turns', () => {
    const finalTurn = { id: 'final', speaker: 'You', timestamp: 0, endTime: 2, text: 'Hello' };
    const preview = { id: 'preview-microphone', speaker: 'You', timestamp: 2, endTime: 2.8, text: 'everyone …', provisional: true };
    const projected = mergeInterleavedSpeakerTurns([finalTurn, preview]);
    expect(projected).toEqual([{ ...finalTurn, endTime: 2.8, text: 'Hello everyone …', provisional: true }]);
    expect(finalTurn.text).toBe('Hello');
    expect(mergeInterleavedSpeakerTurns([finalTurn])).toEqual([finalTurn]);
  });
});

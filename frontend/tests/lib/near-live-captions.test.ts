import { describe, expect, test } from 'bun:test';
import { isDuplicatedMicCaption, liveTurnIdentity, mergeInterleavedSpeakerTurns, previewHasFinalTurn, retainLiveText } from '../../src/lib/nearLiveCaptions';

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

  test('hides matched microphone playback but retains independent local speech', () => {
    const system = { text: "Lucky you're beautiful because there's nothing up here. What? That's mean.", start_time: 55.62, end_time: 60.73 };
    expect(isDuplicatedMicCaption({ text: "Lucky you're beautiful because there's nothing up here. What does he mean?", start_time: 55.8, end_time: 60.88 }, system)).toBe(true);
    expect(isDuplicatedMicCaption({ text: 'I disagree because my microphone is on', start_time: 55.8, end_time: 60.88 }, system)).toBe(false);
  });

  test('retains preview until a final turn from the same source covers its end', () => {
    const preview = { source: 'microphone' as const, end_time: 2.8 };
    const system = { speaker: 'Speaker 1', audio_start_time: 2, audio_end_time: 3 };
    const mic = { speaker: 'You', audio_start_time: 2, audio_end_time: 2.9 };
    expect(previewHasFinalTurn(preview, [system])).toBe(false);
    expect(previewHasFinalTurn(preview, [system, mic])).toBe(true);
  });

  test('does not collapse an established paragraph to its first chunk', () => {
    const shown = new Map<string, string>();
    const full = [{ id: 'speaker-1-first', text: 'Yeah. The timeline is ready for review.' }];
    retainLiveText(full, shown);
    expect(retainLiveText([{ id: 'speaker-1-first', text: 'Yeah.' }], shown)).toEqual(full);
    expect(retainLiveText([{ id: 'speaker-1-first', text: 'Yeah. The timeline is ready for review. Next step.' }], shown)[0].text)
      .toBe('Yeah. The timeline is ready for review. Next step.');
  });

  test('keeps a live row when its first native segment ID changes', () => {
    const shown = new Map<string, string>();
    const original = { id: 'preview', speaker: 'Speaker 1', timestamp: 365.2, text: 'Yeah. The timeline is ready.' };
    const replacement = { ...original, id: 'final', text: 'Yeah.' };
    retainLiveText([original], shown);
    expect(liveTurnIdentity(original)).toBe(liveTurnIdentity(replacement));
    expect(retainLiveText([replacement], shown)[0].text).toBe(original.text);
  });
});

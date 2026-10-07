import type { TranscriptSegmentData } from '../types';
import { isUserSpeaker, speakerKey } from '../utils/speakerUtils';

/** A final turn must cover this preview on the same capture source. */
export function previewHasFinalTurn(
  preview: { end_time: number; source: 'microphone' | 'system' },
  turns: Array<{ audio_start_time?: number; audio_end_time?: number; speaker?: string }>,
): boolean {
  return turns.some((turn) =>
    isUserSpeaker(turn.speaker) === (preview.source === 'microphone')
    && (turn.audio_start_time ?? Infinity) <= preview.end_time
    && (turn.audio_end_time ?? -Infinity) >= preview.end_time - 0.25);
}

export function liveTurnIdentity(turn: { id: string; timestamp?: number; speaker?: string }): string {
  if (turn.timestamp === undefined || !Number.isFinite(turn.timestamp) || !turn.speaker) return turn.id;
  // A final chunk can change the first native segment ID while this speaker's
  // displayed turn still starts at the same recording time.
  return `${speakerKey(turn.speaker)}:${Math.floor(turn.timestamp)}`;
}

/** Keep an already displayed prefix while out-of-order final chunks settle. */
export function retainLiveText<T extends { id: string; text: string; timestamp?: number; speaker?: string }>(
  turns: T[],
  shownText: Map<string, string>,
): T[] {
  return turns.map((turn) => {
    const key = liveTurnIdentity(turn);
    const previous = shownText.get(key);
    const incoming = turn.text.trim();
    // Native final chunks can arrive out of order. A transient projection may
    // only contain the first chunk again; do not collapse an existing bubble.
    const text = previous && previous.startsWith(incoming) && previous.length > incoming.length
      ? previous : turn.text;
    shownText.set(key, text);
    return text === turn.text ? turn : { ...turn, text };
  });
}

// A live display projection. The transcript context and saved turns retain
// their original source, text, and recording-relative timestamps.
export function mergeInterleavedSpeakerTurns(
  segments: TranscriptSegmentData[],
  maxGapSecs = 2.5,
  maxDurationSecs = Infinity,
): TranscriptSegmentData[] {
  const out: TranscriptSegmentData[] = [];
  const latest = new Map<string, number>();
  for (const seg of segments) {
    const key = speakerKey(seg.speaker);
    const index = latest.get(key);
    const prior = index === undefined ? undefined : out[index];
    const gap = prior ? seg.timestamp - (prior.endTime ?? prior.timestamp) : Infinity;
    if (prior && gap >= -0.2 && gap <= maxGapSecs && Math.max(prior.endTime ?? prior.timestamp, seg.endTime ?? seg.timestamp) - prior.timestamp <= maxDurationSecs) {
      prior.text = `${prior.text.trim()} ${seg.text.trim()}`.replace(/\s+/g, ' ').trim();
      prior.endTime = Math.max(prior.endTime ?? prior.timestamp, seg.endTime ?? seg.timestamp);
      prior.provisional = prior.provisional || seg.provisional;
      if (seg.confidence != null) {
        prior.confidence = prior.confidence == null ? seg.confidence : Math.min(prior.confidence, seg.confidence);
      }
      if (prior.words || seg.words) {
        prior.words = [...(prior.words || []), ...(seg.words || [])];
      }
    } else {
      out.push({ ...seg });
      latest.set(key, out.length - 1);
    }
  }
  return out;
}

// Provisional mic text may repeat system playback when microphone processing
// destroys waveform correlation. Hide only overlapping, strongly shared text;
// final transcript suppression remains owned by the native worker.
export function isDuplicatedMicCaption(
  mic: { text: string; start_time: number; end_time: number },
  system: { text: string; start_time: number; end_time: number },
): boolean {
  const overlap = Math.max(0, Math.min(mic.end_time, system.end_time) - Math.max(mic.start_time, system.start_time));
  if (overlap < Math.min(mic.end_time - mic.start_time, system.end_time - system.start_time) * 0.5) return false;
  const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const a = words(mic.text);
  const b = words(system.text);
  if (a.length < 4 || b.length < 4) return false;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (const word of a) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let index = 0; index < b.length; index++) {
      current[index + 1] = word === b[index] ? previous[index] + 1 : Math.max(current[index], previous[index + 1]);
    }
    previous = current;
  }
  const common = previous[b.length];
  return common >= 4 && common * 5 >= a.length * 3;
}

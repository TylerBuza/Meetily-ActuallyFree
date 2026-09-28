import type { TranscriptSegmentData } from '../types';
import { speakerKey } from '../utils/speakerUtils';

// A live display projection. The transcript context and saved turns retain
// their original source, text, and recording-relative timestamps.
export function mergeInterleavedSpeakerTurns(
  segments: TranscriptSegmentData[],
  maxGapSecs = 2.5,
): TranscriptSegmentData[] {
  const out: TranscriptSegmentData[] = [];
  const latest = new Map<string, number>();
  for (const seg of segments) {
    const key = speakerKey(seg.speaker);
    const index = latest.get(key);
    const prior = index === undefined ? undefined : out[index];
    const gap = prior ? seg.timestamp - (prior.endTime ?? prior.timestamp) : Infinity;
    if (prior && gap >= -0.2 && gap <= maxGapSecs) {
      prior.text = `${prior.text.trim()} ${seg.text.trim()}`.replace(/\s+/g, ' ').trim();
      prior.endTime = Math.max(prior.endTime ?? prior.timestamp, seg.endTime ?? seg.timestamp);
      prior.provisional = prior.provisional || seg.provisional;
      if (seg.confidence != null) {
        prior.confidence = prior.confidence == null ? seg.confidence : Math.min(prior.confidence, seg.confidence);
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

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

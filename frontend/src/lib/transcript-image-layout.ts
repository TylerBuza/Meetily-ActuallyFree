import type { TranscriptSegmentData } from '../types';
import type { MeetingImage } from './meeting-images';

export interface ImageTranscriptSegment extends TranscriptSegmentData {
  sourceId: string;
  imagesAfter?: MeetingImage[];
  translatedText?: string;
}

/** Display-only offsets: persisted text and word timestamps are never rewritten. */
function cutOffsets(segment: TranscriptSegmentData, times: number[], end: number): number[] {
  const words = segment.words ?? [];
  let cursor = 0;
  const offsets: number[] = [];
  const aligned = words.length > 0 && words.every(word => {
    const token = word.text.trim();
    const offset = token ? segment.text.indexOf(token, cursor) : -1;
    if (offset < 0 || !/^[\s.,!?;:'"…—-]*$/.test(segment.text.slice(cursor, offset)) || !Number.isFinite(word.startTime)) return false;
    offsets.push(offset);
    cursor = offset + token.length;
    return true;
  }) && /^[\s.,!?;:'"…—-]*$/.test(segment.text.slice(cursor));
  const tokens = [...segment.text.matchAll(/\S+/g)];
  return times.map(time => {
    if (aligned) {
      const index = words.findIndex(word => word.startTime >= time * 1000);
      return index < 0 ? segment.text.length : offsets[index];
    }
    // Older turns lack word timings. Approximate only their display text break;
    // the image keeps its real capture time and no word timestamps are invented.
    const fraction = end > segment.timestamp ? (time - segment.timestamp) / (end - segment.timestamp) : 1;
    const index = Math.max(0, Math.min(tokens.length, Math.round(tokens.length * fraction)));
    return index === tokens.length ? segment.text.length : (tokens[index]?.index ?? 0);
  });
}

/** Interleave screenshots before merging speaker runs so a picture is a hard row break.
 * Segment times are seconds; saved word times are recording-relative milliseconds.
 * Original IDs remain available for editing, search and translation lookup.
 */
export function interleaveTranscriptImages(
  segments: TranscriptSegmentData[], images: MeetingImage[], hasMore = false,
  translations?: Record<string, string>,
): ImageTranscriptSegment[] {
  if (!segments.length) return [];
  const last = segments[segments.length - 1];
  const ordered = images.filter(image => Number.isFinite(image.audioTime) && image.audioTime >= 0
    && !(hasMore && image.audioTime > (last.endTime ?? last.timestamp) + 2.5))
    .slice().sort((a, b) => a.audioTime - b.audioTime || a.id.localeCompare(b.id));
  const out: ImageTranscriptSegment[] = [];
  let imageIndex = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const nextStart = segments[index + 1]?.timestamp ?? Infinity;
    const assigned: MeetingImage[] = [];
    while (imageIndex < ordered.length && ordered[imageIndex].audioTime < nextStart) {
      assigned.push(ordered[imageIndex++]);
    }
    if (!assigned.length) {
      out.push({...segment, sourceId: segment.id, translatedText: translations?.[segment.id]});
      continue;
    }
    const end = Math.max(segment.timestamp, segment.endTime ?? (Number.isFinite(nextStart) ? nextStart : segment.timestamp));
    const times = [...new Set(assigned.map(image => image.audioTime))];
    const cuts = cutOffsets(segment, times, end);
    let textStart = 0;
    let rowStart = Math.min(segment.timestamp, times[0]);
    let wordStart = 0;
    let translationStart = 0;
    const translation = translations?.[segment.id];
    const translationTokens = translation ? [...translation.matchAll(/\S+/g)] : [];
    for (let cutIndex = 0; cutIndex <= times.length; cutIndex++) {
      const time = times[cutIndex];
      const textEnd = cutIndex < cuts.length ? Math.max(textStart, cuts[cutIndex]) : segment.text.length;
      const wordEnd = time === undefined ? (segment.words?.length ?? 0)
        : (segment.words?.findIndex(word => word.startTime >= time * 1000) ?? 0);
      const safeWordEnd = wordEnd < 0 ? (segment.words?.length ?? 0) : Math.max(wordStart, wordEnd);
      const ratio = segment.text.length ? textEnd / segment.text.length : 1;
      const tokenEnd = Math.round(translationTokens.length * ratio);
      const translationEnd = tokenEnd >= translationTokens.length ? (translation?.length ?? 0)
        : (translationTokens[tokenEnd]?.index ?? 0);
      const text = segment.text.slice(textStart, textEnd);
      const pictures = time === undefined ? undefined : assigned.filter(image => image.audioTime === time);
      if (text.trim() || pictures?.length) {
        out.push({...segment, id: `${segment.id}:image-part:${cutIndex}`, sourceId: segment.id,
          timestamp: rowStart, endTime: time === undefined ? end : Math.max(rowStart, time), text,
          words: segment.words?.slice(wordStart, safeWordEnd), imagesAfter: pictures,
          translatedText: translation === undefined ? undefined : translation.slice(translationStart, translationEnd)});
      }
      textStart = textEnd;
      wordStart = safeWordEnd;
      translationStart = translationEnd;
      rowStart = Math.max(segment.timestamp, time ?? end);
    }
  }
  return out;
}

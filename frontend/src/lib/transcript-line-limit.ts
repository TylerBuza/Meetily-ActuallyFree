import { useEffect, useState } from 'react';
import type { TranscriptSegmentData } from '../types';
import { cutOffsets, type ImageTranscriptSegment } from './transcript-image-layout';
const KEY = 'meetily-transcript-line-limit';
const EVENT = 'meetily-transcript-line-limit-changed';
export interface TranscriptLineLimit { enabled: boolean; minutes: number }
export const validLineMinutes = (value: number) => Number.isSafeInteger(value) && value >= 1;
export function readLineLimit(): TranscriptLineLimit {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { enabled: value.enabled === true, minutes: validLineMinutes(value.minutes) ? value.minutes : 1 };
  } catch { return { enabled: false, minutes: 1 }; }
}
export function writeLineLimit(value: TranscriptLineLimit) {
  if (!validLineMinutes(value.minutes)) throw new Error('Enter a whole number of minutes, at least 1.');
  localStorage.setItem(KEY, JSON.stringify(value));
  window.dispatchEvent(new Event(EVENT));
}
export function useTranscriptLineLimit() {
  const [limit, setLimit] = useState<TranscriptLineLimit>({ enabled: false, minutes: 1 });
  useEffect(() => {
    const refresh = () => setLimit(readLineLimit());
    refresh(); window.addEventListener(EVENT, refresh); window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, []);
  const save = (value: TranscriptLineLimit) => {
    writeLineLimit(value); setLimit(value);
  };
  return [limit, save] as const;
}
/** Display-only splitting. Seconds here; word timings remain original milliseconds.
 * Original row IDs survive for editing. Legacy untimed text is split approximately.
 */
export function splitTranscriptLines<T extends TranscriptSegmentData & Partial<ImageTranscriptSegment>>(segments: T[], seconds: number): Array<T & Partial<ImageTranscriptSegment>> {
  if (!Number.isFinite(seconds) || seconds < 60) return segments;
  return segments.flatMap(segment => {
    const start = segment.timestamp;
    const end = segment.endTime ?? start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start <= seconds) return [segment];
    const times: number[] = [];
    for (let time = start + seconds; time < end; time += seconds) times.push(time);
    const offsets = [0, ...cutOffsets(segment, times, end), segment.text.length];
    const bounds = [start, ...times, end];
    const wordOffsets = [0, ...times.map(time => {
      const index = segment.words?.findIndex(word => word.startTime >= time * 1000) ?? 0;
      return index < 0 ? segment.words?.length ?? 0 : index;
    }), segment.words?.length ?? 0];
    const translated = segment.translatedText;
    const tokens = translated ? [...translated.matchAll(/\S+/g)] : [];
    const translationOffset = (offset: number) => {
      const index = Math.round(tokens.length * (segment.text.length ? offset / segment.text.length : 1));
      return index >= tokens.length ? translated?.length ?? 0 : tokens[index]?.index ?? 0;
    };
    return bounds.slice(0,-1).map((timestamp, index) => ({ ...segment,
      id: `${segment.id}:line:${timestamp}`, sourceId: segment.sourceId ?? segment.id,
      timestamp, endTime: bounds[index+1], text: segment.text.slice(offsets[index], offsets[index+1]),
      words: segment.words?.slice(wordOffsets[index], wordOffsets[index+1]),
      imagesAfter: index === bounds.length-2 ? segment.imagesAfter : undefined,
      translatedText: translated === undefined ? undefined : translated.slice(translationOffset(offsets[index]), translationOffset(offsets[index+1])),
    } as T));
  });
}

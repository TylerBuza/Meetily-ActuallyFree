'use client';

/**
 * A recording's loudness, one peak (0 to 1) per second, for the Labs waveform
 * in the meeting player. FFmpeg reads the file in Rust; the last few results
 * are kept so going back to a meeting does not read it again.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

const KEEP = 6;
const cache = new Map<string, number[]>();

function remember(path: string, peaks: number[]) {
  cache.delete(path);
  cache.set(path, peaks);
  while (cache.size > KEEP) cache.delete(cache.keys().next().value as string);
}

export function useWaveform(path: string | null, enabled: boolean): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(() => (path && enabled ? cache.get(path) ?? null : null));

  useEffect(() => {
    if (!enabled || !path) {
      setPeaks(null);
      return;
    }
    const cached = cache.get(path);
    if (cached) {
      setPeaks(cached);
      return;
    }
    setPeaks(null);
    let cancelled = false;
    let retry: number | undefined;
    const attempt = (triesLeft: number) => {
      invoke<number[]>('get_waveform_peaks', { filePath: path })
        .then((result) => {
          if (cancelled) return;
          remember(path, result);
          setPeaks(result);
        })
        .catch((error) => {
          if (cancelled) return;
          // Rust reads one file at a time; the previous meeting's may still be running.
          if (triesLeft > 0 && String(error).includes('already running')) {
            retry = window.setTimeout(() => attempt(triesLeft - 1), 1500);
          } else {
            console.warn('Waveform unavailable:', error);
          }
        });
    };
    attempt(4);
    return () => {
      cancelled = true;
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [path, enabled]);

  return peaks;
}

/**
 * `peaks` squeezed into `bins` bars of 0 to 1, each the loudest second it
 * covers, scaled to the recording's loudest moment so quiet meetings still
 * show their shape.
 */
export function waveformBars(peaks: number[], bins: number): number[] {
  if (peaks.length === 0 || bins <= 0) return [];
  const count = Math.min(bins, peaks.length);
  const bars: number[] = [];
  for (let index = 0; index < count; index++) {
    const start = Math.floor((index * peaks.length) / count);
    const end = Math.max(start + 1, Math.floor(((index + 1) * peaks.length) / count));
    let loudest = 0;
    for (let second = start; second < end; second++) loudest = Math.max(loudest, peaks[second] ?? 0);
    bars.push(loudest);
  }
  const top = Math.max(0.05, ...bars);
  return bars.map((value) => Math.sqrt(Math.min(1, value / top)));
}

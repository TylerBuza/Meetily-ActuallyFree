'use client';

/**
 * Plays a meeting's recording. Rust finds the file and allows it through the
 * asset protocol (Windows/macOS) or bounded binary IPC/blob (Linux). The
 * clock ticks on animation frames while playing so the transcript highlight
 * and scrubber move smoothly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getMeetingAudio, readMeetingAudio } from '@/lib/workspace-api';
import { detectPlatformFromUserAgent } from '@/hooks/usePlatform';

const AUDIO_MIME_TYPES: Record<string, string> = {
  mp4: 'audio/mp4', m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg',
  wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', webm: 'audio/webm',
};

export type AudioStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export interface MeetingAudioControls {
  status: AudioStatus;
  errorMessage?: string | null;
  /** The recording's file, once found. */
  path: string | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  rate: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (seconds: number, autoplay?: boolean) => void;
  skip: (delta: number) => void;
  setRate: (rate: number) => void;
}

export const PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2];
/** Labs waveform scrubbing adds slower speeds for close listening. */
export const SLOW_PLAYBACK_RATES = [0.5, 0.75, ...PLAYBACK_RATES];

export function useMeetingAudio(meetingId: string | null | undefined): MeetingAudioControls {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const frame = useRef<number | null>(null);
  const [status, setStatus] = useState<AudioStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRateState] = useState(1);

  useEffect(() => {
    let cancelled = false;
    let blobUrl: string | null = null;
    setStatus('loading');
    setErrorMessage(null);
    setPath(null);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    if (!meetingId) {
      setStatus('unavailable');
      return;
    }
    void getMeetingAudio(meetingId)
      .then(async (audio) => {
        if (cancelled) return;
        if (!audio.path) {
          setStatus('unavailable');
          return;
        }
        setPath(audio.path);
        let src: string;
        if (detectPlatformFromUserAgent() === 'linux') {
          const bytes = await readMeetingAudio(meetingId);
          if (cancelled) return;
          const extension = audio.path.split('.').pop()?.toLowerCase() ?? '';
          blobUrl = URL.createObjectURL(new Blob([bytes], { type: AUDIO_MIME_TYPES[extension] ?? 'audio/mp4' }));
          src = blobUrl;
        } else {
          src = convertFileSrc(audio.path);
        }
        const element = new Audio();
        element.preload = 'metadata';
        element.src = src;
        element.onloadedmetadata = () => {
          if (cancelled) return;
          setDuration(Number.isFinite(element.duration) ? element.duration : 0);
          setStatus('ready');
        };
        element.onerror = () => !cancelled && setStatus('error');
        element.onplay = () => setPlaying(true);
        element.onpause = () => setPlaying(false);
        element.onended = () => setPlaying(false);
        element.ontimeupdate = () => setCurrentTime(element.currentTime);
        audioRef.current = element;
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorMessage(String(error));
        setStatus('error');
      });
    return () => {
      cancelled = true;
      const element = audioRef.current;
      if (element) {
        element.onloadedmetadata = element.onerror = element.onplay = element.onpause =
          element.onended = element.ontimeupdate = null;
        element.pause();
        element.removeAttribute('src');
        element.load();
      }
      audioRef.current = null;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [meetingId]);

  // Smooth clock while playing.
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const element = audioRef.current;
      if (element) setCurrentTime(element.currentTime);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [playing]);

  const play = useCallback(() => {
    void audioRef.current?.play().catch(() => setStatus('error'));
  }, []);
  const pause = useCallback(() => audioRef.current?.pause(), []);
  const toggle = useCallback(() => {
    const element = audioRef.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => setStatus('error'));
    else element.pause();
  }, []);
  const seek = useCallback((seconds: number, autoplay = false) => {
    const element = audioRef.current;
    if (!element) return;
    const limit = Number.isFinite(element.duration) ? element.duration : seconds;
    element.currentTime = Math.max(0, Math.min(limit, seconds));
    setCurrentTime(element.currentTime);
    if (autoplay && element.paused) void element.play().catch(() => setStatus('error'));
  }, []);
  const skip = useCallback((delta: number) => {
    const element = audioRef.current;
    if (!element) return;
    element.currentTime = Math.max(0, Math.min(element.duration || Infinity, element.currentTime + delta));
    setCurrentTime(element.currentTime);
  }, []);
  const setRate = useCallback((next: number) => {
    if (audioRef.current) audioRef.current.playbackRate = next;
    setRateState(next);
  }, []);

  return { status, errorMessage, path, playing, currentTime, duration, rate, play, pause, toggle, seek, skip, setRate };
}

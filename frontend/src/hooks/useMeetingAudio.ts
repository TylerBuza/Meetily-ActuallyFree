'use client';

/**
 * Plays a meeting's recording. Rust finds the file and allows it through the
 * asset protocol; the page gets a streaming URL plus transport controls. The
 * clock ticks on animation frames while playing so the transcript highlight
 * and scrubber move smoothly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getMeetingAudio } from '@/lib/workspace-api';

export type AudioStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export interface MeetingAudioControls {
  status: AudioStatus;
  /** The recording's audio file, once found. */
  path: string | null;
  /** The recording's video file, if present. */
  videoPath: string | null;
  isVideo: boolean;
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
  bindVideoElement: (el: HTMLVideoElement | null) => void;
}

export const PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2];
/** Labs waveform scrubbing adds slower speeds for close listening. */
export const SLOW_PLAYBACK_RATES = [0.5, 0.75, ...PLAYBACK_RATES];

export function useMeetingAudio(meetingId: string | null | undefined): MeetingAudioControls {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frame = useRef<number | null>(null);
  const [status, setStatus] = useState<AudioStatus>('loading');
  const [path, setPath] = useState<string | null>(null);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRateState] = useState(1);

  const getActiveElement = useCallback((): HTMLMediaElement | null => {
    return videoRef.current || audioRef.current;
  }, []);

  const bindVideoElement = useCallback((videoElement: HTMLVideoElement | null) => {
    videoRef.current = videoElement;
    if (videoElement) {
      videoElement.playbackRate = rate;
      videoElement.onplay = () => setPlaying(true);
      videoElement.onpause = () => setPlaying(false);
      videoElement.onended = () => setPlaying(false);
      videoElement.ontimeupdate = () => setCurrentTime(videoElement.currentTime);
      videoElement.onloadedmetadata = () => {
        setDuration(Number.isFinite(videoElement.duration) ? videoElement.duration : 0);
        setStatus('ready');
      };
      // Pause audio element if video element takes over
      if (audioRef.current) {
        audioRef.current.pause();
      }
    }
  }, [rate]);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setPath(null);
    setVideoPath(null);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    if (!meetingId) {
      setStatus('unavailable');
      return;
    }
    void getMeetingAudio(meetingId)
      .then((audio) => {
        if (cancelled) return;
        if (!audio.path && !audio.videoPath) {
          setStatus('unavailable');
          return;
        }
        setPath(audio.path);
        setVideoPath(audio.videoPath || null);

        // If audio path exists and no video element is currently active, load audio
        if (audio.path) {
          const element = new Audio();
          element.preload = 'metadata';
          element.src = convertFileSrc(audio.path);
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
        } else if (audio.videoPath) {
          setStatus('ready');
        }
      })
      .catch(() => !cancelled && setStatus('unavailable'));
    return () => {
      cancelled = true;
      const element = audioRef.current;
      if (element) {
        element.pause();
        element.removeAttribute('src');
        element.load();
      }
      audioRef.current = null;
      videoRef.current = null;
    };
  }, [meetingId]);

  // Smooth clock while playing.
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const element = getActiveElement();
      if (element) setCurrentTime(element.currentTime);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [playing, getActiveElement]);

  const play = useCallback(() => {
    const el = getActiveElement();
    if (!el) return;
    void el.play().catch(() => setStatus('error'));
  }, [getActiveElement]);

  const pause = useCallback(() => {
    const el = getActiveElement();
    if (!el) return;
    el.pause();
  }, [getActiveElement]);

  const toggle = useCallback(() => {
    const element = getActiveElement();
    if (!element) return;
    if (element.paused) void element.play().catch(() => setStatus('error'));
    else element.pause();
  }, [getActiveElement]);

  const seek = useCallback((seconds: number, autoplay = false) => {
    const element = getActiveElement();
    if (!element) return;
    const limit = Number.isFinite(element.duration) ? element.duration : seconds;
    element.currentTime = Math.max(0, Math.min(limit, seconds));
    setCurrentTime(element.currentTime);
    if (autoplay && element.paused) void element.play().catch(() => setStatus('error'));
  }, [getActiveElement]);

  const skip = useCallback((delta: number) => {
    const element = getActiveElement();
    if (!element) return;
    element.currentTime = Math.max(0, Math.min(element.duration || Infinity, element.currentTime + delta));
    setCurrentTime(element.currentTime);
  }, [getActiveElement]);

  const setRate = useCallback((next: number) => {
    if (audioRef.current) audioRef.current.playbackRate = next;
    if (videoRef.current) videoRef.current.playbackRate = next;
    setRateState(next);
  }, []);

  return {
    status,
    path,
    videoPath,
    isVideo: Boolean(videoPath),
    playing,
    currentTime,
    duration,
    rate,
    play,
    pause,
    toggle,
    seek,
    skip,
    setRate,
    bindVideoElement,
  };
}

'use client';

/**
 * Compact recording bar: the entire UI of the frameless `minibar` window.
 *
 * Shown while recording so the user can watch the timer and input levels, and
 * pause or stop, without the full window taking over the screen. It mirrors
 * the record card on the recorder page (same controls, same order) and follows
 * the app theme. No hover tooltips here: the small window clips them.
 *
 * It does not duplicate the stop logic. Rust owns native finalization and
 * emits the completion event that makes the main window save and navigate.
 */

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Mic, MicOff, Volume2, VolumeX, Pause, Play, Square, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppTheme } from '@/lib/app-theme';
import { LiveAudioVisualizer } from '@/components/LiveAudioVisualizer';
import { formatClock } from '@/lib/dates';
import { recordingService } from '@/services/recordingService';

const sideButton =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-af-panel-2 text-af-text-2 ring-1 ring-inset ring-af-border transition-[background-color,color,transform] duration-150 hover:bg-af-hover hover:text-af-text active:scale-95 disabled:opacity-40';

const laneButton = (muted: boolean) =>
  cn(
    'flex h-9 min-w-0 flex-1 items-center rounded-full px-2.5 ring-1 ring-inset transition-colors disabled:opacity-40',
    muted
      ? 'bg-af-warning/15 text-af-warning ring-af-warning/40 hover:bg-af-warning/25'
      : 'bg-af-panel-2 text-af-text-2 ring-af-border hover:bg-af-hover hover:text-af-text',
  );

export default function MiniBarPage() {
  // Follow theme changes made in the main window.
  useAppTheme();
  const [elapsed, setElapsed] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isChangingMicMute, setIsChangingMicMute] = useState(false);
  const [isSystemMuted, setIsSystemMuted] = useState(false);
  const [isChangingSystemMute, setIsChangingSystemMute] = useState(false);
  // Once stopping begins the timer freezes, even though the bar stays up
  // until the recording is actually finalised.
  const [isStopping, setIsStopping] = useState(false);

  // The window is transparent; the page must not paint a background over it.
  useEffect(() => {
    document.documentElement.classList.add('minibar-window');
    return () => document.documentElement.classList.remove('minibar-window');
  }, []);

  // Rust's RecordingState uses a monotonic Instant. Reading that duration keeps
  // this separate webview aligned through creation delays, pauses, and duplicate
  // minimize events instead of accumulating drift in a local +1 counter.
  useEffect(() => {
    let mounted = true;
    const syncFromNative = async () => {
      try {
        const state = await recordingService.getRecordingState();
        if (!mounted) return;
        const duration = state.active_duration ?? state.recording_duration;
        if (duration !== null) setElapsed(Math.max(0, Math.floor(duration)));
        setIsPaused(state.is_paused);
        setIsMicMuted(state.is_microphone_muted);
        setIsSystemMuted(state.is_system_audio_muted);
      } catch (error) {
        console.error('Compact bar: failed to sync recording state', error);
      }
    };
    void syncFromNative();
    const id = window.setInterval(syncFromNative, 500);
    return () => {
      mounted = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const unsubscribes: Array<() => void> = [];
    const track = (promise: Promise<() => void>, label: string) =>
      promise
        .then((stop) => (disposed ? stop() : unsubscribes.push(stop)))
        .catch((error) => console.error(`Compact bar: failed to listen for ${label}`, error));
    track(recordingService.onSystemAudioMuteChanged(({ muted }) => !disposed && setIsSystemMuted(muted)), 'system audio mute changes');
    track(recordingService.onMicrophoneMuteChanged(({ muted }) => !disposed && setIsMicMuted(muted)), 'microphone mute changes');
    return () => {
      disposed = true;
      unsubscribes.forEach((stop) => stop());
    };
  }, []);

  const togglePause = useCallback(async () => {
    try {
      await invoke(isPaused ? 'resume_recording' : 'pause_recording');
    } catch (error) {
      console.error('Compact bar: pause/resume failed', error);
    }
  }, [isPaused]);

  const toggleMicMute = useCallback(async () => {
    if (isChangingMicMute || isChangingSystemMute || isStopping) return;
    setIsChangingMicMute(true);
    try {
      await recordingService.setMicrophoneMuted(!isMicMuted);
    } catch (error) {
      console.error('Compact bar: microphone mute failed', error);
    } finally {
      setIsChangingMicMute(false);
    }
  }, [isChangingMicMute, isChangingSystemMute, isMicMuted, isStopping]);

  const toggleSystemMute = useCallback(async () => {
    if (isChangingMicMute || isChangingSystemMute || isStopping) return;
    setIsChangingSystemMute(true);
    try {
      await recordingService.setSystemAudioMuted(!isSystemMuted);
    } catch (error) {
      console.error('Compact bar: system audio mute failed', error);
    } finally {
      setIsChangingSystemMute(false);
    }
  }, [isChangingMicMute, isChangingSystemMute, isStopping, isSystemMuted]);

  const expand = useCallback(() => {
    invoke('exit_compact_mode').catch((error) => console.error(error));
  }, []);

  const stop = useCallback(async () => {
    // Rust closes this native window as soon as it claims shutdown. Do not wait
    // for a frontend event from another webview to remove the bar.
    setIsStopping(true);
    try {
      await invoke<boolean>('stop_recording_from_minibar');
    } catch (error) {
      console.error('Compact bar: stop failed', error);
      setIsStopping(false);
    }
  }, []);

  const busy = isStopping || isChangingMicMute || isChangingSystemMute;

  return (
    <div
      onMouseDown={(event) => {
        if (event.button !== 0 || (event.target as Element).closest('button')) return;
        event.preventDefault();
        void getCurrentWindow().startDragging().catch((error) => {
          console.error('Compact bar: dragging failed', error);
        });
      }}
      className="flex h-screen w-screen select-none items-center gap-3 rounded-[26px] border border-af-border-strong bg-af-elevated/95 px-4 text-af-text"
    >
      <button
        type="button"
        onClick={() => void stop()}
        disabled={busy}
        aria-label="Stop recording"
        className="af-record-button relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition-[background,transform] duration-200 active:scale-95 disabled:opacity-40"
      >
        {!isPaused && !isStopping && (
          <span className="pointer-events-none absolute -inset-1 animate-pulse rounded-full border border-af-record/50" />
        )}
        <Square size={13} fill="currentColor" />
      </button>

      <div className="w-[5.25rem] shrink-0 text-left leading-tight">
        <div className="text-sm font-semibold tabular-nums tracking-tight">{formatClock(elapsed)}</div>
        <div className={cn('text-[11px] font-medium', isStopping ? 'text-af-text-3' : isPaused ? 'text-af-warning' : 'text-af-record')}>
          {isStopping ? 'Finishing…' : isPaused ? 'Paused' : 'Recording'}
        </div>
      </div>

      <button
        type="button"
        onClick={() => void togglePause()}
        disabled={busy}
        aria-label={isPaused ? 'Resume recording' : 'Pause recording'}
        className={sideButton}
      >
        {isPaused ? <Play size={14} /> : <Pause size={14} />}
      </button>

      <button type="button" onClick={expand} disabled={busy} aria-label="Back to the full window" className={sideButton}>
        <Maximize2 size={14} />
      </button>

      <div className="h-8 w-px shrink-0 bg-af-border" />

      <button
        type="button"
        onClick={() => void toggleMicMute()}
        disabled={busy}
        aria-pressed={isMicMuted}
        aria-label={isMicMuted ? 'Unmute microphone' : 'Mute microphone'}
        className={laneButton(isMicMuted)}
      >
        {isMicMuted ? <MicOff size={15} strokeWidth={1.75} /> : <Mic size={15} strokeWidth={1.75} />}
        <LiveAudioVisualizer active={!isPaused && !isStopping && !isMicMuted} source="mic" bars={18} fill className="ml-2 min-w-0 flex-1" />
      </button>

      <button
        type="button"
        onClick={() => void toggleSystemMute()}
        disabled={busy}
        aria-pressed={isSystemMuted}
        aria-label={isSystemMuted ? 'Unmute output' : 'Mute output'}
        className={laneButton(isSystemMuted)}
      >
        {isSystemMuted ? <VolumeX size={15} strokeWidth={1.75} /> : <Volume2 size={15} strokeWidth={1.75} />}
        <LiveAudioVisualizer active={!isPaused && !isStopping && !isSystemMuted} source="system" bars={18} fill className="ml-2 min-w-0 flex-1" />
      </button>
    </div>
  );
}

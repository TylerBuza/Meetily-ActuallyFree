'use client';

/**
 * Compact recording bar â€” the entire UI of the frameless `minibar` window.
 *
 * Shown while recording so the user can keep an eye on the timer and input
 * levels, and pause/stop, without the full window taking over their screen.
 *
 * Deliberately does NOT duplicate the stop logic. Rust owns native finalization
 * and emits the completion event that makes the main window save and navigate.
 */

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Mic, Monitor, Pause, Play, Square, Maximize2 } from 'lucide-react';
import { LiveAudioVisualizer } from '@/components/LiveAudioVisualizer';
import { recordingService } from '@/services/recordingService';

function formatElapsed(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function MiniBarPage() {
  const [elapsed, setElapsed] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  // Once stopping begins the timer must freeze immediately, even though the
  // bar stays up until the recording is actually finalised (see below).
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
        if (duration !== null) {
          setElapsed(Math.max(0, Math.floor(duration)));
        }
        setIsPaused(state.is_paused);
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

  const togglePause = useCallback(async () => {
    try {
      await invoke(isPaused ? 'resume_recording' : 'pause_recording');
    } catch (e) {
      console.error('Compact bar: pause/resume failed', e);
    }
  }, [isPaused]);

  const expand = useCallback(() => {
    invoke('exit_compact_mode').catch((e) => console.error(e));
  }, []);

  const stop = useCallback(async () => {
    // Rust closes this native window as soon as it claims shutdown. Do not wait
    // for a frontend event from another webview to remove the bar.
    setIsStopping(true);
    try {
      const didStop = await invoke<boolean>('stop_recording_from_minibar');
      if (!didStop) {
        console.log('Compact bar: native shutdown was already owned');
      }
    } catch (e) {
      console.error('Compact bar: stop failed', e);
      setIsStopping(false);
    }
  }, []);

  return (
    <div
      data-tauri-drag-region
      className="flex h-screen w-screen items-center gap-4 rounded-full border border-white/10 bg-[#0f1218]/60 px-6 text-white shadow-2xl backdrop-blur-xl select-none"
    >
      {/* Status + timer */}
      <div data-tauri-drag-region className="flex items-center gap-3 pl-1">
        <span className="relative flex h-6 w-6 items-center justify-center">
          <span
            className={`absolute inset-0 rounded-full ${
              isStopping ? 'bg-gray-500/20' : isPaused ? 'bg-orange-500/20' : 'bg-red-500/20 animate-pulse'
            }`}
          />
          <span
            className={`h-3 w-3 rounded-full ${
              isStopping ? 'bg-gray-400' : isPaused ? 'bg-orange-400' : 'bg-red-500'
            }`}
          />
        </span>
        <div className="leading-tight">
          <div className="font-semibold tabular-nums tracking-tight">{formatElapsed(elapsed)}</div>
          <div
            className={`text-[11px] ${
              isStopping ? 'text-gray-400' : isPaused ? 'text-orange-400' : 'text-red-400'
            }`}
          >
            {isStopping ? 'Finishing…' : isPaused ? 'Paused' : 'Recording'}
          </div>
        </div>
      </div>

      <div className="h-8 w-px bg-white/10" />

      {/* Live input levels â€” same Rust events the main window listens to. */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Mic size={12} className="shrink-0 text-gray-400" />
          <span className="w-12 text-[11px] text-gray-400">Mic</span>
          <LiveAudioVisualizer active={!isPaused && !isStopping} source="mic" bars={14} />
        </div>
        <div className="flex items-center gap-2">
          <Monitor size={12} className="shrink-0 text-gray-400" />
          <span className="w-12 text-[11px] text-gray-400">System</span>
          <LiveAudioVisualizer active={!isPaused && !isStopping} source="system" bars={14} />
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={togglePause}
          disabled={isStopping}
          title={isPaused ? 'Resume recording' : 'Pause recording'}
          className="flex h-10 w-14 flex-col items-center justify-center rounded-full border border-white/10 bg-white/5 text-xs text-gray-300 transition-colors hover:bg-white/10 disabled:opacity-40"
        >
          {isPaused ? <Play size={15} /> : <Pause size={15} />}
          <span className="mt-0.5 text-[10px]">{isPaused ? 'Resume' : 'Pause'}</span>
        </button>

        <button
          onClick={stop}
          disabled={isStopping}
          title="Stop recording"
          className="flex h-10 w-14 flex-col items-center justify-center rounded-full border border-red-500/30 bg-red-500/15 text-xs text-red-300 transition-colors hover:bg-red-500/25 disabled:opacity-40"
        >
          <Square size={13} fill="currentColor" />
          <span className="mt-0.5 text-[10px]">Stop</span>
        </button>

        <button
          onClick={expand}
          disabled={isStopping}
          title="Back to the full window"
          className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-gray-300 transition-colors hover:bg-white/10 disabled:opacity-40"
        >
          <Maximize2 size={14} />
        </button>
      </div>
    </div>
  );
}

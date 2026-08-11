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
import { listen } from '@tauri-apps/api/event';
import { Mic, Monitor, Pause, Play, Square, Maximize2 } from 'lucide-react';
import { LiveAudioVisualizer } from '@/components/LiveAudioVisualizer';

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

  // Seed the timer from the recording position passed on the URL, so the bar
  // continues the meeting rather than counting from zero.
  useEffect(() => {
    const seed = Number(new URLSearchParams(window.location.search).get('elapsed') || 0);
    setElapsed(Number.isFinite(seed) ? seed : 0);

    const onSync = (e: Event) => {
      const detail = (e as CustomEvent<{ elapsed?: number }>).detail;
      if (typeof detail?.elapsed === 'number') setElapsed(detail.elapsed);
    };
    window.addEventListener('minibar-sync', onSync);
    return () => window.removeEventListener('minibar-sync', onSync);
  }, []);

  useEffect(() => {
    if (isPaused || isStopping) return;
    const id = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [isPaused, isStopping]);

  // The bar does not own the stop sequence, so it can't know when the meeting
  // has finished saving. It listens for the Rust stop events (broadcast to
  // every window) and only then tears itself down. This is what actually stops
  // the timer and closes the bar — regardless of whether the stop was triggered
  // here, from the tray, or by the main window. `recording-stopped` fires from
  // the stop command itself; `recording-stop-complete` is the tray's follow-up.
  useEffect(() => {
    const beginStopping = () => setIsStopping(true);
    const close = () => {
      setIsStopping(true);
      invoke('exit_compact_mode').catch((e) => console.error(e));
    };
    const unlistenStopping = listen('recording-shutdown-progress', beginStopping);
    const unlistenStopped = listen('recording-stopped', close);
    const unlistenComplete = listen('recording-stop-complete', close);
    return () => {
      unlistenStopping.then((fn) => fn());
      unlistenStopped.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
    };
  }, []);

  const togglePause = useCallback(async () => {
    try {
      await invoke(isPaused ? 'resume_recording' : 'pause_recording');
      setIsPaused((v) => !v);
    } catch (e) {
      console.error('Compact bar: pause/resume failed', e);
    }
  }, [isPaused]);

  const expand = useCallback(() => {
    invoke('exit_compact_mode').catch((e) => console.error(e));
  }, []);

  const stop = useCallback(async () => {
    // Drive the stop through Rust rather than emitting to the main window:
    // cross-window frontend events to/from this separate bar webview are
    // unreliable and used to leave the bar counting after the recording ended.
    // `stop_recording_from_minibar` stops the recording (which tears down this
    // bar) and signals the main window to save + navigate, mirroring the tray.
    setIsStopping(true);
    try {
      const didStop = await invoke<boolean>('stop_recording_from_minibar');
      if (!didStop) {
        // Another surface already owns shutdown, or recording already ended.
        // Either way this detached window has no useful state left to show.
        await invoke('exit_compact_mode');
        return;
      }
    } catch (e) {
      console.error('Compact bar: stop failed', e);
      setIsStopping(false);
      return;
    }
    // Safety net: if Rust didn't already close the bar (e.g. recording was
    // already stopped elsewhere), don't leave it stuck on "Finishing…".
    setTimeout(() => {
      invoke('exit_compact_mode').catch((e) => console.error(e));
    }, 6000);
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

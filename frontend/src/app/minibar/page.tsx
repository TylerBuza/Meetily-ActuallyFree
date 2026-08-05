'use client';

/**
 * Compact recording bar â€” the entire UI of the frameless `minibar` window.
 *
 * Shown while recording so the user can keep an eye on the timer and input
 * levels, and pause/stop, without the full window taking over their screen.
 *
 * Deliberately does NOT own the stop logic. Stopping a meeting saves audio,
 * persists transcripts, kicks off summarisation and navigates â€” all of which
 * lives in the main window. Stop here asks the main window to do it, so there
 * is exactly one implementation of that sequence.
 */

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
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
    if (isPaused) return;
    const id = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [isPaused]);

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
    // Hand the stop sequence to the main window, then restore it so the user
    // sees the meeting being finalised.
    try {
      await emit('minibar-stop-requested');
    } catch (e) {
      console.error('Compact bar: could not signal stop', e);
    }
    invoke('exit_compact_mode').catch((e) => console.error(e));
  }, []);

  return (
    <div
      data-tauri-drag-region
      className="flex h-screen w-screen items-center gap-4 border border-white/10 bg-[#0f1218]/85 px-4 text-white shadow-2xl backdrop-blur-xl select-none"
    >
      {/* Status + timer */}
      <div data-tauri-drag-region className="flex items-center gap-3 pl-1">
        <span className="relative flex h-6 w-6 items-center justify-center">
          <span
            className={`absolute inset-0 rounded-full ${isPaused ? 'bg-orange-500/20' : 'bg-red-500/20 animate-pulse'}`}
          />
          <span className={`h-3 w-3 rounded-full ${isPaused ? 'bg-orange-400' : 'bg-red-500'}`} />
        </span>
        <div className="leading-tight">
          <div className="font-semibold tabular-nums tracking-tight">{formatElapsed(elapsed)}</div>
          <div className={`text-[11px] ${isPaused ? 'text-orange-400' : 'text-red-400'}`}>
            {isPaused ? 'Paused' : 'Recording'}
          </div>
        </div>
      </div>

      <div className="h-8 w-px bg-white/10" />

      {/* Live input levels â€” same Rust events the main window listens to. */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Mic size={12} className="shrink-0 text-gray-400" />
          <span className="w-12 text-[11px] text-gray-400">Mic</span>
          <LiveAudioVisualizer active={!isPaused} source="mic" bars={14} />
        </div>
        <div className="flex items-center gap-2">
          <Monitor size={12} className="shrink-0 text-gray-400" />
          <span className="w-12 text-[11px] text-gray-400">System</span>
          <LiveAudioVisualizer active={!isPaused} source="system" bars={14} />
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={togglePause}
          title={isPaused ? 'Resume recording' : 'Pause recording'}
          className="flex h-10 w-14 flex-col items-center justify-center rounded-lg border border-white/10 bg-white/5 text-xs text-gray-300 transition-colors hover:bg-white/10"
        >
          {isPaused ? <Play size={15} /> : <Pause size={15} />}
          <span className="mt-0.5 text-[10px]">{isPaused ? 'Resume' : 'Pause'}</span>
        </button>

        <button
          onClick={stop}
          title="Stop recording"
          className="flex h-10 w-14 flex-col items-center justify-center rounded-lg border border-red-500/30 bg-red-500/15 text-xs text-red-300 transition-colors hover:bg-red-500/25"
        >
          <Square size={13} fill="currentColor" />
          <span className="mt-0.5 text-[10px]">Stop</span>
        </button>

        <button
          onClick={expand}
          title="Back to the full window"
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-gray-300 transition-colors hover:bg-white/10"
        >
          <Maximize2 size={14} />
        </button>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

/**
 * Per-source live audio level sample emitted by the Rust audio pipeline
 * (see `AudioLevels` in `src-tauri/src/audio/pipeline.rs`). One event is sent
 * per incoming chunk, throttled to ~25/sec per source.
 */
interface RecordingAudioLevels {
  source: 'mic' | 'system' | string;
  rms: number;
  peak: number;
}

interface LiveAudioVisualizerProps {
  /** Whether recording is active and un-paused. When false the meter idles flat. */
  active: boolean;
  /** Which audio source to visualize: your microphone or the system/other participants. */
  source?: 'mic' | 'system';
  /** Number of history bars to render (acts like a small scrolling VU meter). */
  bars?: number;
  className?: string;
}

/**
 * Map a raw RMS/peak pair (roughly 0..1, but usually quite small for normalized
 * audio) into a 0..1 visual level. Peak-forward with an RMS floor so quiet
 * speech still registers, clamped to 1.0.
 */
function toLevel(rms: number, peak: number): number {
  const v = Math.max(peak * 1.25, rms * 3.5);
  return Math.min(1, Math.max(0, v));
}

/**
 * A compact, event-driven audio level meter. It subscribes to the Rust
 * `recording-audio-levels` event and renders a small row of bars that scrolls
 * as new samples arrive. Unlike a `getUserMedia`-based visualizer, this does
 * NOT open a second microphone stream (which would compete with the recording
 * capture) and it can faithfully show *system* audio, which the webview cannot
 * capture on its own.
 */
export function LiveAudioVisualizer({
  active,
  source = 'mic',
  bars = 6,
  className = '',
}: LiveAudioVisualizerProps) {
  const [levels, setLevels] = useState<number[]>(() => new Array(bars).fill(0));
  const levelsRef = useRef<number[]>(new Array(bars).fill(0));

  // Reset the history buffer when the bar count changes.
  useEffect(() => {
    const fresh = new Array(bars).fill(0);
    levelsRef.current = fresh;
    setLevels(fresh);
  }, [bars]);

  useEffect(() => {
    if (!active) {
      const idle = new Array(bars).fill(0);
      levelsRef.current = idle;
      setLevels(idle);
      return;
    }

    let mounted = true;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        unlisten = await listen<RecordingAudioLevels>('recording-audio-levels', (event) => {
          if (!mounted) return;
          const payload = event.payload;
          if (payload.source !== source) return;

          const level = toLevel(payload.rms, payload.peak);
          const next = levelsRef.current.slice(1);
          next.push(level);
          levelsRef.current = next;
          setLevels(next);
        });
      } catch {
        // Not in a Tauri context (e.g. plain browser dev) — silently idle.
      }
    })();

    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [active, source, bars]);

  const barColor = source === 'mic' ? 'bg-blue-500' : 'bg-purple-500';

  return (
    <div
      className={`flex items-end gap-[2px] h-4 ${className}`}
      role="img"
      aria-label={`${source === 'mic' ? 'Microphone' : 'System'} audio level`}
    >
      {levels.map((level, index) => (
        <div
          key={index}
          className={`w-[3px] rounded-sm transition-[height,opacity] duration-100 ease-out ${
            active ? barColor : 'bg-gray-500'
          }`}
          style={{
            height: `${Math.max(12, level * 100)}%`,
            opacity: active ? 0.45 + level * 0.55 : 0.3,
          }}
        />
      ))}
    </div>
  );
}

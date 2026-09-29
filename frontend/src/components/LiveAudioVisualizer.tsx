'use client';

/**
 * Live per-source audio level meter (mic OR system) rendered as animated bars.
 *
 * Levels are pushed from Rust via the `recording-audio-levels` event (pre-mix,
 * per source) — the webview cannot read system audio, so these meters are
 * intentionally Rust-driven rather than computed in JS.
 *
 * `fill` makes the bar row flex to fill its container (used by the stacked
 * Mic/System meters in RecordingControls and the minibar); without it the
 * component renders at its intrinsic width.
 */

import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { LOW_SYSTEM_AUDIO_MESSAGE, SystemAudioLevelMonitor } from '@/lib/system-audio-level';

/**
 * Per-source live audio level sample emitted by the Rust audio pipeline
 * (see `AudioLevels` in `src-tauri/src/audio/pipeline.rs`). One event is sent
 * per incoming chunk, throttled to ~25/sec per source.
 */
interface RecordingAudioLevels {
  source: 'mic' | 'system' | string;
  rms: number;
  peak: number;
  limiter_hit?: boolean;
}

interface LiveAudioVisualizerProps {
  /** Whether recording is active and un-paused. When false the meter idles flat. */
  active: boolean;
  /** Which audio source to visualize: your microphone or the system/other participants. */
  source?: 'mic' | 'system';
  /** Number of history bars to render (acts like a small scrolling VU meter). */
  bars?: number;
  /** Stretch the bars to fill the container width instead of a fixed 3px each. */
  fill?: boolean;
  className?: string;
  /**
   * Preview samples (device picker) instead of the recording-audio-levels event.
   * `tick` advances once per sample so the history scrolls the same way as live.
   */
  feedRms?: number;
  feedPeak?: number;
  feedTick?: number;
  /** Multiplies the drawn level. Preview meters use this so the slider changes the graph immediately. */
  displayGain?: number;
}

const SILENCE_DB = -50;
const FULL_DB = -16;

/** Linear amplitude from an RMS/peak pair. Speech on a raw device is often well below 0.05. */
function amplitudeOf(rms: number, peak: number): number {
  return Math.max(0, peak, rms * 1.45);
}

/**
 * Map amplitude to a 0..1 meter using a speech-range decibel scale.
 * -56 dB sits on the floor. About -30 dB (normal speech) is mid-meter.
 * -9 dB is full. `gain` is the volume slider, applied before the decibel
 * conversion so the bars show output level, not the raw input.
 */
function visualLevel(amplitude: number, gain = 1): number {
  const output = amplitude * Math.max(0.05, gain);
  const db = 20 * Math.log10(Math.max(output, 1e-6));
  const span = (db - SILENCE_DB) / (FULL_DB - SILENCE_DB);
  return Math.min(1, Math.max(0, span));
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
  fill = false,
  className = '',
  feedRms,
  feedPeak,
  feedTick,
  displayGain = 1,
}: LiveAudioVisualizerProps) {
  const previewMode = feedTick !== undefined;
  const [levels, setLevels] = useState<number[]>(() => new Array(bars).fill(0));
  const [limiterWarning, setLimiterWarning] = useState(false);
  const [lowWarning, setLowWarning] = useState(false);
  const lowMonitorRef = useRef(new SystemAudioLevelMonitor());
  const lowClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const levelsRef = useRef<number[]>(new Array(bars).fill(0));
  const limiterStartedAtRef = useRef<number | null>(null);
  const limiterLastHitAtRef = useRef<number | null>(null);
  const limiterClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset the history buffer when the bar count changes.
  useEffect(() => {
    const fresh = new Array(bars).fill(0);
    levelsRef.current = fresh;
    setLevels(fresh);
  }, [bars]);

  useEffect(() => {
    if (!previewMode) return;
    const level = amplitudeOf(feedRms ?? 0, feedPeak ?? 0);
    const next = levelsRef.current.slice(1);
    next.push(level);
    levelsRef.current = next;
    setLevels(next);
  }, [previewMode, feedTick, feedRms, feedPeak]);

  useEffect(() => {
    if (previewMode) return;
    if (!active) {
      lowMonitorRef.current.reset();
      setLowWarning(false);
      const idle = new Array(bars).fill(0);
      levelsRef.current = idle;
      setLevels(idle);
      limiterStartedAtRef.current = null;
      limiterLastHitAtRef.current = null;
      setLimiterWarning(false);
      if (limiterClearTimerRef.current) {
        clearTimeout(limiterClearTimerRef.current);
        limiterClearTimerRef.current = null;
      }
      return;
    }

    let mounted = true;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const stopListening = await listen<RecordingAudioLevels>('recording-audio-levels', (event) => {
          if (!mounted) return;
          const payload = event.payload;
          if (payload.source !== source) return;

          const level = amplitudeOf(payload.rms, payload.peak);
          const next = levelsRef.current.slice(1);
          next.push(level);
          levelsRef.current = next;
          setLevels(next);

          if (source === 'system') {
            // Native recording levels already include system gain. displayGain
            // belongs to the device preview and must not amplify this check twice.
            setLowWarning(lowMonitorRef.current.update(payload.rms, payload.peak, performance.now()));
            if (lowClearTimerRef.current) clearTimeout(lowClearTimerRef.current);
            // Some backends stop sending events during silence or device loss.
            lowClearTimerRef.current = setTimeout(() => {
              lowMonitorRef.current.reset();
              setLowWarning(false);
            }, 1000);
          }

          if (source === 'system' && payload.limiter_hit) {
            const now = performance.now();
            const lastHit = limiterLastHitAtRef.current;
            if (lastHit === null || now - lastHit > 250) {
              limiterStartedAtRef.current = now;
            }
            limiterLastHitAtRef.current = now;

            const startedAt = limiterStartedAtRef.current;
            if (startedAt !== null && now - startedAt >= 750) {
              setLimiterWarning(true);
            }

            if (limiterClearTimerRef.current) {
              clearTimeout(limiterClearTimerRef.current);
            }
            limiterClearTimerRef.current = setTimeout(() => {
              limiterStartedAtRef.current = null;
              limiterLastHitAtRef.current = null;
              setLimiterWarning(false);
            }, 1500);
          }
        });
        if (mounted) {
          unlisten = stopListening;
        } else {
          stopListening();
        }
      } catch {
        // Not in a Tauri context (e.g. plain browser dev) — silently idle.
      }
    })();

    return () => {
      mounted = false;
      if (unlisten) unlisten();
      if (lowClearTimerRef.current) {
        clearTimeout(lowClearTimerRef.current);
        lowClearTimerRef.current = null;
      }
      lowMonitorRef.current.reset();
      setLowWarning(false);
      if (limiterClearTimerRef.current) {
        clearTimeout(limiterClearTimerRef.current);
        limiterClearTimerRef.current = null;
      }
    };
  }, [active, source, bars, previewMode]);

  // Your voice in the accent color, everyone else in violet, amber when clipping.
  const barColor = !active
    ? 'var(--af-text-4)'
    : limiterWarning || lowWarning
      ? 'var(--af-warning)'
      : source === 'mic'
        ? 'var(--af-accent)'
        : 'var(--af-c-violet)';
  const warningText = 'System audio is hitting the limiter. Lower system gain or playback volume.';
  const warning = !previewMode && active && (limiterWarning || lowWarning);
  const advice = limiterWarning ? warningText : LOW_SYSTEM_AUDIO_MESSAGE;

  return (
    <div
      className={`flex items-end gap-[2px] h-4 ${fill ? 'w-full' : ''} ${className}`}
      role="group"
      aria-label={`${source === 'mic' ? 'Microphone' : 'System'} audio level${warning ? limiterWarning ? '. Too loud.' : '. Very quiet.' : ''}`}
      title={warning ? advice : undefined}
    >
      {levels.map((level, index) => {
        const shown = visualLevel(level, displayGain);
        return (
        <div
          key={index}
          className={`${fill ? 'flex-1 min-w-[2px]' : 'w-[3px]'} rounded-sm transition-[height,opacity,background-color] duration-100 ease-out`}
          style={{
            backgroundColor: barColor,
            height: `${Math.max(4, shown * 100)}%`,
            opacity: active ? 0.45 + shown * 0.55 : 0.45,
          }}
        />
        );
      })}
      {warning && <span role="status" tabIndex={0} title={advice} aria-label={advice} className="shrink-0 self-center whitespace-nowrap text-[10px] font-medium text-[var(--af-warning)]">
        {limiterWarning ? 'Too loud' : 'Low audio'}
      </span>}
    </div>
  );
}

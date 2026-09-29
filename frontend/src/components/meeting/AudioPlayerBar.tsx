'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, RotateCw, ScrollText, VolumeX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Hint } from '@/components/ui/tooltip';
import { Spinner } from '@/components/ui/spinner';
import { PLAYBACK_RATES, type MeetingAudioControls } from '@/hooks/useMeetingAudio';
import { waveformBars } from '@/hooks/useWaveform';

export function formatPlayback(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return !!element.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
}

export type TranscriptTextMode = 'clean' | 'verbatim';

const WAVE_HEIGHT = 28;
/** Bar pitch in px: a 2px bar and a 1px gap. */
const WAVE_PITCH = 3;

/**
 * The recording's loudness as bars (Labs waveform scrubbing). Drawn twice,
 * dim and in the accent colour, and the accent copy is cut at the playhead,
 * so playback only moves one clip edge instead of redrawing every bar.
 */
function Waveform({ peaks, progress }: { peaks: number[]; progress: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const path = useMemo(() => {
    const bars = waveformBars(peaks, Math.floor(width / WAVE_PITCH));
    if (bars.length === 0) return '';
    const step = width / bars.length;
    const barWidth = Math.max(1, Math.min(step - 1, 2));
    return bars
      .map((value, index) => {
        const height = Math.max(2, value * WAVE_HEIGHT);
        const x = index * step + (step - barWidth) / 2;
        const y = (WAVE_HEIGHT - height) / 2;
        return `M${x.toFixed(1)} ${y.toFixed(1)}h${barWidth.toFixed(1)}v${height.toFixed(1)}h-${barWidth.toFixed(1)}z`;
      })
      .join('');
  }, [peaks, width]);

  const svg = (className: string) => (
    <svg width={width} height={WAVE_HEIGHT} viewBox={`0 0 ${width} ${WAVE_HEIGHT}`} className={cn('block shrink-0', className)} aria-hidden>
      <path d={path} />
    </svg>
  );

  return (
    <div ref={boxRef} className="relative h-7 w-full">
      {width > 0 && (
        <>
          {svg('fill-af-text/[0.22] transition-colors group-hover:fill-af-text/[0.3]')}
          <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${progress}%` }}>
            {svg('fill-af-accent')}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Transport for a meeting's recording, docked under the transcript. Space
 * toggles playback when focus is not in a text field.
 *
 * Labs adds a waveform in place of the plain track (`waveform`), slower
 * speeds (`rates`), and the Clean/Verbatim transcript switch (`textMode`).
 */
export function AudioPlayerBar({
  audio,
  follow,
  onFollowChange,
  waveform,
  rates = PLAYBACK_RATES,
  textMode,
  onTextModeChange,
}: {
  audio: MeetingAudioControls;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  waveform?: number[] | null;
  rates?: number[];
  textMode?: TranscriptTextMode;
  onTextModeChange?: (mode: TranscriptTextMode) => void;
}) {
  const { status, playing, currentTime, duration, rate } = audio;
  const trackRef = useRef<HTMLDivElement>(null);
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const shown = scrubbing ?? currentTime;
  const progress = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;
  const showWave = !!waveform && waveform.length > 0 && status === 'ready';

  useEffect(() => {
    if (status !== 'ready') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || isTyping(event.target)) return;
      event.preventDefault();
      audio.toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status, audio]);

  const textSwitch =
    textMode && onTextModeChange ? (
      <Hint label={textMode === 'clean' ? 'Show every word as spoken' : 'Hide hesitations and repeats'}>
        <button
          type="button"
          onClick={() => onTextModeChange(textMode === 'clean' ? 'verbatim' : 'clean')}
          aria-pressed={textMode === 'clean'}
          className={cn(
            'h-7 shrink-0 rounded-md px-2 text-[11px] font-semibold transition-colors',
            textMode === 'clean'
              ? 'bg-af-accent/[0.12] text-af-accent hover:bg-af-accent/[0.18]'
              : 'text-af-text-2 hover:bg-af-hover hover:text-af-text',
          )}
        >
          {textMode === 'clean' ? 'Clean' : 'Verbatim'}
        </button>
      </Hint>
    ) : null;

  if (status === 'unavailable' || status === 'error') {
    return (
      <div className="flex h-14 items-center gap-2 border-t border-af-border px-4 text-xs text-af-text-3">
        <VolumeX className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {status === 'error' ? 'The recording could not be played.' : 'No audio was saved for this meeting.'}
        </span>
        {textSwitch}
      </div>
    );
  }

  const positionAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || duration <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
  };

  const startScrub = (event: React.PointerEvent<HTMLDivElement>) => {
    if (status !== 'ready') return;
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    setScrubbing(positionAt(event.clientX));
    const move = (moveEvent: PointerEvent) => setScrubbing(positionAt(moveEvent.clientX));
    const end = (endEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      audio.seek(positionAt(endEvent.clientX));
      setScrubbing(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  const nextRate = rates[(rates.indexOf(rate) + 1) % rates.length];
  const button =
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-af-text-2 transition-colors hover:bg-af-hover hover:text-af-text disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60';

  return (
    // h-14 matches the sidebar footer, so their top borders line up.
    <div className="flex h-14 items-center gap-1 border-t border-af-border bg-af-panel px-3">
      <Hint label="Back 10 seconds">
        <button type="button" className={button} onClick={() => audio.skip(-10)} disabled={status !== 'ready'} aria-label="Back 10 seconds">
          <RotateCcw className="h-4 w-4" />
        </button>
      </Hint>
      <Hint label={playing ? 'Pause' : 'Play'} shortcut="Space">
        <button
          type="button"
          onClick={audio.toggle}
          disabled={status !== 'ready'}
          aria-label={playing ? 'Pause' : 'Play'}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-af-accent text-af-on-accent shadow-sm transition-[background-color,transform] hover:bg-af-accent-hover active:scale-95 disabled:opacity-50"
        >
          {status === 'loading' ? <Spinner size={14} /> : playing ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="ml-0.5 h-4 w-4" fill="currentColor" />}
        </button>
      </Hint>
      <Hint label="Forward 10 seconds">
        <button type="button" className={button} onClick={() => audio.skip(10)} disabled={status !== 'ready'} aria-label="Forward 10 seconds">
          <RotateCw className="h-4 w-4" />
        </button>
      </Hint>

      <span className="ml-1.5 w-12 shrink-0 text-right text-[11px] tabular-nums text-af-text-2">{formatPlayback(shown)}</span>
      <div
        ref={trackRef}
        role="slider"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(shown)}
        tabIndex={status === 'ready' ? 0 : -1}
        onPointerDown={startScrub}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') audio.skip(-5);
          if (event.key === 'ArrowRight') audio.skip(5);
        }}
        className="group relative mx-2 flex h-8 min-w-0 flex-1 cursor-pointer items-center focus-visible:outline-none"
      >
        {showWave ? (
          <>
            <Waveform peaks={waveform!} progress={progress} />
            <div
              className="pointer-events-none absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-af-text/80 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              style={{ left: `${progress}%`, opacity: scrubbing !== null ? 1 : undefined }}
            />
          </>
        ) : (
          <>
            <div className="relative h-1 w-full overflow-hidden rounded-full bg-af-text/[0.1] transition-[height] duration-150 group-hover:h-1.5">
              <div className="absolute inset-y-0 left-0 rounded-full bg-af-accent" style={{ width: `${progress}%` }} />
            </div>
            <div
              className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-af-text shadow-md opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              style={{ left: `${progress}%`, opacity: scrubbing !== null ? 1 : undefined }}
            />
          </>
        )}
      </div>
      <span className="w-12 shrink-0 text-[11px] tabular-nums text-af-text-4">{formatPlayback(duration)}</span>

      <Hint label="Playback speed">
        <button
          type="button"
          onClick={() => audio.setRate(nextRate)}
          disabled={status !== 'ready'}
          className="h-7 min-w-[2.75rem] shrink-0 rounded-md px-1.5 text-[11px] font-semibold tabular-nums text-af-text-2 transition-colors hover:bg-af-hover hover:text-af-text disabled:opacity-40"
        >
          {rate}×
        </button>
      </Hint>
      {textSwitch}
      <Hint label={follow ? 'Stop following the playback' : 'Follow the playback'}>
        <button
          type="button"
          onClick={() => onFollowChange(!follow)}
          aria-pressed={follow}
          className={cn(button, follow && 'bg-af-accent/[0.12] text-af-accent hover:bg-af-accent/[0.18] hover:text-af-accent')}
          aria-label="Follow the playback"
        >
          <ScrollText className="h-4 w-4" />
        </button>
      </Hint>
    </div>
  );
}

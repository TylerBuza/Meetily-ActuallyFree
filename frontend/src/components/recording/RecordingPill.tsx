'use client';

/**
 * While a recording runs and you are anywhere but the recorder, this pill sits
 * in the top-right corner of the main pane: it shows the timer, pauses and
 * resumes, stops, and takes you back to the live transcript.
 */
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowUpRight, Pause, Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { Hint } from '@/components/ui/tooltip';
import { formatClock } from '@/lib/dates';
import { requestRecordingStop } from '@/lib/recording-launch';

/** Elapsed recording time, excluding pauses (matches the floating bar). */
export function useRecordingClock(): number {
  const { activeDuration, recordingDuration } = useRecordingState();
  return Math.floor(activeDuration ?? recordingDuration ?? 0);
}

export function RecordingPill() {
  const pathname = usePathname();
  const router = useRouter();
  const { isRecording, isPaused, isStopping } = useRecordingState();
  const elapsed = useRecordingClock();
  const [busy, setBusy] = useState(false);

  if (!isRecording || pathname === '/' || (pathname ?? '').startsWith('/minibar')) return null;

  const togglePause = async () => {
    setBusy(true);
    try {
      await invoke(isPaused ? 'resume_recording' : 'pause_recording');
    } catch (error) {
      toast.error(isPaused ? 'Could not resume the recording' : 'Could not pause the recording', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  // The recorder owns the stop and save flow; it picks this up on arrival.
  const stop = () => requestRecordingStop((href) => router.push(href));

  return (
    <div className="pointer-events-none fixed right-4 top-[calc(var(--af-chrome-h)+0.75rem)] z-[45] animate-af-rise">
      <div
        className={cn(
          'pointer-events-auto flex items-center gap-1 rounded-full border border-af-border-strong bg-af-elevated/95 p-1 pl-1.5 shadow-lg backdrop-blur-md',
        )}
      >
        <button
          type="button"
          onClick={() => router.push('/')}
          className="group flex h-8 items-center gap-2 rounded-full pl-2 pr-2.5 text-sm transition-colors hover:bg-af-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60"
          aria-label="Back to the live recording"
        >
          <span className="relative flex h-2.5 w-2.5">
            {!isPaused && <span className="absolute inset-0 animate-ping rounded-full bg-af-record/60" />}
            <span className={cn('relative h-2.5 w-2.5 rounded-full', isPaused ? 'bg-af-warning' : 'bg-af-record')} />
          </span>
          <span className="font-medium text-af-text">{isStopping ? 'Stopping' : isPaused ? 'Paused' : 'Recording'}</span>
          <span className="tabular-nums text-af-text-2">{formatClock(elapsed)}</span>
          <ArrowUpRight className="h-3.5 w-3.5 text-af-text-3 transition-transform duration-150 group-hover:-translate-y-px group-hover:translate-x-px group-hover:text-af-text" />
        </button>
        <span className="mx-0.5 h-5 w-px bg-af-border" />
        <Hint label={isPaused ? 'Resume' : 'Pause'} side="bottom">
          <button
            type="button"
            onClick={togglePause}
            disabled={busy || isStopping}
            aria-label={isPaused ? 'Resume recording' : 'Pause recording'}
            className="flex h-8 w-8 items-center justify-center rounded-full text-af-text-2 transition-colors hover:bg-af-hover hover:text-af-text disabled:opacity-40"
          >
            {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
        </Hint>
        <Hint label="Stop and save" side="bottom">
          <button
            type="button"
            onClick={stop}
            disabled={isStopping}
            aria-label="Stop recording"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-af-record text-white transition-[background-color,transform] hover:bg-af-record/90 active:scale-95 disabled:opacity-40"
          >
            <Square className="h-3 w-3" fill="currentColor" />
          </button>
        </Hint>
      </div>
    </div>
  );
}

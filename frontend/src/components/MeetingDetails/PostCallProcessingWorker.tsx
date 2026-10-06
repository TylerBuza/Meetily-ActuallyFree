"use client";

/**
 * Owns the post-recording handoff. This must remain a single ordered workflow:
 * speaker count choice -> source-track retranscription -> refetch ->
 * diarization -> refetch -> summary gate. Starting summary or diarization
 * elsewhere races the transactional transcript replacement.
 *
 * Retranscription is event-driven because the Tauri start command returns after
 * spawning its native task. Listeners therefore register before invoke and are
 * meeting-ID filtered. The two refresh failures are intentionally distinct:
 * retrying the first must still run diarization, while retrying the second may
 * complete immediately. Audio-disabled meetings can explicitly continue with
 * their live transcript so the summary stage is never permanently blocked.
 */

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useDiarizationEngine } from '@/hooks/useDiarizationEngine';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/input';
import { PostCallHandoffCard } from '@/components/PostCallHandoffCard';
import type { RawModelInfo } from '@/hooks/useTranscriptionModels';
import { isVisibleParakeetModel } from '@/lib/parakeet';
import { announceChange } from '@/lib/workspace-api';

type Stage = 'idle' | 'prompt' | 'enhancing' | 'diarizing' | 'refreshing' | 'error';
type FailedStage = 'enhancing' | 'diarizing' | 'pre-diarization-refresh' | 'post-diarization-refresh';

interface RetranscriptionProgress {
  meeting_id: string;
  progress_percentage: number;
  message: string;
}

interface RetranscriptionResult {
  meeting_id: string;
}

interface RetranscriptionError {
  meeting_id: string;
  error: string;
}

interface ModelChoice {
  provider: 'whisper' | 'parakeet';
  name: string;
}

interface PostCallTranscriptConfig {
  provider: 'live' | 'whisper' | 'parakeet';
  model: string;
}

async function resolveEnhancementModel(
  configuredProvider?: string,
  configuredModel?: string,
): Promise<ModelChoice> {
  const [whisperModels, parakeetModels] = await Promise.all([
    invoke<RawModelInfo[]>('whisper_get_available_models').catch(() => []),
    invoke<RawModelInfo[]>('parakeet_get_available_models').catch(() => []),
  ]);
  const available: ModelChoice[] = [
    ...parakeetModels
      .filter((model) => model.status === 'Available' && isVisibleParakeetModel(model.name))
      .map((model) => ({ provider: 'parakeet' as const, name: model.name })),
    ...whisperModels
      .filter((model) => model.status === 'Available')
      .map((model) => ({ provider: 'whisper' as const, name: model.name })),
  ];
  const normalizedProvider = configuredProvider === 'localWhisper'
    ? 'whisper'
    : configuredProvider;
  const configured = available.find(
    (model) => model.provider === normalizedProvider && model.name === configuredModel,
  );
  if (configured) return configured;
  if (normalizedProvider === 'whisper' || normalizedProvider === 'parakeet') {
    const sameProvider = available.find((model) => model.provider === normalizedProvider);
    if (sameProvider) return sameProvider;
    throw new Error(`No downloaded ${normalizedProvider} model is available for enhancement.`);
  }
  const localDefault = available.find((model) => model.provider === 'parakeet')
    ?? available.find((model) => model.provider === 'whisper')
    ?? available[0];
  if (localDefault) return localDefault;
  throw new Error('No downloaded transcription model is available for post-call enhancement.');
}

async function runRetranscription({
  meetingId,
  meetingFolderPath,
  language,
  model,
  onProgress,
  signal,
}: {
  meetingId: string;
  meetingFolderPath: string;
  language: string | null;
  model: ModelChoice;
  onProgress: (progress: RetranscriptionProgress) => void;
  signal: AbortSignal;
}): Promise<void> {
  const unlisteners: UnlistenFn[] = [];
  let settled = false;
  let timedOut = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: unknown) => void;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const cleanup = () => {
    signal.removeEventListener('abort', cancel);
    if (timeoutId) clearTimeout(timeoutId);
    unlisteners.splice(0).forEach((unlisten) => unlisten());
  };

  const cancel = () => {
    // Completion/error still owns settlement. Cancelling a JS promise alone
    // must not release the job while native inference is still using models.
    void invoke('cancel_retranscription_command', { meetingId }).catch(() => undefined);
  };
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectCompletion(error);
    else resolveCompletion();
  };

  try {
    unlisteners.push(await listen<RetranscriptionProgress>(
      'retranscription-progress',
      (event) => {
        if (event.payload.meeting_id === meetingId) onProgress(event.payload);
      },
    ));
    unlisteners.push(await listen<RetranscriptionResult>(
      'retranscription-complete',
      (event) => {
        if (!timedOut && event.payload.meeting_id === meetingId) finish();
      },
    ));
    unlisteners.push(await listen<RetranscriptionError>(
      'retranscription-error',
      (event) => {
        if (!timedOut && event.payload.meeting_id === meetingId) {
          finish(new Error(event.payload.error));
        }
      },
    ));

    try {
      if (signal.aborted) throw new Error('Post-call processing cancelled.');
      await invoke('start_retranscription_command', {
        meetingId,
        meetingFolderPath,
        language,
        model: model.name,
        provider: model.provider,
        vocabularyTerms: null,
        vocabularyScope: null,
      });
      signal.addEventListener('abort', cancel);
      if (signal.aborted) cancel();
    } catch (error) {
      finish(error);
    }
    timeoutId = setTimeout(() => {
      timedOut = true;
      void (async () => {
        await invoke('cancel_retranscription_command', { meetingId }).catch(() => undefined);
        for (let attempt = 0; attempt < 60; attempt++) {
          const active = await invoke<boolean>('is_retranscription_in_progress_command')
            .catch(() => false);
          if (!active) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        finish(new Error('Enhancement timed out and was cancelled.'));
      })();
    }, 30 * 60 * 1000);
    await completion;
  } finally {
    cleanup();
  }
}

export function PostCallProcessingWorker({
  enabled,
  meetingId,
  meetingFolderPath,
  onRefetchTranscripts,
  onComplete,
}: {
  enabled: boolean;
  meetingId: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;
  onComplete: () => void;
}) {
  const { selectedLanguage, transcriptModelConfig } = useConfig();
  const [stage, setStage] = useState<Stage>(enabled ? 'prompt' : 'idle');
  const { engine, isNemotron, error: engineError } = useDiarizationEngine(stage !== 'idle');
  const [speakerCount, setSpeakerCount] = useState('2');
  const [autoDetectSpeakers, setAutoDetectSpeakers] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('Preparing enhanced transcript...');
  const [error, setError] = useState<string | null>(null);
  const [failedStage, setFailedStage] = useState<FailedStage | null>(null);
  const initializedMeetingRef = useRef<string | null>(null);
  const activeStageRef = useRef<FailedStage>('enhancing');
  const skippedEnhancementRef = useRef(false);
  const cancellation = useRef(new AbortController());
  const running = useRef(false);
  const [cancelling, setCancelling] = useState(false);

  const checkCancelled = () => {
    if (cancellation.current.signal.aborted) throw new Error('Post-call processing cancelled.');
  };

  const storageKey = `post-call-processing:${meetingId}`;

  useEffect(() => {
    if (!enabled || !meetingId || initializedMeetingRef.current === meetingId) return;
    initializedMeetingRef.current = meetingId;
    const terminalState = sessionStorage.getItem(storageKey);
    if (terminalState === 'completed') {
      onComplete();
      return;
    }
    setStage('prompt');
  }, [enabled, meetingId, onComplete, storageKey]);

  const completeWorkflow = () => {
    sessionStorage.setItem(storageKey, 'completed');
    setStage('idle');
    toast.success('Post-call processing complete', {
      description: skippedEnhancementRef.current
        ? 'Speaker labels refreshed from the saved transcript.'
        : 'Transcript enhanced and speaker labels refreshed.',
    });
    onComplete();
  };

  const refreshTranscript = async (
    phase: 'pre-diarization-refresh' | 'post-diarization-refresh',
  ) => {
    activeStageRef.current = phase;
    setStage('refreshing');
    setMessage('Refreshing the enhanced transcript...');
    await onRefetchTranscripts?.();
    // The rerun links named speakers (and matched voices) to contacts.
    announceChange('people');
  };

  const identifySpeakers = async (count: number | null) => {
    checkCancelled();
    activeStageRef.current = 'diarizing';
    setStage('diarizing');
    setProgress(100);
    setMessage(count === null
      ? 'Auto-detecting speakers...'
      : `Identifying ${count} speaker${count === 1 ? '' : 's'}...`);
    await invoke('diarize_meeting', { meetingId, numSpeakers: count });
    checkCancelled();
    await refreshTranscript('post-diarization-refresh');
    completeWorkflow();
  };

  const runWorkflow = async (count: number | null) => {
    if (!meetingFolderPath) {
      throw new Error('The recording folder is unavailable for enhancement.');
    }

    setError(null);
    setFailedStage(null);
    activeStageRef.current = 'enhancing';
    setStage('enhancing');
    setProgress(0);
    setMessage('Preparing enhanced transcript...');
    const postCallConfig = await invoke<PostCallTranscriptConfig>('api_get_post_call_transcript_config')
      .catch(() => ({ provider: 'live' as const, model: '' }));
    const useLiveDefault = postCallConfig.provider === 'live';
    const model = await resolveEnhancementModel(
      useLiveDefault ? transcriptModelConfig?.provider : postCallConfig.provider,
      useLiveDefault ? transcriptModelConfig?.model : postCallConfig.model,
    );
    await runRetranscription({
      meetingId,
      meetingFolderPath,
      language: model.provider === 'parakeet' || selectedLanguage === 'auto'
        ? null
        : selectedLanguage || null,
      model,
      onProgress: (nextProgress) => {
        setProgress(nextProgress.progress_percentage);
        setMessage(nextProgress.message);
      },
      signal: cancellation.current.signal,
    });
    // Retranscription transactionally replaces the rows. Refresh immediately so
    // a later diarization error can never leave the old live transcript onscreen.
    await refreshTranscript('pre-diarization-refresh');
    await identifySpeakers(count);
  };

  const getSelectedSpeakerCount = (): number | null | undefined => {
    if (isNemotron || autoDetectSpeakers) return null;
    const count = Number(speakerCount);
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      setError('Enter the total number of speakers, from 1 to 20.');
      return undefined;
    }
    return count;
  };

  const start = async () => {
    if (running.current) return;
    const count = getSelectedSpeakerCount();
    if (count === undefined) return;
    running.current = true;
    cancellation.current = new AbortController();
    setCancelling(false);
    try {
      if (failedStage === 'diarizing') {
        await identifySpeakers(count);
      } else if (failedStage === 'pre-diarization-refresh') {
        await refreshTranscript('pre-diarization-refresh');
        await identifySpeakers(count);
      } else if (failedStage === 'post-diarization-refresh') {
        await refreshTranscript('post-diarization-refresh');
        completeWorkflow();
      } else {
        skippedEnhancementRef.current = false;
        await runWorkflow(count);
      }
    } catch (cause) {
      const nextError = cause instanceof Error ? cause.message : String(cause);
      setFailedStage(activeStageRef.current);
      setError(nextError);
      setStage('error');
      if (!cancellation.current.signal.aborted) toast.error('Post-call processing failed', { description: nextError });
    } finally {
      running.current = false;
      setCancelling(false);
    }
  };

  const continueWithLiveTranscript = async () => {
    try {
      skippedEnhancementRef.current = true;
      await refreshTranscript('post-diarization-refresh');
      sessionStorage.setItem(storageKey, 'completed');
      setStage('idle');
      onComplete();
      toast.info('Using the live transcript', {
        description: 'No enhanced audio pass was applied; the saved live text remains available.',
      });
    } catch (cause) {
      const nextError = cause instanceof Error ? cause.message : String(cause);
      setFailedStage('post-diarization-refresh');
      setError(nextError);
      setStage('error');
    }
  };

  const isWorking = stage === 'enhancing' || stage === 'diarizing' || stage === 'refreshing';
  useEffect(() => {
    if (stage !== 'prompt' && stage !== 'error') return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void continueWithLiveTranscript();
      }
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  });
  const visibleProgress = Math.max(4, Math.min(100, progress));

  if (stage === 'idle') return null;

  const choiceClass = (selected: boolean) =>
    cn(
      'h-9 rounded-lg border text-sm font-semibold transition-[background-color,border-color,color,transform] active:scale-[0.97]',
      selected
        ? 'border-af-accent bg-af-accent text-af-on-accent'
        : 'border-af-border bg-af-panel-2 text-af-text-2 hover:border-af-border-strong hover:bg-af-hover hover:text-af-text',
    );

  return (
    <PostCallHandoffCard
      centered
      busy={isWorking}
      title={
        isWorking
          ? 'Improving the transcript'
          : stage === 'error'
            ? 'Could not finish that step'
            : isNemotron
              ? 'Identify speakers with Nemotron'
              : 'How many people spoke?'
      }
      detail={
        isWorking
          ? message
          : isNemotron
            ? 'Automatically identify up to 8 speakers from the full recording.'
            : 'Include yourself. A real count labels speakers more accurately.'
      }
    >
      {isWorking ? (
        <div className="space-y-2">
        <div className="h-1.5 overflow-hidden rounded-full bg-af-border">
          <div
            className="h-full rounded-full bg-af-accent transition-[width] duration-300"
            style={{ width: `${visibleProgress}%` }}
          />
        </div>
        <Button variant="ghost" disabled={cancelling} onClick={() => {
          setCancelling(true);
          cancellation.current.abort();
          setMessage('Cancelling after the current native operation finishes…');
        }}>{cancelling ? 'Cancelling…' : 'Cancel processing'}</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {engineError && <p role="alert" className="text-sm text-af-danger">{engineError}</p>}
          {!engine && !engineError && (
            <p role="status" className="text-sm text-af-text-3">Loading diarization settings…</p>
          )}
          {isNemotron && (
            <Button className="w-full" onClick={() => { void start(); }}>
              {stage === 'error' ? 'Retry auto-detect' : 'Auto-detect & continue'}
            </Button>
          )}
          {engine && !isNemotron && (
            <>
              <div className="grid grid-cols-4 gap-2">
                {[1, 2, 3, 4, 5, 6, 7, 8].map((count) => (
                  <button
                    key={count}
                    type="button"
                    className={choiceClass(!autoDetectSpeakers && speakerCount === String(count))}
                    onClick={() => {
                      setSpeakerCount(String(count));
                      setAutoDetectSpeakers(false);
                      setError(null);
                    }}
                  >
                    {count}
                  </button>
                ))}
                <button
                  type="button"
                  className={`col-span-4 ${choiceClass(autoDetectSpeakers)}`}
                  onClick={() => {
                    setAutoDetectSpeakers(true);
                    setError(null);
                  }}
                >
                  Auto-detect
                </button>
              </div>
              <input
                type="number"
                min={1}
                max={20}
                value={autoDetectSpeakers ? '' : speakerCount}
                placeholder={autoDetectSpeakers ? 'Speakers will be detected automatically' : undefined}
                onFocus={() => setAutoDetectSpeakers(false)}
                onChange={(event) => {
                  setSpeakerCount(event.target.value);
                  setAutoDetectSpeakers(false);
                }}
                className={cn(fieldClass, 'h-9')}
                aria-label="Total number of speakers"
              />
            </>
          )}
          {error && <p className="text-sm text-af-danger">{error}</p>}
          <div className={cn('flex items-center gap-2', isNemotron ? 'justify-center' : 'justify-end')}>
            <Button variant="ghost" onClick={() => { void continueWithLiveTranscript(); }}>
              Keep live transcript
            </Button>
            {!isNemotron && <Button disabled={!engine} onClick={() => { void start(); }}>
              {stage === 'error' ? 'Retry' : 'Continue'}
            </Button>}
          </div>
        </div>
      )}
    </PostCallHandoffCard>
  );
}

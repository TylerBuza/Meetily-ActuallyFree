'use client';

/**
 * In-app recording widget shown on the main screen (app/page.tsx).
 *
 * Two visual states, both styled to mirror the floating compact bar (minibar):
 *  - Idle: red mic button + "Start Recording/Ready", a Mic row (selected device
 *    name) and a System row that shows green "Detected" / red "Not detected".
 *    Detection comes from usePermissionCheck (5s poll) — NOT from the audio
 *    stream, since the webview cannot see system audio (see CLAUDE.md).
 *  - Recording: status dot + timer, stacked Mic/System level meters
 *    (LiveAudioVisualizer with `fill`), and Pause / Stop / shrink controls.
 *
 * Wiring:
 *  - Start/stop go through Tauri commands (invoke) and RecordingStateContext.
 *  - Live audio meters are fed by the Rust `recording-audio-levels` event
 *    (pre-mix, per-source) — the webview cannot capture system audio, so the
 *    meters must be Rust-driven.
 *  - The "shrink" control hands off to the minibar window; the minibar's Stop
 *    is driven from Rust (minibar::stop_recording_from_minibar), because
 *    cross-window emit/listen to the minibar webview is unreliable.
 */

import { invoke } from '@tauri-apps/api/core';

import { useCallback, useEffect, useState, useRef } from 'react';
import { Play, Pause, Square, Mic, Volume2, AlertCircle, X, Minimize2 } from 'lucide-react';
import { LiveAudioVisualizer } from './LiveAudioVisualizer';
import { ProcessRequest, SummaryResponse } from '@/types/summary';
import { listen } from '@tauri-apps/api/event';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import Analytics from '@/lib/analytics';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';

interface RecordingControlsProps {
  isRecording: boolean;
  barHeights: string[];
  onRecordingStop: (callApi?: boolean) => void;
  onRecordingStart: () => void;
  onTranscriptReceived: (summary: SummaryResponse) => void;
  onTranscriptionError?: (message: string) => void;
  onStopInitiated?: () => void; // Called immediately when stop button is clicked
  isRecordingDisabled: boolean;
  isParentProcessing: boolean;
  selectedDevices?: {
    micDevice: string | null;
    systemDevice: string | null;
  };
  meetingName?: string;
}

export const RecordingControls: React.FC<RecordingControlsProps> = ({
  isRecording,
  barHeights,
  onRecordingStop,
  onRecordingStart,
  onTranscriptReceived,
  onTranscriptionError,
  onStopInitiated,
  isRecordingDisabled,
  isParentProcessing,
  selectedDevices,
  meetingName,
}) => {
  // Use global recording state context for pause state (syncs with tray operations)
  const recordingState = useRecordingState();
  const isPaused = recordingState.isPaused;
  // Phase text published by useRecordingStart ("Preparing transcription
  // model…", "Starting audio capture…") so the wait is explained rather than
  // just being a dead button.
  const startupMessage = recordingState.statusMessage;

  // For the idle bar: the selected mic name, and a live-ish system-audio check.
  const { hasSystemAudio, checkPermissions } = usePermissionCheck();
  const micName = selectedDevices?.micDevice?.trim() || 'Default microphone';
  useEffect(() => {
    if (isRecording) return;
    const id = setInterval(() => { checkPermissions(); }, 5000);
    return () => clearInterval(id);
    // checkPermissions is stable enough for a polling interval; re-subscribing
    // on every render would defeat the interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording]);

  const [showPlayback, setShowPlayback] = useState(false);
  const [recordingPath, setRecordingPath] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const MIN_RECORDING_DURATION = 2000; // 2 seconds minimum recording time
  const [transcriptionErrors, setTranscriptionErrors] = useState(0);
  const [isValidatingModel, setIsValidatingModel] = useState(false);
  const [speechDetected, setSpeechDetected] = useState(false);
  const [deviceError, setDeviceError] = useState<{ title: string, message: string } | null>(null);
  // Coach-mark above the minimize button after recording starts.
  const [showCompactTip, setShowCompactTip] = useState(false);

  const currentTime = 0;
  const duration = 0;
  const isPlaying = false;
  const progress = 0;

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  // Elapsed timer for the in-app bar, mirroring the floating compact bar.
  const elapsedSeconds = Math.max(0, Math.floor(recordingState.recordingDuration ?? 0));
  const formatElapsed = (totalSeconds: number) => {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  // Tip above the minimize control when recording starts.
  useEffect(() => {
    const onTip = () => {
      setShowCompactTip(true);
      window.setTimeout(() => setShowCompactTip(false), 12000);
    };
    window.addEventListener('show-compact-mode-tip', onTip);
    return () => window.removeEventListener('show-compact-mode-tip', onTip);
  }, []);

  useEffect(() => {
    if (!isRecording) setShowCompactTip(false);
  }, [isRecording]);

  useEffect(() => {
    const checkTauri = async () => {
      try {
        const result = await invoke('is_recording');
        console.log('Tauri is initialized and ready, is_recording result:', result);
      } catch (error) {
        console.error('Tauri initialization error:', error);
        alert('Failed to initialize recording. Please check the console for details.');
      }
    };
    checkTauri();
  }, []);

  // Holds the stop handler, which is defined further down. The compact-bar
  // listener below is registered once on mount and would otherwise capture a
  // stale closure (or force the listener to re-subscribe on every render).
  const handleStopRecordingRef = useRef<null | (() => void)>(null);

  // Stop requested from the compact recording bar. That window intentionally
  // doesn't implement stopping itself — saving audio, persisting transcripts,
  // summarising and navigating all live here, and duplicating that sequence
  // would be two implementations to keep in step.
  useEffect(() => {
    const unlisten = listen('minibar-stop-requested', () => {
      console.log('[RecordingControls] stop requested from compact bar');
      handleStopRecordingRef.current?.();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleStartRecording = useCallback(async () => {
    if (isStarting || isValidatingModel) return;
    console.log('Starting recording...');
    console.log('Selected devices:', selectedDevices);
    console.log('Meeting name:', meetingName);
    console.log('Current isRecording state:', isRecording);

    setShowPlayback(false);
    setTranscript(''); // Clear any previous transcript
    setSpeechDetected(false); // Reset speech detection on new recording

    // Mark the button busy for the whole start sequence. This was previously
    // only ever read, never set, so the spinner never appeared and the button
    // looked unresponsive during model load.
    setIsStarting(true);

    try {
      // Call the validation callback which will:
      // 1. Check if model is ready
      // 2. Show appropriate toast/modal
      // 3. Call backend if valid
      // 4. Update UI state
      await onRecordingStart();
    } catch (error) {
      console.error('Failed to start recording:', error);
      console.error('Error details:', {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'Unknown',
        stack: error instanceof Error ? error.stack : undefined
      });

      // Parse error message to provide user-friendly feedback
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Check for device-related errors
      if (errorMsg.includes('microphone') || errorMsg.includes('mic') || errorMsg.includes('input')) {
        setDeviceError({
          title: 'Microphone Not Available',
          message: 'Unable to access your microphone. Please check that:\n• Your microphone is connected\n• The app has microphone permissions\n• No other app is using the microphone'
        });
      } else if (errorMsg.includes('system audio') || errorMsg.includes('speaker') || errorMsg.includes('output')) {
        setDeviceError({
          title: 'System Audio Not Available',
          message: 'Unable to capture system audio. Please check that:\n• A virtual audio device (like BlackHole) is installed\n• The app has screen recording permissions (macOS)\n• System audio is properly configured'
        });
      } else if (errorMsg.includes('permission')) {
        setDeviceError({
          title: 'Permission Required',
          message: 'Recording permissions are required. Please:\n• Grant microphone access in System Settings\n• Grant screen recording access for system audio (macOS)\n• Restart the app after granting permissions'
        });
      } else {
        setDeviceError({
          title: 'Recording Failed',
          message: 'Unable to start recording. Please check your audio device settings and try again.'
        });
      }
    } finally {
      setIsStarting(false);
    }
  }, [onRecordingStart, isStarting, isValidatingModel, selectedDevices, meetingName, isRecording]);

  const stopRecordingAction = useCallback(async () => {
    console.log('Executing stop recording...');
    try {
      setIsProcessing(true);
      // Portable build: recordings save into the program's install-local data
      // root (same directory returned for the database), not %APPDATA%.
      const dataDir = await invoke<string>('get_database_directory');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const savePath = `${dataDir}/recording-${timestamp}.wav`;
      console.log('Saving recording to:', savePath);
      console.log('About to call stop_recording command');
      const didStop = await invoke<boolean>('stop_recording', {
        args: {
          save_path: savePath
        }
      });
      console.log('stop_recording command completed successfully:', didStop);
      if (!didStop) {
        setIsProcessing(false);
        return;
      }
      setRecordingPath(savePath);
      // setShowPlayback(true);
      setIsProcessing(false);
      // Track successful transcription
      Analytics.trackTranscriptionSuccess();
      onRecordingStop(true);
    } catch (error) {
      console.error('Failed to stop recording:', error);
      if (error instanceof Error) {
        console.error('Error details:', {
          message: error.message,
          name: error.name,
          stack: error.stack,
        });
        if (error.message.includes('No recording in progress')) {
          return;
        }
      } else if (typeof error === 'string' && error.includes('No recording in progress')) {
        return;
      } else if (error && typeof error === 'object' && 'toString' in error) {
        if (error.toString().includes('No recording in progress')) {
          return;
        }
      }
      setIsProcessing(false);
      onRecordingStop(false);
    } finally {
      setIsStopping(false);
    }
  }, [onRecordingStop]);

  const handleStopRecording = useCallback(async () => {
    console.log('handleStopRecording called - isRecording:', isRecording, 'isStarting:', isStarting, 'isStopping:', isStopping);
    if (!isRecording || isStarting || isStopping) {
      console.log('Early return from handleStopRecording due to state check');
      return;
    }

    console.log('Stopping recording...');

    // Notify parent immediately (for UI state updates)
    onStopInitiated?.();

    setIsStopping(true);

    // Immediately trigger the stop action
    await stopRecordingAction();
  }, [isRecording, isStarting, isStopping, stopRecordingAction, onStopInitiated]);

  // Keep the ref pointing at the current handler for the compact-bar listener.
  useEffect(() => {
    handleStopRecordingRef.current = handleStopRecording;
  }, [handleStopRecording]);

  const handlePauseRecording = useCallback(async () => {
    if (!isRecording || isPaused || isPausing) return;

    console.log('Pausing recording...');
    setIsPausing(true);

    try {
      await invoke('pause_recording');
      // isPaused state now managed by RecordingStateContext via events
      console.log('Recording paused successfully');
    } catch (error) {
      console.error('Failed to pause recording:', error);
      alert('Failed to pause recording. Please check the console for details.');
    } finally {
      setIsPausing(false);
    }
  }, [isRecording, isPaused, isPausing]);

  const handleResumeRecording = useCallback(async () => {
    if (!isRecording || !isPaused || isResuming) return;

    console.log('Resuming recording...');
    setIsResuming(true);

    try {
      await invoke('resume_recording');
      // isPaused state now managed by RecordingStateContext via events
      console.log('Recording resumed successfully');
    } catch (error) {
      console.error('Failed to resume recording:', error);
      alert('Failed to resume recording. Please check the console for details.');
    } finally {
      setIsResuming(false);
    }
  }, [isRecording, isPaused, isResuming]);

  // Collapse the full window down to the floating compact bar. Mirrors the
  // bar's expand button so the two are one control surface in two sizes; the
  // current duration seeds the bar so its timer continues rather than resets.
  const collapseToBar = useCallback(() => {
    const elapsed = Math.max(0, Math.floor(recordingState.recordingDuration ?? 0));
    Analytics.trackButtonClick('enter_compact_mode', 'recording_controls');
    invoke('enter_compact_mode', { elapsedSeconds: elapsed }).catch((e) =>
      console.error('Failed to enter compact mode:', e)
    );
  }, [recordingState.recordingDuration]);

  useEffect(() => {
    return () => {
      // Cleanup on unmount if needed
    };
  }, []);

  useEffect(() => {
    console.log('Setting up recording event listeners');
    let unsubscribes: (() => void)[] = [];

    const setupListeners = async () => {
      try {
        // Transcript error listener - handles both regular and actionable errors
        const transcriptErrorUnsubscribe = await listen('transcript-error', (event) => {
          console.log('transcript-error event received:', event);
          console.error('Transcription error received:', event.payload);
          const errorMessage = event.payload as string;

          Analytics.trackTranscriptionError(errorMessage);
          console.log('Tracked transcription error:', errorMessage);

          setTranscriptionErrors(prev => {
            const newCount = prev + 1;
            console.log('Transcription error count incremented:', newCount);
            return newCount;
          });
          setIsProcessing(false);
          console.log('Calling onRecordingStop(false) due to transcript error');
          onRecordingStop(false);
          if (onTranscriptionError) {
            onTranscriptionError(errorMessage);
          }
        });

        // Transcription error listener - handles structured error objects with actionable flag
        const transcriptionErrorUnsubscribe = await listen('transcription-error', (event) => {
          console.log('transcription-error event received:', event);
          console.error('Transcription error received:', event.payload);

          let errorMessage: string;
          let isActionable = false;

          if (typeof event.payload === 'object' && event.payload !== null) {
            const payload = event.payload as { error: string, userMessage: string, actionable: boolean };
            errorMessage = payload.userMessage || payload.error;
            isActionable = payload.actionable || false;
          } else {
            errorMessage = String(event.payload);
          }

          Analytics.trackTranscriptionError(errorMessage);
          console.log('Tracked transcription error:', errorMessage);

          setTranscriptionErrors(prev => {
            const newCount = prev + 1;
            console.log('Transcription error count incremented:', newCount);
            return newCount;
          });
          setIsProcessing(false);
          console.log('Calling onRecordingStop(false) due to transcription error');
          onRecordingStop(false);

          // For actionable errors (like model loading failures), the main page will handle showing the model selector
          // For regular errors, they are handled by useModalState global listener which shows a toast
          // We don't want to show a modal (via onTranscriptionError) AND a toast, so we skip the callback here
          /* if (onTranscriptionError && !isActionable) {
            onTranscriptionError(errorMessage);
          } */
        });

        // Pause/Resume events are now handled by RecordingStateContext
        // No need for duplicate listeners here

        // Speech detected listener - for UX feedback when VAD detects speech
        const speechDetectedUnsubscribe = await listen('speech-detected', (event) => {
          console.log('speech-detected event received:', event);
          setSpeechDetected(true);
        });

        unsubscribes = [
          transcriptErrorUnsubscribe,
          transcriptionErrorUnsubscribe,
          speechDetectedUnsubscribe
        ];
        console.log('Recording event listeners set up successfully');
      } catch (error) {
        console.error('Failed to set up recording event listeners:', error);
      }
    };

    setupListeners();

    return () => {
      console.log('Cleaning up recording event listeners');
      unsubscribes.forEach(unsubscribe => {
        if (unsubscribe && typeof unsubscribe === 'function') {
          unsubscribe();
        }
      });
    };
  }, [onRecordingStop, onTranscriptionError]);

  return (
    <TooltipProvider>
      <div className="flex flex-col space-y-2">
        <div className={`flex items-center rounded-3xl border border-white/10 bg-[#0f1218]/90 text-white shadow-2xl backdrop-blur-xl ${isRecording ? 'w-[640px] max-w-full gap-3 px-5 py-4' : 'w-[540px] max-w-full gap-4 px-5 py-4'}`}>
          {isProcessing && !isParentProcessing ? (
            <div className="flex items-center space-x-2">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
              <span className="text-sm text-gray-300">Processing recording...</span>
            </div>
          ) : (
            <>
              {showPlayback ? (
                <>
                  <button
                    onClick={handleStartRecording}
                    className="w-10 h-10 flex items-center justify-center bg-red-500 rounded-full text-white hover:bg-red-600 transition-colors"
                  >
                    <Mic size={16} />
                  </button>

                  <div className="w-px h-6 bg-gray-200 mx-1" />

                  <div className="flex items-center space-x-1 mx-2">
                    <div className="text-sm text-gray-600 min-w-[40px]">
                      {formatTime(currentTime)}
                    </div>
                    <div
                      className="relative w-24 h-1 bg-gray-200 rounded-full"
                    >
                      <div
                        className="absolute h-full bg-blue-500 rounded-full"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <div className="text-sm text-gray-600 min-w-[40px]">
                      {formatTime(duration)}
                    </div>
                  </div>

                  <button
                    className="w-10 h-10 flex items-center justify-center bg-gray-300 rounded-full text-white cursor-not-allowed"
                    disabled
                  >
                    <Play size={16} />
                  </button>
                </>
              ) : (
                <>
                  {!isRecording ? (
                    // Idle bar — the "start" twin of the recording bar: red mic
                    // button + a Start/Ready label where the timer sits, then the
                    // idle Mic/System meters stretching to the right.
                    <div className="flex w-full items-center gap-4">
                      <div className="flex items-center gap-3 pl-0.5">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => {
                                Analytics.trackButtonClick('start_recording', 'recording_controls');
                                handleStartRecording();
                              }}
                              disabled={isStarting || isProcessing || isRecordingDisabled || isValidatingModel}
                              className={`w-12 h-12 flex items-center justify-center shrink-0 ${isStarting || isProcessing || isValidatingModel ? 'bg-gray-400' : 'bg-red-500 hover:bg-red-600'
                                } rounded-full text-white transition-colors relative`}
                            >
                              {isStarting || isValidatingModel ? (
                                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                              ) : (
                                <Mic size={20} />
                              )}

                              {(isStarting || isValidatingModel) && (
                                <div className="absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-[var(--af-panel-2,#1f2937)] px-3 py-1 text-xs font-medium text-[var(--af-text,#e5e7eb)] shadow-lg">
                                  {startupMessage || 'Starting…'}
                                </div>
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Start recording</p>
                          </TooltipContent>
                        </Tooltip>

                        <button
                          onClick={() => {
                            if (isStarting || isProcessing || isRecordingDisabled || isValidatingModel) return;
                            Analytics.trackButtonClick('start_recording', 'recording_controls');
                            handleStartRecording();
                          }}
                          className="text-left leading-tight"
                        >
                          <div className="font-semibold tracking-tight text-white">
                            {isStarting || isValidatingModel ? 'Starting…' : 'Start Recording'}
                          </div>
                          <div className="text-[11px] text-red-400">Ready</div>
                        </button>
                      </div>

                      <div className="h-10 w-px bg-white/10" />

                      <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-[12px]">
                        <div className="flex min-w-0 items-center gap-2" title={`Microphone: ${micName}`}>
                          <Mic size={13} className="shrink-0 text-gray-400" />
                          <span className="truncate text-gray-300">{micName}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Volume2 size={13} className="shrink-0 text-gray-400" />
                          <span className="text-gray-400">System audio</span>
                          <span
                            className={`ml-0.5 h-2 w-2 rounded-full ${hasSystemAudio ? 'bg-emerald-500' : 'bg-red-500'}`}
                          />
                          <span className={hasSystemAudio ? 'text-emerald-400' : 'text-red-400'}>
                            {hasSystemAudio ? 'Detected' : 'Not detected'}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    // Recording bar — mirrors the floating compact bar.
                    <div className="flex w-full items-center gap-4">
                      {/* Status + timer */}
                      <div className="flex items-center gap-3 pl-1">
                        <span className="relative flex h-6 w-6 items-center justify-center">
                          <span className={`absolute inset-0 rounded-full ${isPaused ? 'bg-orange-500/20' : 'bg-red-500/20 animate-pulse'}`} />
                          <span className={`h-3 w-3 rounded-full ${isPaused ? 'bg-orange-400' : 'bg-red-500'}`} />
                        </span>
                        <div className="text-left leading-tight">
                          <div className="font-semibold tabular-nums tracking-tight">{formatElapsed(elapsedSeconds)}</div>
                          <div className={`text-[11px] ${isPaused ? 'text-orange-400' : 'text-red-400'}`}>
                            {isStopping ? 'Stopping…' : isPaused ? 'Paused' : 'Recording'}
                          </div>
                        </div>
                      </div>

                      <div className="h-10 w-px bg-white/10" />

                      {/* Live input levels (Rust-driven, per source) — stretch to
                          fill the space between the timer and the controls. */}
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <Mic size={12} className="shrink-0 text-gray-400" />
                          <span className="w-12 shrink-0 text-[11px] text-gray-400">Mic</span>
                          <LiveAudioVisualizer active={isRecording && !isPaused} source="mic" fill bars={28} className="flex-1" />
                        </div>
                        <div className="flex items-center gap-2">
                          <Volume2 size={12} className="shrink-0 text-gray-400" />
                          <span className="w-12 shrink-0 text-[11px] text-gray-400">System</span>
                          <LiveAudioVisualizer active={isRecording && !isPaused} source="system" fill bars={28} className="flex-1" />
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          onClick={() => {
                            if (isPaused) {
                              Analytics.trackButtonClick('resume_recording', 'recording_controls');
                              handleResumeRecording();
                            } else {
                              Analytics.trackButtonClick('pause_recording', 'recording_controls');
                              handlePauseRecording();
                            }
                          }}
                          disabled={isPausing || isResuming || isStopping}
                          title={isPaused ? 'Resume recording' : 'Pause recording'}
                          className="flex h-12 w-14 flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-xs text-gray-300 transition-colors hover:bg-white/10 disabled:opacity-40"
                        >
                          {isPaused ? <Play size={15} /> : <Pause size={15} />}
                          <span className="mt-0.5 text-[10px]">{isPaused ? 'Resume' : 'Pause'}</span>
                        </button>

                        <button
                          onClick={() => {
                            Analytics.trackButtonClick('stop_recording', 'recording_controls');
                            handleStopRecording();
                          }}
                          disabled={isStopping || isPausing || isResuming}
                          title="Stop recording"
                          className="flex h-12 w-14 flex-col items-center justify-center rounded-2xl border border-red-500/30 bg-red-500/15 text-xs text-red-300 transition-colors hover:bg-red-500/25 disabled:opacity-40"
                        >
                          <Square size={13} fill="currentColor" />
                          <span className="mt-0.5 text-[10px]">Stop</span>
                        </button>

                        <div className="relative">
                          {showCompactTip && (
                            <div
                              role="dialog"
                              aria-label="Shrink to floating bar"
                              className="absolute bottom-[calc(100%+12px)] right-0 z-50 w-[260px] rounded-xl border border-white/10 bg-[var(--af-panel,#0f1218)] px-3.5 py-3 text-left shadow-2xl shadow-black/50"
                            >
                              {/* Caret pointing at the minimize button */}
                              <span
                                aria-hidden
                                className="absolute -bottom-1.5 right-4 h-3 w-3 rotate-45 border-b border-r border-white/10 bg-[var(--af-panel,#0f1218)]"
                              />
                              <button
                                type="button"
                                onClick={() => setShowCompactTip(false)}
                                className="absolute right-2 top-2 rounded p-0.5 text-[var(--af-text-3)] hover:text-[var(--af-text)]"
                                aria-label="Dismiss"
                              >
                                <X size={14} />
                              </button>
                              <div className="pr-5 text-sm font-semibold text-[var(--af-text)]">
                                You’re recording
                              </div>
                              <p className="mt-1 text-xs leading-relaxed text-[var(--af-text-2)]">
                                Tuck Meetily into a compact floating bar so it stays out of your way — expand it again anytime.
                              </p>
                              <button
                                type="button"
                                onClick={() => {
                                  setShowCompactTip(false);
                                  collapseToBar();
                                }}
                                className="mt-3 w-full rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-gray-900 transition-colors hover:bg-gray-100"
                              >
                                Shrink to bar
                              </button>
                            </div>
                          )}
                          <button
                            onClick={() => {
                              setShowCompactTip(false);
                              collapseToBar();
                            }}
                            disabled={isStopping}
                            title="Shrink to floating bar"
                            className={`flex h-12 w-12 items-center justify-center rounded-2xl border text-gray-300 transition-colors disabled:opacity-40 ${
                              showCompactTip
                                ? 'border-[var(--af-accent)]/60 bg-[var(--af-accent)]/15 ring-2 ring-[var(--af-accent)]/30'
                                : 'border-white/10 bg-white/5 hover:bg-white/10'
                            }`}
                          >
                            <Minimize2 size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                </>
              )}
            </>
          )}
        </div>

        {/* Show validation status only */}
        {isValidatingModel && (
          <div className="text-xs text-gray-600 text-center mt-2">
            Validating speech recognition...
          </div>
        )}

        {/* Device error alert */}
        {deviceError && (
          <Alert variant="destructive" className="mt-4 border-red-300 bg-red-50">
            <AlertCircle className="h-5 w-5 text-red-600" />
            <button
              onClick={() => setDeviceError(null)}
              className="absolute right-3 top-3 text-red-600 hover:text-red-800 transition-colors"
              aria-label="Close alert"
            >
              <X className="h-4 w-4" />
            </button>
            <AlertTitle className="text-red-800 font-semibold mb-2">
              {deviceError.title}
            </AlertTitle>
            <AlertDescription className="text-red-700">
              {deviceError.message.split('\n').map((line, i) => (
                <div key={i} className={i > 0 ? 'ml-2' : ''}>
                  {line}
                </div>
              ))}
            </AlertDescription>
          </Alert>
        )}

        {/* {showPlayback && recordingPath && (
        <div className="text-sm text-gray-600 px-4">
          Recording saved to: {recordingPath}
        </div>
      )} */}
      </div>
    </TooltipProvider>
  );
};

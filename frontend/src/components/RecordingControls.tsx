'use client';

/**
 * The record card on the recorder page. One card for idle and recording: the
 * red button becomes stop, the label becomes the timer, the device chevrons
 * become level meters, and pause/shrink ease in beside the timer.
 *
 * The floating compact bar (app/minibar) is the same control set in its own
 * window. Keep the two aligned.
 *
 * Wiring:
 *  - Start goes through useRecordingStart (onRecordingStart). Stop, pause and
 *    mute are Tauri commands; their state comes from RecordingStateContext.
 *  - Level meters are fed by Rust's `recording-audio-levels` event, since the
 *    webview cannot capture system audio.
 *  - Shrink hands off to the minibar window, whose Stop is driven from Rust
 *    (minibar::stop_recording_from_minibar).
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Layers, Minimize2, Mic, Pause, Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import Analytics from '@/lib/analytics';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useConfig } from '@/contexts/ConfigContext';
import { usePlatform } from '@/hooks/usePlatform';
import { usePendingGroup } from '@/hooks/usePendingGroup';
import { deviceDisplayName, UNAVAILABLE_DEVICE_VALUE, type AudioDeviceOption } from '@/lib/audio-devices';
import type { RecordingPreferences } from '@/components/RecordingSettings';
import type { SelectedDevices } from '@/components/DeviceSelection';
import { RecordingScreenshotButton } from '@/components/recording/RecordingScreenshotButton';
import { RecordingVoiceLane } from '@/components/RecordingVoiceLane';
import { AppAudioSource, useAppAudioSupported } from '@/components/recording/AppAudioSource';
import { useAppAudio } from '@/hooks/useAppAudio';
import { GroupPicker } from '@/components/groups/GroupBits';
import { Hint } from '@/components/ui/tooltip';
import { Spinner } from '@/components/ui/spinner';
import { STOP_RECORDING_EVENT, STOP_REQUEST_KEY } from '@/lib/recording-launch';
import { formatClock } from '@/lib/dates';

interface RecordingControlsProps {
  isRecording: boolean;
  onRecordingStop: (callApi?: boolean) => void;
  onRecordingStart: () => Promise<void> | void;
  onTranscriptionError?: (message: string) => void;
  /** Called the moment Stop is pressed. */
  onStopInitiated?: () => void;
  isRecordingDisabled: boolean;
  selectedDevices?: {
    micDevice: string | null;
    systemDevice: string | null;
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Round secondary control beside the timer (pause, shrink). */
const sideButton =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-af-panel-2 text-af-text-2 ring-1 ring-inset ring-af-border transition-[background-color,color,transform] duration-150 hover:bg-af-hover hover:text-af-text active:scale-95 disabled:opacity-40';

/** "No group ▾" under "Start recording": which group the next meeting is filed in. */
function NextGroupPicker() {
  const [pending, choose] = usePendingGroup();
  return (
    <GroupPicker
      value={pending?.id ?? null}
      onChange={choose}
      side="top"
      align="start"
      trigger={
        <button
          type="button"
          className="mt-0.5 inline-flex max-w-[10rem] items-center gap-1.5 rounded-md text-[11px] font-medium text-af-text-3 transition-colors hover:text-af-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60"
        >
          <Layers className="h-3 w-3 shrink-0" />
          <span className="truncate">{pending ? pending.name : 'No group'}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
        </button>
      }
    />
  );
}

export const RecordingControls: React.FC<RecordingControlsProps> = ({
  isRecording,
  onRecordingStop,
  onRecordingStart,
  onTranscriptionError,
  onStopInitiated,
  isRecordingDisabled,
  selectedDevices,
}) => {
  // Pause and mute live in the shared context so the tray and minibar agree.
  const recordingState = useRecordingState();
  const isPaused = recordingState.isPaused;
  const isMicrophoneMuted = recordingState.isMicrophoneMuted;
  const isSystemAudioMuted = recordingState.isSystemAudioMuted;
  // Phase text from useRecordingStart ("Preparing transcription model…").
  const startupMessage = recordingState.statusMessage;

  const { selectedDevices: savedDevices, setSelectedDevices } = useConfig();
  const activeDevices = savedDevices ?? selectedDevices;
  const isMacOS = usePlatform() === 'macos';
  // All computer audio, or only chosen apps (Settings > Recording has it too).
  const appAudio = useAppAudio();
  const appAudioSupported = useAppAudioSupported();
  const onlyChosenApps = appAudioSupported && appAudio.onlyApps && appAudio.targets.length > 0;
  const [audioDevices, setAudioDevices] = useState<AudioDeviceOption[]>([]);
  const [openLane, setOpenLane] = useState<'mic' | 'output' | null>(null);
  const [micGain, setMicGain] = useState(1);
  const [systemGain, setSystemGain] = useState(1);
  const saveChain = useRef(Promise.resolve());
  const gainTimer = useRef<number | null>(null);
  const pendingGain = useRef<{ which: 'mic' | 'system'; value: number } | null>(null);
  // Mutes chosen before recording apply the moment it starts.
  const [idleMicMuted, setIdleMicMuted] = useState(false);
  const [idleSystemMuted, setIdleSystemMuted] = useState(false);

  const [isProcessing, setIsProcessing] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [isChangingMicrophoneMute, setIsChangingMicrophoneMute] = useState(false);
  const [isChangingSystemAudioMute, setIsChangingSystemAudioMute] = useState(false);

  const inputDevices = audioDevices.filter((device) => device.device_type === 'Input');
  const outputDevices = audioDevices.filter((device) => device.device_type === 'Output');

  const loadAudioDevices = useCallback(async () => {
    try {
      setAudioDevices(await invoke<AudioDeviceOption[]>('get_audio_devices'));
    } catch (error) {
      console.error('Failed to load audio devices for the recording card:', error);
    }
  }, []);

  useEffect(() => {
    void loadAudioDevices();
    void invoke<RecordingPreferences>('get_recording_preferences')
      .then((prefs) => {
        setMicGain(prefs.mic_gain ?? 1);
        setSystemGain(prefs.system_gain ?? 1);
      })
      .catch(() => undefined);
  }, [loadAudioDevices]);

  // Surface a broken recording backend in the app instead of failing silently.
  useEffect(() => {
    invoke('is_recording').catch((error) => {
      console.error('Tauri initialization error:', error);
      toast.error('Recording is unavailable', { description: 'Restart Meetily. If this keeps happening, check the logs.' });
    });
  }, []);

  const saveDevices = useCallback((next: SelectedDevices) => {
    setSelectedDevices(next);
    saveChain.current = saveChain.current.then(async () => {
      const prefs = await invoke<RecordingPreferences>('get_recording_preferences');
      await invoke('set_recording_preferences', {
        preferences: {
          ...prefs,
          preferred_mic_device: next.micDevice,
          preferred_system_device: next.systemDevice,
        },
      });
    }).catch((error) => {
      console.error('Failed to save recording devices:', error);
      toast.error('Could not save the audio device', { description: errorText(error) });
    });
  }, [setSelectedDevices]);

  const flushGain = useCallback(() => {
    const pending = pendingGain.current;
    if (!pending) return;
    pendingGain.current = null;
    const { which, value } = pending;
    saveChain.current = saveChain.current.then(async () => {
      const prefs = await invoke<RecordingPreferences>('get_recording_preferences');
      await invoke('set_recording_preferences', {
        preferences: {
          ...prefs,
          mic_gain: which === 'mic' ? value : prefs.mic_gain,
          system_gain: which === 'system' ? value : prefs.system_gain,
        },
      });
    }).catch((error) => {
      console.error('Failed to save audio sensitivity:', error);
      toast.error('Could not save sensitivity');
    });
  }, []);

  const scheduleGain = useCallback((which: 'mic' | 'system', raw: number, immediate: boolean) => {
    const value = Math.min(3, Math.max(0.5, raw));
    if (which === 'mic') setMicGain(value);
    else setSystemGain(value);
    pendingGain.current = { which, value };
    if (gainTimer.current !== null) window.clearTimeout(gainTimer.current);
    if (immediate) flushGain();
    else gainTimer.current = window.setTimeout(flushGain, 90);
  }, [flushGain]);

  const applyLiveDevice = (kind: 'Microphone' | 'SystemAudio', value: string, previous: SelectedDevices, next: SelectedDevices) => {
    saveDevices(next);
    if (!isRecording || value === 'default') return;
    const failed = (description: string) => {
      toast.error(kind === 'Microphone' ? 'Could not switch microphone' : 'Could not switch system audio', { description });
      saveDevices(previous);
    };
    void invoke<boolean>('attempt_device_reconnect', {
      deviceName: deviceDisplayName(value),
      deviceType: kind,
    }).then((ok) => {
      if (!ok) failed('The recording is still using the previous device.');
    }).catch((error) => {
      console.error('Failed to switch audio device while recording:', error);
      failed(errorText(error));
    });
  };

  const chooseMic = (value: string) => {
    if (value === UNAVAILABLE_DEVICE_VALUE) return;
    const previous: SelectedDevices = {
      micDevice: activeDevices?.micDevice ?? null,
      systemDevice: activeDevices?.systemDevice ?? null,
    };
    applyLiveDevice('Microphone', value, previous, {
      micDevice: value === 'default' ? null : value,
      systemDevice: previous.systemDevice,
    });
  };

  const chooseSystem = (value: string) => {
    if (value === UNAVAILABLE_DEVICE_VALUE || isMacOS) return;
    const previous: SelectedDevices = {
      micDevice: activeDevices?.micDevice ?? null,
      systemDevice: activeDevices?.systemDevice ?? null,
    };
    applyLiveDevice('SystemAudio', value, previous, {
      micDevice: previous.micDevice,
      systemDevice: value === 'default' ? null : value,
    });
  };

  useEffect(() => {
    if (isStarting) setOpenLane(null);
  }, [isStarting]);

  const wasRecording = useRef(false);
  useEffect(() => {
    if (isRecording && !wasRecording.current) {
      if (idleMicMuted) void invoke('set_microphone_muted', { muted: true }).catch(() => undefined);
      if (idleSystemMuted) void invoke('set_system_audio_muted', { muted: true }).catch(() => undefined);
    }
    if (!isRecording && wasRecording.current) {
      setIdleMicMuted(false);
      setIdleSystemMuted(false);
    }
    wasRecording.current = isRecording;
  }, [idleMicMuted, idleSystemMuted, isRecording]);

  const handleStartRecording = useCallback(async () => {
    if (isStarting) return;
    // Busy for the whole start sequence; loading the model can take a while.
    setIsStarting(true);
    await invoke('stop_audio_level_monitoring').catch(() => undefined);
    try {
      await onRecordingStart();
    } finally {
      setIsStarting(false);
    }
  }, [onRecordingStart, isStarting]);

  const stopRecordingAction = useCallback(async () => {
    try {
      setIsProcessing(true);
      // Recordings save under the install-local data root (same directory as the database).
      const dataDir = await invoke<string>('get_database_directory');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const didStop = await invoke<boolean>('stop_recording', {
        args: { save_path: `${dataDir}/recording-${timestamp}.wav` },
      });
      setIsProcessing(false);
      if (!didStop) return;
      Analytics.trackTranscriptionSuccess();
      // Rust emits one completion event; RecordingPostProcessingProvider saves
      // the meeting and navigates for every stop origin.
    } catch (error) {
      console.error('Failed to stop recording:', error);
      if (errorText(error).includes('No recording in progress')) return;
      setIsProcessing(false);
      onRecordingStop(false);
    } finally {
      setIsStopping(false);
    }
  }, [onRecordingStop]);

  const handleStopRecording = useCallback(async () => {
    if (!isRecording || isStarting || isStopping) return;
    onStopInitiated?.();
    setIsStopping(true);
    await stopRecordingAction();
  }, [isRecording, isStarting, isStopping, stopRecordingAction, onStopInitiated]);

  // Stop pressed elsewhere in the app (recording pill, command bar, meeting
  // automation) routes here and leaves a request, so the normal stop and save
  // flow runs from this card.
  useEffect(() => {
    let requested = false;
    try {
      requested = sessionStorage.getItem(STOP_REQUEST_KEY) === '1';
      if (requested) sessionStorage.removeItem(STOP_REQUEST_KEY);
    } catch {
      requested = false;
    }
    if (requested && isRecording) void handleStopRecording();
  }, [isRecording, handleStopRecording]);

  // The same request while this page is open (command bar, meeting automation).
  useEffect(() => {
    const onStop = () => void handleStopRecording();
    window.addEventListener(STOP_RECORDING_EVENT, onStop);
    return () => window.removeEventListener(STOP_RECORDING_EVENT, onStop);
  }, [handleStopRecording]);

  const handlePauseRecording = useCallback(async () => {
    if (!isRecording || isPaused || isPausing) return;
    setIsPausing(true);
    try {
      await invoke('pause_recording');
    } catch (error) {
      console.error('Failed to pause recording:', error);
      toast.error('Could not pause the recording', { description: errorText(error) });
    } finally {
      setIsPausing(false);
    }
  }, [isRecording, isPaused, isPausing]);

  const handleResumeRecording = useCallback(async () => {
    if (!isRecording || !isPaused || isResuming) return;
    setIsResuming(true);
    try {
      await invoke('resume_recording');
    } catch (error) {
      console.error('Failed to resume recording:', error);
      toast.error('Could not resume the recording', { description: errorText(error) });
    } finally {
      setIsResuming(false);
    }
  }, [isRecording, isPaused, isResuming]);

  const handleMicrophoneMute = useCallback(async () => {
    if (!isRecording || isStopping || isChangingMicrophoneMute || isChangingSystemAudioMute) return;
    setIsChangingMicrophoneMute(true);
    try {
      await invoke<boolean>('set_microphone_muted', { muted: !isMicrophoneMuted });
      Analytics.trackButtonClick(isMicrophoneMuted ? 'unmute_microphone' : 'mute_microphone', 'recording_controls');
    } catch (error) {
      console.error('Failed to change microphone mute state:', error);
    } finally {
      setIsChangingMicrophoneMute(false);
    }
  }, [isChangingMicrophoneMute, isChangingSystemAudioMute, isMicrophoneMuted, isRecording, isStopping]);

  const handleSystemAudioMute = useCallback(async () => {
    if (!isRecording || isStopping || isChangingMicrophoneMute || isChangingSystemAudioMute) return;
    setIsChangingSystemAudioMute(true);
    try {
      await invoke<boolean>('set_system_audio_muted', { muted: !isSystemAudioMuted });
      Analytics.trackButtonClick(isSystemAudioMuted ? 'unmute_system_audio' : 'mute_system_audio', 'recording_controls');
    } catch (error) {
      console.error('Failed to change system audio mute state:', error);
    } finally {
      setIsChangingSystemAudioMute(false);
    }
  }, [isChangingMicrophoneMute, isChangingSystemAudioMute, isRecording, isStopping, isSystemAudioMuted]);

  // Collapse to the floating compact bar; the elapsed time seeds its timer.
  const collapseToBar = useCallback(() => {
    const elapsed = Math.max(0, Math.floor(recordingState.recordingDuration ?? 0));
    Analytics.trackButtonClick('enter_compact_mode', 'recording_controls');
    invoke('enter_compact_mode', { elapsedSeconds: elapsed }).catch((error) =>
      console.error('Failed to enter compact mode:', error)
    );
  }, [recordingState.recordingDuration]);

  // Transcription failures end the recording; useModalState shows the message.
  useEffect(() => {
    let disposed = false;
    const unsubscribes: Array<() => void> = [];
    const track = (promise: Promise<() => void>) =>
      promise
        .then((stop) => (disposed ? stop() : unsubscribes.push(stop)))
        .catch((error) => console.error('Failed to set up recording event listeners:', error));

    track(listen<string>('transcript-error', (event) => {
      const message = String(event.payload);
      Analytics.trackTranscriptionError(message);
      setIsProcessing(false);
      onRecordingStop(false);
      onTranscriptionError?.(message);
    }));
    track(listen<{ error?: string; userMessage?: string } | string>('transcription-error', (event) => {
      const payload = event.payload;
      const message = typeof payload === 'object' && payload ? payload.userMessage || payload.error || '' : String(payload);
      Analytics.trackTranscriptionError(message);
      setIsProcessing(false);
      onRecordingStop(false);
    }));

    return () => {
      disposed = true;
      unsubscribes.forEach((stop) => stop());
    };
  }, [onRecordingStop, onTranscriptionError]);

  const busy = isStarting || isProcessing;
  const elapsed = formatClock(recordingState.activeDuration ?? recordingState.recordingDuration ?? 0);

  return (
    <div
      className={cn(
        'pointer-events-auto flex items-center rounded-[26px] border border-af-border-strong bg-af-elevated/95 px-4 py-3 text-af-text shadow-2xl backdrop-blur-xl',
        isRecording || isProcessing ? 'w-full min-w-0 gap-3' : 'w-max gap-4',
      )}
    >
      <div className={cn('flex min-w-0 items-center gap-4', isRecording || isProcessing ? 'w-full' : 'w-max')}>
        <div className="flex shrink-0 items-center pl-0.5">
          <Hint label={isRecording ? 'Stop recording' : 'Start recording'}>
            <button
              type="button"
              onClick={() => {
                if (isRecording) {
                  Analytics.trackButtonClick('stop_recording', 'recording_controls');
                  void handleStopRecording();
                  return;
                }
                Analytics.trackButtonClick('start_recording', 'recording_controls');
                void handleStartRecording();
              }}
              disabled={
                busy ||
                (!isRecording && isRecordingDisabled) ||
                (isRecording && (isStopping || isPausing || isResuming))
              }
              aria-label={isRecording ? 'Stop recording' : 'Start recording'}
              data-loading={busy ? 'true' : undefined}
              className="af-record-button relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition-[background,transform] duration-200 active:scale-95 disabled:active:scale-100"
            >
              {isRecording && !isPaused && !isStopping && !isProcessing && (
                <span className="pointer-events-none absolute -inset-1 animate-pulse rounded-full border border-af-record/50" />
              )}
              {busy ? (
                <Spinner size={20} className="text-white" />
              ) : (
                <span className="relative flex h-5 w-5 items-center justify-center">
                  <Mic
                    size={20}
                    className={cn('absolute transition-all duration-300', isRecording ? 'scale-75 opacity-0' : 'scale-100 opacity-100')}
                  />
                  <Square
                    size={13}
                    fill="currentColor"
                    className={cn('absolute transition-all duration-300', isRecording ? 'scale-100 opacity-100' : 'scale-75 opacity-0')}
                  />
                </span>
              )}
            </button>
          </Hint>

          <div className={cn('ml-3 shrink-0 whitespace-nowrap text-left leading-tight', isRecording ? 'w-[5.25rem]' : 'min-w-[7.75rem]')}>
            <div className="text-sm font-semibold tabular-nums tracking-tight text-af-text">
              {isRecording ? elapsed : isProcessing ? 'Processing…' : isStarting ? 'Starting…' : 'Start recording'}
            </div>
            {isRecording ? (
              <div
                className={cn(
                  'text-[11px] font-medium transition-colors duration-300',
                  isStopping ? 'text-af-text-3' : isPaused ? 'text-af-warning' : 'text-af-record',
                )}
              >
                {isStopping ? 'Stopping…' : isPaused ? 'Paused' : 'Recording'}
              </div>
            ) : busy ? (
              <div className="max-w-[11rem] truncate text-[11px] text-af-text-3">{startupMessage || 'One moment'}</div>
            ) : (
              <NextGroupPicker />
            )}
          </div>

          <div
            className={cn(
              'grid overflow-hidden transition-[grid-template-columns,opacity,margin] duration-500 ease-af motion-reduce:transition-none',
              isRecording ? 'ml-2 grid-cols-[1fr] opacity-100' : 'pointer-events-none ml-0 grid-cols-[0fr] opacity-0',
            )}
          >
            <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
              <Hint label={isPaused ? 'Resume recording' : 'Pause recording'}>
                <button
                  type="button"
                  onClick={() => {
                    Analytics.trackButtonClick(isPaused ? 'resume_recording' : 'pause_recording', 'recording_controls');
                    void (isPaused ? handleResumeRecording() : handlePauseRecording());
                  }}
                  disabled={isPausing || isResuming || isStopping}
                  aria-label={isPaused ? 'Resume recording' : 'Pause recording'}
                  className={sideButton}
                >
                  {isPaused ? <Play size={14} /> : <Pause size={14} />}
                </button>
              </Hint>
              <RecordingScreenshotButton disabled={!isRecording || isStopping} className={sideButton} />
              <Hint label="Shrink to floating bar">
                <button
                  type="button"
                  onClick={collapseToBar}
                  disabled={isStopping}
                  aria-label="Shrink to floating bar"
                  className={sideButton}
                >
                  <Minimize2 size={14} />
                </button>
              </Hint>
            </div>
          </div>
        </div>

        <div className="h-8 w-px shrink-0 self-center bg-af-border" />

        <div className={cn('flex items-center gap-2', isRecording ? 'min-w-0 flex-1' : 'shrink-0')}>
          <RecordingVoiceLane
            kind="mic"
            open={openLane === 'mic'}
            onOpenChange={(next) => {
              if (next) void loadAudioDevices();
              setOpenLane(next ? 'mic' : null);
            }}
            savedValue={activeDevices?.micDevice ?? null}
            options={inputDevices}
            onSelect={chooseMic}
            disabled={isStarting}
            gain={micGain}
            onGainLive={(value) => scheduleGain('mic', value, false)}
            onGainCommit={(value) => scheduleGain('mic', value, true)}
            live={isRecording}
            muted={isRecording ? isMicrophoneMuted : idleMicMuted}
            meterActive={isRecording && !isPaused && !isMicrophoneMuted}
            onMute={() => {
              if (isRecording) void handleMicrophoneMute();
              else setIdleMicMuted((current) => !current);
            }}
          />
          <RecordingVoiceLane
            kind="output"
            open={openLane === 'output'}
            onOpenChange={(next) => {
              if (next) void loadAudioDevices();
              setOpenLane(next ? 'output' : null);
            }}
            savedValue={isMacOS ? null : activeDevices?.systemDevice ?? null}
            options={isMacOS ? [] : outputDevices}
            onSelect={chooseSystem}
            disabled={isStarting}
            gain={systemGain}
            onGainLive={(value) => scheduleGain('system', value, false)}
            onGainCommit={(value) => scheduleGain('system', value, true)}
            macDefaultOutput={isMacOS}
            source={appAudioSupported ? <AppAudioSource choice={appAudio} variant="compact" live={isRecording} /> : undefined}
            hideDevice={onlyChosenApps}
            live={isRecording}
            muted={isRecording ? isSystemAudioMuted : idleSystemMuted}
            meterActive={isRecording && !isPaused && !isSystemAudioMuted}
            onMute={() => {
              if (isRecording) void handleSystemAudioMute();
              else setIdleSystemMuted((current) => !current);
            }}
          />
        </div>
      </div>
    </div>
  );
};

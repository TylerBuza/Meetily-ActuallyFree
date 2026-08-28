'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { usePlatform } from '@/hooks/usePlatform';
import { MACOS_SYSTEM_AUDIO_VERIFIED_KEY } from '@/hooks/usePermissionCheck';
import { OnboardingContainer } from '../OnboardingContainer';
import { Mic, Volume2, RefreshCw } from 'lucide-react';

interface AudioDevice {
  name: string;
  device_type: 'Input' | 'Output' | string;
}

interface AudioLevelData {
  device_name: string;
  device_type: string;
  rms_level: number;
  peak_level: number;
  is_active: boolean;
}

interface AudioLevelUpdate {
  timestamp: number;
  levels: AudioLevelData[];
}

/**
 * Quick mic + system-audio level check so users know capture works before
 * their first real meeting.
 */
export function AudioTestStep() {
  const { goPrevious, completeOnboarding } = useOnboarding();
  const platform = usePlatform();
  const isMacOS = platform === 'macos';
  const [micRms, setMicRms] = useState(0);
  const [sysRms, setSysRms] = useState(0);
  const [micHeard, setMicHeard] = useState(false);
  const [sysHeard, setSysHeard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Starting meters…');
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  const [micName, setMicName] = useState<string>('');
  const [sysName, setSysName] = useState<string>('');
  const monitoring = useRef(false);
  const active = useRef(true);
  const deviceLoad = useRef(0);
  const meterRun = useRef(0);
  // Rust owns one process-global monitor. Serialize stop/start transitions so a
  // stale StrictMode effect, retest, or device change cannot stop its successor.
  const meterTransition = useRef<Promise<void>>(Promise.resolve());
  const micNameRef = useRef('');
  const sysNameRef = useRef('');

  const stop = useCallback(async () => {
    if (!monitoring.current) return;
    monitoring.current = false;
    try {
      await invoke('stop_audio_level_monitoring');
    } catch {
      /* ignore */
    }
  }, []);

  const startMeters = useCallback(
    (mic: string, sys: string) => {
      const run = ++meterRun.current;
      const transition = meterTransition.current.then(async () => {
        await stop();
        if (!active.current || run !== meterRun.current) return;
        setError(null);
        setMicRms(0);
        setSysRms(0);
        setStatus('Opening devices…');

        const deviceNames = (isMacOS ? [mic] : [mic, sys]).filter(
          (name) => name && name.trim().length > 0,
        );
        if (!mic && !sys) {
          setError('No microphone or speakers found. Check your system sound settings.');
          setStatus('No devices');
          return;
        }

        try {
          // Ask the OS for mic permission before opening streams.
          try {
            await invoke('trigger_microphone_permission');
          } catch {
            /* non-fatal */
          }
          if (!active.current || run !== meterRun.current) return;

          if (isMacOS && sys) {
            setStatus('Testing native system audio… Play a video now.');
            try {
              const detected = await invoke<boolean>('trigger_system_audio_permission_command');
              if (!active.current || run !== meterRun.current) return;
              window.sessionStorage.setItem(MACOS_SYSTEM_AUDIO_VERIFIED_KEY, String(detected));
              setSysHeard(detected);
              setSysRms(detected ? 0.2 : 0);
              if (!detected) {
                setError(
                  'System audio was not detected. Grant Audio Capture permission if prompted, then click Retest audio.',
                );
              }
            } catch (systemError) {
              if (!active.current || run !== meterRun.current) return;
              window.sessionStorage.setItem(MACOS_SYSTEM_AUDIO_VERIFIED_KEY, 'false');
              const message =
                typeof systemError === 'string'
                  ? systemError
                  : systemError instanceof Error
                    ? systemError.message
                    : String(systemError);
              setError(`Could not test native system audio: ${message}`);
            }
          }
          if (!active.current || run !== meterRun.current) return;

          micNameRef.current = mic;
          sysNameRef.current = sys;
          if (deviceNames.length > 0) {
            monitoring.current = true;
            await invoke('start_audio_level_monitoring', { deviceNames });
            if (!active.current || run !== meterRun.current) {
              await invoke('stop_audio_level_monitoring').catch(() => undefined);
              monitoring.current = false;
              return;
            }
          }
          setStatus(
            isMacOS
              ? `Listening${mic ? ` · ${shortName(mic)}` : ''} · native system-audio probe complete`
              : `Listening${mic ? ` · ${shortName(mic)}` : ''}`,
          );
        } catch (e) {
          if (!active.current || run !== meterRun.current) return;
          monitoring.current = false;
          const msg = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
          setError(msg || 'Could not start level meters');
          setStatus('Failed');
        }
      });
      meterTransition.current = transition.catch(() => undefined);
      return transition;
    },
    [isMacOS, stop],
  );

  const queueStop = useCallback(() => {
    meterRun.current += 1;
    const transition = meterTransition.current.then(stop, stop);
    meterTransition.current = transition.catch(() => undefined);
    return transition;
  }, [stop]);

  const loadDevicesAndStart = useCallback(async () => {
    const run = ++deviceLoad.current;
    setError(null);
    setStatus('Finding devices…');
    try {
      const devices = await invoke<AudioDevice[]>('get_audio_devices');
      if (!active.current || run !== deviceLoad.current) return;
      const inputList = devices.filter((d) => String(d.device_type).toLowerCase() === 'input');
      const outputList = devices.filter((d) => String(d.device_type).toLowerCase() === 'output');
      setInputs(inputList);
      setOutputs(outputList);

      const nextMic = inputList[0]?.name || '';
      const nextSys = outputList[0]?.name || '';
      setMicName(nextMic);
      setSysName(nextSys);

      if (!nextMic && !nextSys) {
        setError('No audio devices detected. Plug in a microphone and check system privacy settings.');
        setStatus('No devices');
        return;
      }

      await startMeters(nextMic, nextSys);
    } catch (e) {
      if (!active.current || run !== deviceLoad.current) return;
      const msg = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
      setError(msg || 'Failed to list audio devices');
      setStatus('Failed');
    }
  }, [startMeters]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    active.current = true;

    (async () => {
      try {
        unlisten = await listen<AudioLevelUpdate>('audio-levels', (event) => {
          if (cancelled) return;
          const levels = event.payload?.levels || [];
          for (const level of levels) {
            const rms =
              typeof level.rms_level === 'number'
                ? level.rms_level
                : typeof (level as { peak_level?: number }).peak_level === 'number'
                  ? (level as { peak_level: number }).peak_level * 0.7
                  : 0;
            const kind = (level.device_type || '').toLowerCase();
            const name = level.device_name || '';

            const isMic =
              kind === 'input' ||
              kind.includes('mic') ||
              (!!micNameRef.current && name === micNameRef.current);
            const isSys =
              kind === 'output' ||
              kind.includes('system') ||
              (!!sysNameRef.current && name === sysNameRef.current && !isMic);

            if (isMic) {
              setMicRms(rms);
              if (rms > 0.008) setMicHeard(true);
            } else if (isSys) {
              setSysRms(rms);
              if (rms > 0.008) setSysHeard(true);
            }
          }
        });
      } catch (e) {
        console.error('audio-levels listen failed', e);
      }

      if (!cancelled) {
        await loadDevicesAndStart();
      }
    })();

    return () => {
      cancelled = true;
      active.current = false;
      deviceLoad.current += 1;
      unlisten?.();
      void queueStop();
    };
  }, [loadDevicesAndStart, queueStop]);

  const onMicChange = async (name: string) => {
    setMicName(name);
    setMicHeard(false);
    await startMeters(name, sysName);
  };

  const onSysChange = async (name: string) => {
    setSysName(name);
    setSysHeard(false);
    await startMeters(micName, name);
  };

  const finish = async () => {
    await queueStop();
    try {
      await completeOnboarding();
      await new Promise((r) => setTimeout(r, 100));
      window.location.reload();
    } catch (e) {
      console.error('Failed to complete onboarding:', e);
    }
  };

  const bar = (rms: number, ok: boolean) => (
    <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--af-panel-2)]">
      <div
        className={`h-full rounded-full transition-all duration-75 ${
          ok ? 'bg-emerald-500' : 'bg-[var(--af-accent)]'
        }`}
        style={{ width: `${Math.min(100, Math.round(Math.max(rms, 0) * 500))}%` }}
      />
    </div>
  );

  const selectClass =
    'w-full rounded-lg border border-[var(--af-border)] bg-[var(--af-panel-2)] px-3 py-2 text-sm text-[var(--af-text)] outline-none focus:border-[var(--af-accent)]';

  return (
    <OnboardingContainer
      title="Test your audio"
      description={
        isMacOS
          ? 'Pick your mic, play audio through the current default output, then use Retest audio to verify native Audio Capture.'
          : 'Pick your mic and speakers, then speak / play something. Meters should move.'
      }
      step={5}
      totalSteps={5}
      showNavigation
      onPrevious={async () => {
        await queueStop();
        goPrevious();
      }}
      onNext={finish}
      canGoNext
      canGoPrevious
    >
      <div className="mx-auto max-w-md space-y-5">
        <div className="rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-4 space-y-3">
          <div className="flex items-center justify-between text-sm font-medium text-[var(--af-text)]">
            <span className="inline-flex items-center gap-2">
              <Mic size={16} className="text-blue-400" /> Microphone
            </span>
            <span className={micHeard ? 'text-emerald-400 text-xs' : 'text-[var(--af-text-3)] text-xs'}>
              {micHeard ? 'Heard you ✓' : 'Speak now…'}
            </span>
          </div>
          {inputs.length > 0 ? (
            <select
              className={selectClass}
              value={micName}
              onChange={(e) => void onMicChange(e.target.value)}
            >
              {inputs.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-xs text-[var(--af-text-3)]">No microphones found</p>
          )}
          {bar(micRms, micHeard)}
        </div>

        <div className="rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-4 space-y-3">
          <div className="flex items-center justify-between text-sm font-medium text-[var(--af-text)]">
            <span className="inline-flex items-center gap-2">
              <Volume2 size={16} className="text-purple-400" /> System audio
            </span>
            <span className={sysHeard ? 'text-emerald-400 text-xs' : 'text-[var(--af-text-3)] text-xs'}>
              {sysHeard ? 'Detected ✓' : 'Play a video…'}
            </span>
          </div>
          {isMacOS && outputs.length > 0 ? (
            <p className="text-xs text-[var(--af-text-3)]">
              Current default output (change it in System Settings)
            </p>
          ) : outputs.length > 0 ? (
            <select
              className={selectClass}
              value={sysName}
              onChange={(e) => void onSysChange(e.target.value)}
            >
              {outputs.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-xs text-[var(--af-text-3)]">No playback devices found</p>
          )}
          {bar(sysRms, sysHeard)}
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-[var(--af-text-3)]">{status}</p>
          <button
            type="button"
            onClick={() => void loadDevicesAndStart()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--af-border)] px-2.5 py-1.5 text-xs text-[var(--af-text-2)] hover:bg-[var(--af-panel-2)]"
          >
            <RefreshCw size={12} /> {isMacOS ? 'Retest audio' : 'Refresh devices'}
          </button>
        </div>

        {error && <p className="text-center text-xs text-amber-400 break-words">{error}</p>}
        <p className="text-center text-xs text-[var(--af-text-3)]">
          You can finish even if a meter stays quiet — fix devices later in Settings → Recording.
        </p>

        <button
          type="button"
          onClick={() => void finish()}
          className="w-full h-11 rounded-xl bg-[var(--af-accent)] text-sm font-semibold text-white shadow-sm transition hover:brightness-110 active:scale-[0.99]"
        >
          {micHeard || sysHeard ? 'Continue' : 'Skip for now'}
        </button>
      </div>
    </OnboardingContainer>
  );
}

function shortName(name: string): string {
  return name.length > 36 ? `${name.slice(0, 34)}…` : name;
}

export default AudioTestStep;

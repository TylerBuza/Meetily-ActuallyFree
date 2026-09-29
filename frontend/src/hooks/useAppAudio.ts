'use client';

/**
 * Which computer audio a recording captures: everything the computer plays,
 * or only chosen apps (Windows and macOS). Rust reads the choice when a
 * recording starts, so a change applies from the next recording.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import type { PerAppTarget, RecordableApp, RecordingPreferences } from '@/components/RecordingSettings';

const APP_AUDIO_CHANGED_EVENT = 'meetily-app-audio-changed';

const sameApp = (a: { executable: string }, b: { executable: string }) =>
  a.executable.toLowerCase() === b.executable.toLowerCase();

export interface AppAudioChoice {
  loaded: boolean;
  /** Record only `targets` rather than all computer audio. */
  onlyApps: boolean;
  targets: PerAppTarget[];
  /** Apps running now, those playing sound first. */
  running: RecordableApp[];
  scanning: boolean;
  setOnlyApps: (value: boolean) => void;
  addApp: (app: RecordableApp | PerAppTarget) => void;
  removeApp: (executable: string) => void;
  scan: () => Promise<void>;
  /** Pick an app that is not running from disk. */
  browse: () => Promise<void>;
  /** Running state of a chosen app. */
  statusOf: (target: PerAppTarget) => 'playing' | 'open' | 'closed' | 'unknown';
}

export function useAppAudio(): AppAudioChoice {
  const [loaded, setLoaded] = useState(false);
  const [onlyApps, setOnlyAppsState] = useState(false);
  const [targets, setTargets] = useState<PerAppTarget[]>([]);
  const [running, setRunning] = useState<RecordableApp[]>([]);
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'done' | 'failed'>('idle');
  const saveChain = useRef(Promise.resolve());
  const latest = useRef({ onlyApps, targets });
  latest.current = { onlyApps, targets };
  // Saves announce themselves to other open pickers, not to this one.
  const instance = useRef(Math.random());

  const load = useCallback(async () => {
    try {
      const prefs = await invoke<RecordingPreferences>('get_recording_preferences');
      setOnlyAppsState(!!prefs.per_app_recording_enabled);
      setTargets(prefs.per_app_targets ?? []);
    } catch (error) {
      console.error('Could not read the computer audio choice:', error);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const reload = (event: Event) => {
      if ((event as CustomEvent<number>).detail !== instance.current) void load();
    };
    window.addEventListener(APP_AUDIO_CHANGED_EVENT, reload);
    return () => window.removeEventListener(APP_AUDIO_CHANGED_EVENT, reload);
  }, [load]);

  const save = useCallback((next: { onlyApps: boolean; targets: PerAppTarget[] }) => {
    setOnlyAppsState(next.onlyApps);
    setTargets(next.targets);
    // Read-modify-write, one save at a time, so other settings are never lost.
    saveChain.current = saveChain.current
      .then(async () => {
        const prefs = await invoke<RecordingPreferences>('get_recording_preferences');
        await invoke('set_recording_preferences', {
          preferences: {
            ...prefs,
            per_app_recording_enabled: next.onlyApps,
            per_app_targets: next.targets,
            // The single-app fields are the old format; Rust re-adds a target
            // from them when the list is empty, so they follow the list.
            per_app_target_app: next.targets[0]?.executable ?? null,
            per_app_target_name: next.targets[0]?.name ?? null,
          },
        });
        window.dispatchEvent(new CustomEvent(APP_AUDIO_CHANGED_EVENT, { detail: instance.current }));
      })
      .catch((error) => {
        toast.error('Could not save which audio to record', { description: error instanceof Error ? error.message : String(error) });
        void load();
      });
  }, [load]);

  const scan = useCallback(async () => {
    setScanState('scanning');
    try {
      setRunning(await invoke<RecordableApp[]>('get_recordable_apps'));
      setScanState('done');
    } catch (error) {
      console.error('Could not list running apps:', error);
      setScanState('failed');
    }
  }, []);

  // Show which chosen apps are open or playing sound.
  useEffect(() => {
    if (onlyApps && scanState === 'idle') void scan();
  }, [onlyApps, scanState, scan]);

  const addApp = useCallback((app: RecordableApp | PerAppTarget) => {
    const current = latest.current;
    if (current.targets.some((target) => sameApp(target, app))) return;
    save({
      onlyApps: current.onlyApps,
      targets: [...current.targets, { id: app.id || app.executable, name: app.name, executable: app.executable, icon: app.icon ?? null }],
    });
  }, [save]);

  const removeApp = useCallback((executable: string) => {
    const current = latest.current;
    save({ onlyApps: current.onlyApps, targets: current.targets.filter((target) => !sameApp(target, { executable })) });
  }, [save]);

  const setOnlyApps = useCallback((value: boolean) => {
    save({ onlyApps: value, targets: latest.current.targets });
  }, [save]);

  const browse = useCallback(async () => {
    try {
      const app = await invoke<RecordableApp | null>('select_custom_app_executable');
      if (app) addApp(app);
    } catch (error) {
      toast.error('Could not add that app', { description: error instanceof Error ? error.message : String(error) });
    }
  }, [addApp]);

  const statusOf = useCallback(
    (target: PerAppTarget) => {
      if (scanState !== 'done') return 'unknown' as const;
      const match = running.find((app) => sameApp(app, target));
      return match ? (match.has_audio ? ('playing' as const) : ('open' as const)) : ('closed' as const);
    },
    [running, scanState],
  );

  return {
    loaded,
    onlyApps,
    targets,
    running,
    scanning: scanState === 'scanning',
    setOnlyApps,
    addApp,
    removeApp,
    scan,
    browse,
    statusOf,
  };
}

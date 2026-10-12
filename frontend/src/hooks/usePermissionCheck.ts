import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usePlatform } from './usePlatform';

// macOS Audio Capture authorization as TCC records it (native
// `get_system_audio_permission_status`). 'unknown' means it could not be read.
export type SystemAudioPermission = 'granted' | 'denied' | 'not_determined' | 'unknown';

export interface PermissionStatus {
  hasMicrophone: boolean;
  hasSystemAudio: boolean;
  systemAudioPermission: SystemAudioPermission;
  isChecking: boolean;
  error: string | null;
}

// Audible samples from the tap prove Audio Capture is granted (a denied tap
// returns zeros). Keep the proof session-scoped so a permission revoked between
// app launches is not trusted.
export const MACOS_SYSTEM_AUDIO_VERIFIED_KEY = 'macos_system_audio_verified';

type Availability = Omit<PermissionStatus, 'isChecking' | 'error'>;

// The last result in this window, so a page that mounts again (the recorder)
// shows the record card at once while the device check re-runs behind it.
let lastKnown: Availability | null = null;

export function usePermissionCheck() {
  const platform = usePlatform();
  const requestInFlight = useRef<Promise<void> | null>(null);
  const [status, setStatus] = useState<PermissionStatus>(() => ({
    hasMicrophone: lastKnown?.hasMicrophone ?? false,
    hasSystemAudio: lastKnown?.hasSystemAudio ?? false,
    systemAudioPermission: lastKnown?.systemAudioPermission ?? 'unknown',
    isChecking: lastKnown === null,
    error: null,
  }));

  const checkPermissions = async (): Promise<Availability> => {
    // A known result stays on screen during a background re-check.
    if (lastKnown === null) setStatus(prev => ({ ...prev, isChecking: true, error: null }));

    try {
      // Get audio devices to check for microphone and system audio availability
      const devices = await invoke<Array<{ name: string; device_type: 'Input' | 'Output' }>>('get_audio_devices');

      // Check for microphone devices (Input)
      const inputDevices = devices.filter(d => d.device_type === 'Input');
      const hasMicrophone = inputDevices.length > 0;

      // Output availability is separate from macOS Audio Capture authorization.
      // A granted TCC record needs no audible proof on each launch (the native
      // side re-asks a fresh process past TCC's per-process cache). When the
      // status is unreadable or still lags, this session's audible probe
      // (requestPermissions) also counts.
      const outputDevices = devices.filter(d => d.device_type === 'Output');
      const systemAudioPermission: SystemAudioPermission =
        platform === 'macos'
          ? await invoke<SystemAudioPermission>('get_system_audio_permission_status').catch(
              () => 'unknown' as const,
            )
          : 'granted';
      const systemAudioAllowed =
        systemAudioPermission === 'granted' ||
        window.sessionStorage.getItem(MACOS_SYSTEM_AUDIO_VERIFIED_KEY) === 'true';
      const hasSystemAudio = outputDevices.length > 0 && systemAudioAllowed;

      console.log('Permission check:', {
        hasMicrophone,
        hasSystemAudio,
        systemAudioPermission,
        inputDevices: inputDevices.length,
        outputDevices: outputDevices.length
      });

      lastKnown = { hasMicrophone, hasSystemAudio, systemAudioPermission };
      setStatus({ ...lastKnown, isChecking: false, error: null });

      return lastKnown;
    } catch (error) {
      console.error('Failed to check audio permissions:', error);
      const unavailable: Availability = {
        hasMicrophone: false,
        hasSystemAudio: false,
        systemAudioPermission: 'unknown',
      };
      setStatus({
        ...unavailable,
        isChecking: false,
        error: error instanceof Error ? error.message : 'Failed to check permissions',
      });
      return unavailable;
    }
  };

  const requestPermissions = () => {
    // The native probe runs for up to five seconds; deduplicate Recheck clicks
    // so an older result cannot overwrite a newer permission attempt.
    if (requestInFlight.current) return requestInFlight.current;

    const request = (async () => {
      setStatus(prev => ({ ...prev, isChecking: true, error: null }));
      try {
        await invoke('trigger_microphone_permission');
        if (platform === 'macos') {
          // Starting the tap also shows the macOS prompt when not yet asked.
          // Audible samples prove the grant before TCC's cached status catches up.
          const systemAudioDetected = await invoke<boolean>('trigger_system_audio_permission_command');
          window.sessionStorage.setItem(
            MACOS_SYSTEM_AUDIO_VERIFIED_KEY,
            String(systemAudioDetected),
          );
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        await checkPermissions();
      } catch (error) {
        console.error('Failed to request permissions:', error);
        if (platform === 'macos') {
          window.sessionStorage.setItem(MACOS_SYSTEM_AUDIO_VERIFIED_KEY, 'false');
        }
        setStatus(prev => ({
          ...prev,
          hasSystemAudio: false,
          error: error instanceof Error ? error.message : 'Failed to request permissions',
        }));
      } finally {
        requestInFlight.current = null;
        setStatus(prev => ({ ...prev, isChecking: false }));
      }
    })();

    requestInFlight.current = request;
    return request;
  };

  // Check permissions on mount
  useEffect(() => {
    checkPermissions();
  }, []);

  return {
    ...status,
    checkPermissions,
    requestPermissions,
  };
}

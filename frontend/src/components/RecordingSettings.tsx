import React, { useState, useEffect } from 'react';
import { Switch } from '@/components/ui/switch';
import { AlertTriangle, FolderCog, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { invoke } from '@tauri-apps/api/core';
import Analytics from '@/lib/analytics';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';

/** A running app that can be recorded on its own (Windows and macOS). */
export interface RecordableApp {
  id: string;
  name: string;
  executable: string;
  pid: number | null;
  /** Playing sound right now (Windows). */
  has_audio: boolean;
  icon: string | null;
}

export interface PerAppTarget {
  id: string;
  name: string;
  executable: string;
  icon?: string | null;
}

export interface RecordingPreferences {
  save_folder: string;
  auto_save: boolean;
  file_format: string;
  preferred_mic_device: string | null;
  preferred_system_device: string | null;
  /** Extra mic loudness after normalize (0.5–3.0). */
  mic_gain?: number;
  /** System-audio gain before metering, transcription, and recording (0.5–3.0). */
  system_gain?: number;
  /** Faster real-time streaming mode: cuts audio segments frequently (~3.5s) with fast pause detection (350ms). */
  real_time_transcription?: boolean;
  /** Record only `per_app_targets` instead of all computer audio. */
  per_app_recording_enabled?: boolean;
  /** Older single-app format; kept equal to the first target. */
  per_app_target_app?: string | null;
  per_app_target_name?: string | null;
  per_app_targets?: PerAppTarget[];
}

interface RecordingSettingsProps {
  onSave?: (preferences: RecordingPreferences) => void;
}

export function RecordingSettings({ onSave }: RecordingSettingsProps) {
  const { updateRecordingsLocation, setSelectedDevices } = useConfig();
  const [preferences, setPreferences] = useState<RecordingPreferences>({
    save_folder: '',
    auto_save: true,
    file_format: 'mp4',
    preferred_mic_device: null,
    preferred_system_device: null,
    mic_gain: 1.0,
    system_gain: 1.0,
    real_time_transcription: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isChoosingFolder, setIsChoosingFolder] = useState(false);
  const [showRecordingNotification, setShowRecordingNotification] = useState(true);

  // Load recording preferences on component mount
  useEffect(() => {
    const loadPreferences = async () => {
      try {
        const prefs = await invoke<RecordingPreferences>('get_recording_preferences');
        setPreferences(prefs);
        setSelectedDevices({
          micDevice: prefs.preferred_mic_device ?? null,
          systemDevice: prefs.preferred_system_device ?? null,
        });
      } catch (error) {
        console.error('Failed to load recording preferences:', error);
        // If loading fails, get default folder path
        try {
          const defaultPath = await invoke<string>('get_default_recordings_folder_path');
          setPreferences(prev => ({ ...prev, save_folder: defaultPath }));
        } catch (defaultError) {
          console.error('Failed to get default folder path:', defaultError);
        }
      } finally {
        setLoading(false);
      }
    };

    loadPreferences();
  }, []);

  // Load recording notification preference
  useEffect(() => {
    const loadNotificationPref = async () => {
      try {
        const { Store } = await import('@tauri-apps/plugin-store');
        const store = await Store.load('preferences.json');
        const show = await store.get<boolean>('show_recording_notification') ?? true;
        setShowRecordingNotification(show);
      } catch (error) {
        console.error('Failed to load notification preference:', error);
      }
    };
    loadNotificationPref();
  }, []);

  const handleAutoSaveToggle = async (enabled: boolean) => {
    setPreferences((current) => ({ ...current, auto_save: enabled }));
    await savePreferences({ auto_save: enabled });

    // Track auto-save setting change
    await Analytics.track('auto_save_recording_toggled', {
      enabled: enabled.toString()
    });
  };

  const handleOpenFolder = async () => {
    try {
      await invoke('open_recordings_folder');
    } catch (error) {
      console.error('Failed to open recordings folder:', error);
      toast.error('Could not open recordings folder', {
        description: String(error),
      });
    }
  };

  const handleChangeFolder = async () => {
    if (isChoosingFolder) return;

    setIsChoosingFolder(true);
    try {
      const selectedFolder = await invoke<string | null>('select_recording_folder');
      if (!selectedFolder) return;

      const current = await invoke<RecordingPreferences>('get_recording_preferences');
      const newPreferences = { ...current, save_folder: selectedFolder };
      await invoke('set_recording_preferences', { preferences: newPreferences });
      setPreferences(newPreferences);
      updateRecordingsLocation(selectedFolder);
      onSave?.(newPreferences);
      toast.success('Recordings folder updated');
      Analytics.track('recordings_folder_changed', { source: 'recording_settings' }).catch(console.error);
    } catch (error) {
      console.error('Failed to change recordings folder:', error);
      toast.error('Could not update recordings folder', {
        description: String(error),
      });
    } finally {
      setIsChoosingFolder(false);
    }
  };

  const handleNotificationToggle = async (enabled: boolean) => {
    try {
      setShowRecordingNotification(enabled);
      const { Store } = await import('@tauri-apps/plugin-store');
      const store = await Store.load('preferences.json');
      await store.set('show_recording_notification', enabled);
      await store.save();
      toast.success('Preference saved');
      await Analytics.track('recording_notification_preference_changed', {
        enabled: enabled.toString()
      });
    } catch (error) {
      console.error('Failed to save notification preference:', error);
      toast.error('Failed to save preference');
    }
  };

  // Saved over the latest stored preferences, so choices made in the record
  // card (devices, sensitivity, which apps to record) are never overwritten.
  const savePreferences = async (patch: Partial<RecordingPreferences>) => {
    setSaving(true);
    try {
      const current = await invoke<RecordingPreferences>('get_recording_preferences');
      const prefs = { ...current, ...patch };
      await invoke('set_recording_preferences', { preferences: prefs });
      setPreferences(prefs);
      onSave?.(prefs);

      toast.success('Recording settings saved');
    } catch (error) {
      console.error('Failed to save recording preferences:', error);
      toast.error('Could not save recording settings', {
        description: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="af-skeleton h-20 rounded-2xl" />
        <div className="af-skeleton h-28 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-5">
      <div className="flex min-w-0 items-center justify-between gap-4 rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-af-text">Save audio</h3>
          <p className="mt-0.5 text-[13px] leading-relaxed text-af-text-3">
            Keep each meeting's audio so you can play it back, fix who said what, and transcribe it again later.
          </p>
        </div>
        <Switch checked={preferences.auto_save} onCheckedChange={handleAutoSaveToggle} disabled={saving} className="shrink-0" />
      </div>

      {preferences.auto_save ? (
        <div className="min-w-0 rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
          <h3 className="text-[15px] font-semibold text-af-text">Where recordings are saved</h3>
          <p className="mt-2 break-all rounded-lg border border-af-border bg-af-panel px-3 py-2 font-mono text-xs text-af-text-2">
            {preferences.save_folder || 'Default folder'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={handleChangeFolder} disabled={isChoosingFolder || saving} loading={isChoosingFolder}>
              <FolderCog />
              Change folder
            </Button>
            <Button variant="ghost" size="sm" onClick={handleOpenFolder} disabled={isChoosingFolder}>
              <FolderOpen />
              Open folder
            </Button>
          </div>
          <p className="mt-3 text-xs text-af-text-4">
            Saved as {preferences.file_format.toUpperCase()} files named recording_YYYYMMDD_HHMMSS.{preferences.file_format}.
          </p>
        </div>
      ) : (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Audio isn't being saved</AlertTitle>
          <AlertDescription className="text-af-text-2">
            Transcripts are kept, but you won't be able to play meetings back or transcribe them again. Turn on Save audio to keep it.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

"use client"

import { useEffect, useState, useRef } from "react"
import { Switch } from "./ui/switch"
import { FolderCog, FolderOpen } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import Analytics from "@/lib/analytics"
import { useConfig, NotificationSettings } from "@/contexts/ConfigContext"
import { ThemePicker } from "@/components/settings/ThemePicker"

import { useTranscriptLeftAligned, useTranscriptHideSpeakerDots } from "@/lib/transcript-layout"

export function PreferenceSettings() {
  const [leftAligned, setLeftAligned] = useTranscriptLeftAligned();
  const [hideSpeakerDots, setHideSpeakerDots] = useTranscriptHideSpeakerDots();
  const {
    notificationSettings,
    storageLocations,
    isLoadingPreferences,
    loadPreferences,
    updateNotificationSettings,
    updateRecordingsLocation,
  } = useConfig();
  const [isChoosingRecordingsFolder, setIsChoosingRecordingsFolder] = useState(false);

  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [previousNotificationsEnabled, setPreviousNotificationsEnabled] = useState<boolean | null>(null);
  const hasTrackedViewRef = useRef(false);

  // "Your name" — used to label the user's mic transcripts as "You (Name)".
  const [userName, setUserName] = useState<string>('');
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setUserName(localStorage.getItem('meetily_user_name') || '');
    }
  }, []);
  const saveUserName = (v: string) => {
    setUserName(v);
    if (typeof window !== 'undefined') {
      localStorage.setItem('meetily_user_name', v);
    }
  };

  // Lazy load preferences on mount (only loads if not already cached)
  useEffect(() => {
    loadPreferences();
    // Reset tracking ref on mount (every tab visit)
    hasTrackedViewRef.current = false;
  }, [loadPreferences]);

  // Track preferences viewed analytics on every tab visit (once per mount)
  useEffect(() => {
    if (hasTrackedViewRef.current) return;

    const trackPreferencesViewed = async () => {
      // Wait for notification settings to be available (either from cache or after loading)
      if (notificationSettings) {
        await Analytics.track('preferences_viewed', {
          notifications_enabled: notificationSettings.notification_preferences.show_recording_started ? 'true' : 'false'
        });
        hasTrackedViewRef.current = true;
      } else if (!isLoadingPreferences) {
        // If not loading and no settings available, track with default value
        await Analytics.track('preferences_viewed', {
          notifications_enabled: 'false'
        });
        hasTrackedViewRef.current = true;
      }
    };

    trackPreferencesViewed();
  }, [notificationSettings, isLoadingPreferences]);

  // Update notificationsEnabled when notificationSettings are loaded from global state
  useEffect(() => {
    if (notificationSettings) {
      // Notification enabled means both started and stopped notifications are enabled
      const enabled =
        notificationSettings.notification_preferences.show_recording_started &&
        notificationSettings.notification_preferences.show_recording_stopped;
      setNotificationsEnabled(enabled);
      if (isInitialLoad) {
        setPreviousNotificationsEnabled(enabled);
        setIsInitialLoad(false);
      }
    } else if (!isLoadingPreferences) {
      // If not loading and no settings, use default
      setNotificationsEnabled(true);
      if (isInitialLoad) {
        setPreviousNotificationsEnabled(true);
        setIsInitialLoad(false);
      }
    }
  }, [notificationSettings, isLoadingPreferences, isInitialLoad])

  useEffect(() => {
    // Skip update on initial load or if value hasn't actually changed
    if (isInitialLoad || notificationsEnabled === null || notificationsEnabled === previousNotificationsEnabled) return;
    if (!notificationSettings) return;

    const handleUpdateNotificationSettings = async () => {
      console.log("Updating notification settings to:", notificationsEnabled);

      try {
        // Update the notification preferences
        const updatedSettings: NotificationSettings = {
          ...notificationSettings,
          notification_preferences: {
            ...notificationSettings.notification_preferences,
            show_recording_started: notificationsEnabled,
            show_recording_stopped: notificationsEnabled,
          }
        };

        console.log("Calling updateNotificationSettings with:", updatedSettings);
        await updateNotificationSettings(updatedSettings);
        setPreviousNotificationsEnabled(notificationsEnabled);
        console.log("Successfully updated notification settings to:", notificationsEnabled);

        // Track notification preference change - only fires when user manually toggles
        await Analytics.track('notification_settings_changed', {
          notifications_enabled: notificationsEnabled.toString()
        });
      } catch (error) {
        console.error('Failed to update notification settings:', error);
      }
    };

    handleUpdateNotificationSettings();
  }, [notificationsEnabled, notificationSettings, isInitialLoad, previousNotificationsEnabled, updateNotificationSettings])

  const handleOpenFolder = async (folderType: 'database' | 'models' | 'recordings') => {
    try {
      switch (folderType) {
        case 'database':
          await invoke('open_database_folder');
          break;
        case 'models':
          await invoke('open_models_folder');
          break;
        case 'recordings':
          await invoke('open_recordings_folder');
          break;
      }

      // Track storage folder access
      await Analytics.track('storage_folder_opened', {
        folder_type: folderType
      });
    } catch (error) {
      console.error(`Failed to open ${folderType} folder:`, error);
    }
  };

  const handleChangeRecordingsFolder = async () => {
    if (isChoosingRecordingsFolder) return;

    setIsChoosingRecordingsFolder(true);
    try {
      const selectedFolder = await invoke<string | null>('select_recording_folder');
      if (!selectedFolder) return;

      const preferences = await invoke<Record<string, unknown> & { save_folder: string }>(
        'get_recording_preferences',
      );
      await invoke('set_recording_preferences', {
        preferences: { ...preferences, save_folder: selectedFolder },
      });
      updateRecordingsLocation(selectedFolder);
      toast.success('Recordings folder updated');
      Analytics.track('recordings_folder_changed', { source: 'preferences' }).catch(console.error);
    } catch (error) {
      console.error('Failed to change recordings folder:', error);
      toast.error('Could not update recordings folder', {
        description: String(error),
      });
    } finally {
      setIsChoosingRecordingsFolder(false);
    }
  };

  // Show loading only if we're actually loading and don't have cached data
  if (isLoadingPreferences && !notificationSettings && !storageLocations) {
    return <div className="max-w-2xl mx-auto p-6">Loading Preferences...</div>
  }

  // Show loading if notificationsEnabled hasn't been determined yet
  if (notificationsEnabled === null && !isLoadingPreferences) {
    return <div className="max-w-2xl mx-auto p-6">Loading Preferences...</div>
  }

  // Ensure we have a boolean value for the Switch component
  const notificationsEnabledValue = notificationsEnabled ?? false;

  return (
    <div className="space-y-6">
      {/* Appearance / Theme Section */}
      <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
        <h3 className="text-[15px] font-semibold text-af-text mb-1">Theme</h3>
        <p className="text-sm text-af-text-2 mb-4">Applies to every window, including the floating recording bar.</p>
        <ThemePicker />
        <div className="mt-5 flex items-center justify-between gap-4">
          <div><p className="text-sm font-medium text-af-text">Align speaker names to the left</p><p className="text-xs text-af-text-3">Show names in a left column with transcript text indented beside them.</p></div>
          <Switch checked={leftAligned} onCheckedChange={setLeftAligned} aria-label="Align speaker names to the left" />
        </div>
        <div className="mt-3 flex items-center justify-between gap-4 pl-4">
          <div><p className="text-sm font-medium text-af-text">Hide speaker dots</p><p className="text-xs text-af-text-3">Remove the bullet before speaker names in any transcript layout.</p></div>
          <Switch checked={hideSpeakerDots} onCheckedChange={setHideSpeakerDots} aria-label="Hide speaker dots" />
        </div>
      </div>

      {/* Your Name Section */}
      <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
        <h3 className="text-[15px] font-semibold text-af-text mb-2">Your Name</h3>
        <p className="text-sm text-af-text-2 mb-3">
          Labels your microphone in transcripts as <strong>You ({userName || 'Name'})</strong>. Your audio is
          always tagged as you; other participants are labelled separately (&quot;Guest&quot;, and Speaker 1/2/3 once
          voice diarization is enabled).
        </p>
        <input
          type="text"
          value={userName}
          onChange={(e) => saveUserName(e.target.value)}
          placeholder="e.g. Tyler"
          className="w-full max-w-sm rounded-lg border border-af-border px-3 py-2 text-sm focus:border-af-accent/40 focus:outline-none"
        />
      </div>

      {/* Notifications Section */}
      <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[15px] font-semibold text-af-text mb-2">Notifications</h3>
            <p className="text-sm text-af-text-2">Enable or disable notifications of start and end of meeting</p>
          </div>
          <Switch checked={notificationsEnabledValue} onCheckedChange={setNotificationsEnabled} />
        </div>
      </div>

      {/* Data Storage Locations Section */}
      <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
        <h3 className="text-[15px] font-semibold text-af-text mb-4">Data Storage Locations</h3>
        <p className="text-sm text-af-text-2 mb-6">
          View and access where Meetily stores your data
        </p>

        <div className="space-y-4">
          {/* Database Location */}
          {/* <div className="p-4 border rounded-lg bg-af-panel-2">
            <div className="font-medium mb-2">Database</div>
            <div className="text-sm text-af-text-2 mb-3 break-all font-mono text-xs">
              {storageLocations?.database || 'Loading...'}
            </div>
            <button
              onClick={() => handleOpenFolder('database')}
              className="flex items-center gap-2 px-3 py-2 text-sm border border-af-border-strong rounded-md hover:bg-af-panel-2 transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              Open Folder
            </button>
          </div> */}

          {/* Models Location */}
          {/* <div className="p-4 border rounded-lg bg-af-panel-2">
            <div className="font-medium mb-2">Whisper Models</div>
            <div className="text-sm text-af-text-2 mb-3 break-all font-mono text-xs">
              {storageLocations?.models || 'Loading...'}
            </div>
            <button
              onClick={() => handleOpenFolder('models')}
              className="flex items-center gap-2 px-3 py-2 text-sm border border-af-border-strong rounded-md hover:bg-af-panel-2 transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              Open Folder
            </button>
          </div> */}

          {/* Recordings Location */}
          <div className="p-4 border rounded-lg bg-af-panel-2">
            <div className="font-medium mb-2">Meeting Recordings</div>
            <div className="text-sm text-af-text-2 mb-3 break-all font-mono text-xs">
              {storageLocations?.recordings || 'Loading...'}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleChangeRecordingsFolder}
                disabled={isChoosingRecordingsFolder}
                className="flex items-center gap-2 px-3 py-2 text-sm border border-af-border-strong rounded-md hover:bg-af-panel-2 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              >
                <FolderCog className="w-4 h-4" />
                {isChoosingRecordingsFolder ? 'Choosing...' : 'Change Folder'}
              </button>
              <button
                onClick={() => handleOpenFolder('recordings')}
                className="flex items-center gap-2 px-3 py-2 text-sm border border-af-border-strong rounded-md hover:bg-af-panel-2 transition-colors"
              >
                <FolderOpen className="w-4 h-4" />
                Open Folder
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 p-3 bg-af-accent/10 rounded-md">
          <p className="text-xs text-af-accent">
            <strong>Portable core data:</strong> Models, database, and templates use Meetily&apos;s app data
            folder. Recordings stay in the user-facing folder shown above so they remain easy to find,
            play, and back up.
          </p>
        </div>
      </div>
    </div>
  )
}

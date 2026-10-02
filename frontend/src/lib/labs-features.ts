/**
 * Turning Labs features on and off. Three of them keep their real state in
 * Rust (Whisper silence guard, voice profiles, Parakeet on the GPU, near-live
 * captions, and mic playback suppression); the
 * browser copy in lib/labs mirrors them so any page can read them at once.
 */
import { invoke } from '@tauri-apps/api/core';
import { loadLabsPreferences, saveLabsPreferences, type LabsPreferences } from '@/lib/labs';

export type LabsFeature = keyof LabsPreferences;

/** Refreshes the mirrored switches from Rust. */
export async function syncLabsFromBackend(): Promise<LabsPreferences> {
  const [whisper, voices, gpu, nearLive, micPlayback, autoSave, wordTimestamps] = await Promise.allSettled([
    invoke<boolean>('get_whisper_strict_silence'),
    invoke<boolean>('get_voice_profiles_enabled'),
    invoke<boolean>('get_parakeet_gpu_enabled'),
    invoke<boolean>('get_near_live_captions_enabled'),
    invoke<boolean>('get_mic_playback_suppression_enabled'),
    invoke<boolean>('get_voice_profiles_auto_save'),
    invoke<boolean>('get_word_timestamps_enabled'),
  ]);
  const current = loadLabsPreferences();
  const next: LabsPreferences = {
    ...current,
    autoSaveVoiceProfiles: autoSave.status === 'fulfilled' ? autoSave.value : current.autoSaveVoiceProfiles,
    whisperSilenceGuard: whisper.status === 'fulfilled' ? whisper.value : current.whisperSilenceGuard,
    voiceProfiles: voices.status === 'fulfilled' ? voices.value : current.voiceProfiles,
    parakeetGpu: gpu.status === 'fulfilled' ? gpu.value : current.parakeetGpu,
    nearLiveCaptions: nearLive.status === 'fulfilled' ? nearLive.value : current.nearLiveCaptions,
    micPlaybackSuppression: micPlayback.status === 'fulfilled' ? micPlayback.value : current.micPlaybackSuppression,
    wordTimestamps: wordTimestamps.status === 'fulfilled' ? wordTimestamps.value : current.wordTimestamps,
  };
  if (JSON.stringify(next) !== JSON.stringify(current)) saveLabsPreferences(next);
  return next;
}

/**
 * Saves one switch, applying its backend side first. Rejects with the reason
 * when the backend refuses, and then nothing is saved.
 */
export async function setLabsFeature(feature: LabsFeature, value: boolean): Promise<LabsPreferences> {
  switch (feature) {
    case 'meetingAutomation':
      // Automation acts on meeting detection's events, so it needs detection on.
      if (value) {
        const detection = await invoke<Record<string, unknown>>('get_meeting_detection_settings');
        if (!detection.enabled) {
          await invoke('set_meeting_detection_settings', { settings: { ...detection, enabled: true } });
        }
      }
      break;
    case 'whisperSilenceGuard':
      await invoke('set_whisper_strict_silence', { enabled: value });
      break;
    case 'autoSaveVoiceProfiles':
      await invoke('set_voice_profiles_auto_save', { value });
      break;
    case 'voiceProfiles':
      await invoke('set_voice_profiles_enabled', { value });
      break;
    case 'nearLiveCaptions':
      await invoke('set_near_live_captions_enabled', { value });
      break;
    case 'micPlaybackSuppression':
      await invoke('set_mic_playback_suppression_enabled', { value });
      break;
    case 'parakeetGpu':
      // Reloads the current Parakeet model; Rust restores CPU if that fails.
      await invoke('set_parakeet_gpu_enabled', { value });
      break;
    case 'wordTimestamps':
      await invoke('set_word_timestamps_enabled', { value });
      break;
    default:
      break;
  }
  const next = { ...loadLabsPreferences(), [feature]: value };
  saveLabsPreferences(next);
  return next;
}

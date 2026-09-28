'use client';

import { useEffect, useState } from 'react';
import { Switch } from './ui/switch';
import { LabsPreferences, defaultLabsPreferences, loadLabsPreferences, saveLabsPreferences } from '@/lib/labs';
import { invoke } from '@tauri-apps/api/core';

const options: { key: keyof LabsPreferences; title: string; detail: string }[] = [
  { key: 'meetingAutomation', title: 'Meeting automation', detail: 'Automatically start and stop a recording for an actively detected call. Enabling this also turns on Meeting Detection; process-only detections still prompt.' },
  { key: 'transcriptScrubbing', title: 'Audio transcript scrubbing', detail: 'Seek to a transcript turn while reviewing a recorded meeting. Word-level timing is not available.' },
  { key: 'voiceProfiles', title: 'Voice profiles', detail: 'Enroll a named speaker from clear saved system audio. WeSpeaker compares future Pyannote or Nemotron live turns and post-call diarization; short or uncertain turns stay unnamed.' },
  { key: 'whisperSilenceGuard', title: 'Whisper silence guard', detail: 'Use stricter no-speech rejection for Whisper transcription. Quiet speech may be omitted.' },
  { key: 'parakeetGpu', title: 'Parakeet GPU acceleration', detail: 'Run the Parakeet encoder through DirectML on Windows. Switching reloads the selected model; CPU remains the default.' },
  { key: 'nearLiveCaptions', title: 'Near-live captions', detail: 'Experimental Parakeet previews update during speech. This may briefly show extra speakers or inaccurate words; final transcription and diarization replace the previews, and post-call transcription and diarization can improve the saved result. Some errors may remain, especially with overlapping remote voices. Takes effect next recording.' },
  { key: 'cleanTranscript', title: 'Clean transcript view', detail: 'Hide simple English hesitations and immediate repeated words in the transcript display and new summaries. Saved text stays verbatim.' },
];

export function LabsSettings() {
  const [preferences, setPreferences] = useState<LabsPreferences>(defaultLabsPreferences);
  const [profiles, setProfiles] = useState<{ person_id: string; name: string; samples: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPreferences(loadLabsPreferences());
    invoke<boolean>('get_whisper_strict_silence').then((enabled) => {
      setPreferences((current) => {
        const next = { ...current, whisperSilenceGuard: enabled };
        saveLabsPreferences(next);
        return next;
      });
    }).catch(console.error);
    invoke<boolean>('get_voice_profiles_enabled').then((enabled) => {
      setPreferences((current) => {
        const next = { ...current, voiceProfiles: enabled };
        saveLabsPreferences(next);
        return next;
      });
    }).catch(console.error);
    invoke<boolean>('get_parakeet_gpu_enabled').then((enabled) => {
      setPreferences((current) => {
        const next = { ...current, parakeetGpu: enabled };
        saveLabsPreferences(next);
        return next;
      });
    }).catch(console.error);
    invoke<boolean>('get_near_live_captions_enabled').then((enabled) => {
      setPreferences((current) => {
        const next = { ...current, nearLiveCaptions: enabled };
        saveLabsPreferences(next);
        return next;
      });
    }).catch(console.error);
    invoke<{ person_id: string; name: string; samples: number }[]>('list_voice_profiles').then(setProfiles).catch(console.error);
  }, []);
  const update = async (key: keyof LabsPreferences, value: boolean) => {
    setError(null);
    if (key === 'meetingAutomation' && value) {
      try {
        const detection = await invoke<Record<string, unknown>>('get_meeting_detection_settings');
        if (!detection.enabled) {
          await invoke('set_meeting_detection_settings', { settings: { ...detection, enabled: true } });
        }
      } catch (error) {
        console.error('Could not enable meeting detection:', error);
        return;
      }
    }
    if (key === 'whisperSilenceGuard') {
      try {
        await invoke('set_whisper_strict_silence', { enabled: value });
      } catch (error) {
        console.error('Could not save Whisper silence guard:', error);
        return;
      }
    }
    if (key === 'voiceProfiles') {
      try {
        await invoke('set_voice_profiles_enabled', { value });
      } catch (error) {
        console.error('Could not save voice profile setting:', error);
        return;
      }
    }
    if (key === 'parakeetGpu') {
      try {
        await invoke('set_parakeet_gpu_enabled', { value });
      } catch (failure) {
        setError(`Parakeet GPU setting failed: ${String(failure)}`);
        return;
      }
    }
    if (key === 'nearLiveCaptions') {
      try {
        await invoke('set_near_live_captions_enabled', { value });
      } catch (failure) {
        setError(`Near-live captions setting failed: ${String(failure)}`);
        return;
      }
    }
    const next = { ...preferences, [key]: value };
    setPreferences(next);
    saveLabsPreferences(next);
  };
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Labs</h2>
        <p className="text-sm text-[var(--af-text-2)]">Experimental controls for meeting and transcript workflows.</p>
      </div>
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      {options.map((option) => (
        <div key={option.key} className="flex items-start justify-between gap-5 rounded-lg border border-[var(--af-border)] bg-[var(--af-panel)] p-4">
          <div>
            <h3 className="font-medium">{option.title}</h3>
            <p className="mt-1 text-sm text-[var(--af-text-2)]">{option.detail}</p>
          </div>
          <Switch aria-label={option.title} checked={preferences[option.key]} onCheckedChange={(value) => void update(option.key, value)} />
        </div>
      ))}
      {profiles.length > 0 && <div className="rounded-lg border border-[var(--af-border)] p-4">
        <h3 className="font-medium">Enrolled voices</h3>
        {profiles.map((profile) => <div key={profile.person_id} className="mt-2 flex items-center justify-between gap-3 text-sm">
          <span>{profile.name} · {profile.samples} turns</span>
          <button type="button" className="text-red-500 hover:underline" onClick={() => void invoke('delete_voice_profile', { personId: profile.person_id }).then(() => setProfiles((current) => current.filter((item) => item.person_id !== profile.person_id)))}>Delete</button>
        </div>)}
      </div>}
    </section>
  );
}

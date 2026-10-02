/**
 * A simulated recording for the browser preview: starting one emits a
 * transcript line every few seconds, pause and mute behave like the real
 * backend, and stopping runs the normal save flow into the sample library.
 */
import { emit } from '@tauri-apps/api/event';
import { loadLabsPreferences } from '@/lib/labs';
import type { PreviewTranscript } from './fixtures';

const SCRIPT: Array<[string, string]> = [
  ['You', 'Morning everyone, let’s keep this one short.'],
  ['Speaker 2', 'Sure. Yesterday I finished the export dialog and started on moving meetings between groups.'],
  ['Speaker 3', 'I’m still on the onboarding copy. Design review is Thursday at noon.'],
  ['You', 'Great. Any blockers?'],
  ['Speaker 2', 'The audio route warning fires twice on some headsets. I need a Windows machine with a USB headset to check it.'],
  ['You', 'I have one. I’ll send it over after this call.'],
  ['Speaker 3', 'Can we decide on the default theme before the release notes go out?'],
  ['You', 'Let’s keep Midnight as the default and mention Vanilla and Charcoal in the notes.'],
  ['Speaker 2', 'Works for me. I’ll write that section of the release notes by Friday.'],
  ['Speaker 3', 'Then I think that covers it.'],
];

interface LiveState {
  recording: boolean;
  paused: boolean;
  startedAt: number;
  pausedAt: number;
  pausedTotal: number;
  meetingName: string | null;
  micMuted: boolean;
  systemMuted: boolean;
  lines: PreviewTranscript[];
  timer: ReturnType<typeof setInterval> | null;
}

const live: LiveState = {
  recording: false,
  paused: false,
  startedAt: 0,
  pausedAt: 0,
  pausedTotal: 0,
  meetingName: null,
  micMuted: false,
  systemMuted: false,
  lines: [],
  timer: null,
};

function elapsed(): number {
  const end = live.paused ? live.pausedAt : Date.now();
  return Math.max(0, (end - live.startedAt - live.pausedTotal) / 1000);
}

export function liveRecordingState() {
  const seconds = live.recording ? elapsed() : null;
  return {
    is_recording: live.recording,
    is_paused: live.paused,
    is_microphone_muted: live.micMuted,
    is_system_audio_muted: live.systemMuted,
    is_active: live.recording && !live.paused,
    recording_duration: live.recording ? (Date.now() - live.startedAt) / 1000 : null,
    active_duration: seconds,
    total_pause_duration: live.pausedTotal / 1000,
    current_pause_duration: live.paused ? (Date.now() - live.pausedAt) / 1000 : null,
  };
}

/** Handles recording commands; returns undefined for anything else. */
export function handleLiveCommand(cmd: string, args: Record<string, any>): unknown {
  switch (cmd) {
    case 'is_recording':
      return live.recording;
    case 'get_recording_state':
      return liveRecordingState();
    case 'get_recording_meeting_name':
      return live.meetingName;
    case 'start_recording':
    case 'start_recording_with_devices_and_meeting': {
      if (live.recording) return null;
      Object.assign(live, {
        recording: true,
        paused: false,
        startedAt: Date.now(),
        pausedAt: 0,
        pausedTotal: 0,
        meetingName: args.meetingName ?? args.meeting_name ?? null,
        micMuted: false,
        systemMuted: false,
        lines: [],
      });
      let index = 0;
      live.timer = setInterval(() => {
        if (live.paused || index >= SCRIPT.length) return;
        const [speaker, text] = SCRIPT[index++];
        const start = Math.max(0, elapsed() - 2.5);
        const line: PreviewTranscript = {
          id: `live-${index}`,
          text,
          timestamp: new Date().toISOString(),
          audio_start_time: start,
          audio_end_time: start + 2.4,
          duration: 2.4,
          speaker,
          confidence: 0.93,
        };
        if (loadLabsPreferences().nearLiveCaptions) {
          const source = speaker === 'You' ? 'microphone' : 'system';
          void emit('near-live-finalized', { source, end_time: start + 2.4 });
          const next = SCRIPT[index];
          if (next) void emit('near-live-caption', {
            source: next[0] === 'You' ? 'microphone' : 'system',
            start_time: elapsed(), end_time: elapsed() + 0.8,
            text: next[1].split(' ').slice(0, 8).join(' '),
          });
        }
        live.lines.push(line);
        void emit('transcript-update', {
          text,
          timestamp: line.timestamp,
          source: speaker,
          sequence_id: index,
          chunk_start_time: start,
          is_partial: false,
          confidence: 0.93,
          audio_start_time: start,
          audio_end_time: start + 2.4,
          duration: 2.4,
        });
      }, 2600);
      setTimeout(() => void emit('recording-started'), 50);
      return null;
    }
    case 'pause_recording':
      if (!live.recording || live.paused) return null;
      live.paused = true;
      live.pausedAt = Date.now();
      void emit('recording-paused');
      return null;
    case 'resume_recording':
      if (!live.recording || !live.paused) return null;
      live.pausedTotal += Date.now() - live.pausedAt;
      live.paused = false;
      void emit('recording-resumed');
      return null;
    case 'set_microphone_muted':
      live.micMuted = !!args.muted;
      void emit('microphone-mute-changed', { muted: live.micMuted });
      return live.micMuted;
    case 'set_system_audio_muted':
      live.systemMuted = !!args.muted;
      void emit('system-audio-mute-changed', { muted: live.systemMuted });
      return live.systemMuted;
    case 'stop_recording':
    case 'stop_recording_from_minibar': {
      if (!live.recording) return false;
      if (live.timer) clearInterval(live.timer);
      live.timer = null;
      live.recording = false;
      live.paused = false;
      const folder = `/preview/live-${Date.now()}`;
      setTimeout(() => {
        void emit('recording-stopped', { message: 'stopped', folder_path: folder, meeting_name: live.meetingName });
        void emit('recording-stop-complete', { call_api: true, folder_path: folder, meeting_name: live.meetingName });
      }, 100);
      return true;
    }
    case 'get_transcription_status':
      return { is_processing: false, chunks_in_queue: 0, last_activity_ms: 60_000 };
    default:
      return undefined;
  }
}

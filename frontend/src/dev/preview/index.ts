/**
 * Browser preview for UI work.
 *
 * `next dev` serves the UI at http://localhost:3118, but outside the desktop
 * shell every Tauri call fails, so pages render empty. In development only,
 * and only when the Tauri bridge is absent, this installs Tauri's own IPC mock
 * with an in-memory sample library, so screens can be reviewed in a normal
 * browser. It is never bundled into production builds.
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { MotionGlobalConfig } from 'framer-motion';
import * as fx from './fixtures';
import { handleLiveCommand } from './live';
import { CUSTOM_CHROME_CLASS } from '@/lib/window-chrome';

type Args = Record<string, any>;

interface ActionItemRow {
  id: string;
  meetingId: string;
  text: string;
  ownerLabel: string | null;
  personId: string | null;
  dueText: string | null;
  done: boolean;
  doneAt: string | null;
  source: 'ai' | 'user';
  edited: boolean;
  audioTime: number | null;
  transcriptId: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

const state = {
  meetings: fx.meetings.map((meeting) => ({ ...meeting })),
  groups: fx.groups.map((group) => ({ ...group, createdAt: new Date(Date.now() - 60 * 86_400_000).toISOString() })),
  people: fx.people.map((person) => ({ ...person })),
  links: fx.speakerLinks.map((link) => ({ ...link })),
  notes: new Map<string, { markdown: string | null; json: unknown[] | null; updatedAt: string }>(),
  summaries: new Map<string, string | null>(),
  actionItems: [] as ActionItemRow[],
  actionSynced: new Set<string>(),
  transcripts: new Map<string, fx.PreviewTranscript[]>(),
  diarization: {
    active_engine: 'pyannote',
    nemotron_available: false,
    nemotron_max_speakers: 8,
    nemotron_threshold: 0.5,
    pyannote_threshold: 0.7,
  },
  recordingPrefs: {
    save_folder: 'C:/Users/preview/Music/meetily-recordings',
    auto_save: true,
    file_format: 'mp4',
    preferred_mic_device: null as string | null,
    preferred_system_device: null as string | null,
    mic_gain: 1,
    system_gain: 1,
    real_time_transcription: false,
    per_app_recording_enabled: false,
    per_app_target_app: null as string | null,
    per_app_target_name: null as string | null,
    per_app_targets: [] as Array<{ id: string; name: string; executable: string; icon?: string | null }>,
  },
  meetingDetection: {
    enabled: false,
    interval_secs: 15,
    meeting_apps: ['Zoom', 'Microsoft Teams', 'Slack', 'Webex', 'Discord', 'Google Meet'],
    ignored_apps: [] as string[],
    notify: true,
  },
  labs: { whisperStrictSilence: false, voiceProfiles: false, parakeetGpu: false },
  voices: [{ person_id: 'person-tom', samples: 6, meetings: 1, from: ['meeting-acme-kickoff'] }] as Array<{
    person_id: string;
    samples: number;
    meetings: number;
    from: string[];
  }>,
};

const RUNNING_APPS = [
  { id: 'Zoom.exe', name: 'Zoom Workplace', executable: 'Zoom.exe', pid: 4120, has_audio: true, icon: null },
  { id: 'chrome.exe', name: 'Google Chrome', executable: 'chrome.exe', pid: 9876, has_audio: true, icon: null },
  { id: 'Spotify.exe', name: 'Spotify', executable: 'Spotify.exe', pid: 7312, has_audio: true, icon: null },
  { id: 'ms-teams.exe', name: 'Microsoft Teams', executable: 'ms-teams.exe', pid: 5544, has_audio: false, icon: null },
  { id: 'slack.exe', name: 'Slack', executable: 'slack.exe', pid: 6620, has_audio: false, icon: null },
  { id: 'Discord.exe', name: 'Discord', executable: 'Discord.exe', pid: 8210, has_audio: false, icon: null },
  { id: 'Code.exe', name: 'Visual Studio Code', executable: 'Code.exe', pid: 3108, has_audio: false, icon: null },
];

let idCounter = 0;
const newId = (prefix: string) => `${prefix}-preview-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
const now = () => new Date().toISOString();

function transcripts(meetingId: string) {
  if (!state.transcripts.has(meetingId)) state.transcripts.set(meetingId, fx.transcriptsFor(meetingId));
  return state.transcripts.get(meetingId)!;
}

// ---- Recording audio ----------------------------------------------------
// Each meeting gets a silent recording as long as its transcript, so the
// player has a real duration, and a waveform that is loud while people talk.

const PREVIEW_AUDIO = 'preview-audio/';
const audioUrls = new Map<string, string>();

function previewDuration(meetingId: string) {
  const end = transcripts(meetingId).reduce((max, row) => Math.max(max, row.audio_end_time ?? 0), 0);
  return Math.max(30, Math.ceil(end) + 4);
}

function silentWav(seconds: number): string {
  const rate = 8000;
  const samples = seconds * rate;
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([view.buffer], { type: 'audio/wav' }));
}

function previewAudioUrl(path: string): string {
  const meetingId = path.slice(PREVIEW_AUDIO.length);
  if (!audioUrls.has(meetingId)) audioUrls.set(meetingId, silentWav(previewDuration(meetingId)));
  return audioUrls.get(meetingId)!;
}

function previewPeaks(meetingId: string): number[] {
  const peaks = Array.from({ length: previewDuration(meetingId) }, (_, second) => 0.03 + ((second * 37) % 5) / 100);
  for (const row of transcripts(meetingId)) {
    const start = Math.floor(row.audio_start_time ?? 0);
    const end = Math.ceil(row.audio_end_time ?? start + 3);
    for (let second = start; second < end && second < peaks.length; second++) {
      peaks[second] = 0.3 + ((second * 73 + start * 11) % 65) / 100;
    }
  }
  return peaks;
}

function summary(meetingId: string) {
  if (!state.summaries.has(meetingId)) state.summaries.set(meetingId, fx.summaryFor(meetingId));
  return state.summaries.get(meetingId) ?? null;
}

function meeting(meetingId: string) {
  return state.meetings.find((entry) => entry.id === meetingId);
}

function groupSummary(group: (typeof state.groups)[number]) {
  const members = state.meetings
    .filter((entry) => entry.group_id === group.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const last = members[0];
  return {
    id: group.id,
    name: group.name,
    color: group.color,
    kind: group.kind,
    description: group.description ?? null,
    schedule: group.schedule ?? null,
    meetingCount: members.length,
    lastMeetingAt: last?.created_at,
    lastMeetingId: last?.id,
    lastMeetingTitle: last?.title,
    createdAt: group.createdAt,
  };
}

function personRow(person: (typeof state.people)[number]) {
  const links = state.links.filter((link) => link.personId === person.id);
  const meetingIds = [...new Set(links.map((link) => link.meetingId))];
  const dated = meetingIds
    .map((id) => meeting(id))
    .filter(Boolean)
    .sort((a, b) => b!.created_at.localeCompare(a!.created_at));
  const groupIds = [...new Set(dated.map((entry) => entry!.group_id).filter(Boolean))] as string[];
  return {
    id: person.id,
    displayName: person.displayName,
    email: person.email ?? null,
    company: person.company ?? null,
    role: person.role ?? null,
    phone: person.phone ?? null,
    meetingCount: meetingIds.length,
    lastSeenAt: dated[0]?.created_at,
    groups: groupIds
      .map((id) => state.groups.find((group) => group.id === id))
      .filter(Boolean)
      .map((group) => ({ id: group!.id, name: group!.name, color: group!.color })),
  };
}

function actionView(item: ActionItemRow) {
  const source = meeting(item.meetingId);
  const person = item.personId ? state.people.find((entry) => entry.id === item.personId) : undefined;
  return {
    ...item,
    meetingTitle: source?.title ?? 'Meeting',
    meetingCreatedAt: source?.created_at ?? item.createdAt,
    groupId: source?.group_id ?? null,
    personName: person?.displayName ?? null,
  };
}

/** Pulls "Owner: task" bullets and Owner|Task|Due tables out of a summary. */
function extractActions(markdown: string) {
  const items: Array<{ text: string; ownerLabel: string | null; dueText: string | null }> = [];
  let inActions = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inActions = /action|next step|to-?do|follow/i.test(heading[1]);
      continue;
    }
    if (!inActions || !line) continue;
    if (line.startsWith('|')) {
      const cells = line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === '') || /^owner$/i.test(cells[0])) continue;
      items.push({ ownerLabel: cells[0] || null, text: cells[1] ?? '', dueText: cells[2] || null });
      continue;
    }
    const bullet = line.replace(/^[-*]\s+/, '');
    const owned = bullet.match(/^([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*)?):\s+(.*)$/);
    items.push(owned ? { ownerLabel: owned[1], text: owned[2], dueText: null } : { ownerLabel: null, text: bullet, dueText: null });
  }
  return items.filter((item) => item.text);
}

function ensureActionItems(meetingId: string) {
  if (state.actionSynced.has(meetingId)) return;
  state.actionSynced.add(meetingId);
  const text = summary(meetingId);
  if (!text) return;
  extractActions(text).forEach((item, index) => {
    const person = state.people.find((entry) => entry.displayName.toLowerCase() === (item.ownerLabel ?? '').toLowerCase());
    const stamp = meeting(meetingId)?.created_at ?? now();
    state.actionItems.push({
      id: newId('action'),
      meetingId,
      text: item.text,
      ownerLabel: item.ownerLabel,
      personId: person?.id ?? null,
      dueText: item.dueText,
      done: index === 0 && meetingId !== 'meeting-acme-review',
      doneAt: null,
      source: 'ai',
      edited: false,
      audioTime: 30 + index * 25,
      transcriptId: null,
      position: index,
      createdAt: stamp,
      updatedAt: stamp,
    });
  });
}

function searchResults(query: string) {
  const needle = query.toLowerCase();
  const results: any[] = [];
  for (const person of state.people) {
    if (person.displayName.toLowerCase().includes(needle)) {
      results.push({ kind: 'person', id: person.id, personId: person.id, title: person.displayName, snippet: [person.role, person.company].filter(Boolean).join(' · '), meetingCount: personRow(person).meetingCount });
    }
  }
  for (const group of state.groups) {
    if (group.name.toLowerCase().includes(needle)) {
      results.push({ kind: 'group', id: group.id, groupId: group.id, title: group.name, snippet: `${groupSummary(group).meetingCount} meetings`, color: group.color });
    }
  }
  for (const entry of state.meetings) {
    if (entry.title.toLowerCase().includes(needle)) {
      results.push({ kind: 'meeting', id: entry.id, meetingId: entry.id, title: entry.title, snippet: '', timestamp: entry.created_at });
    }
    for (const line of transcripts(entry.id)) {
      if (line.text.toLowerCase().includes(needle)) {
        results.push({ kind: 'transcript', id: line.id, meetingId: entry.id, transcriptId: line.id, title: entry.title, snippet: line.text, speaker: line.speaker, audioStartTime: line.audio_start_time, timestamp: entry.created_at });
      }
    }
  }
  for (const item of state.actionItems) {
    const owner = item.ownerLabel ?? '';
    if (!item.text.toLowerCase().includes(needle) && !owner.toLowerCase().includes(needle)) continue;
    const entry = meeting(item.meetingId);
    if (!entry) continue;
    results.push({ kind: 'action', id: item.id, meetingId: entry.id, title: entry.title, snippet: item.text, speaker: item.ownerLabel ?? undefined, audioStartTime: item.audioTime ?? undefined, timestamp: entry.created_at });
  }
  return results.slice(0, 40);
}

const notificationSettings = {
  recording_notifications: true,
  time_based_reminders: false,
  meeting_reminders: false,
  respect_do_not_disturb: true,
  notification_sound: false,
  system_permission_granted: true,
  consent_given: true,
  manual_dnd_mode: false,
  notification_preferences: {
    show_recording_started: true,
    show_recording_stopped: true,
    show_recording_paused: false,
    show_recording_resumed: false,
    show_transcription_complete: true,
    show_meeting_reminders: false,
    show_system_errors: true,
    meeting_reminder_minutes: [5],
  },
};

let storeRid = 1;

function handle(cmd: string, args: Args): unknown {
  const liveResult = handleLiveCommand(cmd, args);
  if (liveResult !== undefined) return liveResult;
  // @tauri-apps/plugin-store: an empty store that accepts writes.
  if (cmd.startsWith('plugin:store|')) {
    if (cmd === 'plugin:store|load' || cmd === 'plugin:store|get_store') return storeRid++;
    if (cmd === 'plugin:store|get') return [null, false];
    if (cmd === 'plugin:store|has') return false;
    if (cmd === 'plugin:store|keys' || cmd === 'plugin:store|values' || cmd === 'plugin:store|entries') return [];
    if (cmd === 'plugin:store|length') return 0;
    return null;
  }
  if (cmd.startsWith('plugin:')) return null;

  switch (cmd) {
    // ---- App shell -------------------------------------------------------
    case 'get_onboarding_status':
      // `?preview=onboarding` shows first-run setup instead of the app.
      return {
        version: '1',
        completed: !window.location.search.includes('preview=onboarding'),
        current_step: window.location.search.includes('preview=onboarding') ? 1 : 5,
        model_status: { parakeet: 'downloaded', summary: 'downloaded' },
        last_updated: now(),
      };
    case 'get_pending_crash_report':
      return null;
    case 'get_cuda_reconfiguration_status':
      return { reconfigurationRequired: false, compiledBackend: 'cpu', setupDownloadUrl: null };
    case 'check_first_launch':
    case 'get_check_updates_on_launch':
      return false;
    case 'get_notification_settings':
      return notificationSettings;
    case 'get_database_directory':
      return 'C:/Users/preview/AppData/Meetily';
    case 'whisper_get_models_directory':
    case 'parakeet_get_models_directory':
      return 'C:/Users/preview/AppData/Meetily/models';
    case 'get_default_recordings_folder_path':
      return 'C:/Users/preview/Music/meetily-recordings';
    case 'get_ollama_models':
    case 'whisper_get_available_models':
    case 'builtin_ai_list_models':
    case 'get_meeting_history':
    case 'get_transcript_history':
      return [];
    case 'parakeet_get_available_models':
      return [{ name: 'parakeet-tdt-0.6b-v3-int8', status: 'Available', size_mb: 670 }];
    case 'api_get_post_call_transcript_config':
      return { provider: 'live', model: '' };
    case 'api_get_vocabulary':
      return { global: '', meeting: '' };
    case 'parakeet_has_available_models':
    case 'parakeet_is_model_loaded':
    case 'builtin_ai_is_model_ready':
      return true;
    case 'builtin_ai_get_recommended_model':
      return 'gemma3:1b';
    case 'api_get_api_key':
      return '';
    case 'get_meeting_detection_settings':
      return { ...state.meetingDetection };
    case 'set_meeting_detection_settings':
      state.meetingDetection = { ...state.meetingDetection, ...args.settings };
      return null;
    case 'is_recording':
      return false;
    case 'get_recording_state':
      return {
        is_recording: false,
        is_paused: false,
        is_microphone_muted: false,
        is_system_audio_muted: false,
        is_active: false,
        recording_duration: null,
        active_duration: null,
        total_pause_duration: 0,
        current_pause_duration: null,
      };
    case 'get_audio_devices':
      return [
        { name: 'MacBook Pro Microphone', device_type: 'Input' },
        { name: 'Studio Display Microphone', device_type: 'Input' },
        // Long enough to scroll on hover in the device picker.
        { name: 'Headset Microphone (Jabra Evolve2 65 – Bluetooth Hands-Free)', device_type: 'Input' },
        { name: 'MacBook Pro Speakers', device_type: 'Output' },
      ];
    case 'get_recording_preferences':
      return { ...state.recordingPrefs, per_app_targets: [...state.recordingPrefs.per_app_targets] };
    case 'set_recording_preferences':
      state.recordingPrefs = { ...state.recordingPrefs, ...args.preferences };
      return null;
    case 'get_recordable_apps':
      return new Promise((resolve) => setTimeout(() => resolve(RUNNING_APPS.map((app) => ({ ...app }))), 250));
    case 'select_custom_app_executable':
      return { id: 'CiscoCollabHost.exe', name: 'Webex', executable: 'CiscoCollabHost.exe', pid: null, has_audio: false, icon: null };

    // ---- Labs --------------------------------------------------------------
    case 'get_whisper_strict_silence':
      return state.labs.whisperStrictSilence;
    case 'set_whisper_strict_silence':
      state.labs.whisperStrictSilence = !!args.enabled;
      return null;
    case 'get_voice_profiles_enabled':
      return state.labs.voiceProfiles;
    case 'set_voice_profiles_enabled':
      state.labs.voiceProfiles = !!args.value;
      return null;
    case 'get_parakeet_gpu_enabled':
      return state.labs.parakeetGpu;
    case 'set_parakeet_gpu_enabled':
      state.labs.parakeetGpu = !!args.value;
      return new Promise((resolve) => setTimeout(() => resolve(null), 600));
    case 'list_voice_profiles':
      return state.voices
        .map(({ from: _from, ...voice }) => ({ ...voice, name: state.people.find((person) => person.id === voice.person_id)?.displayName }))
        .filter((voice) => voice.name);
    case 'enroll_person_voice':
    case 'enroll_voice_profile': {
      const person =
        cmd === 'enroll_person_voice'
          ? state.people.find((entry) => entry.id === args.personId)
          : state.people.find((entry) => entry.displayName === args.speaker);
      if (!person) return Promise.reject('Only a named speaker on the call can have a voice profile.');
      // Like the app: one meeting adds its share, no meeting relearns from all of theirs.
      const earlier = state.voices.find((voice) => voice.person_id === person.id)?.from ?? [];
      const theirs = state.links.filter((link) => link.personId === person.id).map((link) => link.meetingId);
      const from = cmd === 'enroll_voice_profile' ? [...new Set([...earlier, args.meetingId as string])] : theirs;
      const voice = { person_id: person.id, samples: from.length * 4, meetings: from.length, from };
      state.voices = [...state.voices.filter((entry) => entry.person_id !== person.id), voice];
      return new Promise((resolve) =>
        setTimeout(() => resolve({ person_id: person.id, name: person.displayName, samples: voice.samples, meetings: voice.meetings }), 900),
      );
    }
    case 'delete_voice_profile':
      state.voices = state.voices.filter((voice) => voice.person_id !== args.personId);
      return null;
    case 'get_waveform_peaks':
      return new Promise((resolve) => setTimeout(() => resolve(previewPeaks(String(args.filePath).slice(PREVIEW_AUDIO.length))), 300));
    case 'api_get_model_config':
      return { provider: 'ollama', model: 'llama3.2:3b', whisperModel: 'large-v3', apiKey: null, ollamaEndpoint: null };
    case 'api_get_transcript_config':
      return { provider: 'parakeet', model: 'parakeet-tdt-0.6b-v3-int8', apiKey: null };
    case 'api_list_templates':
      return [
        { id: 'standard_meeting', name: 'Standard meeting', description: 'Summary, decisions, action items' },
        { id: 'daily_standup', name: 'Daily standup', description: 'Updates and blockers' },
        { id: 'sales_call', name: 'Sales call', description: 'Needs, objections, next steps' },
      ];
    case 'diarization_models_available':
      return true;
    case 'diarization_get_status': {
      const engine = state.diarization;
      return {
        ...engine,
        pyannote_available: true,
        current_available: engine.active_engine === 'pyannote' || engine.nemotron_available,
        model_dir: 'C:\\Users\\you\\AppData\\Local\\Meetily\\models\\diarization',
        nemotron_download_size: 382 * 1024 * 1024,
        pyannote_download_size: 33 * 1024 * 1024,
      };
    }
    case 'set_diarization_engine':
      state.diarization.active_engine = args.engine;
      return null;
    case 'set_diarization_config':
      state.diarization.nemotron_max_speakers = args.nemotronMaxSpeakers;
      state.diarization.nemotron_threshold = args.nemotronThreshold;
      state.diarization.pyannote_threshold = args.pyannoteThreshold;
      return null;
    case 'claude_cli_get_status':
      return {
        installed: true,
        path: 'C:\\Users\\you\\.local\\bin\\claude.exe',
        version: '2.1.177 (Claude Code)',
        auth: { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' },
        api_key_env_detected: false,
        error: null,
      };
    case 'claude_cli_list_models':
      return [
        { id: 'sonnet', display_name: 'Sonnet — balanced quality and speed' },
        { id: 'opus', display_name: 'Opus — highest quality, slowest' },
        { id: 'haiku', display_name: 'Haiku — fastest, lightest summaries' },
        { id: 'default', display_name: 'Whatever the CLI is configured to use' },
      ];
    case 'claude_cli_get_path':
    case 'claude_cli_save_path':
      return null;
    case 'claude_cli_test_connection':
      return new Promise((resolve) =>
        setTimeout(() => resolve({ status: 'success', message: 'Claude Code CLI responded: ready' }), 900),
      );
    case 'download_diarization_models':
      return new Promise((resolve) =>
        setTimeout(() => {
          if (args.engine === 'nemotron') state.diarization.nemotron_available = true;
          resolve(null);
        }, 1200),
      );
    case 'get_meeting_folder_path':
      return meeting(args.meetingId)?.folder_path ?? null;
    case 'api_get_meeting_summary_language':
      return { language: null, storage: 'metadata' };

    // ---- Meetings --------------------------------------------------------
    case 'api_get_meetings':
      return [...state.meetings]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((entry) => ({ id: entry.id, title: entry.title, created_at: entry.created_at, duration_seconds: entry.duration_seconds, group_id: entry.group_id }));
    case 'api_get_meeting_metadata': {
      const entry = meeting(args.meetingId);
      if (!entry) throw new Error('Meeting not found');
      return { id: entry.id, title: entry.title, created_at: entry.created_at, updated_at: entry.created_at, folder_path: entry.folder_path };
    }
    case 'api_get_meeting_transcripts': {
      const rows = transcripts(args.meetingId);
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      return { transcripts: rows.slice(offset, offset + limit), total_count: rows.length, has_more: offset + limit < rows.length };
    }
    case 'api_get_meeting': {
      const entry = meeting(args.meetingId);
      return entry ? { id: entry.id, title: entry.title, created_at: entry.created_at, updated_at: entry.created_at, transcripts: transcripts(entry.id) } : null;
    }
    case 'api_get_summary': {
      const text = summary(args.meetingId);
      return text ? { status: 'completed', data: { markdown: text } } : { status: 'idle', data: null };
    }
    case 'api_save_meeting_summary': {
      const data = args.summary ?? {};
      if (typeof data.markdown === 'string') state.summaries.set(args.meetingId, data.markdown);
      return null;
    }
    case 'api_save_transcript': {
      // The simulated recording's save: add it to the library like the real one.
      const id = newId('meeting');
      const rows = (args.transcripts ?? []) as Array<Record<string, any>>;
      const createdAt = args.recordingStartedAt ?? now();
      state.meetings.push({
        id,
        title: args.meetingTitle ?? 'New Meeting',
        created_at: createdAt,
        duration_seconds: Math.round(rows.reduce((max, row) => Math.max(max, row.audio_end_time ?? 0), 0)),
        group_id: null,
        folder_path: args.folderPath ?? '/preview/live',
      });
      state.transcripts.set(
        id,
        rows.map((row, index) => ({
          id: `${id}-t${index}`,
          text: row.text,
          timestamp: row.timestamp ?? now(),
          audio_start_time: row.audio_start_time ?? 0,
          audio_end_time: row.audio_end_time ?? 0,
          duration: row.duration ?? 0,
          speaker: row.speaker,
          confidence: row.confidence,
        })),
      );
      state.summaries.set(id, null);
      return { meeting_id: id };
    }
    case 'api_save_meeting_title': {
      const entry = meeting(args.meetingId);
      if (entry) entry.title = args.title;
      return null;
    }
    case 'api_delete_meeting':
      state.meetings = state.meetings.filter((entry) => entry.id !== args.meetingId);
      state.actionItems = state.actionItems.filter((item) => item.meetingId !== args.meetingId);
      return null;
    case 'api_set_meetings_group':
      for (const entry of state.meetings) {
        if ((args.meetingIds as string[]).includes(entry.id)) entry.group_id = args.groupId ?? null;
      }
      return (args.meetingIds as string[]).length;
    case 'api_get_meeting_notes': {
      const notes = state.notes.get(args.meetingId);
      return notes ?? null;
    }
    case 'api_save_meeting_notes':
      state.notes.set(args.meetingId, { markdown: args.markdown ?? null, json: args.json ?? null, updatedAt: now() });
      return null;
    case 'api_get_meeting_audio':
      return transcripts(args.meetingId).length > 0
        ? { path: `${PREVIEW_AUDIO}${args.meetingId}`, micPath: null, systemPath: null }
        : { path: null, micPath: null, systemPath: null };

    // ---- Groups ----------------------------------------------------------
    case 'api_list_groups':
      return state.groups.map(groupSummary).sort((a, b) => (b.lastMeetingAt ?? '').localeCompare(a.lastMeetingAt ?? ''));
    case 'api_get_group': {
      const group = state.groups.find((entry) => entry.id === args.groupId);
      if (!group) throw new Error('Group not found');
      const query = (args.query ?? '').toLowerCase();
      const members = state.meetings
        .filter((entry) => entry.group_id === group.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      const attendance = new Map<string, number>();
      for (const entry of members) {
        for (const link of state.links.filter((candidate) => candidate.meetingId === entry.id)) {
          attendance.set(link.personId, (attendance.get(link.personId) ?? 0) + 1);
        }
      }
      const everyone = [...attendance.entries()].map(([personId, meetingCount]) => ({
        personId,
        displayName: state.people.find((person) => person.id === personId)?.displayName ?? 'Unknown',
        meetingCount,
      }));
      const threshold = Math.max(2, Math.ceil(members.length / 2));
      return {
        ...groupSummary(group),
        frequent: everyone.filter((member) => member.meetingCount >= threshold),
        rare: everyone.filter((member) => member.meetingCount < threshold),
        meetings: members
          .filter((entry) => !query || entry.title.toLowerCase().includes(query) || transcripts(entry.id).some((line) => line.text.toLowerCase().includes(query)))
          .map((entry) => ({
            meetingId: entry.id,
            title: entry.title,
            createdAt: entry.created_at,
            durationSeconds: entry.duration_seconds,
            present: state.links
              .filter((link) => link.meetingId === entry.id)
              .map((link) => state.people.find((person) => person.id === link.personId)?.displayName ?? link.label),
          })),
      };
    }
    case 'api_create_group': {
      const group = { id: newId('group'), name: args.name, color: args.color ?? 'blue', kind: args.kind ?? 'other', description: args.description ?? null, schedule: args.schedule ?? null, createdAt: now() };
      state.groups.push(group);
      return groupSummary(group);
    }
    case 'api_update_group': {
      const group = state.groups.find((entry) => entry.id === args.groupId);
      if (!group) throw new Error('Group not found');
      Object.assign(group, { name: args.name, color: args.color, kind: args.kind, description: args.description ?? null, schedule: args.schedule ?? null });
      return groupSummary(group);
    }
    case 'api_delete_group':
      state.groups = state.groups.filter((entry) => entry.id !== args.groupId);
      for (const entry of state.meetings) if (entry.group_id === args.groupId) entry.group_id = null;
      return null;
    case 'api_get_meeting_group': {
      const entry = meeting(args.meetingId);
      const group = entry?.group_id ? state.groups.find((candidate) => candidate.id === entry.group_id) : undefined;
      return group ? groupSummary(group) : null;
    }
    case 'api_set_meeting_group': {
      const entry = meeting(args.meetingId);
      if (entry) entry.group_id = args.groupId ?? null;
      return null;
    }

    // ---- People ----------------------------------------------------------
    case 'api_list_people':
      return state.people.map(personRow).sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''));
    case 'api_get_person_profile': {
      const person = state.people.find((entry) => entry.id === args.personId);
      if (!person) throw new Error('Person not found');
      const row = personRow(person);
      const meetingIds = [...new Set(state.links.filter((link) => link.personId === person.id).map((link) => link.meetingId))];
      const history = meetingIds
        .map((id) => meeting(id))
        .filter(Boolean)
        .sort((a, b) => b!.created_at.localeCompare(a!.created_at))
        .map((entry) => {
          const label = state.links.find((link) => link.personId === person.id && link.meetingId === entry!.id)?.label;
          const lines = transcripts(entry!.id).filter((line) => line.speaker === label);
          return {
            meetingId: entry!.id,
            title: entry!.title,
            createdAt: entry!.created_at,
            messageCount: lines.length,
            speakingSeconds: lines.reduce((sum, line) => sum + line.duration, 0),
            excerpt: lines[0]?.text,
          };
        });
      return {
        ...row,
        notes: person.notes ?? '',
        messageCount: history.reduce((sum, entry) => sum + entry.messageCount, 0),
        totalSpeakingSeconds: history.reduce((sum, entry) => sum + entry.speakingSeconds, 0),
        firstSeenAt: history[history.length - 1]?.createdAt,
        lastSeenAt: history[0]?.createdAt,
        meetings: history,
        groups: row.groups.map((group) => ({ ...group, meetingCount: history.filter((entry) => meeting(entry.meetingId)?.group_id === group.id).length })),
      };
    }
    case 'api_create_person': {
      const person = { id: newId('person'), displayName: args.displayName, email: args.email ?? null, company: args.company ?? null, role: args.role ?? null, phone: args.phone ?? null, notes: null };
      state.people.push(person);
      return personRow(person);
    }
    case 'api_update_person': {
      const person = state.people.find((entry) => entry.id === args.personId);
      if (!person) throw new Error('Person not found');
      for (const link of state.links) if (link.personId === person.id) link.label = args.displayName;
      Object.assign(person, { displayName: args.displayName, email: args.email ?? null, company: args.company ?? null, role: args.role ?? null, phone: args.phone ?? null });
      return personRow(person);
    }
    case 'api_merge_people': {
      const target = state.people.find((entry) => entry.id === args.targetId);
      if (!target) throw new Error('Person not found');
      for (const link of state.links) {
        if (link.personId === args.sourceId) {
          link.personId = target.id;
          link.label = target.displayName;
        }
      }
      for (const item of state.actionItems) if (item.personId === args.sourceId) item.personId = target.id;
      state.people = state.people.filter((entry) => entry.id !== args.sourceId);
      return personRow(target);
    }
    case 'api_delete_person':
      state.links = state.links.filter((link) => link.personId !== args.personId);
      state.people = state.people.filter((entry) => entry.id !== args.personId);
      for (const item of state.actionItems) if (item.personId === args.personId) item.personId = null;
      return null;
    case 'api_update_person_notes': {
      const person = state.people.find((entry) => entry.id === args.personId);
      if (person) person.notes = args.notes;
      return null;
    }
    // Relabels the lines like the app does, so turns merge and split as they
    // would after a rename or a diarization rerun.
    case 'rename_meeting_speaker': {
      const rows = transcripts(args.meetingId);
      const target = args.to || 'Speaker 1';
      let count = 0;
      for (const row of rows) {
        if (row.speaker === args.from) {
          row.speaker = target;
          count += 1;
        }
      }
      return { speaker: target, count, removedName: !args.to };
    }
    case 'reassign_transcript_speaker': {
      const row = transcripts(args.meetingId).find((entry) => entry.id === args.transcriptId);
      if (row) row.speaker = args.to || 'Speaker 1';
      return { speaker: args.to || 'Speaker 1', count: row ? 1 : 0, removedName: !args.to };
    }

    // ---- Action items ----------------------------------------------------
    case 'api_list_action_items': {
      state.meetings.forEach((entry) => ensureActionItems(entry.id));
      let rows = state.actionItems.map(actionView);
      if (args.meetingId) rows = rows.filter((item) => item.meetingId === args.meetingId);
      if (args.personId) rows = rows.filter((item) => item.personId === args.personId);
      if (args.groupId) rows = rows.filter((item) => item.groupId === args.groupId);
      if (args.openOnly) rows = rows.filter((item) => !item.done);
      rows.sort((a, b) => (a.meetingId === b.meetingId ? a.position - b.position : b.meetingCreatedAt.localeCompare(a.meetingCreatedAt)));
      return args.limit ? rows.slice(0, args.limit) : rows;
    }
    case 'api_create_action_item': {
      const item: ActionItemRow = {
        id: newId('action'),
        meetingId: args.meetingId,
        text: args.text,
        ownerLabel: args.ownerLabel ?? null,
        personId: args.personId ?? null,
        dueText: args.dueText ?? null,
        done: false,
        doneAt: null,
        source: 'user',
        edited: true,
        audioTime: args.audioTime ?? null,
        transcriptId: null,
        position: state.actionItems.filter((entry) => entry.meetingId === args.meetingId).length,
        createdAt: now(),
        updatedAt: now(),
      };
      state.actionItems.push(item);
      return actionView(item);
    }
    case 'api_update_action_item': {
      const item = state.actionItems.find((entry) => entry.id === args.id);
      if (!item) throw new Error('Action item not found');
      const textChanged = item.text !== args.text || item.ownerLabel !== (args.ownerLabel ?? null) || item.dueText !== (args.dueText ?? null);
      Object.assign(item, {
        text: args.text,
        ownerLabel: args.ownerLabel ?? null,
        personId: args.personId ?? null,
        dueText: args.dueText ?? null,
        done: !!args.done,
        doneAt: args.done ? item.doneAt ?? now() : null,
        edited: item.edited || textChanged || !!args.done,
        updatedAt: now(),
      });
      return actionView(item);
    }
    case 'api_delete_action_item':
      state.actionItems = state.actionItems.filter((entry) => entry.id !== args.id);
      return null;
    case 'api_sync_ai_action_items': {
      state.actionSynced.add(args.meetingId);
      state.actionItems = state.actionItems.filter((item) => item.meetingId !== args.meetingId || item.source !== 'ai' || item.edited);
      (args.items as any[]).forEach((draft, index) => {
        const person = state.people.find((entry) => entry.displayName.toLowerCase() === (draft.ownerLabel ?? '').toLowerCase());
        state.actionItems.push({
          id: newId('action'),
          meetingId: args.meetingId,
          text: draft.text,
          ownerLabel: draft.ownerLabel ?? null,
          personId: person?.id ?? null,
          dueText: draft.dueText ?? null,
          done: false,
          doneAt: null,
          source: 'ai',
          edited: false,
          audioTime: draft.audioTime ?? null,
          transcriptId: null,
          position: index,
          createdAt: now(),
          updatedAt: now(),
        });
      });
      return state.actionItems.filter((item) => item.meetingId === args.meetingId).map(actionView);
    }
    case 'api_list_unsynced_action_meetings':
      return [];

    // ---- Search and AI ---------------------------------------------------
    case 'api_global_search':
      return searchResults(args.query ?? '');
    case 'ask_live_assistant':
    case 'ask_person':
    case 'api_ask_meeting':
      return new Promise((resolve) =>
        setTimeout(() => resolve('This is a preview answer. In the app, your configured model answers from the meeting records, with citations.'), 700),
      );
    default:
      return null;
  }
}

let installed = false;

export function installPreviewMocks() {
  if (installed || typeof window === 'undefined' || '__TAURI_INTERNALS__' in window) return;
  installed = true;
  // A hidden preview pane pauses animation frames, which would freeze
  // entrance animations mid-way in screenshots. Previews skip them.
  MotionGlobalConfig.skipAnimations = true;
  // plugin-os reads these synchronously from injected internals.
  (window as any).__TAURI_OS_PLUGIN_INTERNALS__ = {
    platform: 'windows',
    os_type: 'windows',
    family: 'windows',
    version: '10.0.26200',
    arch: 'x86_64',
    eol: '\r\n',
    exe_extension: 'exe',
  };
  // ?chrome=custom previews the Windows title strip and window buttons.
  if (new URLSearchParams(window.location.search).get('chrome') === 'custom') {
    document.documentElement.classList.add(CUSTOM_CHROME_CLASS);
  }
  mockWindows('main');
  mockIPC((cmd, args) => handle(cmd, (args ?? {}) as Args), { shouldMockEvents: true });
  // Meeting recordings play from generated silent audio.
  (window as any).__TAURI_INTERNALS__.convertFileSrc = (path: string) =>
    path.startsWith(PREVIEW_AUDIO) ? previewAudioUrl(path) : path;
  try {
    if (!localStorage.getItem('meetily_user_name')) localStorage.setItem('meetily_user_name', 'Jay');
  } catch {
    // Storage unavailable: the preview still works without a display name.
  }
  console.info('[preview] Tauri IPC is mocked with sample data.');
}

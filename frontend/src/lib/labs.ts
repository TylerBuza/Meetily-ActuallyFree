export interface LabsPreferences {
  meetingAutomation: boolean;
  transcriptScrubbing: boolean;
  voiceProfiles: boolean;
  whisperSilenceGuard: boolean;
  cleanTranscript: boolean;
  parakeetGpu: boolean;
  nearLiveCaptions: boolean;
  micPlaybackSuppression: boolean;
}

export const defaultLabsPreferences: LabsPreferences = {
  meetingAutomation: false,
  transcriptScrubbing: false,
  voiceProfiles: false,
  whisperSilenceGuard: false,
  cleanTranscript: false,
  parakeetGpu: false,
  nearLiveCaptions: false,
  micPlaybackSuppression: false,
};

const key = 'meetily-labs-v1';
export const LABS_CHANGED_EVENT = 'meetily-labs-changed';

export function loadLabsPreferences(): LabsPreferences {
  if (typeof window === 'undefined') return defaultLabsPreferences;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    return Object.fromEntries(
      Object.entries(defaultLabsPreferences).map(([name, fallback]) =>
        [name, typeof saved[name] === 'boolean' ? saved[name] : fallback],
      ),
    ) as unknown as LabsPreferences;
  } catch {
    return defaultLabsPreferences;
  }
}

export function saveLabsPreferences(value: LabsPreferences): void {
  localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new Event(LABS_CHANGED_EVENT));
}

// Only display text is changed. Persisted transcription and turn timestamps stay verbatim.
export function cleanTranscriptText(text: string): string {
  const cleaned = text
    .replace(/\b(?:uh+|um+|erm|er)\b[,\s]*/gi, '')
    .replace(/\b([\p{L}\p{N}]+)(?:\s+\1)\b/giu, (pair, word: string) =>
      ['no', 'yes', 'very', 'never'].includes(word.toLowerCase()) ? pair : word)
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
}

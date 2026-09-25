import { invoke } from '@tauri-apps/api/core';

export const OPTIONAL_MODEL_PREFERENCES_CHANGED = 'optional-model-preferences-changed';

export async function activateOptionalModel(model: 'whisper' | 'nemotron', whisperModel: string) {
  if (model === 'nemotron') {
    await invoke('set_diarization_engine', { engine: 'nemotron' });
  } else {
    // Only the post-call default changes; live transcription stays on Parakeet.
    await invoke('api_save_post_call_transcript_config', { provider: 'whisper', model: whisperModel });
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(OPTIONAL_MODEL_PREFERENCES_CHANGED));
  }
}

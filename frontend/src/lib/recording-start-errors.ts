// Readable reasons for a failed recording start. Kept free of React and
// Tauri imports so it can be unit tested.
import { tNow } from '@/i18n/translate'

/** The text of a rejected `invoke`: usually a string, but may be an Error or a serialized object. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error == null) return '';
  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** A readable reason for a failed start, from the backend's error text. */
export function describeStartError(error: unknown): { title: string; message: string } {
  const raw = errorText(error);
  const text = raw.toLowerCase();
  // Only "not currently running" means opening an app helps; other per-app
  // failures fall through to the backend's own reason below.
  if (text.includes('target application') && text.includes('currently running')) {
    return {
      title: tNow('feedback.noChosenAppsOpen'),
      message: tNow('feedback.noChosenAppsOpenMessage'),
    };
  }
  if (text.includes('microphone') || text.includes('mic') || text.includes('input')) {
    return {
      title: tNow('feedback.microphoneNotAvailable'),
      message: tNow('feedback.microphoneNotAvailableMessage'),
    };
  }
  if (text.includes('system audio') || text.includes('speaker') || text.includes('output')) {
    return {
      title: tNow('feedback.systemAudioNotAvailable'),
      message: tNow('feedback.systemAudioNotAvailableMessage'),
    };
  }
  if (text.includes('permission')) {
    return {
      title: tNow('feedback.permissionNeeded'),
      message: tNow('feedback.permissionNeededMessage'),
    };
  }
  // Unrecognised: show the backend's own reason rather than hiding it.
  const reason = raw.replace(/^Failed to start recording:\s*/i, '').trim();
  return {
    title: tNow('feedback.couldNotStartRecording'),
    message: reason || tNow('feedback.couldNotStartRecordingHint'),
  };
}

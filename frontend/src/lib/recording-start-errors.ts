// Readable reasons for a failed recording start. Kept free of React and
// Tauri imports so it can be unit tested.

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
      title: 'None of your chosen apps is open',
      message: 'Computer audio is set to record only chosen apps. Open one of them, or switch the record card back to all computer audio.',
    };
  }
  if (text.includes('microphone') || text.includes('mic') || text.includes('input')) {
    return {
      title: 'Microphone not available',
      message: 'Check that the microphone is connected, that Meetily may use it, and that no other app has taken it.',
    };
  }
  if (text.includes('system audio') || text.includes('speaker') || text.includes('output')) {
    return {
      title: 'System audio not available',
      message:
        'On macOS, allow Meetily Audio Capture in Privacy & Security, play some audio, and try again. Elsewhere, check the selected playback device.',
    };
  }
  if (text.includes('permission')) {
    return {
      title: 'Permission needed',
      message: 'Allow microphone access (and Audio Capture on macOS) in your system settings, then restart Meetily.',
    };
  }
  // Unrecognised: show the backend's own reason rather than hiding it.
  const reason = raw.replace(/^Failed to start recording:\s*/i, '').trim();
  return {
    title: 'Could not start recording',
    message: reason || 'Check your audio devices in the recording card and try again.',
  };
}

export interface SystemAudioProbe {
  detected: boolean;
  /** False when the probe could not make a trustworthy judgement. */
  conclusive: boolean;
  reason:
    | 'captured'
    | 'silentWithSelfTest'
    | 'selfTestUnavailable'
    | 'outputMuted'
    | 'outputVolumeUnknown'
    | 'tapDenied'
    | 'tapUnavailable'
    | 'notRequired';
}

/**
 * Wording for a probe that did not capture audio. Only a conclusive result may
 * state that permission is denied; everything else describes the most likely
 * cause and asks for another attempt.
 */
export function systemAudioProbeMessage(probe: SystemAudioProbe): string {
  switch (probe.reason) {
    case 'tapDenied':
      return 'Audio Capture permission was denied. Grant it in System Settings, then test again.';
    case 'silentWithSelfTest':
      return 'System audio was not detected, even though Meetily played a test sound. This usually means Audio Capture permission is denied — grant it in System Settings, then test again.';
    case 'outputMuted':
      return 'Your output is muted, so the test sound could not be heard. Unmute your speakers and test again.';
    case 'outputVolumeUnknown':
      return 'Meetily could not confirm your output volume, so this test was not conclusive. Check your speakers are audible and test again.';
    case 'selfTestUnavailable':
      return 'Meetily could not play its test sound. Play some audio, then test again.';
    case 'tapUnavailable':
      return 'The system audio tap could not be opened, so permission could not be verified. Restart Meetily and test again.';
    default:
      return 'System audio was not detected. Play some audio, then test again.';
  }
}

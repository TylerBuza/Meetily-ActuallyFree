/** Advisory post-gain digital levels, not Windows volume percentages or VAD
 * speech probabilities. Amplitude alone cannot establish that speech is present.
 */
const QUIET_RMS = 10 ** (-45 / 20);
const QUIET_PEAK = 10 ** (-30 / 20);
const SIGNAL_FLOOR = 10 ** (-80 / 20);

/** One monitor per active meter. Missing events do not count as quiet audio. */
export class SystemAudioLevelMonitor {
  private quietSince: number | null = null;
  private lastSample: number | null = null;

  reset() { this.quietSince = null; this.lastSample = null; }

  update(rms: number, peak: number, now: number): boolean {
    const quietSignal = Number.isFinite(rms) && Number.isFinite(peak) && Number.isFinite(now)
      && rms > SIGNAL_FLOOR && peak >= rms && rms < QUIET_RMS && peak < QUIET_PEAK;
    if (!quietSignal) { this.reset(); return false; }
    if (this.lastSample === null || now < this.lastSample || now - this.lastSample > 300) {
      this.quietSince = now;
    }
    this.quietSince ??= now;
    this.lastSample = now;
    return now - this.quietSince >= 5000;
  }
}

export const LOW_SYSTEM_AUDIO_MESSAGE = 'System audio is very quiet. If someone is speaking, raise the call/playback volume or System volume in the recorder’s Output settings. Stop increasing it if the meter warns that audio is too loud.';

/** Advisory post-gain digital levels, not Windows volume percentages or VAD
 * speech probabilities. Amplitude alone cannot establish that speech is present.
 */
import { tNow } from '@/i18n/translate'

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

/** Advice shown beside the meter when system audio stays quiet. Translated at
 *  call time so it follows the interface language. */
export function lowSystemAudioMessage(): string {
  return tNow('feedback.lowSystemAudioAdvice');
}

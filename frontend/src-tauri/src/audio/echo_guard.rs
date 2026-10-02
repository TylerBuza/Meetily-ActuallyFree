//! Optional acoustic playback suppression for the microphone source.
//! The system loopback is the reference; matching it never proves a speaker's
//! identity. Only a strong, positively correlated match is removed, so local
//! speech over playback remains in the microphone residual.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static ENABLED: OnceLock<AtomicBool> = OnceLock::new();

fn path() -> std::path::PathBuf {
    crate::paths::install_data_root().join("mic_playback_suppression_enabled.txt")
}

fn flag() -> &'static AtomicBool {
    ENABLED.get_or_init(|| {
        let saved = std::fs::read_to_string(path())
            .map(|value| value.trim() == "true")
            .unwrap_or(false);
        AtomicBool::new(saved)
    })
}

pub fn enabled() -> bool { flag().load(Ordering::Relaxed) }

#[tauri::command]
pub fn get_mic_playback_suppression_enabled() -> bool { enabled() }

#[tauri::command]
pub fn set_mic_playback_suppression_enabled(value: bool) -> Result<(), String> {
    let file = path();
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(file, if value { "true" } else { "false" })
        .map_err(|error| error.to_string())?;
    flag().store(value, Ordering::Relaxed);
    Ok(())
}

/// A bounded reference history covers up to 250 ms of acoustic/device delay.
/// The ~50 ms window search uses every sixth sample to keep pipeline work small;
/// subtraction then uses the full-rate samples at the best lag. Uncertain
/// matches leave microphone audio untouched.
pub struct EchoGuard {
    reference: Vec<f32>,
    sample_rate: u32,
}

impl EchoGuard {
    pub fn new(sample_rate: u32) -> Self {
        Self { reference: Vec::new(), sample_rate }
    }

    pub fn reset(&mut self) { self.reference.clear(); }

    pub fn filter_window(&mut self, mic: &[f32], system: &[f32]) -> Vec<f32> {
        if mic.len() != system.len() || mic.is_empty() || self.sample_rate == 0 {
            return mic.to_vec();
        }
        self.reference.extend_from_slice(system);
        let max_lag = (self.sample_rate as usize / 4).min(self.reference.len().saturating_sub(mic.len()));
        let stride = (self.sample_rate as usize / 8_000).max(1);
        let mic_energy: f64 = mic.iter().step_by(stride).map(|&x| (x as f64).powi(2)).sum();
        // Silence and very low-level reference audio provide no useful evidence.
        if mic_energy > 1e-6 {
            let mut best = (0.0_f64, 0_usize);
            for lag in (0..=max_lag).step_by(stride) {
                let start = self.reference.len() - mic.len() - lag;
                let candidate = &self.reference[start..start + mic.len()];
                let mut dot = 0.0_f64;
                let mut system_energy = 0.0_f64;
                for (&m, &s) in mic.iter().zip(candidate).step_by(stride) {
                    dot += m as f64 * s as f64;
                    system_energy += (s as f64).powi(2);
                }
                if system_energy <= 1e-6 || dot <= 0.0 { continue; }
                let correlation = dot / (mic_energy * system_energy).sqrt();
                if correlation > best.0 { best = (correlation, lag); }
            }
            if best.0 >= 0.88 {
                let start = self.reference.len() - mic.len() - best.1;
                let candidate = &self.reference[start..start + mic.len()];
                let (dot, energy) = mic.iter().zip(candidate).fold((0.0_f64, 0.0_f64), |(dot, energy), (&m, &s)| {
                    (dot + m as f64 * s as f64, energy + (s as f64).powi(2))
                });
                if energy > 1e-6 {
                    let gain = (dot / energy).clamp(0.0, 8.0) as f32;
                    let mut residual: Vec<f32> = mic.iter().zip(candidate).map(|(&m, &s)| m - gain * s).collect();
                    let residual_energy: f64 = residual.iter().map(|&x| (x as f64).powi(2)).sum();
                    let original_energy: f64 = mic.iter().map(|&x| (x as f64).powi(2)).sum();
                    if residual_energy < original_energy * 0.04 {
                        residual.fill(0.0);
                    }
                    self.trim();
                    return residual;
                }
            }
        }
        self.trim();
        mic.to_vec()
    }

    fn trim(&mut self) {
        let keep = self.sample_rate as usize / 4 + self.sample_rate as usize / 10;
        if self.reference.len() > keep {
            self.reference.drain(..self.reference.len() - keep);
        }
    }
}

/// ASR-level fallback for microphones (notably NVIDIA Broadcast) that reshape
/// playback enough to defeat waveform correlation. A mic turn is discarded only
/// when an overlapping system turn contains most of the same ordered words.
/// This is source deduplication, never speaker identification.
fn shared_mic_words(
    mic_text: &str, mic_start: f64, mic_end: f64,
    system_text: &str, system_start: f64, system_end: f64,
) -> Option<(usize, usize)> {
    let mic_duration = mic_end - mic_start;
    let system_duration = system_end - system_start;
    let overlap = (mic_end.min(system_end) - mic_start.max(system_start)).max(0.0);
    if mic_duration <= 0.0 || system_duration <= 0.0
        || overlap < mic_duration.min(system_duration) * 0.5 { return None; }
    let words = |text: &str| -> Vec<String> {
        text.to_lowercase().split(|c: char| !c.is_alphanumeric())
            .filter(|word| !word.is_empty()).map(str::to_string).collect()
    };
    let mic = words(mic_text);
    let system = words(system_text);
    if mic.len() < 4 || system.len() < 4 { return None; }
    // Longest common subsequence tolerates ASR spelling/word differences while
    // requiring ordered matching speech, not just a shared word bag.
    let mut previous = vec![0_usize; system.len() + 1];
    for word in &mic {
        let mut current = vec![0_usize; system.len() + 1];
        for (index, other) in system.iter().enumerate() {
            current[index + 1] = if word == other {
                previous[index] + 1
            } else {
                current[index].max(previous[index + 1])
            };
        }
        previous = current;
    }
    Some((previous[system.len()], mic.len()))
}

pub fn duplicated_mic_text(
    mic_text: &str, mic_start: f64, mic_end: f64,
    system_text: &str, system_start: f64, system_end: f64,
) -> bool {
    shared_mic_words(mic_text, mic_start, mic_end, system_text, system_start, system_end)
        .is_some_and(|(common, mic_words)| common >= 4 && common * 5 >= mic_words * 3)
}

/// Ten-millisecond log-RMS frames retain speech timing after denoisers such as
/// NVIDIA Broadcast reshape the waveform. Source start times are recording-
/// relative seconds; the mic can lag the system by at most 400 ms.
pub fn rms_envelope(audio_16k: &[f32]) -> Vec<f32> {
    audio_16k.chunks_exact(160).map(|frame| {
        let energy = frame.iter().map(|&sample| sample * sample).sum::<f32>() / 160.0;
        (energy.sqrt() + 1e-5).ln()
    }).collect()
}

pub fn envelope_correlation(
    mic: &[f32], mic_origin: f64, system: &[f32], system_origin: f64,
    turn_start: f64, turn_end: f64,
) -> f32 {
    if mic.is_empty() || system.is_empty() || turn_end <= turn_start { return 0.0; }
    let first = (((turn_start - mic_origin) * 100.0).floor() as isize).max(0) as usize;
    let last = (((turn_end - mic_origin) * 100.0).ceil() as isize).max(0) as usize;
    let last = last.min(mic.len());
    if last <= first || last - first < 80 { return 0.0; }
    let mut best = 0.0_f32;
    for lag in 0..=40 {
        let mut count = 0_f64;
        let (mut sum_m, mut sum_s, mut sum_mm, mut sum_ss, mut sum_ms) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for index in first..last {
            let time = mic_origin + index as f64 / 100.0 - lag as f64 / 100.0;
            let system_index = ((time - system_origin) * 100.0).round() as isize;
            if system_index < 0 || system_index as usize >= system.len() { continue; }
            let m = mic[index] as f64;
            let s = system[system_index as usize] as f64;
            count += 1.0;
            sum_m += m; sum_s += s;
            sum_mm += m * m; sum_ss += s * s; sum_ms += m * s;
        }
        if count < 80.0 || count * 2.0 < (last - first) as f64 { continue; }
        let covariance = count * sum_ms - sum_m * sum_s;
        let variance = ((count * sum_mm - sum_m * sum_m) * (count * sum_ss - sum_s * sum_s)).sqrt();
        if variance > 1e-8 { best = best.max((covariance / variance) as f32); }
    }
    best
}

pub fn duplicated_mic_with_envelope(
    mic_text: &str, mic_start: f64, mic_end: f64, mic_envelope: &[f32], mic_origin: f64,
    system_text: &str, system_start: f64, system_end: f64, system_envelope: &[f32], system_origin: f64,
) -> bool {
    let Some((common, mic_words)) = shared_mic_words(
        mic_text, mic_start, mic_end, system_text, system_start, system_end,
    ) else { return false; };
    if common >= 4 && common * 5 >= mic_words * 3 { return true; }
    common >= 3 && common * 5 >= mic_words * 2
        && envelope_correlation(mic_envelope, mic_origin, system_envelope, system_origin, mic_start, mic_end) >= 0.68
}

/// An existing combined label may have inherited `You` from playback on the
/// mic track. Keep named remote parts, and remove `You` only when no separate
/// retained mic transcript confirms local speech at that time.
pub fn strip_unconfirmed_user_label(existing: Option<String>, enabled: bool, confirmed: bool) -> Option<String> {
    if !enabled || confirmed { return existing; }
    let label = existing?;
    let parts: Vec<&str> = label.split(" + ").collect();
    if parts.len() < 2 { return Some(label); }
    let remote: Vec<&str> = parts.into_iter().filter(|part| !part.eq_ignore_ascii_case("you")).collect();
    (!remote.is_empty()).then(|| remote.join(" + "))
}

#[cfg(test)]
mod tests {
    use super::{duplicated_mic_text, duplicated_mic_with_envelope, envelope_correlation, EchoGuard};

    fn signal(index: usize) -> f32 {
        let x = index as f32;
        0.12 * ((x * 0.017).sin() + (x * 0.041).sin())
    }

    #[test]
    fn removes_delayed_playback_but_preserves_local_voice() {
        let mut guard = EchoGuard::new(48_000);
        let delay = 2_400;
        let mut echo_energy = 0.0;
        let mut local_energy = 0.0;
        for window in 0..12 {
            let start = window * 2_400;
            let system: Vec<f32> = (start..start + 2_400).map(signal).collect();
            let mic: Vec<f32> = (start..start + 2_400).map(|i| {
                let echo = if i >= delay { signal(i - delay) * 0.6 } else { 0.0 };
                let local = if window >= 6 { 0.08 * (i as f32 * 0.071).sin() } else { 0.0 };
                echo + local
            }).collect();
            let filtered = guard.filter_window(&mic, &system);
            if window == 4 {
                echo_energy = filtered.iter().map(|x| x * x).sum();
            }
            if window == 8 {
                local_energy = filtered.iter().map(|x| x * x).sum();
            }
        }
        assert!(echo_energy < 0.01, "playback should be removed: {echo_energy}");
        assert!(local_energy > 1.0, "local speech should remain: {local_energy}");
    }

    #[test]
    fn unrelated_mic_audio_is_not_removed() {
        let mut guard = EchoGuard::new(48_000);
        let mic: Vec<f32> = (0..2_400).map(|i| (i as f32 * 0.071).sin() * 0.1).collect();
        let system: Vec<f32> = (0..2_400).map(signal).collect();
        assert_eq!(guard.filter_window(&mic, &system), mic);
    }

    #[test]
    fn duplicate_fallback_matches_recorded_asr_variants_without_dropping_local_speech() {
        assert!(duplicated_mic_text(
            "Lucky you're beautiful because there's nothing up here. What does he mean?", 55.80, 60.88,
            "Lucky you're beautiful because there's nothing up here. What? That's mean.", 55.62, 60.73,
        ));
        assert!(duplicated_mic_text(
            "Did you just call it dumb? You even screamed to dumb like women. I was like, oh, you're wearing my grandma's", 60.88, 66.36,
            "Did you just call me dumb? You went straight to dumb? Like one minute I was like, oh, you're wearing my grandma's", 60.73, 66.17,
        ));
        assert!(!duplicated_mic_text(
            "Hello, my name is Andrew and I'm testing Meetily", 8.43, 14.38,
            "You're ugly. Oh, here we go", 16.17, 21.78,
        ));
        assert!(!duplicated_mic_text(
            "I disagree because my microphone is on", 55.80, 60.88,
            "Lucky you're beautiful because there's nothing up here", 55.62, 60.73,
        ));
    }

    #[test]
    fn aligned_speech_envelopes_resolve_short_or_misheard_duplicates() {
        let system: Vec<f32> = (0..10_000).map(|i| {
            let t = i as f32;
            (t * 0.23).sin() + (t * 0.071).sin() * 0.4
        }).collect();
        let mic: Vec<f32> = (0..10_000).map(|i| {
            if i >= 22 { system[i - 22] * 0.8 } else { 0.0 }
        }).collect();
        assert!(envelope_correlation(&mic, 0.0, &system, 0.0, 74.8, 79.9) > 0.9);
        assert!(duplicated_mic_with_envelope(
            "Oh yeah. Keep going. What?", 74.81, 79.91, &mic, 0.0,
            "Not yet. No, you've got to keep going. So what's Black Widow's superpower?", 74.67, 80.58, &system, 0.0,
        ));
        assert!(duplicated_mic_with_envelope(
            "Black Widow is a superpower again, but only a couple of tazers.", 79.91, 84.95, &mic, 0.0,
            "power again. But owning is a couple of tasers or are they", 80.58, 85.61, &system, 0.0,
        ));
        assert!(!duplicated_mic_with_envelope(
            "My microphone is on and I disagree with that", 74.81, 79.91, &mic, 0.0,
            "Not yet. No, you've got to keep going. So what's Black Widow's superpower?", 74.67, 80.58, &system, 0.0,
        ));
    }
}

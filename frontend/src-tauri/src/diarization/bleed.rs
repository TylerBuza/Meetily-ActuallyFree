//! Speaker-bleed detection on the microphone source track.
//!
//! Without headphones, remote speech plays from the speakers and reaches the
//! microphone, so `mic.mp4` contains a delayed, room-filtered copy of
//! `system.mp4`. Post-processing would otherwise call that audio "You". The
//! two tracks are written from the same aligned mixer windows
//! (`audio/pipeline.rs`), so the system track is a clean reference for what
//! the speakers played.
//!
//! This is an offline residual-echo decision, not echo cancellation: no audio
//! is modified. For each 10 ms mic frame it asks whether the mic spectrum is
//! louder than the system spectrum can explain after the estimated
//! speaker→mic delay and per-band coupling. Frames with unexplained energy are
//! local speech (including double-talk); voiced frames that are fully
//! explained are bleed.
//!
//! When the delay cannot be established (headphones, muted system audio, OS
//! echo cancellation already removed the bleed) the analysis is inactive and
//! callers keep their existing behavior. It never guesses a delay.
//!
//! Units: inputs are 16 kHz mono samples sample-aligned at index 0; internal
//! frames are 10 ms (`dsp::for_each_log_mel` frame `m` starts at `m * 160`);
//! the public interface takes and returns seconds.

use super::dsp;

const FRAMES_PER_SECOND: f32 = 100.0;
/// Mel bins are pooled into coarse bands: enough spectral shape to see a local
/// voice over bleed, and an hour of audio stays ~25 MB per track.
const BANDS: usize = 16;
const BINS_PER_BAND: usize = dsp::NUM_MEL_BINS / BANDS;
/// ln-energy to dB.
const DB_PER_NEPER: f32 = 4.342_945;

/// Lag search range. The system track is captured before playback, so the
/// mic copy normally arrives later (output buffering + air path). A small
/// negative range absorbs capture-timestamp jitter between the two sources.
const MIN_LAG_FRAMES: i32 = -5;
const MAX_LAG_FRAMES: i32 = 50;
/// Delay is estimated per block so a device change or latency shift partway
/// through a meeting does not invalidate the rest of it.
const BLOCK_FRAMES: usize = 3000;
/// A block needs this much active system audio to estimate a delay.
const MIN_ACTIVE_SYSTEM_FRAMES: usize = 200;
/// Envelope correlation a block must reach before its delay is trusted. Real
/// bleed correlates strongly; independent conversation tracks stay far lower.
const MIN_BLOCK_CORRELATION: f32 = 0.5;

/// Frames this far above a track's own noise floor count as active/voiced.
const ACTIVITY_DB: f32 = 12.0;
/// A track whose loud frames never rise this far above its floor is treated
/// as silent (muted, disconnected, or zero-filled).
const MIN_DYNAMIC_RANGE_DB: f32 = 20.0;

/// A mic band must exceed the predicted bleed by this margin to be evidence
/// of a local voice. The margin absorbs coupling-estimate error and the
/// spectral variability of loudspeaker playback.
const LOCAL_MARGIN_DB: f32 = 8.0;
/// Bands that must show that excess in one frame.
const LOCAL_MIN_BANDS: usize = 3;
/// Reverberation tail: the prediction for a frame is the maximum of recent
/// system frames, each decayed by this much per 10 ms of age.
const TAIL_FRAMES: usize = 20;
const TAIL_DECAY_DB_PER_FRAME: f32 = 1.0;

/// Local runs shorter than this are treated as estimate noise.
const MIN_LOCAL_RUN_FRAMES: usize = 5;
/// Accepted local runs are widened so syllable onsets and offsets survive.
const LOCAL_HANGOVER_FRAMES: usize = 10;

/// A span is bleed when less than this share of its voiced mic frames is local.
const BLEED_MAX_LOCAL: f32 = 0.2;
/// Minimum voiced frames in a span before it can be called bleed.
const MIN_VOICED_FRAMES: usize = 10;
/// Gaps shorter than this between local regions are bridged.
const REGION_BRIDGE_FRAMES: usize = 30;
/// Local regions shorter than this are not reported as separate segments.
const MIN_REGION_FRAMES: usize = 20;

type Bands = [f32; BANDS];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Frame {
    Silent,
    Local,
    Bleed,
}

#[derive(Debug, Clone)]
pub struct BleedAnalysis {
    /// Median speaker→mic delay over blocks with a trusted estimate.
    pub delay_ms: f32,
    /// Median envelope correlation over those blocks; 0 when inactive.
    pub confidence: f32,
    /// False means no usable delay was found; every query then reports local.
    pub active: bool,
    frames: Vec<Frame>,
}

impl BleedAnalysis {
    pub fn inactive() -> Self {
        Self { delay_ms: 0.0, confidence: 0.0, active: false, frames: Vec::new() }
    }

    pub fn analyze(mic: &[f32], system: &[f32]) -> Self {
        let mic_bands = band_energies(mic);
        let sys_bands = band_energies(system);
        if mic_bands.is_empty() || sys_bands.is_empty() {
            return Self::inactive();
        }
        let mic_total: Vec<f32> = mic_bands.iter().map(total_db).collect();
        let sys_total: Vec<f32> = sys_bands.iter().map(total_db).collect();
        let (Some(mic_floor), Some(sys_floor)) = (activity_floor(&mic_total), activity_floor(&sys_total)) else {
            return Self::inactive();
        };
        let sys_active: Vec<bool> = sys_total.iter().map(|&e| e > sys_floor).collect();
        let mic_voiced: Vec<bool> = mic_total.iter().map(|&e| e > mic_floor).collect();

        let block_delays = estimate_block_delays(&mic_total, &sys_total, &sys_active);
        let trusted: Vec<(i32, f32)> = block_delays.iter().flatten().copied().collect();
        if trusted.is_empty() {
            return Self::inactive();
        }
        let global_lag = median_i32(trusted.iter().map(|(lag, _)| *lag).collect());
        let confidence = median_f32(trusted.iter().map(|(_, r)| *r).collect());
        let lag_for = |mic_frame: usize| -> i32 {
            block_delays
                .get(mic_frame / BLOCK_FRAMES)
                .copied()
                .flatten()
                .map(|(lag, _)| lag)
                .unwrap_or(global_lag)
        };

        let coupling = estimate_coupling(&mic_bands, &sys_bands, &sys_active, &lag_for);

        let mut frames = Vec::with_capacity(mic_bands.len());
        for t in 0..mic_bands.len() {
            if !mic_voiced[t] {
                frames.push(Frame::Silent);
                continue;
            }
            let Some(prediction) = predicted_bleed(&sys_bands, &sys_active, &coupling, t as i64 - lag_for(t) as i64) else {
                // No recent playback to explain this frame.
                frames.push(Frame::Local);
                continue;
            };
            let excess_bands = mic_bands[t]
                .iter()
                .zip(prediction.iter())
                .filter(|(m, p)| *m - *p >= LOCAL_MARGIN_DB)
                .count();
            frames.push(if excess_bands >= LOCAL_MIN_BANDS { Frame::Local } else { Frame::Bleed });
        }
        smooth_local(&mut frames);

        Self {
            delay_ms: global_lag as f32 * 1000.0 / FRAMES_PER_SECOND,
            confidence,
            active: true,
            frames,
        }
    }

    fn frame_range(&self, start_s: f32, end_s: f32) -> std::ops::Range<usize> {
        let to_frame = |s: f32| ((s.max(0.0) * FRAMES_PER_SECOND).round() as usize).min(self.frames.len());
        let start = to_frame(start_s);
        start..to_frame(end_s).max(start)
    }

    /// Share of voiced mic frames in the span that carry local speech. Spans
    /// with no voiced frames report 1.0: silence is not evidence of bleed.
    pub fn local_fraction(&self, start_s: f32, end_s: f32) -> f32 {
        let (local, voiced) = self.counts(start_s, end_s);
        if voiced == 0 {
            1.0
        } else {
            local as f32 / voiced as f32
        }
    }

    /// Bleed share of all voiced mic frames, for logging and voiceprint gating.
    pub fn bleed_share(&self) -> f32 {
        if !self.active {
            return 0.0;
        }
        1.0 - self.local_fraction(0.0, self.frames.len() as f32 / FRAMES_PER_SECOND)
    }

    fn counts(&self, start_s: f32, end_s: f32) -> (usize, usize) {
        let mut local = 0;
        let mut voiced = 0;
        for frame in &self.frames[self.frame_range(start_s, end_s)] {
            match frame {
                Frame::Local => {
                    local += 1;
                    voiced += 1;
                }
                Frame::Bleed => voiced += 1,
                Frame::Silent => {}
            }
        }
        (local, voiced)
    }

    /// True when the mic audio in the span is mostly a copy of speaker playback.
    pub fn is_bleed(&self, start_s: f32, end_s: f32) -> bool {
        if !self.active {
            return false;
        }
        let (local, voiced) = self.counts(start_s, end_s);
        voiced >= MIN_VOICED_FRAMES && (local as f32) < BLEED_MAX_LOCAL * voiced as f32
    }

    /// The parts of a mic segment that carry local speech. Segments without
    /// any bleed frames are returned unchanged so this never reshapes
    /// segmentation where there was nothing to remove.
    pub fn local_regions(&self, start_s: f32, end_s: f32) -> Vec<(f32, f32)> {
        if !self.active {
            return vec![(start_s, end_s)];
        }
        let range = self.frame_range(start_s, end_s);
        let frames = &self.frames[range.clone()];
        if !frames.contains(&Frame::Bleed) {
            return vec![(start_s, end_s)];
        }
        if self.is_bleed(start_s, end_s) {
            return Vec::new();
        }

        let mut runs: Vec<(usize, usize)> = Vec::new();
        let mut run_start: Option<usize> = None;
        for (i, frame) in frames.iter().enumerate() {
            match (*frame == Frame::Local, run_start) {
                (true, None) => run_start = Some(i),
                (false, Some(s)) => {
                    runs.push((s, i));
                    run_start = None;
                }
                _ => {}
            }
        }
        if let Some(s) = run_start {
            runs.push((s, frames.len()));
        }

        let mut bridged: Vec<(usize, usize)> = Vec::new();
        for run in runs {
            match bridged.last_mut() {
                Some(last) if run.0 - last.1 <= REGION_BRIDGE_FRAMES => last.1 = run.1,
                _ => bridged.push(run),
            }
        }

        bridged
            .into_iter()
            .filter(|(s, e)| e - s >= MIN_REGION_FRAMES)
            .map(|(s, e)| {
                let to_secs = |f: usize| (range.start + f) as f32 / FRAMES_PER_SECOND;
                (to_secs(s).max(start_s), to_secs(e).min(end_s))
            })
            .filter(|(s, e)| e > s)
            .collect()
    }
}

/// Pool mel bins into `BANDS` dB energies per 10 ms frame.
fn band_energies(samples: &[f32]) -> Vec<Bands> {
    let mut out = Vec::with_capacity(samples.len() / 160 + 1);
    dsp::for_each_log_mel(samples, |row| {
        let mut bands = [0f32; BANDS];
        for (b, band) in bands.iter_mut().enumerate() {
            let linear: f32 = row[b * BINS_PER_BAND..(b + 1) * BINS_PER_BAND].iter().map(|v| v.exp()).sum();
            *band = linear.ln() * DB_PER_NEPER;
        }
        out.push(bands);
    });
    out
}

fn total_db(bands: &Bands) -> f32 {
    let linear: f32 = bands.iter().map(|db| 10f32.powf(db / 10.0)).sum();
    10.0 * linear.max(f32::MIN_POSITIVE).log10()
}

/// Level above which a frame counts as active, from the track's own floor
/// (10th percentile). `None` when the track has no usable dynamic range.
fn activity_floor(total: &[f32]) -> Option<f32> {
    let mut sorted = total.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let floor = sorted[sorted.len() / 10];
    let loud = sorted[sorted.len() * 98 / 100];
    (loud - floor >= MIN_DYNAMIC_RANGE_DB).then_some(floor + ACTIVITY_DB)
}

/// Per block: the lag (mic frame = system frame + lag) maximizing the Pearson
/// correlation of the two envelopes over active system frames, if trusted.
fn estimate_block_delays(mic_total: &[f32], sys_total: &[f32], sys_active: &[bool]) -> Vec<Option<(i32, f32)>> {
    let blocks = mic_total.len().div_ceil(BLOCK_FRAMES);
    (0..blocks)
        .map(|block| {
            let start = block * BLOCK_FRAMES;
            let end = (start + BLOCK_FRAMES).min(sys_total.len());
            if start >= end || sys_active[start..end].iter().filter(|&&a| a).count() < MIN_ACTIVE_SYSTEM_FRAMES {
                return None;
            }
            let mut best: Option<(i32, f32)> = None;
            for lag in MIN_LAG_FRAMES..=MAX_LAG_FRAMES {
                let pairs = (start..end).filter(|&s| sys_active[s]).filter_map(|s| {
                    let m = s as i64 + lag as i64;
                    (m >= 0 && (m as usize) < mic_total.len()).then(|| (sys_total[s], mic_total[m as usize]))
                });
                if let Some(r) = pearson(pairs) {
                    if best.map_or(true, |(_, br)| r > br) {
                        best = Some((lag, r));
                    }
                }
            }
            best.filter(|(_, r)| *r >= MIN_BLOCK_CORRELATION)
        })
        .collect()
}

fn pearson(pairs: impl Iterator<Item = (f32, f32)>) -> Option<f32> {
    let (mut n, mut sx, mut sy, mut sxx, mut syy, mut sxy) = (0f64, 0f64, 0f64, 0f64, 0f64, 0f64);
    for (x, y) in pairs {
        let (x, y) = (x as f64, y as f64);
        n += 1.0;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
    }
    if n < MIN_ACTIVE_SYSTEM_FRAMES as f64 {
        return None;
    }
    let cov = sxy - sx * sy / n;
    let vx = sxx - sx * sx / n;
    let vy = syy - sy * sy / n;
    (vx > 1e-6 && vy > 1e-6).then(|| (cov / (vx * vy).sqrt()) as f32)
}

/// Per-band dB offset from system playback to its copy on the mic. The median
/// over all active playback frames is robust to the minority of frames where
/// the user talks over the remote speaker.
fn estimate_coupling(
    mic_bands: &[Bands],
    sys_bands: &[Bands],
    sys_active: &[bool],
    lag_for: &impl Fn(usize) -> i32,
) -> Bands {
    let mut diffs: Vec<Vec<f32>> = vec![Vec::new(); BANDS];
    for (t, mic) in mic_bands.iter().enumerate() {
        let s = t as i64 - lag_for(t) as i64;
        if s < 0 || s as usize >= sys_bands.len() || !sys_active[s as usize] {
            continue;
        }
        for b in 0..BANDS {
            diffs[b].push(mic[b] - sys_bands[s as usize][b]);
        }
    }
    let mut coupling = [0f32; BANDS];
    for (b, values) in diffs.into_iter().enumerate() {
        coupling[b] = if values.is_empty() { 0.0 } else { median_f32(values) };
    }
    coupling
}

/// Expected mic band levels from playback at system frame `s` and its decaying
/// tail, or `None` when nothing was playing recently.
fn predicted_bleed(sys_bands: &[Bands], sys_active: &[bool], coupling: &Bands, s: i64) -> Option<Bands> {
    let mut prediction = [f32::NEG_INFINITY; BANDS];
    let mut any = false;
    for age in 0..=TAIL_FRAMES {
        let idx = s - age as i64;
        if idx < 0 || idx as usize >= sys_bands.len() || !sys_active[idx as usize] {
            continue;
        }
        any = true;
        let decay = age as f32 * TAIL_DECAY_DB_PER_FRAME;
        for b in 0..BANDS {
            prediction[b] = prediction[b].max(sys_bands[idx as usize][b] + coupling[b] - decay);
        }
    }
    any.then_some(prediction)
}

/// Drop short local runs, then widen the rest into neighbouring voiced frames.
fn smooth_local(frames: &mut [Frame]) {
    let mut i = 0;
    while i < frames.len() {
        if frames[i] != Frame::Local {
            i += 1;
            continue;
        }
        let start = i;
        while i < frames.len() && frames[i] == Frame::Local {
            i += 1;
        }
        if i - start < MIN_LOCAL_RUN_FRAMES {
            frames[start..i].fill(Frame::Bleed);
        }
    }

    let original = frames.to_vec();
    for (i, frame) in original.iter().enumerate() {
        if *frame != Frame::Local {
            continue;
        }
        let lo = i.saturating_sub(LOCAL_HANGOVER_FRAMES);
        let hi = (i + LOCAL_HANGOVER_FRAMES + 1).min(frames.len());
        for f in &mut frames[lo..hi] {
            if *f == Frame::Bleed {
                *f = Frame::Local;
            }
        }
    }
}

fn median_f32(mut values: Vec<f32>) -> f32 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    values[values.len() / 2]
}

fn median_i32(mut values: Vec<i32>) -> i32 {
    values.sort_unstable();
    values[values.len() / 2]
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: usize = 16_000;

    /// Deterministic xorshift noise in [-1, 1].
    struct Noise(u64);
    impl Noise {
        fn next(&mut self) -> f32 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 40) as f32 / (1u64 << 23) as f32 - 1.0
        }
    }

    /// Speech-like signal: noise shaped by a syllable-rate (≈4 Hz) envelope,
    /// active only inside the given second ranges.
    fn talker(seed: u64, secs: f32, talk: &[(f32, f32)], amp: f32) -> Vec<f32> {
        let mut noise = Noise(seed);
        let mut rate = Noise(seed ^ 0x9e37_79b9);
        let n = (secs * SR as f32) as usize;
        let mut out = vec![0f32; n];
        let mut syllable_gain = 1.0f32;
        for (i, sample) in out.iter_mut().enumerate() {
            if i % (SR / 8) == 0 {
                syllable_gain = 0.3 + 0.7 * rate.next().abs();
            }
            let t = i as f32 / SR as f32;
            if talk.iter().any(|(s, e)| t >= *s && t < *e) {
                let envelope = (std::f32::consts::PI * 4.0 * t).sin().abs();
                *sample = amp * syllable_gain * envelope * noise.next();
            }
        }
        out
    }

    /// Room/loudspeaker stand-in: delay, attenuate, one-pole low-pass.
    fn through_speakers(system: &[f32], delay_ms: usize, gain: f32) -> Vec<f32> {
        let delay = delay_ms * SR / 1000;
        let mut out = vec![0f32; system.len()];
        let mut state = 0f32;
        for i in 0..system.len() {
            let x = if i >= delay { system[i - delay] } else { 0.0 };
            state += 0.5 * (x - state);
            out[i] = gain * state;
        }
        out
    }

    fn add(a: &mut [f32], b: &[f32]) {
        for (x, y) in a.iter_mut().zip(b) {
            *x += y;
        }
    }

    fn with_noise_floor(mut signal: Vec<f32>, seed: u64) -> Vec<f32> {
        let mut noise = Noise(seed);
        for s in signal.iter_mut() {
            *s += 0.0005 * noise.next();
        }
        signal
    }

    const REMOTE: &[(f32, f32)] = &[(2.0, 12.0), (20.0, 32.0), (40.0, 50.0)];

    #[test]
    fn pure_bleed_is_detected_at_several_delays() {
        for delay_ms in [0usize, 150, 400] {
            let system = with_noise_floor(talker(1, 60.0, REMOTE, 0.3), 2);
            let mic = with_noise_floor(through_speakers(&system, delay_ms, 0.1), 3);
            let analysis = BleedAnalysis::analyze(&mic, &system);

            assert!(analysis.active, "delay {delay_ms}: inactive");
            assert!(
                (analysis.delay_ms - delay_ms as f32).abs() <= 20.0,
                "delay {delay_ms}: estimated {}",
                analysis.delay_ms
            );
            for (s, e) in REMOTE {
                assert!(analysis.is_bleed(*s, *e), "delay {delay_ms}: {s}-{e} not bleed");
                assert!(analysis.local_regions(*s, *e).is_empty());
            }
        }
    }

    #[test]
    fn local_speech_without_playback_stays_local() {
        let system = with_noise_floor(talker(1, 60.0, REMOTE, 0.3), 2);
        let mut mic = through_speakers(&system, 150, 0.1);
        add(&mut mic, &talker(7, 60.0, &[(14.0, 19.0), (34.0, 38.0)], 0.3));
        let mic = with_noise_floor(mic, 3);
        let analysis = BleedAnalysis::analyze(&mic, &system);

        assert!(analysis.active);
        assert!(!analysis.is_bleed(14.0, 19.0));
        assert!(!analysis.is_bleed(34.0, 38.0));
        assert_eq!(analysis.local_regions(14.0, 19.0), vec![(14.0, 19.0)]);
        assert!(analysis.is_bleed(20.0, 32.0));
    }

    #[test]
    fn double_talk_is_kept_as_local() {
        let system = with_noise_floor(talker(1, 60.0, REMOTE, 0.3), 2);
        let mut mic = through_speakers(&system, 150, 0.1);
        add(&mut mic, &talker(7, 60.0, &[(24.0, 28.0)], 0.3));
        let mic = with_noise_floor(mic, 3);
        let analysis = BleedAnalysis::analyze(&mic, &system);

        assert!(analysis.active);
        assert!(!analysis.is_bleed(24.0, 28.0));
        assert!(analysis.local_fraction(24.5, 27.5) > 0.8);
        let regions = analysis.local_regions(20.0, 32.0);
        assert_eq!(regions.len(), 1, "{regions:?}");
        let (s, e) = regions[0];
        assert!(s >= 23.5 && s <= 24.5 && e >= 27.5 && e <= 28.5, "{regions:?}");
    }

    #[test]
    fn uncorrelated_tracks_are_inactive() {
        let system = with_noise_floor(talker(1, 60.0, REMOTE, 0.3), 2);
        let mic = with_noise_floor(talker(9, 60.0, &[(5.0, 15.0), (25.0, 45.0)], 0.3), 3);
        let analysis = BleedAnalysis::analyze(&mic, &system);

        assert!(!analysis.active, "delay {} confidence {}", analysis.delay_ms, analysis.confidence);
        assert!(!analysis.is_bleed(25.0, 45.0));
        assert_eq!(analysis.local_regions(25.0, 45.0), vec![(25.0, 45.0)]);
    }

    #[test]
    fn silent_system_track_is_inactive() {
        let system = vec![0f32; 60 * SR];
        let mic = with_noise_floor(talker(9, 60.0, &[(5.0, 15.0)], 0.3), 3);
        let analysis = BleedAnalysis::analyze(&mic, &system);

        assert!(!analysis.active);
        assert_eq!(analysis.bleed_share(), 0.0);
    }

    #[test]
    fn muted_microphone_has_no_local_speech() {
        let system = with_noise_floor(talker(1, 60.0, REMOTE, 0.3), 2);
        let mic = vec![0f32; 60 * SR];
        let analysis = BleedAnalysis::analyze(&mic, &system);

        assert!(!analysis.active);
        assert!(!analysis.is_bleed(0.0, 60.0));
    }

    #[test]
    fn delay_change_partway_through_is_tracked_per_block() {
        let talk: Vec<(f32, f32)> = (0..12).map(|i| (i as f32 * 10.0 + 1.0, i as f32 * 10.0 + 8.0)).collect();
        let system = with_noise_floor(talker(1, 120.0, &talk, 0.3), 2);
        let early = through_speakers(&system, 100, 0.1);
        let late = through_speakers(&system, 350, 0.1);
        let switch = 60 * SR;
        let mic: Vec<f32> = early[..switch].iter().chain(&late[switch..]).copied().collect();
        let analysis = BleedAnalysis::analyze(&with_noise_floor(mic, 3), &system);

        assert!(analysis.active);
        for (s, e) in &talk {
            assert!(analysis.is_bleed(*s, *e), "{s}-{e} not bleed");
        }
    }

    #[test]
    fn out_of_range_queries_are_safe() {
        let analysis = BleedAnalysis::inactive();
        assert_eq!(analysis.local_fraction(5.0, 1.0), 1.0);
        assert_eq!(analysis.local_regions(1.0, 2.0), vec![(1.0, 2.0)]);
        let system = with_noise_floor(talker(1, 60.0, REMOTE, 0.3), 2);
        let mic = with_noise_floor(through_speakers(&system, 150, 0.1), 3);
        let active = BleedAnalysis::analyze(&mic, &system);
        assert!(active.local_regions(500.0, 600.0).len() <= 1);
        assert!(!active.is_bleed(-5.0, -1.0));
    }
}

/// Headless check against a real meeting folder holding `mic.mp4` and
/// `system.mp4`. Skipped unless `BLEED_MEETING_DIR` is set, e.g.:
///
/// ```text
/// BLEED_MEETING_DIR=~/.../Meeting cargo test --release --lib \
///   bleed_real_meeting -- --ignored --nocapture
/// ```
#[cfg(test)]
mod real_meeting {
    use super::*;

    #[test]
    #[ignore = "requires a private local recording"]
    fn bleed_real_meeting() {
        let dir = std::path::PathBuf::from(std::env::var("BLEED_MEETING_DIR").expect("BLEED_MEETING_DIR"));
        let decode = |name: &str| {
            crate::audio::decoder::decode_audio_file(&dir.join(name)).expect(name).to_whisper_format()
        };
        let (mic, system) = (decode("mic.mp4"), decode("system.mp4"));
        let started = std::time::Instant::now();
        let analysis = BleedAnalysis::analyze(&mic, &system);
        println!(
            "{:.0} s audio analyzed in {:.1} s: active={} delay={:.0} ms confidence={:.2} bleed_share={:.0}%",
            mic.len() as f32 / 16_000.0,
            started.elapsed().as_secs_f32(),
            analysis.active,
            analysis.delay_ms,
            analysis.confidence,
            analysis.bleed_share() * 100.0
        );

        // Mic speech chunks the retranscription filter would keep or drop.
        let chunks = crate::audio::vad::get_speech_chunks_with_thresholds_and_progress(&mic, 2000, 0.20, 0.10, |_, _| true)
            .expect("mic VAD");
        let mut dropped = 0;
        for chunk in &chunks {
            let (s, e) = ((chunk.start_timestamp_ms / 1000.0) as f32, (chunk.end_timestamp_ms / 1000.0) as f32);
            let bleed = analysis.is_bleed(s, e);
            dropped += bleed as usize;
            println!("{s:8.2}-{e:8.2}  local={:.2}  {}", analysis.local_fraction(s, e), if bleed { "DROP" } else { "keep" });
        }
        println!("would drop {dropped} of {} mic chunks", chunks.len());

        // Stored transcript lines whose "You" hint would no longer apply.
        let Ok(json) = std::fs::read_to_string(dir.join("transcripts.json")) else { return };
        let transcripts: serde_json::Value = serde_json::from_str(&json).expect("transcripts.json");
        let mut tally: std::collections::BTreeMap<String, (usize, usize)> = Default::default();
        for line in transcripts["segments"].as_array().into_iter().flatten() {
            let (Some(s), Some(e)) = (line["audio_start_time"].as_f64(), line["audio_end_time"].as_f64()) else { continue };
            let label = line["speaker"].as_str().unwrap_or("").to_string();
            let entry = tally.entry(label).or_default();
            entry.0 += 1;
            entry.1 += analysis.is_bleed(s as f32, e as f32) as usize;
        }
        for (label, (lines, bleed)) in tally {
            println!("label {label:?}: {lines} lines, {bleed} mic-bleed");
        }
    }
}

//! Microphone echo cancellation, using the captured computer audio as the
//! reference, the way Granola and Hyprnote do it.
//!
//! With built-in speakers the microphone also hears the call. Without this,
//! the far side lands in both tracks: doubled, with a slight echo, and
//! transcribed as "You". The microphone stays raw (no Apple voice processing),
//! so other apps are not ducked. Skipped when the output is headphones.
//!
//! Two engines, measured on real built-in mic/speaker recordings with the
//! user's voice and the speaker echo recorded separately and mixed (so the
//! clean voice is known):
//!
//! | engine            | echo removed | voice in double talk (SI-SDR) |
//! |-------------------|--------------|-------------------------------|
//! | neural (DTLN-aec) | ~42 dB       | ~13.7 dB                      |
//! | WebRTC AEC3       | ~32 dB       | ~8.3 dB                       |
//!
//! The neural engine is the default; AEC3 is the fallback when the model
//! cannot load, or with `MEETILY_AEC=aec3`. Both only cancel echo that arrives
//! after its reference, and system chunks are stamped when processed, so both
//! tracks leave the canceller `LEAD_MS` later than they entered it: that lead
//! lets the reference be fed ahead of its echo while the saved tracks stay
//! aligned.

use log::{info, warn};
use realfft::RealFftPlanner;
use sonora::config::EchoCanceller;
use sonora::{AudioProcessing, Config, StreamConfig};
use std::collections::VecDeque;

use super::neural_echo::{self, NeuralEcho};

/// Delay of both output tracks relative to the input windows.
const LEAD_MS: usize = 160;
/// Log reduction about every 10 s of audio.
const STATS_EVERY_MS: usize = 10_000;

pub struct MicEchoCanceller {
    engine: Engine,
    sys_delay: VecDeque<f32>,
    /// Raw mic delayed like the output, for the before/after log.
    raw_delay: VecDeque<f32>,
    stats: Stats,
}

enum Engine {
    Neural(NeuralPath),
    Aec3(Aec3Path),
}

impl MicEchoCanceller {
    /// The neural engine at 48 kHz unless `MEETILY_AEC=aec3` or the model fails
    /// to load; AEC3 otherwise.
    pub fn new(sample_rate: u32) -> Self {
        Self::with_engine(sample_rate, std::env::var("MEETILY_AEC").as_deref() != Ok("aec3"))
    }

    fn with_engine(sample_rate: u32, neural: bool) -> Self {
        let lead = sample_rate as usize * LEAD_MS / 1000;
        let engine = if !neural || sample_rate != 48_000 {
            Engine::Aec3(Aec3Path::new(sample_rate, lead))
        } else {
            match NeuralPath::new(lead) {
                Ok(path) => Engine::Neural(path),
                Err(e) => {
                    warn!("🔇 Neural echo cancellation unavailable ({e}); using WebRTC AEC3");
                    Engine::Aec3(Aec3Path::new(sample_rate, lead))
                }
            }
        };
        info!(
            "🔇 Mic echo cancellation on: {} (computer audio as reference)",
            match engine { Engine::Neural(_) => "neural DTLN-aec", Engine::Aec3(_) => "WebRTC AEC3" }
        );
        Self {
            engine,
            sys_delay: std::iter::repeat(0.0).take(lead).collect(),
            raw_delay: std::iter::repeat(0.0).take(lead).collect(),
            stats: Stats::new(sample_rate),
        }
    }

    /// Takes time-aligned mic/system windows and returns them `LEAD_MS` later,
    /// with the speaker playback removed from the mic. Both stay aligned, so
    /// every consumer (VAD, saved tracks, mixed audio) sees the same timeline.
    pub fn process(&mut self, mic: &mut Vec<f32>, sys: &mut Vec<f32>) {
        let n = mic.len().min(sys.len());
        let cleaned = match &mut self.engine {
            Engine::Neural(path) => path.process(&mic[..n], &sys[..n]),
            Engine::Aec3(path) => path.process(&mic[..n], &sys[..n]),
        };
        self.sys_delay.extend(&sys[..n]);
        let sys_out: Vec<f32> = self.sys_delay.drain(..n).collect();
        self.raw_delay.extend(&mic[..n]);
        let raw: Vec<f32> = self.raw_delay.drain(..n).collect();
        let lag = match &self.engine {
            Engine::Neural(path) => path.lag_ms(),
            Engine::Aec3(path) => path.delay_ms(),
        };
        self.stats.add(&raw, &cleaned, &sys_out, lag);
        *mic = cleaned;
        *sys = sys_out;
    }

    /// The last `LEAD_MS` of both tracks, for the final flush.
    pub fn drain(&mut self) -> (Vec<f32>, Vec<f32>) {
        let mut mic = vec![0.0; self.sys_delay.len()];
        let mut sys = vec![0.0; self.sys_delay.len()];
        self.process(&mut mic, &mut sys);
        (mic, sys)
    }
}

/// Before/after energy while computer audio plays, logged about every 10 s.
/// "Before" is the delayed raw mic, kept by each engine.
struct Stats {
    pre: f64,
    post: f64,
    samples: usize,
    every: usize,
}

impl Stats {
    fn new(sample_rate: u32) -> Self {
        Self { pre: 0.0, post: 0.0, samples: 0, every: sample_rate as usize * STATS_EVERY_MS / 1000 }
    }

    fn add(&mut self, raw: &[f32], cleaned: &[f32], reference: &[f32], lag_ms: Option<i64>) {
        // Only windows with computer audio playing say anything about echo.
        if energy(reference) > 1e-6 * reference.len() as f64 {
            self.pre += energy(raw);
            self.post += energy(cleaned);
        }
        self.samples += raw.len();
        if self.samples >= self.every {
            if self.pre > 0.0 {
                info!(
                    "🔇 Mic echo cancellation: mic {:.1} dB → {:.1} dB while computer audio played ({:.1} dB removed); echo lag {:?} ms",
                    db(self.pre), db(self.post), db(self.pre) - db(self.post), lag_ms,
                );
            }
            *self = Self::new_every(self.every);
        }
    }

    fn new_every(every: usize) -> Self {
        Self { pre: 0.0, post: 0.0, samples: 0, every }
    }
}

fn energy(s: &[f32]) -> f64 {
    s.iter().map(|&v| (v as f64) * (v as f64)).sum()
}

fn db(e: f64) -> f64 {
    10.0 * (e + 1e-12).log10()
}

// ---------------------------------------------------------------------------
// Neural engine (48 kHz in/out, DTLN-aec at 16 kHz)
// ---------------------------------------------------------------------------

/// Echo lag assumed until the estimator locks (measured ~107 ms between the
/// system window and its echo in the mic on a MacBook Pro's built-in speakers).
const DEFAULT_LAG_MS: i64 = 100;
/// The model works best with the reference 5-40 ms ahead of its echo
/// (measured plateau); aim for the middle so estimator error stays inside it.
const REFERENCE_LEAD_MS: i64 = 20;
/// Mic held back before the model, so a reference up to this much *later*
/// than its echo (minus `REFERENCE_LEAD_MS`) can still be fed ahead of it.
const MIC_HOLD_MS: i64 = 100;
/// Longest echo lag searched and supported.
const MAX_LAG_MS: i64 = 500;

struct NeuralPath {
    model: NeuralEcho,
    down_mic: Decimator,
    down_ref: Decimator,
    up: Interpolator,
    /// 16 kHz mic awaiting the model; starts with `MIC_HOLD_MS` of silence.
    mic16: VecDeque<f32>,
    /// 16 kHz reference history; `ref_base` is the absolute index of its front.
    ref16: VecDeque<f32>,
    ref_base: i64,
    /// Absolute 16 kHz index of the next mic sample to process.
    mic_next: i64,
    lag: LagEstimator,
    /// Echo lag in use, in 16 kHz samples.
    lag_in_use: i64,
    /// Cleaned 48 kHz mic awaiting output.
    out48: VecDeque<f32>,
}

impl NeuralPath {
    fn new(lead48: usize) -> anyhow::Result<Self> {
        let model = NeuralEcho::new(neural_echo::MODEL_1, neural_echo::MODEL_2, neural_echo::MODEL_STATE_SIZE)?;
        let hold = ms16(MIC_HOLD_MS);
        // Fixed latency of the chain, in 48 kHz samples: both FIRs plus the
        // mic hold and the model's overlap-add, the latter two at 16 kHz.
        let chain = 2 * FIR_DELAY_48 + 3 * (hold as usize + neural_echo::LATENCY);
        anyhow::ensure!(chain < lead48, "LEAD_MS too short for the neural chain");
        Ok(Self {
            model,
            down_mic: Decimator::new(),
            down_ref: Decimator::new(),
            up: Interpolator::new(),
            mic16: std::iter::repeat(0.0).take(hold as usize).collect(),
            ref16: VecDeque::new(),
            ref_base: 0,
            mic_next: -hold,
            lag: LagEstimator::new(),
            lag_in_use: ms16(DEFAULT_LAG_MS),
            out48: std::iter::repeat(0.0).take(lead48 - chain).collect(),
        })
    }

    fn lag_ms(&self) -> Option<i64> {
        Some(self.lag_in_use * 1000 / 16_000)
    }

    #[cfg(test)]
    fn locked_lag(&self) -> i64 {
        self.lag_in_use
    }

    fn process(&mut self, mic48: &[f32], sys48: &[f32]) -> Vec<f32> {
        let mic16 = self.down_mic.process(mic48);
        let ref16 = self.down_ref.process(sys48);
        if let Some(lag) = self.lag.observe(&mic16, &ref16) {
            let lag = lag.clamp(ms16(REFERENCE_LEAD_MS - MIC_HOLD_MS), ms16(MAX_LAG_MS));
            if lag != self.lag_in_use {
                info!("🔇 Echo lag locked at {} ms", lag * 1000 / 16_000);
                // A shift inside the model's 5-40 ms tolerance keeps its state;
                // a larger one means a new echo path, so start it fresh.
                if (lag - self.lag_in_use).abs() > ms16(15) {
                    self.model.reset();
                }
                self.lag_in_use = lag;
            }
        }
        self.mic16.extend(mic16);
        self.ref16.extend(ref16);

        // Each hop of mic pairs with the reference `lag - lead` earlier. With the
        // mic held back, that reference has always arrived already.
        let hop = neural_echo::HOP;
        let mut cleaned16 = Vec::new();
        while self.mic16.len() >= hop {
            let ref_start = self.mic_next - self.lag_in_use + ms16(REFERENCE_LEAD_MS);
            let reference: Vec<f32> = (ref_start..ref_start + hop as i64)
                .map(|i| {
                    let k = i - self.ref_base;
                    if k >= 0 && (k as usize) < self.ref16.len() { self.ref16[k as usize] } else { 0.0 }
                })
                .collect();
            let mic: Vec<f32> = self.mic16.drain(..hop).collect();
            match self.model.process(&mic, &reference) {
                Ok(out) => cleaned16.extend(out),
                Err(e) => {
                    warn!("Neural echo cancellation failed for a hop: {e}");
                    cleaned16.extend(mic);
                }
            }
            self.mic_next += hop as i64;
        }
        // Keep only the reference history a future hop can still need.
        let keep_from = self.mic_next - ms16(MAX_LAG_MS) - 1;
        while self.ref_base < keep_from && !self.ref16.is_empty() {
            self.ref16.pop_front();
            self.ref_base += 1;
        }

        self.out48.extend(self.up.process(&cleaned16));
        let n = mic48.len();
        if self.out48.len() < n {
            warn!("Neural echo cancellation fell behind; padding {} samples", n - self.out48.len());
            self.out48.resize(n, 0.0);
        }
        self.out48.drain(..n).collect()
    }
}

fn ms16(ms: i64) -> i64 {
    ms * 16
}

// ---------------------------------------------------------------------------
// 48 kHz <-> 16 kHz with linear-phase FIRs of known, integer delay
// ---------------------------------------------------------------------------

const FIR_TAPS: usize = 97;
/// Group delay of the FIR, in 48 kHz samples (16 samples at 16 kHz).
const FIR_DELAY_48: usize = (FIR_TAPS - 1) / 2;

/// Blackman-windowed sinc low-pass at 7 kHz (48 kHz rate), unity DC gain.
fn fir() -> [f32; FIR_TAPS] {
    let fc = 7_000.0 / 48_000.0;
    let mid = FIR_DELAY_48 as f64;
    let mut h = [0f32; FIR_TAPS];
    let mut sum = 0.0;
    for (i, tap) in h.iter_mut().enumerate() {
        let x = i as f64 - mid;
        let sinc = if x == 0.0 { 2.0 * fc } else { (2.0 * std::f64::consts::PI * fc * x).sin() / (std::f64::consts::PI * x) };
        let w = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (FIR_TAPS - 1) as f64).cos()
            + 0.08 * (4.0 * std::f64::consts::PI * i as f64 / (FIR_TAPS - 1) as f64).cos();
        *tap = (sinc * w) as f32;
        sum += sinc * w;
    }
    h.iter_mut().for_each(|t| *t /= sum as f32);
    h
}

/// 48 kHz → 16 kHz.
struct Decimator {
    h: [f32; FIR_TAPS],
    history: VecDeque<f32>,
    phase: usize,
}

impl Decimator {
    fn new() -> Self {
        Self { h: fir(), history: std::iter::repeat(0.0).take(FIR_TAPS).collect(), phase: 0 }
    }

    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        let mut out = Vec::with_capacity(input.len() / 3 + 1);
        for &x in input {
            self.history.pop_front();
            self.history.push_back(x);
            self.phase = (self.phase + 1) % 3;
            if self.phase == 0 {
                out.push(self.history.iter().rev().zip(&self.h).map(|(a, b)| a * b).sum());
            }
        }
        out
    }
}

/// 16 kHz → 48 kHz (zero-stuffing and the same low-pass, gain 3).
struct Interpolator {
    h: [f32; FIR_TAPS],
    history: VecDeque<f32>,
}

impl Interpolator {
    fn new() -> Self {
        Self { h: fir(), history: std::iter::repeat(0.0).take(FIR_TAPS).collect() }
    }

    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        let mut out = Vec::with_capacity(input.len() * 3);
        for &x in input {
            for stuffed in [3.0 * x, 0.0, 0.0] {
                self.history.pop_front();
                self.history.push_back(stuffed);
                out.push(self.history.iter().rev().zip(&self.h).map(|(a, b)| a * b).sum());
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Echo lag estimation (GCC-PHAT on 16 kHz mic and reference)
// ---------------------------------------------------------------------------

const LAG_WINDOW: usize = 16_384; // ~1 s
const LAG_EVERY: usize = 8_000; // 0.5 s
/// Peak height over the correlation's spread needed to trust an estimate.
const LAG_MIN_CONFIDENCE: f32 = 8.0;

struct LagEstimator {
    mic: VecDeque<f32>,
    reference: VecDeque<f32>,
    since: usize,
    last: Option<i64>,
    planner: RealFftPlanner<f32>,
}

impl LagEstimator {
    fn new() -> Self {
        Self { mic: VecDeque::new(), reference: VecDeque::new(), since: 0, last: None, planner: RealFftPlanner::new() }
    }

    /// Feed new 16 kHz samples (same span for both). Returns a lag (16 kHz
    /// samples, echo after reference is positive) once two consecutive
    /// confident estimates agree within 2 ms.
    fn observe(&mut self, mic: &[f32], reference: &[f32]) -> Option<i64> {
        self.mic.extend(mic);
        self.reference.extend(reference);
        while self.mic.len() > LAG_WINDOW { self.mic.pop_front(); }
        while self.reference.len() > LAG_WINDOW { self.reference.pop_front(); }
        self.since += mic.len();
        if self.since < LAG_EVERY || self.mic.len() < LAG_WINDOW || self.reference.len() < LAG_WINDOW {
            return None;
        }
        self.since = 0;
        let estimate = self.estimate();
        let agreed = match (estimate, self.last) {
            (Some(now), Some(before)) if (now - before).abs() <= ms16(2) => Some((now + before) / 2),
            _ => None,
        };
        self.last = estimate;
        agreed
    }

    fn estimate(&mut self) -> Option<i64> {
        let n = 2 * LAG_WINDOW;
        let fft = self.planner.plan_fft_forward(n);
        let ifft = self.planner.plan_fft_inverse(n);
        let mut a: Vec<f32> = self.mic.iter().copied().chain(std::iter::repeat(0.0)).take(n).collect();
        let mut b: Vec<f32> = self.reference.iter().copied().chain(std::iter::repeat(0.0)).take(n).collect();
        // Need real playback in the window (mean power above -60 dBFS).
        if energy(&b[..LAG_WINDOW]) < 1e-6 * LAG_WINDOW as f64 {
            return None;
        }
        let mut fa = fft.make_output_vec();
        let mut fb = fft.make_output_vec();
        fft.process(&mut a, &mut fa).ok()?;
        fft.process(&mut b, &mut fb).ok()?;
        let mut cross: Vec<_> = fa.iter().zip(&fb).map(|(x, y)| { let v = x * y.conj(); v / (v.norm() + 1e-9) }).collect();
        let mut corr = vec![0.0f32; n];
        ifft.process(&mut cross, &mut corr).ok()?;
        let at = |lag: i64| corr[lag.rem_euclid(n as i64) as usize];
        let range = ms16(REFERENCE_LEAD_MS - MIC_HOLD_MS)..=ms16(MAX_LAG_MS);
        let (best, peak) = range.clone().map(|l| (l, at(l))).max_by(|x, y| x.1.total_cmp(&y.1))?;
        let values: Vec<f32> = range.filter(|l| (l - best).abs() > ms16(5)).map(|l| at(l).abs()).collect();
        let mean = values.iter().sum::<f32>() / values.len() as f32;
        let spread = (values.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / values.len() as f32).sqrt();
        ((peak - mean) / spread.max(1e-12) >= LAG_MIN_CONFIDENCE).then_some(best)
    }
}

// ---------------------------------------------------------------------------
// WebRTC AEC3 engine (fallback)
// ---------------------------------------------------------------------------

/// AEC3 processes 10 ms frames.
const FRAME_MS: usize = 10;
/// AEC3's own capture-path delay, taken out of the mic hold so both tracks
/// still leave exactly `LEAD_MS` later. Measured: 430 samples at 48 kHz (its
/// three-band filter bank adds ~1 ms), 8 ms at 16 kHz.
fn aec3_delay_samples(sample_rate: u32) -> usize {
    if sample_rate == 48_000 { 430 } else { sample_rate as usize * 8 / 1000 }
}

struct Aec3Path {
    apm: AudioProcessing,
    frame: usize,
    out: Vec<f32>,
    mic_delay: VecDeque<f32>,
}

impl Aec3Path {
    fn new(sample_rate: u32, lead: usize) -> Self {
        // Meetily high-passes the mic at capture; AEC3's own filter would only
        // add phase distortion to the voice (measured correlation 0.67 → 1.0).
        let config = Config {
            echo_canceller: Some(EchoCanceller { enforce_high_pass_filtering: false, ..Default::default() }),
            ..Default::default()
        };
        let stream = StreamConfig::new(sample_rate, 1);
        let apm = AudioProcessing::builder().config(config).capture_config(stream).render_config(stream).build();
        let frame = sample_rate as usize * FRAME_MS / 1000;
        let hold = lead - aec3_delay_samples(sample_rate);
        Self { apm, frame, out: vec![0.0; frame], mic_delay: std::iter::repeat(0.0).take(hold).collect() }
    }

    fn delay_ms(&self) -> Option<i64> {
        self.apm.statistics().delay_median_ms.map(i64::from)
    }

    /// Reference now; the mic from `LEAD_MS` ago, whose echo it contains.
    fn process(&mut self, mic: &[f32], sys: &[f32]) -> Vec<f32> {
        let n = mic.len();
        let mut out = Vec::with_capacity(n);
        let mut start = 0;
        while start < n {
            let end = (start + self.frame).min(n);
            self.mic_delay.extend(&mic[start..end]);
            let delayed: Vec<f32> = self.mic_delay.drain(..end - start).collect();
            if end - start == self.frame {
                let _ = self.apm.process_render_f32(&[&sys[start..end]], &mut [&mut self.out]);
                let _ = self.apm.process_capture_f32(&[&delayed], &mut [&mut self.out]);
                out.extend_from_slice(&self.out);
            } else {
                out.extend(delayed); // ponytail: partial tail only at flush, passed through
            }
            start = end;
        }
        out
    }
}

/// Whether the current default output is headphones, so nothing the speakers
/// play can reach the microphone: the built-in output's headphone jack, or a
/// Bluetooth device (AirPods and similar). USB and other outputs keep echo
/// cancellation, since conference speakerphones are USB.
#[cfg(target_os = "macos")]
pub fn output_is_headphones() -> bool {
    use cidre::core_audio as ca;
    let Ok(device) = ca::System::default_output_device() else { return false };
    let transport: u32 = device
        .prop(&ca::PropSelector(u32::from_be_bytes(*b"tran")).global_addr())
        .unwrap_or(0);
    let data_source: u32 = device
        .prop(&ca::PropSelector(u32::from_be_bytes(*b"ssrc")).output_addr())
        .unwrap_or(0);
    transport == u32::from_be_bytes(*b"blue")
        || transport == u32::from_be_bytes(*b"blea")
        || data_source == u32::from_be_bytes(*b"hdpn")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> f32 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 33) as f32 / (1u64 << 31) as f32) - 0.5
    }

    /// Speech-like test signal: noise in 250 ms bursts.
    fn bursts(n: usize, seed: u64) -> Vec<f32> {
        let mut s = seed;
        (0..n).map(|i| if (i / 12_000) % 2 == 0 { lcg(&mut s) * 0.5 } else { 0.0 }).collect()
    }

    fn delayed(x: &[f32], d: usize, gain: f32) -> Vec<f32> {
        (0..x.len()).map(|i| if i >= d { x[i - d] * gain } else { 0.0 }).collect()
    }

    /// Run windows of 50 ms through the canceller, like the pipeline does.
    fn run(aec: &mut MicEchoCanceller, mic: &[f32], sys: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let (mut mo, mut so) = (Vec::new(), Vec::new());
        for (m, s) in mic.chunks(2400).zip(sys.chunks(2400)) {
            let (mut m, mut s) = (m.to_vec(), s.to_vec());
            aec.process(&mut m, &mut s);
            mo.extend(m);
            so.extend(s);
        }
        (mo, so)
    }

    fn best_lag(a: &[f32], b: &[f32], max: usize) -> usize {
        (0..max).max_by(|&x, &y| {
            let c = |d: usize| b.iter().zip(a.iter().skip(d)).map(|(p, q)| p * q).sum::<f32>();
            c(x).total_cmp(&c(y))
        }).unwrap()
    }

    #[test]
    fn resampling_round_trip_has_known_delay() {
        // Band-limited noise (a pure tone would match a later cycle too).
        let noise = bursts(48_000, 5);
        let input: Vec<f32> = Decimator::new().process(&noise).iter().flat_map(|&v| [v, v, v]).collect();
        let input = Interpolator::new().process(&Decimator::new().process(&input));
        let out = Interpolator::new().process(&Decimator::new().process(&input));
        let d = best_lag(&out, &input[..40_000], 200);
        assert!((d as i64 - 2 * FIR_DELAY_48 as i64).abs() <= 3, "round trip delay {d}");
        let e = |s: &[f32]| s.iter().map(|v| v * v).sum::<f32>();
        let ratio = e(&out[d..d + 40_000]) / e(&input[..40_000]);
        assert!((0.9..1.1).contains(&ratio), "gain {ratio}");
    }

    #[test]
    fn lag_estimator_locks_on_the_echo_delay() {
        let reference = bursts(16_000 * 6, 3);
        let mic = delayed(&reference, 1_712, 0.4); // 107 ms
        let mut est = LagEstimator::new();
        let mut locked = None;
        for (m, r) in mic.chunks(800).zip(reference.chunks(800)) {
            if let Some(l) = est.observe(m, r) { locked = Some(l); }
        }
        let l = locked.expect("no lock");
        assert!((l - 1_712).abs() <= 32, "locked at {l}");
    }

    #[test]
    fn both_engines_keep_tracks_aligned_and_delayed_by_lead() {
        let lead = 48_000 * LEAD_MS / 1000;
        for neural in [true, false] {
            let mut aec = MicEchoCanceller::with_engine(48_000, neural);
            // A noise burst on the mic with silent speakers comes out `lead` later.
            let burst = bursts(2_400, 9);
            let mic: Vec<f32> = (0..48_000).map(|i| if (20_000..22_400).contains(&i) { burst[i - 20_000] } else { 0.0 }).collect();
            let sys: Vec<f32> = (0..48_000).map(|i| i as f32).collect();
            let (mo, so) = run(&mut aec, &mic, &sys);
            assert_eq!(so[lead + 1], 1.0, "system track delay");
            let d = best_lag(&mo, &mic, lead + 400);
            assert!((d as i64 - lead as i64).abs() <= 6, "neural={neural}: mic delay {d}, expected {lead}");
            println!("neural={neural}: mic delay {d} samples (target {lead})");
            let (mt, st) = aec.drain();
            assert_eq!((mt.len(), st.len()), (lead, lead));
        }
    }

    #[test]
    fn aec3_engine_removes_speaker_echo() {
        let far: Vec<f32> = { let mut s = 7; (0..48_000 * 8).map(|_| lcg(&mut s) * 0.5).collect() };
        let echo = delayed(&far, 48 * 30, 0.4); // 30 ms acoustic + device delay
        let mut aec = MicEchoCanceller::with_engine(48_000, false);
        let (out, _) = run(&mut aec, &echo, &far);
        let lead = 48_000 * LEAD_MS / 1000;
        let e = |s: &[f32]| s.iter().map(|&v| (v as f64).powi(2)).sum::<f64>();
        let tail = 48_000 * 6..48_000 * 8;
        let removed = 10.0 * (e(&echo[tail.start - lead..tail.end - lead]) / e(&out[tail]).max(1e-12)).log10();
        assert!(removed > 20.0, "only {removed:.1} dB removed");
    }

    /// Real built-in mic/speaker takes (48 kHz raw f32le files in
    /// $AEC_EVAL_DIR: voice48.f32, echo_mic48.f32, echo_ref48.f32), mixed so
    /// the clean voice is known.
    #[test]
    #[ignore]
    fn real_recordings_report() {
        let dir = std::env::var("AEC_EVAL_DIR").expect("AEC_EVAL_DIR");
        let read = |name: &str| -> Vec<f32> {
            std::fs::read(format!("{dir}/{name}.f32")).unwrap()
                .chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
        };
        let (voice, echo_mic, echo_ref) = (read("voice48"), read("echo_mic48"), read("echo_ref48"));
        let n = voice.len().min(echo_mic.len()).min(echo_ref.len());
        let mix: Vec<f32> = (0..n).map(|i| voice[i] + echo_mic[i]).collect();
        let lead = 48_000 * LEAD_MS / 1000;
        let e = |s: &[f32]| s.iter().map(|&v| (v as f64).powi(2)).sum::<f64>() + 1e-12;
        let si_sdr = |est: &[f32], target: &[f32]| {
            let dot: f64 = est.iter().zip(target).map(|(&a, &b)| a as f64 * b as f64).sum();
            let alpha = dot / e(target);
            let noise: f64 = est.iter().zip(target).map(|(&a, &b)| (a as f64 - alpha * b as f64).powi(2)).sum::<f64>() + 1e-12;
            10.0 * (alpha * alpha * e(target) / noise).log10()
        };
        for neural in [true, false] {
            let (echo_out, _) = run(&mut MicEchoCanceller::with_engine(48_000, neural), &echo_mic[..n], &echo_ref[..n]);
            for (a, b) in [(0usize, 1usize), (1, 2), (2, 3), (3, 4)] {
                let w = 48_000 * a + lead..48_000 * b + lead;
                println!("  {} second {a}-{b}: echo removed {:.1} dB", if neural { "neural" } else { "aec3" },
                    10.0 * (e(&echo_mic[w.start - lead..w.end - lead]) / e(&echo_out[w])).log10());
            }
            let (mix_out, _) = run(&mut MicEchoCanceller::with_engine(48_000, neural), &mix, &echo_ref[..n]);
            let skip = 48_000 * 4; // lag lock + convergence
            let r = skip..n;
            let target = &voice[r.start - lead..r.end - lead];
            println!("{}: echo removed {:.1} dB, double-talk SI-SDR {:.1} dB",
                if neural { "neural" } else { "aec3  " },
                10.0 * (e(&echo_mic[r.start - lead..r.end - lead]) / e(&echo_out[r.clone()])).log10(),
                si_sdr(&mix_out[r], target));
        }
    }
}

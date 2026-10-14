//! Microphone echo cancellation with WebRTC AEC3 (pure-Rust `sonora`), using
//! the captured computer audio as the reference, the way Granola does it.
//!
//! With built-in speakers the microphone also hears the call. Without this,
//! the far side lands in both tracks: doubled, with a slight echo, and
//! transcribed as "You". AEC3 subtracts what the speakers play from the mic.
//! The microphone stays raw (no Apple voice processing), so other apps are not
//! ducked. The pipeline feeds time-aligned mic/system windows; AEC3 estimates
//! the remaining acoustic and device delay itself. Skipped when the output is
//! headphones, where nothing can leak.

use log::info;
use sonora::config::EchoCanceller;
use sonora::{AudioProcessing, Config, StreamConfig};
use std::collections::VecDeque;

/// AEC3 processes 10 ms frames.
const FRAME_MS: usize = 10;
/// AEC3 only cancels echo that arrives after its reference (measured: ~52 dB
/// removed with the reference 30-250 ms ahead, ~3 dB at 0 ms or late). System
/// chunks are timestamped when processed, so they can trail the mic slightly.
/// Delaying both tracks by this much before cancellation keeps the reference
/// ahead without misaligning the saved tracks.
const LEAD_MS: usize = 100;
/// Log reduction about every 10 s of audio.
const STATS_EVERY_FRAMES: usize = 1000;

pub struct MicEchoCanceller {
    apm: AudioProcessing,
    frame: usize,
    out: Vec<f32>,
    // Samples awaiting output, `LEAD_MS` behind the input.
    mic_delay: VecDeque<f32>,
    sys_delay: VecDeque<f32>,
    // Energy before/after cancellation while the reference is active.
    pre: f64,
    post: f64,
    active: bool,
    frames: usize,
}

impl MicEchoCanceller {
    pub fn new(sample_rate: u32) -> Self {
        let config = Config {
            echo_canceller: Some(EchoCanceller::default()),
            ..Default::default()
        };
        let stream = StreamConfig::new(sample_rate, 1);
        let apm = AudioProcessing::builder()
            .config(config)
            .capture_config(stream)
            .render_config(stream)
            .build();
        let frame = sample_rate as usize * FRAME_MS / 1000;
        let lead = sample_rate as usize * LEAD_MS / 1000;
        Self {
            apm,
            frame,
            out: vec![0.0; frame],
            mic_delay: std::iter::repeat(0.0).take(lead).collect(),
            sys_delay: std::iter::repeat(0.0).take(lead).collect(),
            pre: 0.0,
            post: 0.0,
            active: false,
            frames: 0,
        }
    }

    /// Takes time-aligned mic/system windows and returns them `LEAD_MS` later,
    /// with the speaker playback removed from the mic. Both stay aligned, so
    /// every consumer (VAD, saved tracks, mixed audio) sees the same timeline.
    pub fn process(&mut self, mic: &mut Vec<f32>, sys: &mut Vec<f32>) {
        let n = mic.len().min(sys.len());
        let mut mic_out = Vec::with_capacity(n);
        let mut sys_out = Vec::with_capacity(n);
        let mut start = 0;
        while start < n {
            let end = (start + self.frame).min(n);
            self.mic_delay.extend(&mic[start..end]);
            self.sys_delay.extend(&sys[start..end]);
            let delayed_mic: Vec<f32> = self.mic_delay.drain(..end - start).collect();
            sys_out.extend(self.sys_delay.drain(..end - start));
            if end - start == self.frame {
                // Reference now; the mic from LEAD_MS ago, whose echo it contains.
                let _ = self.apm.process_render_f32(&[&sys[start..end]], &mut [&mut self.out]);
                let _ = self.apm.process_capture_f32(&[&delayed_mic], &mut [&mut self.out]);
                self.measure(&delayed_mic, &sys_out[sys_out.len() - self.frame..]);
                mic_out.extend_from_slice(&self.out);
            } else {
                mic_out.extend(delayed_mic); // ponytail: partial tail only at flush, passed through
            }
            start = end;
        }
        *mic = mic_out;
        *sys = sys_out;
    }

    /// The last `LEAD_MS` of both tracks, for the final flush.
    pub fn drain(&mut self) -> (Vec<f32>, Vec<f32>) {
        let (mut mic, mut sys) = (vec![0.0; self.mic_delay.len()], vec![0.0; self.sys_delay.len()]);
        self.process(&mut mic, &mut sys);
        (mic, sys)
    }

    fn measure(&mut self, mic: &[f32], reference: &[f32]) {
        let energy = |s: &[f32]| s.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>();
        if energy(reference) > 1e-6 * self.frame as f64 {
            self.pre += energy(mic);
            self.post += energy(&self.out);
            self.active = true;
        }
        self.frames += 1;
        if self.frames % STATS_EVERY_FRAMES == 0 && self.active {
            let db = |e: f64| 10.0 * (e + 1e-12).log10();
            let stats = self.apm.statistics();
            info!(
                "🔇 Mic echo cancellation: mic {:.1} dB → {:.1} dB while computer audio played ({:.1} dB removed); AEC3 delay {:?} ms, ERLE {:?} dB",
                db(self.pre), db(self.post), db(self.pre) - db(self.post),
                stats.delay_median_ms, stats.echo_return_loss_enhancement.map(|v| v.round()),
            );
            self.pre = 0.0;
            self.post = 0.0;
            self.active = false;
        }
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
    use super::MicEchoCanceller;

    fn lcg(seed: &mut u64) -> f32 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 33) as f32 / (1u64 << 31) as f32) - 0.5
    }

    /// Echo-only mic level (dB) before vs after cancellation in the last 2 s
    /// of 8 s of speaker noise, when the echo trails its reference by
    /// `echo_delay_ms` in the windows handed to the canceller (negative: the
    /// reference arrives late, as when system chunks are stamped late).
    fn echo_removed_db(echo_delay_ms: i64) -> f64 {
        let sr = 48_000usize;
        let mut seed = 7;
        let far: Vec<f32> = (0..sr * 8).map(|_| lcg(&mut seed) * 0.5).collect();
        let delay = (sr as i64 * echo_delay_ms / 1000) as isize;
        let echo: Vec<f32> = (0..far.len() as isize)
            .map(|i| if i - delay >= 0 && ((i - delay) as usize) < far.len() { far[(i - delay) as usize] * 0.4 } else { 0.0 })
            .collect();
        let mut aec = MicEchoCanceller::new(sr as u32);
        let mut out = Vec::new();
        for (mic, reference) in echo.chunks(2400).zip(far.chunks(2400)) {
            let (mut mic, mut sys) = (mic.to_vec(), reference.to_vec());
            aec.process(&mut mic, &mut sys);
            out.extend(mic);
        }
        let lead = sr * super::LEAD_MS / 1000;
        let tail = sr * 6..sr * 8;
        let e = |s: &[f32]| s.iter().map(|&v| (v as f64).powi(2)).sum::<f64>();
        10.0 * (e(&echo[tail.start - lead..tail.end - lead]) / e(&out[tail]).max(1e-12)).log10()
    }

    #[test]
    fn output_is_delayed_by_lead_and_drained_at_flush() {
        let mut aec = MicEchoCanceller::new(48_000);
        let (mut mic, mut sys) = (vec![0.5f32; 9600], (0..9600).map(|i| i as f32).collect::<Vec<_>>());
        aec.process(&mut mic, &mut sys);
        let lead = 48_000 * super::LEAD_MS / 1000;
        assert_eq!((mic.len(), sys.len()), (9600, 9600));
        assert!(sys[..lead].iter().all(|&v| v == 0.0));
        assert_eq!(sys[lead], 0.0);
        assert_eq!(sys[lead + 1], 1.0);
        let (mic_tail, sys_tail) = aec.drain();
        assert_eq!((mic_tail.len(), sys_tail.len()), (lead, lead));
        assert_eq!(sys_tail[lead - 1], 9599.0);
    }

    #[test]
    fn removes_speaker_echo_when_reference_leads() {
        let removed = echo_removed_db(30); // typical acoustic + device delay
        assert!(removed > 20.0, "only {removed:.1} dB removed");
    }

    #[test]
    #[ignore] // diagnostic: tolerance to reference timing, including late system stamps
    fn reference_lag_report() {
        for delay in [100, 30, 0, -30, -60, -90] {
            println!("echo {delay:>4} ms after its reference in the windows: {:.1} dB removed", echo_removed_db(delay));
        }
    }
}

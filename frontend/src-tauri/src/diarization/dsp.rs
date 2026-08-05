//! Audio I/O + Kaldi-compatible fbank feature extraction for diarization.
//!
//! WeSpeaker's ONNX embedding model expects 80-dimensional log-mel filterbank
//! features computed the same way `torchaudio.compliance.kaldi.fbank` does
//! (25 ms window, 10 ms shift, Povey window, pre-emphasis 0.97, power
//! spectrum, HTK mel), followed by per-utterance mean normalization (CMN).
//!
//! This is a from-scratch, dependency-light implementation using `realfft`.
//! It aims to match torchaudio/Kaldi closely; small differences are tolerable
//! because the downstream clustering is robust to minor feature perturbations.

use anyhow::{anyhow, Result};
use realfft::RealFftPlanner;
use std::path::Path;

pub const SAMPLE_RATE: u32 = 16000;
const FRAME_LENGTH_MS: f32 = 25.0;
const FRAME_SHIFT_MS: f32 = 10.0;
pub const NUM_MEL_BINS: usize = 80;
const PREEMPH: f32 = 0.97;
const LOW_FREQ: f32 = 20.0;
const LOG_FLOOR: f32 = 1.1921e-07; // torch.finfo(float32).eps

/// Read a WAV file and return (mono samples in [-1, 1], sample_rate).
/// Supports PCM 16-bit and 32-bit float, mono or multi-channel (downmixed).
pub fn read_wav(path: &Path) -> Result<(Vec<f32>, u32)> {
    let bytes = std::fs::read(path)?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(anyhow!("Not a RIFF/WAVE file: {}", path.display()));
    }

    // Walk chunks to find "fmt " and "data".
    let mut pos = 12usize;
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // (audio_format, channels, sample_rate, bits)
    let mut data: Option<(usize, usize)> = None; // (offset, len)

    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let sz = u32::from_le_bytes([bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]]) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            let audio_format = u16::from_le_bytes([bytes[body], bytes[body + 1]]);
            let channels = u16::from_le_bytes([bytes[body + 2], bytes[body + 3]]);
            let sample_rate = u32::from_le_bytes([bytes[body + 4], bytes[body + 5], bytes[body + 6], bytes[body + 7]]);
            let bits = u16::from_le_bytes([bytes[body + 14], bytes[body + 15]]);
            fmt = Some((audio_format, channels, sample_rate, bits));
        } else if id == b"data" {
            let len = sz.min(bytes.len().saturating_sub(body));
            data = Some((body, len));
        }
        // Chunks are word-aligned (padded to even size).
        pos = body + sz + (sz & 1);
    }

    let (audio_format, channels, sample_rate, bits) =
        fmt.ok_or_else(|| anyhow!("WAV missing fmt chunk"))?;
    let (off, len) = data.ok_or_else(|| anyhow!("WAV missing data chunk"))?;
    let channels = channels.max(1) as usize;
    let raw = &bytes[off..off + len];

    // Decode interleaved samples to f32.
    let mut interleaved: Vec<f32> = Vec::new();
    match (audio_format, bits) {
        (1, 16) => {
            interleaved.reserve(raw.len() / 2);
            for c in raw.chunks_exact(2) {
                interleaved.push(i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0);
            }
        }
        (1, 32) => {
            interleaved.reserve(raw.len() / 4);
            for c in raw.chunks_exact(4) {
                let v = i32::from_le_bytes([c[0], c[1], c[2], c[3]]);
                interleaved.push(v as f32 / 2147483648.0);
            }
        }
        (3, 32) => {
            interleaved.reserve(raw.len() / 4);
            for c in raw.chunks_exact(4) {
                interleaved.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
            }
        }
        (fmt, bits) => {
            return Err(anyhow!("Unsupported WAV format {} / {} bits", fmt, bits));
        }
    }

    // Downmix to mono.
    let mono = if channels == 1 {
        interleaved
    } else {
        interleaved
            .chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect()
    };

    Ok((mono, sample_rate))
}

/// Povey window of length `n`: (0.5 - 0.5*cos(2πi/(n-1)))^0.85
fn povey_window(n: usize) -> Vec<f32> {
    let mut w = vec![0f32; n];
    let denom = (n - 1) as f32;
    for i in 0..n {
        let hann = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / denom).cos();
        w[i] = hann.powf(0.85);
    }
    w
}

fn hz_to_mel(f: f32) -> f32 {
    1127.0 * (1.0 + f / 700.0).ln()
}
fn mel_to_hz(m: f32) -> f32 {
    700.0 * ((m / 1127.0).exp() - 1.0)
}

/// Build `NUM_MEL_BINS` triangular mel filters over `n_bins` FFT magnitude bins.
/// Peak-1 triangles (Kaldi/HTK convention, no area normalization).
fn mel_filterbank(n_fft: usize, n_bins: usize, fs: f32) -> Vec<Vec<f32>> {
    let high_freq = fs / 2.0;
    let mel_low = hz_to_mel(LOW_FREQ);
    let mel_high = hz_to_mel(high_freq);
    let points = NUM_MEL_BINS + 2;
    let mel_step = (mel_high - mel_low) / (points as f32 - 1.0);
    let centers_hz: Vec<f32> = (0..points)
        .map(|i| mel_to_hz(mel_low + i as f32 * mel_step))
        .collect();

    let bin_hz = |k: usize| k as f32 * fs / n_fft as f32;

    let mut filters = vec![vec![0f32; n_bins]; NUM_MEL_BINS];
    for m in 0..NUM_MEL_BINS {
        let left = centers_hz[m];
        let center = centers_hz[m + 1];
        let right = centers_hz[m + 2];
        for k in 0..n_bins {
            let f = bin_hz(k);
            let w = if f < left || f > right {
                0.0
            } else if f <= center {
                (f - left) / (center - left)
            } else {
                (right - f) / (right - center)
            };
            filters[m][k] = w.max(0.0);
        }
    }
    filters
}

/// Compute 80-dim log-mel fbank features for a 16 kHz mono signal.
/// Returns `[num_frames][NUM_MEL_BINS]`, with per-utterance mean normalization.
pub fn compute_fbank(samples: &[f32]) -> Vec<Vec<f32>> {
    let frame_len = (FRAME_LENGTH_MS * SAMPLE_RATE as f32 / 1000.0).round() as usize; // 400
    let frame_shift = (FRAME_SHIFT_MS * SAMPLE_RATE as f32 / 1000.0).round() as usize; // 160
    if samples.len() < frame_len {
        return Vec::new();
    }

    let mut n_fft = 1usize;
    while n_fft < frame_len {
        n_fft <<= 1;
    }
    let n_bins = n_fft / 2 + 1;

    let window = povey_window(frame_len);
    let filters = mel_filterbank(n_fft, n_bins, SAMPLE_RATE as f32);

    let mut planner = RealFftPlanner::<f32>::new();
    let r2c = planner.plan_fft_forward(n_fft);
    let mut fft_in = r2c.make_input_vec();
    let mut fft_out = r2c.make_output_vec();

    let num_frames = 1 + (samples.len() - frame_len) / frame_shift;
    let mut feats: Vec<Vec<f32>> = Vec::with_capacity(num_frames);

    for m in 0..num_frames {
        let start = m * frame_shift;
        let frame = &samples[start..start + frame_len];

        // Copy + remove DC offset.
        let mut buf: Vec<f32> = frame.to_vec();
        let mean = buf.iter().sum::<f32>() / frame_len as f32;
        for v in buf.iter_mut() {
            *v -= mean;
        }
        // Pre-emphasis (in place, high index first).
        for i in (1..frame_len).rev() {
            buf[i] -= PREEMPH * buf[i - 1];
        }
        buf[0] -= PREEMPH * buf[0];
        // Window.
        for i in 0..frame_len {
            buf[i] *= window[i];
        }

        // FFT (zero-padded to n_fft).
        for i in 0..n_fft {
            fft_in[i] = if i < frame_len { buf[i] } else { 0.0 };
        }
        if r2c.process(&mut fft_in, &mut fft_out).is_err() {
            feats.push(vec![0.0; NUM_MEL_BINS]);
            continue;
        }

        // Power spectrum.
        let mut power = vec![0f32; n_bins];
        for k in 0..n_bins {
            let re = fft_out[k].re;
            let im = fft_out[k].im;
            power[k] = re * re + im * im;
        }

        // Mel energies + log.
        let mut row = vec![0f32; NUM_MEL_BINS];
        for (b, filt) in filters.iter().enumerate() {
            let mut e = 0f32;
            for k in 0..n_bins {
                e += filt[k] * power[k];
            }
            row[b] = e.max(LOG_FLOOR).ln();
        }
        feats.push(row);
    }

    // Per-utterance mean normalization (CMN), like WeSpeaker.
    if !feats.is_empty() {
        let mut mean = vec![0f32; NUM_MEL_BINS];
        for row in &feats {
            for d in 0..NUM_MEL_BINS {
                mean[d] += row[d];
            }
        }
        let n = feats.len() as f32;
        for d in 0..NUM_MEL_BINS {
            mean[d] /= n;
        }
        for row in feats.iter_mut() {
            for d in 0..NUM_MEL_BINS {
                row[d] -= mean[d];
            }
        }
    }

    feats
}

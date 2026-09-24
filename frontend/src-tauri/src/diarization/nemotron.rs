//! NVIDIA Nemotron-3 Diarization engine (Sortformer v3 architecture).
//!
//! Provides on-device speaker diarization using NVIDIA's Nemotron-3 model
//! via ONNX Runtime (`ort`). Supports up to 8 concurrent speakers, high-resolution
//! frame predictions, and FIFO buffer with speaker cache (`spkcache`).
//!
//! Reference: https://huggingface.co/nvidia/Nemotron-3-Diarization/blob/main/ASR_INTEGRATION_GUIDE.md

use anyhow::{anyhow, Result};
use ndarray::{Array1, Array2, Array3};
use ort::execution_providers::CPUExecutionProvider;
use ort::inputs;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::TensorRef;
use std::path::{Path, PathBuf};

use super::{DiarizationResult, DiarizationSegment};

pub const NEMOTRON_MODEL_FILENAME: &str = "nemotron3_diar_v3.onnx";
pub const NEMO128_MODEL_FILENAME: &str = "nemo128.onnx";
pub const NEMOTRON_EXPECTED_BYTES: u64 = 400_506_656; // ~382 MB
pub const NEMOTRON_DOWNLOAD_URL: &str =
    "https://huggingface.co/altunenes/parakeet-rs/resolve/main/nemotron-3-diarization/nemotron3_diar_v3.onnx";
pub const NEMO128_DOWNLOAD_URL: &str =
    "https://meetily.towardsgeneralintelligence.com/models/parakeet-tdt-0.6b-v3-onnx/nemo128.onnx";

const FIFO_MAX_LEN: usize = 264; // NVIDIA Sortformer standard (264 frames = ~21.1s)
const SPKCACHE_MAX_LEN: usize = 264; // NVIDIA Sortformer standard (264 frames)
pub const DEFAULT_NEMOTRON_THRESHOLD: f32 = 0.50;
pub const DEFAULT_MAX_SPEAKERS: usize = 4;

/// Locate or fetch `nemo128.onnx` Mel-spectrogram preprocessor.
pub fn resolve_or_fetch_nemo128(models_dir: &Path) -> Result<PathBuf> {
    let direct_path = models_dir.join(NEMO128_MODEL_FILENAME);
    if direct_path.exists() {
        return Ok(direct_path);
    }

    // Check parent models directory (e.g. Parakeet models directory)
    if let Some(parent) = models_dir.parent() {
        let candidate_paths = [
            parent.join("parakeet").join("parakeet-tdt-0.6b-v3-int8").join(NEMO128_MODEL_FILENAME),
            parent.join("parakeet").join("parakeet-tdt-0.6b-v2-int8").join(NEMO128_MODEL_FILENAME),
            parent.join("parakeet").join(NEMO128_MODEL_FILENAME),
            parent.join(NEMO128_MODEL_FILENAME),
            crate::paths::models_dir().join(NEMO128_MODEL_FILENAME),
        ];

        for cand in candidate_paths {
            if cand.exists() {
                log::info!("Found existing nemo128.onnx at {:?}, copying to diarization models dir", cand);
                let _ = std::fs::copy(&cand, &direct_path);
                return Ok(direct_path);
            }
        }
    }

    // Download nemo128.onnx (~140KB) if not present
    log::info!("nemo128.onnx not found locally, downloading from {}", NEMO128_DOWNLOAD_URL);
    let resp = reqwest::blocking::get(NEMO128_DOWNLOAD_URL)
        .map_err(|e| anyhow!("Failed to fetch nemo128 preprocessor: {}", e))?;
    if !resp.status().is_success() {
        return Err(anyhow!("Failed to download nemo128 preprocessor: HTTP {}", resp.status()));
    }

    let bytes = resp.bytes().map_err(|e| anyhow!("Failed to read nemo128 bytes: {}", e))?;
    std::fs::write(&direct_path, &bytes)?;
    log::info!("✅ Successfully downloaded nemo128.onnx to {:?}", direct_path);
    Ok(direct_path)
}

pub struct NemotronDiarizationModel {
    session: Session,
    preprocessor: Session,
    max_speakers: usize,
    threshold: f32,
    spkcache: Array3<f32>,
    fifo: Array3<f32>,
}

impl NemotronDiarizationModel {
    pub fn new<P: AsRef<Path>>(
        model_path: P,
        max_speakers: usize,
        threshold: f32,
    ) -> Result<Self> {
        crate::onnx_runtime::ensure_available()
            .map_err(|e| anyhow!("ONNX Runtime unavailable: {}", e))?;

        let model_path = model_path.as_ref();
        let (model_file, models_dir) = if model_path.is_file() {
            (
                model_path.to_path_buf(),
                model_path.parent().unwrap_or_else(|| Path::new(".")).to_path_buf(),
            )
        } else {
            (
                model_path.join(NEMOTRON_MODEL_FILENAME),
                model_path.to_path_buf(),
            )
        };

        if !model_file.exists() {
            return Err(anyhow!("Nemotron model file not found at {:?}", model_file));
        }

        let nemo128_path = resolve_or_fetch_nemo128(&models_dir)?;

        log::info!("Loading Nemotron-3 Diarization model from {:?}...", model_file);
        let providers = vec![CPUExecutionProvider::default().build()];

        let session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_execution_providers(providers.clone())?
            .with_parallel_execution(true)?
            .commit_from_file(&model_file)?;

        log::info!("Loading Nemo 128 Mel preprocessor from {:?}...", nemo128_path);
        let preprocessor = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_execution_providers(providers)?
            .commit_from_file(&nemo128_path)?;

        log::info!("✅ Nemotron-3 Diarization model and Mel preprocessor loaded successfully");

        Ok(Self {
            session,
            preprocessor,
            max_speakers: max_speakers.clamp(1, 8),
            threshold: threshold.clamp(0.1, 0.9),
            spkcache: Array3::<f32>::zeros((1, 0, 512)),
            fifo: Array3::<f32>::zeros((1, 0, 512)),
        })
    }

    /// Reset persistent streaming cache between distinct recording sessions.
    pub fn reset_streaming_state(&mut self) {
        self.spkcache = Array3::<f32>::zeros((1, 0, 512));
        self.fifo = Array3::<f32>::zeros((1, 0, 512));
        log::info!("🔄 Reset Nemotron-3 streaming diarization state");
    }

    pub fn set_max_speakers(&mut self, max: usize) {
        self.max_speakers = max.clamp(1, 8);
    }

    pub fn set_threshold(&mut self, t: f32) {
        self.threshold = t.clamp(0.1, 0.9);
    }

    /// Run full speaker diarization on 16kHz mono audio samples.
    pub fn diarize(
        &mut self,
        samples: &[f32],
        sample_rate: u32,
    ) -> Result<DiarizationResult> {
        if samples.is_empty() {
            return Ok(DiarizationResult {
                segments: Vec::new(),
                num_speakers: 0,
                duration: 0.0,
                user_speaker: None,
            });
        }

        let audio_16k = if sample_rate != 16000 {
            log::info!("Diarization: resampling {} Hz → 16000 Hz", sample_rate);
            crate::audio::audio_processing::resample_audio(samples, sample_rate, 16000)
        } else {
            samples.to_vec()
        };

        let duration_secs = audio_16k.len() as f32 / 16000.0;
        if duration_secs < 0.25 {
            return Ok(DiarizationResult {
                segments: vec![DiarizationSegment {
                    speaker: 0,
                    start: 0.0,
                    end: duration_secs,
                    overlapped: false,
                }],
                num_speakers: 1,
                duration: duration_secs,
                user_speaker: Some(0),
            });
        }

        let (speaker_probs, embs_opt) = self.run_inference(&audio_16k)?;

        // Update FIFO queue and cascade overflow into speaker cache (Sortformer architecture)
        if let Some(embs) = embs_opt {
            let new_len = embs.shape()[1];
            if new_len > 0 {
                let old_fifo_len = self.fifo.shape()[1];
                let total_fifo_len = old_fifo_len + new_len;
                let mut combined_fifo = Array3::<f32>::zeros((1, total_fifo_len, 512));

                for t in 0..old_fifo_len {
                    for d in 0..512 {
                        combined_fifo[[0, t, d]] = self.fifo[[0, t, d]];
                    }
                }
                for t in 0..new_len {
                    for d in 0..512 {
                        combined_fifo[[0, old_fifo_len + t, d]] = embs[[0, t, d]];
                    }
                }

                if total_fifo_len > FIFO_MAX_LEN {
                    let overflow = total_fifo_len - FIFO_MAX_LEN;
                    let old_cache_len = self.spkcache.shape()[1];
                    let total_cache_len = old_cache_len + overflow;
                    let mut combined_cache = Array3::<f32>::zeros((1, total_cache_len, 512));

                    for t in 0..old_cache_len {
                        for d in 0..512 {
                            combined_cache[[0, t, d]] = self.spkcache[[0, t, d]];
                        }
                    }
                    for t in 0..overflow {
                        for d in 0..512 {
                            combined_cache[[0, old_cache_len + t, d]] = combined_fifo[[0, t, d]];
                        }
                    }

                    if total_cache_len > SPKCACHE_MAX_LEN {
                        let start_idx = total_cache_len - SPKCACHE_MAX_LEN;
                        let mut trimmed_cache = Array3::<f32>::zeros((1, SPKCACHE_MAX_LEN, 512));
                        for t in 0..SPKCACHE_MAX_LEN {
                            for d in 0..512 {
                                trimmed_cache[[0, t, d]] = combined_cache[[0, start_idx + t, d]];
                            }
                        }
                        self.spkcache = trimmed_cache;
                    } else {
                        self.spkcache = combined_cache;
                    }

                    let mut trimmed_fifo = Array3::<f32>::zeros((1, FIFO_MAX_LEN, 512));
                    for t in 0..FIFO_MAX_LEN {
                        for d in 0..512 {
                            trimmed_fifo[[0, t, d]] = combined_fifo[[0, overflow + t, d]];
                        }
                    }
                    self.fifo = trimmed_fifo;
                } else {
                    self.fifo = combined_fifo;
                }
            }
        }

        let segments = self.post_process_predictions(&speaker_probs, duration_secs as f64)?;

        // Find unique speakers and primary speaker
        let mut speaker_durations: std::collections::HashMap<usize, f32> =
            std::collections::HashMap::new();
        for seg in &segments {
            *speaker_durations.entry(seg.speaker).or_insert(0.0) += seg.end - seg.start;
        }

        let num_speakers = speaker_durations.len().max(1);
        let user_speaker = speaker_durations
            .into_iter()
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(spk, _)| spk)
            .or(Some(0));

        log::info!(
            "🎤 Nemotron-3 Diarization: found {} speakers, {} segments over {:.1}s",
            num_speakers,
            segments.len(),
            duration_secs
        );

        Ok(DiarizationResult {
            segments,
            num_speakers,
            duration: duration_secs,
            user_speaker,
        })
    }

    /// Process a live streaming chunk of PCM samples.
    pub fn diarize_stream_chunk(
        &mut self,
        samples: &[f32],
    ) -> Result<Option<super::online::LiveSpeaker>> {
        if samples.len() < 4000 {
            // Under 250ms of audio, not enough for feature frames
            return Ok(None);
        }

        let (probs, embs_opt) = self.run_inference(samples)?;

        if let Some(embs) = embs_opt {
            let new_len = embs.shape()[1];
            if new_len > 0 {
                let old_fifo_len = self.fifo.shape()[1];
                let total_fifo_len = old_fifo_len + new_len;
                let mut combined_fifo = Array3::<f32>::zeros((1, total_fifo_len, 512));
                for t in 0..old_fifo_len {
                    for d in 0..512 {
                        combined_fifo[[0, t, d]] = self.fifo[[0, t, d]];
                    }
                }
                for t in 0..new_len {
                    for d in 0..512 {
                        combined_fifo[[0, old_fifo_len + t, d]] = embs[[0, t, d]];
                    }
                }
                if total_fifo_len > FIFO_MAX_LEN {
                    let mut trimmed_fifo = Array3::<f32>::zeros((1, FIFO_MAX_LEN, 512));
                    let overflow = total_fifo_len - FIFO_MAX_LEN;
                    for t in 0..FIFO_MAX_LEN {
                        for d in 0..512 {
                            trimmed_fifo[[0, t, d]] = combined_fifo[[0, overflow + t, d]];
                        }
                    }
                    self.fifo = trimmed_fifo;
                } else {
                    self.fifo = combined_fifo;
                }
            }
        }

        let num_frames = probs.nrows();
        let num_spks = probs.ncols();
        if num_frames == 0 || num_spks == 0 {
            return Ok(None);
        }

        // Find most active speaker in this chunk
        let mut spk_scores = vec![0.0f32; num_spks];
        for t in 0..num_frames {
            for s in 0..num_spks {
                let p = probs[[t, s]];
                let prob = if p < 0.0 || p > 1.0 {
                    1.0 / (1.0 + (-p).exp())
                } else {
                    p
                };
                if prob > self.threshold {
                    spk_scores[s] += prob;
                }
            }
        }

        let best = spk_scores
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal));

        if let Some((best_spk, &score)) = best {
            if score > 0.0 {
                return Ok(Some(super::online::LiveSpeaker {
                    index: best_spk,
                    is_user: false,
                }));
            }
        }

        Ok(None)
    }

    fn run_inference(
        &mut self,
        audio_16k: &[f32],
    ) -> Result<(Array2<f32>, Option<Array3<f32>>)> {
        let num_samples = audio_16k.len();
        let wave_arr = Array2::from_shape_vec((1, num_samples), audio_16k.to_vec())
            .map_err(|e| anyhow!("Waveform shape error: {}", e))?;
        let wave_len = Array1::from_vec(vec![num_samples as i64]);

        // 1. Run Nemo 128 Mel Spectrogram Preprocessor
        let prep_res = self.preprocessor.run(inputs![
            "waveforms" => TensorRef::from_array_view(wave_arr.view())?,
            "waveforms_lens" => TensorRef::from_array_view(wave_len.view())?,
        ])?;

        let features_out = prep_res
            .get("features")
            .ok_or_else(|| anyhow!("Model output 'features' not found"))?;
        let features = features_out.try_extract_array::<f32>()?;

        // features shape is [1, 128, T_raw]
        let t_raw = features.shape()[2];
        // Sortformer requires T to be a multiple of 8 (subsampling factor 8)
        let t_dim = ((t_raw / 8) * 8).max(8);

        let mut chunk_features = Array3::<f32>::zeros((1, t_dim, 128));
        for t in 0..t_dim.min(t_raw) {
            for m in 0..128 {
                chunk_features[[0, t, m]] = features[[0, m, t]];
            }
        }

        let chunk_lengths = Array1::<i64>::from_vec(vec![t_dim as i64]);
        let spkcache_len = self.spkcache.shape()[1];
        let spkcache_lengths = Array1::<i64>::from_vec(vec![spkcache_len as i64]);
        let fifo_len = self.fifo.shape()[1];
        let fifo_lengths = Array1::<i64>::from_vec(vec![fifo_len as i64]);

        // 2. Run Nemotron-3 Diarization Model
        let diar_res = self.session.run(inputs![
            "chunk" => TensorRef::from_array_view(chunk_features.view())?,
            "chunk_lengths" => TensorRef::from_array_view(chunk_lengths.view())?,
            "spkcache" => TensorRef::from_array_view(self.spkcache.view())?,
            "spkcache_lengths" => TensorRef::from_array_view(spkcache_lengths.view())?,
            "fifo" => TensorRef::from_array_view(self.fifo.view())?,
            "fifo_lengths" => TensorRef::from_array_view(fifo_lengths.view())?,
        ])?;

        // 3. Extract high-resolution predictions
        let hires_out = diar_res
            .get("preds_hires")
            .or_else(|| diar_res.get("preds_diar"))
            .ok_or_else(|| anyhow!("Nemotron output 'preds_hires' not found"))?;
        let hires = hires_out.try_extract_array::<f32>()?;
        let total_frames = hires.shape()[1];

        // Slice current chunk frames (Sortformer outputs predictions over history + chunk)
        let chunk_start_frame = if total_frames >= t_dim {
            total_frames - t_dim
        } else {
            0
        };

        let spk_dim = self.max_speakers.min(8);
        let mut probs = Array2::<f32>::zeros((t_dim, spk_dim));
        for t in 0..t_dim {
            let src_t = (chunk_start_frame + t).min(total_frames - 1);
            for s in 0..spk_dim {
                probs[[t, s]] = hires[[0, src_t, s]];
            }
        }

        let embs_opt: Option<Array3<f32>> = diar_res
            .get("chunk_pre_encode_embs")
            .and_then(|val| val.try_extract_array::<f32>().ok())
            .and_then(|arr| arr.to_owned().into_dimensionality::<ndarray::Ix3>().ok());

        Ok((probs, embs_opt))
    }

    /// Convert frame probabilities [T, Speakers] into contiguous DiarizationSegments.
    fn post_process_predictions(
        &self,
        probs: &Array2<f32>,
        total_duration: f64,
    ) -> Result<Vec<DiarizationSegment>> {
        let num_frames = probs.nrows();
        let num_spks = probs.ncols();

        if num_frames == 0 {
            return Ok(Vec::new());
        }

        let frame_duration = total_duration / num_frames as f64;
        let mut segments: Vec<DiarizationSegment> = Vec::new();

        // Assign dominant speaker and track overlap for each frame
        let mut frame_speakers: Vec<Option<usize>> = Vec::with_capacity(num_frames);
        let mut frame_overlapped: Vec<bool> = Vec::with_capacity(num_frames);
        let mut max_overall_prob = 0.0f32;
        let mut best_overall_spk = 0;

        for t in 0..num_frames {
            let mut best_spk = None;
            let mut best_prob = self.threshold;
            let mut active_count = 0;

            for s in 0..num_spks {
                let p = probs[[t, s]];
                let prob = if p < 0.0 || p > 1.0 {
                    1.0 / (1.0 + (-p).exp())
                } else {
                    p
                };

                if prob > max_overall_prob {
                    max_overall_prob = prob;
                    best_overall_spk = s;
                }

                if prob > self.threshold {
                    active_count += 1;
                }

                if prob > best_prob {
                    best_prob = prob;
                    best_spk = Some(s); // 0-indexed speaker
                }
            }
            frame_speakers.push(best_spk);
            frame_overlapped.push(active_count > 1);
        }

        // Smooth out short gaps
        let smoothed_speakers = smooth_frame_sequence(&frame_speakers, 3);

        // Group consecutive frames into segments
        let mut current_speaker: Option<usize> = None;
        let mut start_frame = 0;
        let mut segment_overlapped = false;

        for (frame_idx, &spk) in smoothed_speakers.iter().enumerate() {
            if spk != current_speaker {
                if let Some(prev_spk) = current_speaker {
                    let start_sec = (start_frame as f64 * frame_duration) as f32;
                    let end_sec = (frame_idx as f64 * frame_duration) as f32;
                    if end_sec - start_sec >= 0.15 {
                        segments.push(DiarizationSegment {
                            speaker: prev_spk,
                            start: start_sec,
                            end: end_sec,
                            overlapped: segment_overlapped,
                        });
                    }
                }
                current_speaker = spk;
                start_frame = frame_idx;
                segment_overlapped = frame_overlapped[frame_idx];
            } else if frame_overlapped[frame_idx] {
                segment_overlapped = true;
            }
        }

        // Add trailing segment
        if let Some(prev_spk) = current_speaker {
            let start_sec = (start_frame as f64 * frame_duration) as f32;
            let end_sec = total_duration as f32;
            if end_sec - start_sec >= 0.15 {
                segments.push(DiarizationSegment {
                    speaker: prev_spk,
                    start: start_sec,
                    end: end_sec,
                    overlapped: segment_overlapped,
                });
            }
        }

        // If no segment was long enough, use the overall dominant speaker
        if segments.is_empty() {
            segments.push(DiarizationSegment {
                speaker: best_overall_spk,
                start: 0.0,
                end: total_duration as f32,
                overlapped: false,
            });
        }

        // Merge adjacent same-speaker segments with small gap (< 0.5s)
        let mut merged: Vec<DiarizationSegment> = Vec::with_capacity(segments.len());
        for seg in segments {
            if let Some(last) = merged.last_mut() {
                if last.speaker == seg.speaker && seg.start - last.end <= 0.5 {
                    if seg.end > last.end {
                        last.end = seg.end;
                    }
                    if seg.overlapped {
                        last.overlapped = true;
                    }
                    continue;
                }
            }
            merged.push(seg);
        }

        Ok(merged)
    }
}

/// Simple majority smoothing over a window to remove erratic single-frame flips.
fn smooth_frame_sequence(sequence: &[Option<usize>], window_size: usize) -> Vec<Option<usize>> {
    let len = sequence.len();
    let mut smoothed = sequence.to_vec();

    if len <= window_size {
        return smoothed;
    }

    let half = window_size / 2;
    for i in half..(len - half) {
        let window = &sequence[i - half..=i + half];
        let mut counts = std::collections::HashMap::new();
        for &item in window {
            if let Some(val) = item {
                *counts.entry(val).or_insert(0) += 1;
            }
        }

        if let Some((&most_common, &count)) = counts.iter().max_by_key(|entry| entry.1) {
            if count > half {
                smoothed[i] = Some(most_common);
            }
        }
    }

    smoothed
}

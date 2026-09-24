//! Online (streaming) speaker diarization for live transcription.
//!
//! Supports both:
//! - Pyannote pipeline (WeSpeaker centroid tracking)
//! - NVIDIA Nemotron-3 Diarization Sortformer streaming session (FIFO + spkcache)
//!
//! During a live meeting we receive speech segments and attribute them to speakers.
//! The "Speakers" action on a finished meeting re-runs the full offline pipeline and supersedes these labels.

use anyhow::{anyhow, Result};
use std::sync::Mutex;

use super::models::DiarizationModels;
use super::nemotron::NemotronDiarizationModel;

/// Shortest segment worth embedding. Anything briefer is dominated by onset
/// artefacts and produces an unreliable speaker vector.
const MIN_SEGMENT_SAMPLES: usize = 16_000; // 1.0 s at 16 kHz

const ONLINE_THRESHOLD_SYSTEM: f32 = 0.38;
const ONLINE_THRESHOLD_MIC: f32 = 0.50;
const MAX_LIVE_SPEAKERS: usize = 12;
const USER_MIC_RATIO: f32 = 0.5;
const USER_MIN_SEGMENTS: f32 = 1.0;

struct PyannoteOnlineDiarizer {
    models: DiarizationModels,
    centroids: Vec<Vec<f32>>,
    counts: Vec<f32>,
    mic_counts: Vec<f32>,
    last_speaker: usize,
    last_system_speaker: Option<usize>,
    last_mic_speaker: Option<usize>,
}

impl PyannoteOnlineDiarizer {
    fn user_speaker(&self) -> Option<usize> {
        let mut best: Option<(usize, f32)> = None;
        for i in 0..self.centroids.len() {
            let total = self.counts[i];
            if total < USER_MIN_SEGMENTS {
                continue;
            }
            let ratio = self.mic_counts[i] / total;
            if ratio >= USER_MIC_RATIO {
                if best.map(|(_, b)| ratio > b).unwrap_or(true) {
                    best = Some((i, ratio));
                }
            }
        }
        best.map(|(i, _)| i)
    }
}

enum OnlineBackend {
    Pyannote(PyannoteOnlineDiarizer),
    Nemotron(NemotronDiarizationModel),
}

static ONLINE: Mutex<Option<OnlineBackend>> = Mutex::new(None);

/// Whether live speaker identification is currently active.
pub fn is_active() -> bool {
    ONLINE.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Begin a live diarization session.
pub fn start() -> Result<()> {
    let engine = super::get_active_engine();

    if engine.eq_ignore_ascii_case("nemotron") && super::nemotron_models_available() {
        let model_path = super::diarization_user_model_dir().join(super::nemotron::NEMOTRON_MODEL_FILENAME);
        let config = super::get_diarization_config();
        let model = NemotronDiarizationModel::new(
            &model_path,
            config.nemotron_max_speakers,
            config.nemotron_threshold,
        )?;
        let mut guard = ONLINE
            .lock()
            .map_err(|_| anyhow!("online diarizer lock poisoned"))?;
        *guard = Some(OnlineBackend::Nemotron(model));
        log::info!("🧑‍🤝‍🧑 Live speaker identification started with Nemotron-3 Diarization");
        return Ok(());
    }

    if !super::pyannote_models_available() {
        return Err(anyhow!("diarization models not installed"));
    }

    let models = DiarizationModels::load(&super::diarization_model_dir())?;
    let mut guard = ONLINE
        .lock()
        .map_err(|_| anyhow!("online diarizer lock poisoned"))?;
    let enrolled = super::voiceprint::load()
        .map(|v| v.embedding)
        .filter(|e| !e.is_empty());
    let has_enrolled = enrolled.is_some();
    *guard = Some(OnlineBackend::Pyannote(PyannoteOnlineDiarizer {
        models,
        centroids: enrolled.into_iter().collect(),
        counts: if has_enrolled { vec![4.0] } else { Vec::new() },
        mic_counts: if has_enrolled { vec![4.0] } else { Vec::new() },
        last_speaker: 0,
        last_system_speaker: None,
        last_mic_speaker: has_enrolled.then_some(0),
    }));
    log::info!(
        "🧑‍🤝‍🧑 Live speaker identification started with Pyannote (voiceprint={})",
        has_enrolled
    );
    Ok(())
}

/// End the session and release the model.
pub fn stop() {
    if let Ok(mut guard) = ONLINE.lock() {
        if let Some(backend) = guard.take() {
            match backend {
                OnlineBackend::Pyannote(d) => {
                    log::info!(
                        "🧑‍🤝‍🧑 Live speaker identification stopped ({} pyannote speakers seen)",
                        d.centroids.len()
                    );
                }
                OnlineBackend::Nemotron(_) => {
                    log::info!("🧑‍🤝‍🧑 Live speaker identification stopped (Nemotron-3)");
                }
            }
        }
    }
}

/// Outcome of labelling one live speech segment.
pub struct LiveSpeaker {
    /// Speaker index (0-based) within this recording session.
    pub index: usize,
    /// Whether this speaker appears to be the local user.
    pub is_user: bool,
}

/// Assign a 16 kHz mono speech segment to a live speaker.
pub fn assign_speaker(samples: &[f32], mic_dominant: bool) -> Option<LiveSpeaker> {
    let mut guard = ONLINE.lock().ok()?;
    let backend = guard.as_mut()?;

    match backend {
        OnlineBackend::Nemotron(nemotron) => {
            if mic_dominant {
                // Mic path is deterministically the local user
                return Some(LiveSpeaker {
                    index: 0,
                    is_user: true,
                });
            }
            // For system path, feed Nemotron streaming chunk
            match nemotron.diarize_stream_chunk(samples) {
                Ok(Some(speaker)) => {
                    // System speakers map directly: worker.rs will label as Speaker (index + 1)
                    Some(LiveSpeaker {
                        index: speaker.index,
                        is_user: false,
                    })
                }
                _ => None,
            }
        }
        OnlineBackend::Pyannote(d) => {
            if samples.len() < MIN_SEGMENT_SAMPLES {
                let index = if mic_dominant {
                    d.last_mic_speaker.unwrap_or(d.last_speaker)
                } else {
                    d.last_system_speaker.unwrap_or(d.last_speaker)
                };
                let is_user = mic_dominant || d.user_speaker() == Some(index);
                return Some(LiveSpeaker {
                    index,
                    is_user: mic_dominant || is_user,
                });
            }

            let embedding = match d.models.embed(samples) {
                Ok(e) => e,
                Err(e) => {
                    log::debug!("Live diarization: embedding failed ({})", e);
                    let index = if mic_dominant {
                        d.last_mic_speaker.unwrap_or(d.last_speaker)
                    } else {
                        d.last_system_speaker.unwrap_or(d.last_speaker)
                    };
                    return Some(LiveSpeaker {
                        index,
                        is_user: mic_dominant,
                    });
                }
            };

            let user_idx = d.user_speaker();
            let mut best = 0usize;
            let mut best_sim = f32::NEG_INFINITY;
            for (i, c) in d.centroids.iter().enumerate() {
                if !mic_dominant && user_idx == Some(i) {
                    continue;
                }
                let sim: f32 = embedding.iter().zip(c).map(|(a, b)| a * b).sum();
                if sim > best_sim {
                    best_sim = sim;
                    best = i;
                }
            }
            if best_sim == f32::NEG_INFINITY && mic_dominant {
                for (i, c) in d.centroids.iter().enumerate() {
                    let sim: f32 = embedding.iter().zip(c).map(|(a, b)| a * b).sum();
                    if sim > best_sim {
                        best_sim = sim;
                        best = i;
                    }
                }
            }

            let threshold = if mic_dominant {
                ONLINE_THRESHOLD_MIC
            } else {
                ONLINE_THRESHOLD_SYSTEM
            };

            let speaker = if d.centroids.is_empty() {
                d.centroids.push(embedding);
                d.counts.push(1.0);
                d.mic_counts.push(0.0);
                0
            } else if (1.0 - best_sim) <= threshold || d.centroids.len() >= MAX_LIVE_SPEAKERS {
                d.counts[best] += 1.0;
                let n = d.counts[best];
                for (c, e) in d.centroids[best].iter_mut().zip(&embedding) {
                    *c += (e - *c) / n;
                }
                let norm = d.centroids[best].iter().map(|v| v * v).sum::<f32>().sqrt();
                if norm > 1e-8 {
                    for v in d.centroids[best].iter_mut() {
                        *v /= norm;
                    }
                }
                best
            } else {
                d.centroids.push(embedding);
                d.counts.push(1.0);
                d.mic_counts.push(0.0);
                log::info!(
                    "🧑‍🤝‍🧑 Live diarization: new speaker {} detected (path={})",
                    d.centroids.len(),
                    if mic_dominant { "mic" } else { "system" }
                );
                d.centroids.len() - 1
            };

            if mic_dominant {
                d.mic_counts[speaker] += 1.0;
                d.last_mic_speaker = Some(speaker);
            } else {
                d.last_system_speaker = Some(speaker);
            }

            d.last_speaker = speaker;
            let user = d.user_speaker();
            let is_user = mic_dominant || user == Some(speaker);

            Some(LiveSpeaker {
                index: speaker,
                is_user,
            })
        }
    }
}

//! Online (streaming) speaker diarization for live transcription.
//!
//! The offline pipeline in this module's parent sees the whole recording and can
//! cluster globally. During a live meeting we instead get one VAD speech segment
//! at a time and must label it immediately, so this keeps a running set of
//! speaker centroids: each incoming segment is embedded, compared against the
//! speakers seen so far, and either assigned to the closest one (updating its
//! centroid) or promoted to a new speaker.
//!
//! Online assignment is necessarily less accurate than the offline pass — it has
//! no view of the future and cannot revise past decisions. The "Speakers" action
//! on a finished meeting re-runs the full offline pipeline and supersedes these
//! labels.

use anyhow::{anyhow, Result};
use std::sync::Mutex;

use super::models::DiarizationModels;

/// Shortest segment worth embedding. Anything briefer is dominated by onset
/// artefacts and produces an unreliable speaker vector.
const MIN_SEGMENT_SAMPLES: usize = 16_000; // 1.0 s at 16 kHz

/// Cosine distance beyond which a segment is considered a new speaker.
///
/// Lower = easier to split voices (better distinction between remote people).
/// Higher = more merging (fewer false "Speaker N"s). Dual-path STT already
/// pins the local mic as "You", so we can afford a lower threshold on the
/// system/remote path without mislabeling the user.
const ONLINE_THRESHOLD_SYSTEM: f32 = 0.38;
/// Mic path still feeds the embedder (so offline refine can learn the user
/// voice) but labels are forced to "You" — keep a slightly looser merge so
/// mic bleed doesn't spawn extra speakers.
const ONLINE_THRESHOLD_MIC: f32 = 0.50;

/// Upper bound on live speakers, so pathological audio can't spawn dozens.
const MAX_LIVE_SPEAKERS: usize = 12;

/// How much more often a speaker must arrive on the microphone than not before
/// we call them the local user. Mic bleed means remote participants sometimes
/// register on the mic, so a simple majority is too weak a signal.
const USER_MIC_RATIO: f32 = 0.5;
/// Minimum segments before the user verdict is trusted.
///
/// Kept at 1 deliberately: a speaker may only take one or two turns in a short
/// meeting, and requiring more meant they were never identified as the user at
/// all. The mic-activity signal is strong enough that a single confident segment
/// is better evidence than none.
const USER_MIN_SEGMENTS: f32 = 1.0;

struct OnlineDiarizer {
    models: DiarizationModels,
    /// Running mean embedding per speaker (kept length-normalized).
    centroids: Vec<Vec<f32>>,
    /// How many segments contributed to each centroid.
    counts: Vec<f32>,
    /// Of those, how many arrived while the microphone was dominant.
    mic_counts: Vec<f32>,
    /// Last speaker assigned on any path (legacy fallback).
    last_speaker: usize,
    /// Last speaker heard on the system/remote path only — short remote
    /// fragments should not inherit the local user's cluster.
    last_system_speaker: Option<usize>,
    /// Last speaker heard on the mic path.
    last_mic_speaker: Option<usize>,
}

impl OnlineDiarizer {
    /// Index of the speaker that best matches the local user, if any.
    ///
    /// The user is whoever most consistently arrives on the microphone. Ties and
    /// weak evidence deliberately return `None` — labelling the wrong person
    /// "You" is worse than leaving everyone as "Speaker N".
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

static ONLINE: Mutex<Option<OnlineDiarizer>> = Mutex::new(None);

/// Whether live speaker identification is currently active.
pub fn is_active() -> bool {
    ONLINE.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Begin a live diarization session, loading the embedding model.
///
/// Safe to call when models are absent — it simply reports failure and the
/// caller falls back to capture-source labels.
pub fn start() -> Result<()> {
    if !super::models_available() {
        return Err(anyhow!("diarization models not installed"));
    }
    let models = DiarizationModels::load(&super::diarization_model_dir())?;
    let mut guard = ONLINE
        .lock()
        .map_err(|_| anyhow!("online diarizer lock poisoned"))?;
    // Seed speaker 0 with the enrolled local-user voiceprint when one exists.
    // The mic path remains authoritative, but enrollment makes the identity
    // stable from the first utterance instead of relearning it every meeting.
    let enrolled = super::voiceprint::load()
        .map(|v| v.embedding)
        .filter(|e| !e.is_empty());
    let has_enrolled = enrolled.is_some();
    *guard = Some(OnlineDiarizer {
        models,
        centroids: enrolled.into_iter().collect(),
        counts: if has_enrolled { vec![4.0] } else { Vec::new() },
        mic_counts: if has_enrolled { vec![4.0] } else { Vec::new() },
        last_speaker: 0,
        last_system_speaker: None,
        last_mic_speaker: has_enrolled.then_some(0),
    });
    log::info!(
        "🧑‍🤝‍🧑 Live speaker identification started (voiceprint={})",
        has_enrolled
    );
    Ok(())
}

/// End the session and release the model.
pub fn stop() {
    if let Ok(mut guard) = ONLINE.lock() {
        if let Some(d) = guard.take() {
            log::info!(
                "🧑‍🤝‍🧑 Live speaker identification stopped ({} speakers seen)",
                d.centroids.len()
            );
        }
    }
}

/// Outcome of labelling one live speech segment.
pub struct LiveSpeaker {
    /// Speaker index (0-based) within this recording session.
    pub index: usize,
    /// Whether this speaker appears to be the local user (see `user_speaker`).
    pub is_user: bool,
}

/// Assign a 16 kHz mono speech segment to a live speaker.
///
/// `mic_dominant` says whether the microphone was the louder source for the
/// audio this segment came from; aggregated across segments it identifies which
/// speaker is the local user.
///
/// Returns `None` when live diarization isn't running or the segment can't be
/// embedded, so callers can fall back to their existing labelling.
pub fn assign_speaker(samples: &[f32], mic_dominant: bool) -> Option<LiveSpeaker> {
    let mut guard = ONLINE.lock().ok()?;
    let d = guard.as_mut()?;

    // Too short to characterise a voice — stick with the last speaker on the
    // *same* source path so a brief remote clip doesn't inherit "You".
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

    // Closest known speaker by cosine similarity (embeddings are unit-length).
    // Prefer matching remote segments to non-user centroids first so the local
    // voice cluster doesn't absorb everyone else.
    let user_idx = d.user_speaker();
    let mut best = 0usize;
    let mut best_sim = f32::NEG_INFINITY;
    for (i, c) in d.centroids.iter().enumerate() {
        // On the system path, de-prioritize the known "You" cluster so remote
        // voices don't get folded into the user.
        if !mic_dominant && user_idx == Some(i) {
            continue;
        }
        let sim: f32 = embedding.iter().zip(c).map(|(a, b)| a * b).sum();
        if sim > best_sim {
            best_sim = sim;
            best = i;
        }
    }
    // Mic may match the enrolled user. If system audio skipped the only user
    // centroid, deliberately create a remote cluster instead of contaminating
    // the user voiceprint centroid.
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
        // Fold into the matched speaker as an incremental mean, then restore
        // unit length so later cosine comparisons stay valid.
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

    // Record which source this speaker arrived on, so the user can be identified.
    if mic_dominant {
        d.mic_counts[speaker] += 1.0;
        d.last_mic_speaker = Some(speaker);
    } else {
        d.last_system_speaker = Some(speaker);
    }

    d.last_speaker = speaker;
    let user = d.user_speaker();
    // Mic path is always the local user for dual-path STT; system path never is.
    let is_user = mic_dominant || user == Some(speaker);

    // Log the evidence: if the wrong person (or nobody) ends up labelled "You",
    // these ratios are what's needed to tell whether the mic-activity signal or
    // the clustering is at fault.
    log::debug!(
        "Live diarization: speaker {} (mic_active={}, mic {}/{} segments), user={:?}",
        speaker + 1,
        mic_dominant,
        d.mic_counts[speaker],
        d.counts[speaker],
        user.map(|u| u + 1)
    );

    Some(LiveSpeaker { index: speaker, is_user })
}

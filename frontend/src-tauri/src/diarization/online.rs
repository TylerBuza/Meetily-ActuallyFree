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
/// Deliberately stricter than the offline default: a wrong *merge* is invisible
/// to the user, whereas a wrong *split* spawns a bogus "Speaker 4" mid-meeting
/// that never goes away. Erring toward merging keeps the live view stable.
const ONLINE_THRESHOLD: f32 = 0.55;

/// Upper bound on live speakers, so pathological audio can't spawn dozens.
const MAX_LIVE_SPEAKERS: usize = 10;

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
    /// Last speaker assigned, reused for segments too short to embed.
    last_speaker: usize,
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
    *guard = Some(OnlineDiarizer {
        models,
        centroids: Vec::new(),
        counts: Vec::new(),
        mic_counts: Vec::new(),
        last_speaker: 0,
    });
    log::info!("🧑‍🤝‍🧑 Live speaker identification started");
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

    // Too short to characterise a voice — attribute it to whoever was last
    // speaking rather than guessing or dropping the label.
    if samples.len() < MIN_SEGMENT_SAMPLES {
        let index = d.last_speaker;
        let is_user = d.user_speaker() == Some(index);
        return Some(LiveSpeaker { index, is_user });
    }

    let embedding = match d.models.embed(samples) {
        Ok(e) => e,
        Err(e) => {
            log::debug!("Live diarization: embedding failed ({})", e);
            let index = d.last_speaker;
            let is_user = d.user_speaker() == Some(index);
            return Some(LiveSpeaker { index, is_user });
        }
    };

    // Closest known speaker by cosine similarity (embeddings are unit-length).
    let mut best = 0usize;
    let mut best_sim = f32::NEG_INFINITY;
    for (i, c) in d.centroids.iter().enumerate() {
        let sim: f32 = embedding.iter().zip(c).map(|(a, b)| a * b).sum();
        if sim > best_sim {
            best_sim = sim;
            best = i;
        }
    }

    let speaker = if d.centroids.is_empty() {
        d.centroids.push(embedding);
        d.counts.push(1.0);
        d.mic_counts.push(0.0);
        0
    } else if (1.0 - best_sim) <= ONLINE_THRESHOLD || d.centroids.len() >= MAX_LIVE_SPEAKERS {
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
            "🧑‍🤝‍🧑 Live diarization: new speaker {} detected",
            d.centroids.len()
        );
        d.centroids.len() - 1
    };

    // Record which source this speaker arrived on, so the user can be identified.
    if mic_dominant {
        d.mic_counts[speaker] += 1.0;
    }

    d.last_speaker = speaker;
    let user = d.user_speaker();
    let is_user = user == Some(speaker);

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

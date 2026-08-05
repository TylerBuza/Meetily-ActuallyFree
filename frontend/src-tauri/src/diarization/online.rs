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

struct OnlineDiarizer {
    models: DiarizationModels,
    /// Running mean embedding per speaker (kept length-normalized).
    centroids: Vec<Vec<f32>>,
    /// How many segments contributed to each centroid.
    counts: Vec<f32>,
    /// Last speaker assigned, reused for segments too short to embed.
    last_speaker: usize,
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

/// Assign a 16 kHz mono speech segment to a live speaker index (0-based).
///
/// Returns `None` when live diarization isn't running or the segment can't be
/// embedded, so callers can fall back to their existing labelling.
pub fn assign_speaker(samples: &[f32]) -> Option<usize> {
    let mut guard = ONLINE.lock().ok()?;
    let d = guard.as_mut()?;

    // Too short to characterise a voice — attribute it to whoever was last
    // speaking rather than guessing or dropping the label.
    if samples.len() < MIN_SEGMENT_SAMPLES {
        return Some(d.last_speaker);
    }

    let embedding = match d.models.embed(samples) {
        Ok(e) => e,
        Err(e) => {
            log::debug!("Live diarization: embedding failed ({})", e);
            return Some(d.last_speaker);
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
        log::info!(
            "🧑‍🤝‍🧑 Live diarization: new speaker {} detected",
            d.centroids.len()
        );
        d.centroids.len() - 1
    };

    d.last_speaker = speaker;
    Some(speaker)
}

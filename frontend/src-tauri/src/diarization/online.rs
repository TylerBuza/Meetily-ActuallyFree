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
    /// Of those, how many arrived on the microphone capture source.
    mic_counts: Vec<f32>,
    /// Last speaker assigned on any path (legacy fallback).
    last_speaker: usize,
    /// Last speaker heard on the system/remote path only — short remote
    /// fragments should not inherit the local user's cluster.
    last_system_speaker: Option<usize>,
    /// Last speaker heard on the mic path.
    last_mic_speaker: Option<usize>,
    profiles: Vec<super::voice_profiles::VoiceProfile>,
    /// Set from a tentative vector match, never from a meeting-local channel number.
    names: Vec<Option<String>>,
    profile_evidence: Vec<Vec<Vec<f32>>>,
    blocked_profiles: std::collections::HashSet<usize>,
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
pub fn detach_voice_match(label: &str) {
    let Some(index) = label.strip_prefix("Speaker ").and_then(|number| number.parse::<usize>().ok()).and_then(|value| value.checked_sub(1)) else { return; };
    if let Ok(mut guard) = ONLINE.lock() {
        if let Some(diarizer) = guard.as_mut() {
            diarizer.blocked_profiles.insert(index);
            if let Some(name) = diarizer.names.get_mut(index) { *name = None; }
            if let Some(evidence) = diarizer.profile_evidence.get_mut(index) { evidence.clear(); }
        }
    }
}

pub fn possible_voice_match(label: &str) -> Option<super::voice_profiles::PossibleVoiceMatch> {
    let index = label.strip_prefix("Speaker ")?.parse::<usize>().ok()?.checked_sub(1)?;
    let guard = ONLINE.try_lock().ok()?;
    let diarizer = guard.as_ref()?;
    if diarizer.user_speaker() == Some(index) || diarizer.blocked_profiles.contains(&index) { return None; }
    super::voice_profiles::possible_match(diarizer.profile_evidence.get(index)?, &diarizer.profiles)
}

pub fn is_active() -> bool {
    super::live_nemotron::active() || ONLINE.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Begin a live session with the selected engine, fixed for this recording.
/// Nemotron receives continuous system audio from the pipeline; Pyannote uses
/// the existing per-turn embedding path. Neither silently switches engines.
///
/// Safe to call when models are absent — it simply reports failure and the
/// caller falls back to capture-source labels.
pub fn start<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<()> {
    stop();
    if super::get_active_engine() == "nemotron" {
        super::live_nemotron::start(app)?;
        if let Err(error) = super::voice_profiles::start_live_matcher() {
            log::warn!("Named voice matching unavailable for this Nemotron session: {error}");
        }
        return Ok(());
    }
    if !super::pyannote_models_available() {
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
    let profiles = match super::voice_profiles::load_for_matching() {
        Ok(profiles) => profiles,
        Err(error) => {
            log::warn!("Named voice profiles unavailable for this meeting: {error}");
            Vec::new()
        }
    };
    *guard = Some(OnlineDiarizer {
        models,
        centroids: enrolled.into_iter().collect(),
        counts: if has_enrolled { vec![4.0] } else { Vec::new() },
        mic_counts: if has_enrolled { vec![4.0] } else { Vec::new() },
        last_speaker: 0,
        last_system_speaker: None,
        last_mic_speaker: has_enrolled.then_some(0),
        profiles,
        blocked_profiles: Default::default(),
        profile_evidence: if has_enrolled { vec![Vec::new()] } else { Vec::new() },
        names: if has_enrolled { vec![None] } else { Vec::new() },
    });
    log::info!(
        "🧑‍🤝‍🧑 Live speaker identification started (voiceprint={})",
        has_enrolled
    );
    Ok(())
}

/// End the session and release the model.
pub fn stop() {
    super::live_nemotron::stop();
    super::voice_profiles::stop_live_matcher();
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
    /// Whether this chunk came from the microphone; not verified identity.
    pub is_user: bool,
    pub profile_name: Option<String>,
}

/// Assign a 16 kHz mono speech segment to a live speaker.
///
/// `mic_dominant` is the immutable capture-source flag, not a volume comparison.
/// Microphone and system clusters never learn from one another.
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
            d.last_mic_speaker?
        } else {
            d.last_system_speaker?
        };
        let is_user = mic_dominant;
        return Some(LiveSpeaker {
            index,
            is_user: mic_dominant || is_user,
            profile_name: if mic_dominant { None } else { d.names.get(index).cloned().flatten() },
        });
    }

    let embedding = match d.models.embed(samples) {
        Ok(e) => e,
        Err(e) => {
            log::debug!("Live diarization: embedding failed ({})", e);
            let index = if mic_dominant {
                d.last_mic_speaker?
            } else {
                d.last_system_speaker?
            };
            return Some(LiveSpeaker {
                index,
                is_user: mic_dominant,
                profile_name: if mic_dominant { None } else { d.names.get(index).cloned().flatten() },
            });
        }
    };

    let profile_embedding = (!mic_dominant && samples.len() >= 32_000).then(|| embedding.clone());

    // A microphone copy of remote playback must not claim or update that
    // remote cluster, even when it arrives while joining during speech. Source
    // membership is fixed by the first sample, independently of voice similarity.
    let (best, best_sim) = closest_on_source(&d.centroids, &d.mic_counts, &embedding, mic_dominant)
        .unwrap_or((0, f32::NEG_INFINITY));
    if !best_sim.is_finite() && d.centroids.len() >= MAX_LIVE_SPEAKERS { return None; }

    let threshold = if mic_dominant {
        ONLINE_THRESHOLD_MIC
    } else {
        ONLINE_THRESHOLD_SYSTEM
    };

    let speaker = if d.centroids.is_empty() {
        d.centroids.push(embedding);
        d.counts.push(1.0);
        d.mic_counts.push(0.0);
        d.names.push(None);
        d.profile_evidence.push(Vec::new());
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
        d.names.push(None);
        d.profile_evidence.push(Vec::new());
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
    if let Some(vector) = profile_embedding.filter(|_| !d.blocked_profiles.contains(&speaker)) {
        super::voice_profiles::push_match_evidence(&mut d.profile_evidence[speaker], vector);
        d.names[speaker] = super::voice_profiles::confirmed_match(&d.profile_evidence[speaker], &d.profiles)
            .map(|profile| profile.name.clone());
    }
    let user = d.user_speaker();
    // Mic path is always the local user for dual-path STT; system path never is.
    let is_user = mic_dominant;

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

    Some(LiveSpeaker {
        index: speaker,
        is_user,
        profile_name: if mic_dominant { None } else { d.names[speaker].clone() },
    })
}

/// Only compare within immutable capture-source membership. Synthetic embeddings
/// reproduce identical electrical loopback without requiring a speech model.
fn closest_on_source(centroids: &[Vec<f32>], mic_counts: &[f32], embedding: &[f32], microphone: bool) -> Option<(usize, f32)> {
    centroids.iter().enumerate().filter(|(i, _)| (mic_counts[*i] > 0.0) == microphone)
        .map(|(i, c)| (i, embedding.iter().zip(c).map(|(a,b)| a*b).sum::<f32>()))
        .filter(|(_, score)| score.is_finite())
        .max_by(|a,b| a.1.total_cmp(&b.1))
}

#[cfg(test)]
mod source_tests {
    use super::*;
    #[test]
    fn joining_during_remote_speech_does_not_claim_remote_cluster_as_user() {
        let remote = vec![1.0, 0.0];
        let mut centroids = vec![remote.clone()]; let mut mic_counts = vec![0.0];
        assert_eq!(closest_on_source(&centroids, &mic_counts, &remote, false), Some((0, 1.0)));
        // The headset delivers an identical electronic copy on the mic input.
        assert_eq!(closest_on_source(&centroids, &mic_counts, &remote, true), None);
        centroids.push(remote.clone()); mic_counts.push(1.0);
        assert_eq!(closest_on_source(&centroids, &mic_counts, &remote, true), Some((1, 1.0)));
        assert_eq!(closest_on_source(&centroids, &mic_counts, &remote, false), Some((0, 1.0)));
        assert_eq!(mic_counts[0], 0.0);
    }
    #[test]
    fn enrolled_user_and_short_first_remote_turn_do_not_share_a_fallback() {
        let user = vec![1.0, 0.0];
        assert_eq!(closest_on_source(&[user.clone()], &[1.0], &user, false), None);
        assert_eq!(closest_on_source(&[user.clone()], &[1.0], &user, true), Some((0, 1.0)));
    }
}

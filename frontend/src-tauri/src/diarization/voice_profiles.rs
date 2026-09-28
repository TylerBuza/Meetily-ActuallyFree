//! Opt-in WeSpeaker voice profiles for named people. A profile is enrolled only
//! from user-labeled, non-overlapping system-track turns; anonymous diarization
//! channel numbers are never treated as durable identities.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::sync::Mutex;
use std::collections::HashMap;

use super::models::DiarizationModels;

const MODEL: &str = "wespeaker-resnet34-LM/lda-128";
const MATCH_THRESHOLD: f32 = 0.80;
const MATCH_MARGIN: f32 = 0.08;
const MAX_PROFILES: usize = 50;
const MAX_TURNS: usize = 8;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VoiceProfile {
    pub person_id: String,
    pub name: String,
    pub embedding: Vec<f32>,
    pub samples: u32,
    pub model: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct VoiceProfileInfo {
    pub person_id: String,
    pub name: String,
    pub samples: u32,
}

fn path() -> PathBuf {
    crate::paths::install_data_root().join("voice_profiles.json")
}

fn enabled_path() -> PathBuf {
    crate::paths::install_data_root().join("voice_profiles_enabled.txt")
}

static ENABLED: OnceLock<AtomicBool> = OnceLock::new();
static PROFILE_WRITE: Mutex<()> = Mutex::new(());
static LIVE_MATCHER: Mutex<Option<LiveMatcher>> = Mutex::new(None);

struct LiveMatcher {
    models: DiarizationModels,
    profiles: Vec<VoiceProfile>,
    names: HashMap<String, String>,
    pending: HashMap<String, Vec<f32>>,
}

/// Identity matching supplements Nemotron's meeting-local channels; it does not
/// run a second diarization engine or infer a name from the channel number.
pub fn start_live_matcher() -> Result<()> {
    let mut guard = LIVE_MATCHER.lock().map_err(|_| anyhow::anyhow!("Live profile lock poisoned"))?;
    *guard = None;
    let profiles = load_for_matching()?;
    if profiles.is_empty() { return Ok(()); }
    let models = DiarizationModels::load(&super::diarization_model_dir())?;
    *guard = Some(LiveMatcher { models, profiles, names: HashMap::new(), pending: HashMap::new() });
    Ok(())
}

pub fn stop_live_matcher() {
    if let Ok(mut guard) = LIVE_MATCHER.lock() { *guard = None; }
}

/// Called on a blocking ASR worker, never on the capture thread.
pub fn name_live_nemotron_turn(label: &str, samples: &[f32]) -> Option<String> {
    if !label.starts_with("Speaker ") { return None; }
    let mut guard = LIVE_MATCHER.lock().ok()?;
    let matcher = guard.as_mut()?;
    if let Some(name) = matcher.names.get(label) { return Some(name.clone()); }
    // Near-live VAD chunks can be shorter than the embedding model's 2 s
    // comparison window. Accumulate only this Nemotron channel's audio and
    // cap it at 4 s; channel numbers are meeting-local, never identities.
    let ready = {
        let pending = matcher.pending.entry(label.to_string()).or_default();
        append_live_profile_audio(pending, samples);
        (pending.len() >= 32_000).then(|| pending.clone())
    };
    if let Some(audio) = ready {
        if let Ok(embedding) = matcher.models.embed(&audio) {
            if let Some(profile) = best_match(&embedding, &matcher.profiles) {
                let name = profile.name.clone();
                matcher.names.insert(label.to_string(), name.clone());
                matcher.pending.remove(label);
                return Some(name);
            }
        }
        if audio.len() >= 64_000 { matcher.pending.remove(label); }
    }
    None
}

fn append_live_profile_audio(pending: &mut Vec<f32>, samples: &[f32]) {
    const MAX_SAMPLES: usize = 64_000;
    let incoming = &samples[samples.len().saturating_sub(MAX_SAMPLES)..];
    let excess = pending.len().saturating_add(incoming.len()).saturating_sub(MAX_SAMPLES);
    if excess > 0 { pending.drain(..excess); }
    pending.extend_from_slice(incoming);
}

/// Compare clean, non-overlapping system-track turns for each diarized remote
/// channel. The caller keeps all unnamed channels and original timestamps.
pub fn match_offline_speakers(track: &Path, segments: &[super::DiarizationSegment]) -> Result<HashMap<usize, String>> {
    let profiles = load_for_matching()?;
    if profiles.is_empty() { return Ok(HashMap::new()); }
    let audio = crate::audio::decoder::decode_audio_file(track)?.to_whisper_format();
    let mut models = DiarizationModels::load(&super::diarization_model_dir())?;
    let mut vectors: HashMap<usize, Vec<Vec<f32>>> = HashMap::new();
    for segment in segments {
        let duration = segment.end - segment.start;
        // Cross-track overlap with the local mic does not contaminate the
        // separate system file. Only another remote channel makes it unsafe.
        let remote_overlap = segments.iter().any(|other| other.speaker != segment.speaker
            && other.start < segment.end && other.end > segment.start);
        if remote_overlap || !(2.0..=15.0).contains(&duration) { continue; }
        let entries = vectors.entry(segment.speaker).or_default();
        if entries.len() >= MAX_TURNS { continue; }
        let first = (segment.start * 16_000.0) as usize;
        let last = (segment.end * 16_000.0) as usize;
        if first >= last || last > audio.len() { continue; }
        if let Ok(vector) = models.embed(&audio[first..last]) {
            if vector.len() == 128 { entries.push(vector); }
        }
    }
    let mut names = HashMap::new();
    for (speaker, samples) in vectors {
        if samples.len() < 2 { continue; }
        let mut mean = vec![0.0f32; 128];
        for vector in &samples {
            for (target, value) in mean.iter_mut().zip(vector) { *target += *value; }
        }
        if let Some(profile) = best_match(&mean, &profiles) {
            names.insert(speaker, profile.name.clone());
        }
    }
    Ok(names)
}

fn enabled_flag() -> &'static AtomicBool {
    ENABLED.get_or_init(|| {
        let value = std::fs::read_to_string(enabled_path())
            .map(|text| text.trim() == "true")
            .unwrap_or(false);
        AtomicBool::new(value)
    })
}

pub fn enabled() -> bool {
    enabled_flag().load(Ordering::Relaxed)
}

#[tauri::command]
pub fn get_voice_profiles_enabled() -> bool {
    enabled()
}

#[tauri::command]
pub fn set_voice_profiles_enabled(value: bool) -> Result<(), String> {
    let file = enabled_path();
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(file, if value { "true" } else { "false" })
        .map_err(|error| error.to_string())?;
    enabled_flag().store(value, Ordering::Relaxed);
    Ok(())
}

fn load() -> Result<Vec<VoiceProfile>> {
    let bytes = match std::fs::read(path()) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    serde_json::from_slice(&bytes).context("Voice profile data is invalid")
}

fn save(profiles: &[VoiceProfile]) -> Result<()> {
    let file = path();
    if let Some(parent) = file.parent() { std::fs::create_dir_all(parent)?; }
    let temp = file.with_extension("json.tmp");
    let backup = file.with_extension("json.bak");
    std::fs::write(&temp, serde_json::to_vec_pretty(profiles)?)?;
    if file.exists() {
        if backup.exists() { std::fs::remove_file(&backup)?; }
        std::fs::rename(&file, &backup)?;
    }
    if let Err(error) = std::fs::rename(&temp, &file) {
        if backup.exists() { let _ = std::fs::rename(&backup, &file); }
        return Err(error.into());
    }
    if backup.exists() { let _ = std::fs::remove_file(backup); }
    Ok(())
}

pub fn load_for_matching() -> Result<Vec<VoiceProfile>> {
    if !enabled() { return Ok(Vec::new()); }
    let _guard = PROFILE_WRITE.lock().map_err(|_| anyhow::anyhow!("Voice profile lock poisoned"))?;
    Ok(load()?.into_iter().filter(|profile| profile.model == MODEL && profile.embedding.len() == 128).collect())
}

pub fn active_person_links() -> Vec<(String, String)> {
    load_for_matching().unwrap_or_default().into_iter()
        .map(|profile| (profile.name, profile.person_id)).collect()
}

fn similarity(a: &[f32], b: &[f32]) -> Option<f32> {
    if a.len() != 128 || b.len() != 128 { return None; }
    let dot = a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
    let na = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    (na > 1e-6 && nb > 1e-6).then_some(dot / (na * nb))
}

pub fn best_match<'a>(embedding: &[f32], profiles: &'a [VoiceProfile]) -> Option<&'a VoiceProfile> {
    let mut ranked: Vec<(f32, &VoiceProfile)> = profiles.iter()
        .filter_map(|profile| similarity(embedding, &profile.embedding).map(|score| (score, profile)))
        .collect();
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
    let (score, profile) = *ranked.first()?;
    let runner_up = ranked.get(1).map(|entry| entry.0).unwrap_or(-1.0);
    (score >= MATCH_THRESHOLD && score - runner_up >= MATCH_MARGIN).then_some(profile)
}

fn enroll_from_track(track: &Path, turns: &[(f64, f64)], person_id: String, name: String) -> Result<VoiceProfile> {
    let audio = crate::audio::decoder::decode_audio_file(track)?.to_whisper_format();
    let mut models = DiarizationModels::load(&super::diarization_model_dir())?;
    let mut vectors = Vec::new();
    for &(start, end) in turns.iter().take(MAX_TURNS) {
        let first = (start * 16_000.0) as usize;
        let last = (end * 16_000.0) as usize;
        if first >= last || last > audio.len() { continue; }
        if let Ok(vector) = models.embed(&audio[first..last]) {
            if vector.len() == 128 { vectors.push(vector); }
        }
    }
    if vectors.len() < 2 { bail!("At least two clear speaker turns are required for enrollment"); }
    let mut mean = vec![0.0f32; 128];
    for vector in &vectors {
        for (target, value) in mean.iter_mut().zip(vector) { *target += *value; }
    }
    let norm = mean.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm <= 1e-6 { bail!("Voice embedding is empty"); }
    for value in &mut mean { *value /= norm; }
    Ok(VoiceProfile { person_id, name, embedding: mean, samples: vectors.len() as u32, model: MODEL.into() })
}

#[tauri::command]
pub async fn enroll_voice_profile(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    speaker: String,
) -> Result<VoiceProfileInfo, String> {
    if !enabled() { return Err("Enable Voice profiles in Labs first".into()); }
    if !super::pyannote_models_available() { return Err("WeSpeaker diarization models are required".into()); }
    if !crate::database::repositories::person::is_person_name(&speaker) {
        if speaker.trim().to_ascii_lowercase().starts_with("speaker ") {
            return Err("Name this speaker before enrolling a voice profile".into());
        }
        return Err("Choose a named remote speaker for voice enrollment".into());
    }
    let pool = state.db_manager.pool();
    let mut identity: Option<(String, String)> = sqlx::query_as(
        "SELECT p.id, p.display_name FROM person_speakers ps JOIN people p ON p.id = ps.person_id \
         WHERE ps.meeting_id = ? AND ps.speaker_label = ?",
    ).bind(&meeting_id).bind(&speaker).fetch_optional(pool).await
        .map_err(|error| error.to_string())?;
    if identity.is_none() {
        // Older saves and names entered during live capture can have the name
        // on transcript rows without a durable person_speakers link.
        let saved: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM transcripts WHERE meeting_id = ? AND speaker = ?",
        ).bind(&meeting_id).bind(&speaker).fetch_one(pool).await.map_err(|error| error.to_string())?;
        if saved == 0 {
            return Err("This named speaker is not in the saved transcript yet".into());
        }
        crate::database::repositories::person::PeopleRepository::rename_meeting_speaker(
            pool, &meeting_id, &speaker, &speaker,
        ).await.map_err(|error| format!("Could not link named speaker: {error}"))?;
        identity = sqlx::query_as(
            "SELECT p.id, p.display_name FROM person_speakers ps JOIN people p ON p.id = ps.person_id \
             WHERE ps.meeting_id = ? AND ps.speaker_label = ?",
        ).bind(&meeting_id).bind(&speaker).fetch_optional(pool).await.map_err(|error| error.to_string())?;
    }
    let (person_id, name) = identity.ok_or("Could not link this named speaker to a person")?;
    let folder: Option<String> = sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id = ?")
        .bind(&meeting_id).fetch_optional(pool).await.map_err(|error| error.to_string())?.flatten();
    let folder = folder.ok_or("Meeting has no saved audio folder")?;
    let track = PathBuf::from(folder).join("system.mp4");
    if !track.is_file() { return Err("A separate system audio track is required for enrollment".into()); }
    let rows: Vec<(String, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT COALESCE(speaker, ''), audio_start_time, audio_end_time FROM transcripts WHERE meeting_id = ? ORDER BY audio_start_time",
    ).bind(&meeting_id).fetch_all(pool).await.map_err(|error| error.to_string())?;
    let others: Vec<(f64, f64)> = rows.iter().filter(|(label, _, _)| label != &speaker)
        .filter_map(|(_, start, end)| Some((start.as_ref()?.to_owned(), end.as_ref()?.to_owned())))
        .collect();
    let turns: Vec<(f64, f64)> = rows.iter().filter(|(label, _, _)| label == &speaker)
        .filter_map(|(_, start, end)| Some((start.as_ref()?.to_owned(), end.as_ref()?.to_owned())))
        .filter(|(start, end)| start.is_finite() && end.is_finite() && *start >= 0.0 && end - start >= 2.0 && end - start <= 15.0)
        .filter(|(start, end)| !others.iter().any(|(other_start, other_end)| other_start < end && other_end > start))
        .take(MAX_TURNS).collect();
    if turns.len() < 2 { return Err("At least two non-overlapping turns of 2–15 seconds are required".into()); }
    let profile = tokio::task::spawn_blocking(move || enroll_from_track(&track, &turns, person_id, name))
        .await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())?;
    let info = VoiceProfileInfo { person_id: profile.person_id.clone(), name: profile.name.clone(), samples: profile.samples };
    let _guard = PROFILE_WRITE.lock().map_err(|_| "Voice profile lock poisoned")?;
    let mut profiles = load().map_err(|error| error.to_string())?;
    profiles.retain(|existing| existing.person_id != profile.person_id);
    if profiles.len() >= MAX_PROFILES { return Err("Voice profile limit reached".into()); }
    profiles.push(profile);
    save(&profiles).map_err(|error| error.to_string())?;
    Ok(info)
}

#[tauri::command]
pub fn list_voice_profiles() -> Result<Vec<VoiceProfileInfo>, String> {
    let _guard = PROFILE_WRITE.lock().map_err(|_| "Voice profile lock poisoned")?;
    Ok(load().map_err(|error| error.to_string())?.into_iter().map(|profile| VoiceProfileInfo {
        person_id: profile.person_id, name: profile.name, samples: profile.samples,
    }).collect())
}

#[tauri::command]
pub fn delete_voice_profile(person_id: String) -> Result<(), String> {
    let _guard = PROFILE_WRITE.lock().map_err(|_| "Voice profile lock poisoned")?;
    let mut profiles = load().map_err(|error| error.to_string())?;
    profiles.retain(|profile| profile.person_id != person_id);
    save(&profiles).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matching_requires_margin_and_correct_dimension() {
        let mut vector = vec![0.0; 128]; vector[0] = 1.0;
        let profile = VoiceProfile { person_id: "p1".into(), name: "Alice".into(), embedding: vector.clone(), samples: 2, model: MODEL.into() };
        assert_eq!(best_match(&vector, &[profile.clone()]).unwrap().name, "Alice");
        assert!(best_match(&vector, &[profile.clone(), profile]).is_none());
        assert!(best_match(&[1.0, 0.0], &[]).is_none());
    }
    #[test]
    fn short_live_chunks_accumulate_to_embedding_length_with_bounded_memory() {
        let mut pending = Vec::new();
        append_live_profile_audio(&mut pending, &vec![0.2; 20_000]);
        assert_eq!(pending.len(), 20_000);
        append_live_profile_audio(&mut pending, &vec![0.3; 16_000]);
        assert_eq!(pending.len(), 36_000);
        append_live_profile_audio(&mut pending, &vec![0.4; 50_000]);
        assert_eq!(pending.len(), 64_000);
        assert_eq!(pending[0], 0.3);
    }
}

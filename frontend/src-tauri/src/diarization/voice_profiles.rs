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
use sqlx::SqlitePool;

use super::models::DiarizationModels;

const MODEL: &str = "wespeaker-resnet34-LM/lda-128";
const MATCH_THRESHOLD: f32 = 0.80;
const MATCH_MARGIN: f32 = 0.08;
const MAX_PROFILES: usize = 50;
/// Clear turns learned from one meeting, spread across it.
const LEARN_TURNS: usize = 20;
/// Turns compared per voice when matching during diarization.
const MATCH_TURNS: usize = 8;
/// Meetings a voice is learned from; the oldest share drops off first.
const MAX_SOURCES: usize = 12;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VoiceProfile {
    pub person_id: String,
    pub name: String,
    pub embedding: Vec<f32>,
    pub samples: u32,
    pub model: String,
    /// Each meeting's share of the voice, so learning from a meeting again
    /// replaces its share instead of counting it twice. A profile saved before
    /// shares were kept has none, and counts as one earlier share.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<VoiceSource>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VoiceSource {
    /// Empty for the share of a profile saved before shares were kept.
    pub meeting_id: String,
    /// Sum of the meeting's turn embeddings.
    pub sum: Vec<f32>,
    pub turns: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct VoiceProfileInfo {
    pub person_id: String,
    pub name: String,
    pub samples: u32,
    /// Meetings the voice was learned from.
    pub meetings: u32,
}

impl VoiceProfile {
    fn info(&self) -> VoiceProfileInfo {
        VoiceProfileInfo {
            person_id: self.person_id.clone(),
            name: self.name.clone(),
            samples: self.samples,
            meetings: self.sources.len().max(1) as u32,
        }
    }

    /// The meeting shares the voice was built from.
    fn shares(&self) -> Vec<VoiceSource> {
        if !self.sources.is_empty() {
            return self.sources.clone();
        }
        vec![VoiceSource {
            meeting_id: String::new(),
            sum: self.embedding.iter().map(|value| value * self.samples as f32).collect(),
            turns: self.samples,
        }]
    }
}

/// Up to `count` items, evenly spaced from first to last, so a long meeting
/// is learned from all of it rather than its opening minutes.
fn spread<T: Copy>(items: &[T], count: usize) -> Vec<T> {
    if items.len() <= count {
        return items.to_vec();
    }
    (0..count).map(|index| items[index * items.len() / count]).collect()
}

fn share_of(meeting_id: &str, vectors: &[Vec<f32>]) -> VoiceSource {
    let mut sum = vec![0.0f32; 128];
    for vector in vectors {
        for (target, value) in sum.iter_mut().zip(vector) { *target += *value; }
    }
    VoiceSource { meeting_id: meeting_id.to_string(), sum, turns: vectors.len() as u32 }
}

/// Adds shares to a voice's earlier ones. A meeting learned again replaces
/// its earlier share; past `MAX_SOURCES`, the oldest shares drop off.
fn merge_shares(mut earlier: Vec<VoiceSource>, added: Vec<VoiceSource>) -> Vec<VoiceSource> {
    for share in added {
        if !share.meeting_id.is_empty() {
            earlier.retain(|existing| existing.meeting_id != share.meeting_id);
        }
        earlier.push(share);
    }
    if earlier.len() > MAX_SOURCES {
        let extra = earlier.len() - MAX_SOURCES;
        earlier.drain(..extra);
    }
    earlier
}

/// A voice is the direction of the mean of every turn it was learned from.
fn build_profile(person_id: String, name: String, sources: Vec<VoiceSource>) -> Result<VoiceProfile> {
    let turns: u32 = sources.iter().map(|source| source.turns).sum();
    if turns < 2 {
        bail!("{name} needs at least two clear turns of 2 to 15 seconds, with nobody talking over them.");
    }
    let mut embedding = vec![0.0f32; 128];
    for source in sources.iter().filter(|source| source.sum.len() == 128) {
        for (target, value) in embedding.iter_mut().zip(&source.sum) { *target += *value; }
    }
    let norm = embedding.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm <= 1e-6 { bail!("Voice embedding is empty"); }
    for value in &mut embedding { *value /= norm; }
    Ok(VoiceProfile { person_id, name, embedding, samples: turns, model: MODEL.into(), sources })
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
    // Near-live chunks can be shorter than the embedding model's 2 s window.
    // Keep at most 4 s for this meeting-local channel, never as an identity.
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
        if entries.len() >= MATCH_TURNS { continue; }
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

/// Why a voice could not be learned. `Unavailable` holds for every meeting
/// (the feature is off, the models are missing, the list is full), so there
/// is no point trying another one.
enum EnrollError {
    Unavailable(String),
    Meeting(String),
}

impl From<EnrollError> for String {
    fn from(error: EnrollError) -> Self {
        match error {
            EnrollError::Unavailable(message) | EnrollError::Meeting(message) => message,
        }
    }
}

/// Embeds up to `LEARN_TURNS` clean turns of one meeting's call audio.
fn embed_turns(track: &Path, turns: &[(f64, f64)]) -> Result<Vec<Vec<f32>>> {
    let audio = crate::audio::decoder::decode_audio_file(track)?.to_whisper_format();
    let mut models = DiarizationModels::load(&super::diarization_model_dir())?;
    let mut vectors = Vec::new();
    for &(start, end) in turns.iter().take(LEARN_TURNS) {
        let first = (start * 16_000.0) as usize;
        let last = (end * 16_000.0) as usize;
        if first >= last || last > audio.len() { continue; }
        if let Ok(vector) = models.embed(&audio[first..last]) {
            if vector.len() == 128 { vectors.push(vector); }
        }
    }
    Ok(vectors)
}

/// One meeting's share of a named speaker's voice, with the contact it
/// belongs to.
async fn meeting_share(
    pool: &SqlitePool,
    meeting_id: &str,
    speaker: &str,
) -> Result<(String, String, VoiceSource), EnrollError> {
    use EnrollError::{Meeting, Unavailable};
    let failed = |error: sqlx::Error| Meeting(error.to_string());
    if !enabled() {
        return Err(Unavailable("Turn on Voice profiles in Settings > Labs first.".into()));
    }
    if !super::pyannote_models_available() {
        return Err(Unavailable("Voice profiles need the speaker models. Download them in Settings > Transcription.".into()));
    }
    if !crate::database::repositories::person::is_person_name(speaker) {
        if speaker.trim().to_ascii_lowercase().starts_with("speaker ") {
            return Err(Meeting("Name this speaker before learning their voice.".into()));
        }
        return Err(Meeting("Only a named speaker on the call can have a voice profile.".into()));
    }
    let mut identity: Option<(String, String)> = sqlx::query_as(
        "SELECT p.id, p.display_name FROM person_speakers ps JOIN people p ON p.id = ps.person_id \
         WHERE ps.meeting_id = ? AND ps.speaker_label = ?",
    ).bind(meeting_id).bind(speaker).fetch_optional(pool).await.map_err(failed)?;
    if identity.is_none() {
        // Older saves and names entered during live capture can have the name
        // on transcript rows without a durable person_speakers link.
        let saved: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM transcripts WHERE meeting_id = ? AND speaker = ?",
        ).bind(meeting_id).bind(speaker).fetch_one(pool).await.map_err(failed)?;
        if saved == 0 {
            return Err(Meeting("This named speaker is not in the saved transcript yet.".into()));
        }
        crate::database::repositories::person::PeopleRepository::rename_meeting_speaker(
            pool, meeting_id, speaker, speaker,
        ).await.map_err(|error| Meeting(format!("Could not link the named speaker: {error}")))?;
        identity = sqlx::query_as(
            "SELECT p.id, p.display_name FROM person_speakers ps JOIN people p ON p.id = ps.person_id \
             WHERE ps.meeting_id = ? AND ps.speaker_label = ?",
        ).bind(meeting_id).bind(speaker).fetch_optional(pool).await.map_err(failed)?;
    }
    let (person_id, name) = identity.ok_or_else(|| Meeting("Could not link this named speaker to a contact.".into()))?;
    let folder: Option<String> = sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id = ?")
        .bind(meeting_id).fetch_optional(pool).await.map_err(failed)?.flatten();
    let folder = folder.ok_or_else(|| Meeting("This meeting has no saved audio.".into()))?;
    let track = PathBuf::from(folder).join("system.mp4");
    if !track.is_file() {
        return Err(Meeting(
            "This meeting has no separate call audio to learn from. Recordings made with Save audio on keep it; imported files do not.".into(),
        ));
    }
    let rows: Vec<(String, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT COALESCE(speaker, ''), audio_start_time, audio_end_time FROM transcripts WHERE meeting_id = ? ORDER BY audio_start_time",
    ).bind(meeting_id).fetch_all(pool).await.map_err(failed)?;
    let others: Vec<(f64, f64)> = rows.iter().filter(|(label, _, _)| label != speaker)
        .filter_map(|(_, start, end)| Some((start.as_ref()?.to_owned(), end.as_ref()?.to_owned())))
        .collect();
    let clear: Vec<(f64, f64)> = rows.iter().filter(|(label, _, _)| label == speaker)
        .filter_map(|(_, start, end)| Some((start.as_ref()?.to_owned(), end.as_ref()?.to_owned())))
        .filter(|(start, end)| start.is_finite() && end.is_finite() && *start >= 0.0 && end - start >= 2.0 && end - start <= 15.0)
        .filter(|(start, end)| !others.iter().any(|(other_start, other_end)| other_start < end && other_end > start))
        .collect();
    let turns = spread(&clear, LEARN_TURNS);
    let no_clear_turn = || Meeting(format!(
        "{name} has no clear turn of 2 to 15 seconds, with nobody talking over them, in this meeting."
    ));
    if turns.is_empty() {
        return Err(no_clear_turn());
    }
    let vectors = tokio::task::spawn_blocking(move || embed_turns(&track, &turns))
        .await.map_err(|error| Meeting(error.to_string()))?.map_err(|error| Meeting(error.to_string()))?;
    if vectors.is_empty() {
        return Err(no_clear_turn());
    }
    Ok((person_id, name, share_of(meeting_id, &vectors)))
}

/// Adds (or, with `replace`, rebuilds from) meeting shares of a contact's
/// voice and saves it.
fn store_shares(person_id: &str, name: &str, shares: Vec<VoiceSource>, replace: bool) -> Result<VoiceProfileInfo, EnrollError> {
    use EnrollError::{Meeting, Unavailable};
    let _guard = PROFILE_WRITE.lock().map_err(|_| Unavailable("Voice profile lock poisoned".into()))?;
    let mut profiles = load().map_err(|error| Unavailable(error.to_string()))?;
    let existing = profiles.iter().position(|profile| profile.person_id == person_id);
    let earlier = match existing {
        Some(index) if !replace => profiles[index].shares(),
        _ => Vec::new(),
    };
    let profile = build_profile(person_id.to_string(), name.to_string(), merge_shares(earlier, shares))
        .map_err(|error| Meeting(error.to_string()))?;
    if existing.is_none() && profiles.len() >= MAX_PROFILES {
        return Err(Unavailable(format!("Meetily keeps up to {MAX_PROFILES} voices. Forget one to learn another.")));
    }
    let info = profile.info();
    match existing {
        Some(index) => profiles[index] = profile,
        None => profiles.push(profile),
    }
    save(&profiles).map_err(|error| Unavailable(error.to_string()))?;
    Ok(info)
}

/// Learns a named speaker's voice from one meeting. A voice learned before
/// keeps its other meetings; this meeting's share is added or replaced.
#[tauri::command]
pub async fn enroll_voice_profile(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    speaker: String,
) -> Result<VoiceProfileInfo, String> {
    let (person_id, name, share) = meeting_share(state.db_manager.pool(), &meeting_id, &speaker).await?;
    Ok(store_shares(&person_id, &name, vec![share], false)?)
}

/// Learns a contact's voice. With a meeting, that meeting's audio is added to
/// the voice; without one, the voice is rebuilt from all their recent
/// meetings, so it picks up everything recorded since it was first learned.
#[tauri::command]
pub async fn enroll_person_voice(
    state: tauri::State<'_, crate::state::AppState>,
    person_id: String,
    meeting_id: Option<String>,
) -> Result<VoiceProfileInfo, String> {
    let pool = state.db_manager.pool();
    let name: String = sqlx::query_scalar("SELECT display_name FROM people WHERE id = ?")
        .bind(&person_id).fetch_optional(pool).await.map_err(|error| error.to_string())?
        .ok_or("Contact not found")?;
    let meetings: Vec<(String, String)> = sqlx::query_as(
        "SELECT ps.meeting_id, ps.speaker_label FROM person_speakers ps \
         JOIN meetings m ON m.id = ps.meeting_id \
         WHERE ps.person_id = ? AND (? IS NULL OR ps.meeting_id = ?) \
         ORDER BY m.created_at DESC LIMIT ?",
    ).bind(&person_id).bind(&meeting_id).bind(&meeting_id).bind(MAX_SOURCES as i64)
        .fetch_all(pool).await.map_err(|error| error.to_string())?;
    if meetings.is_empty() {
        return Err(format!("{name} is not named as a speaker in a saved meeting yet."));
    }
    let tried = meetings.len();
    let mut shares = Vec::new();
    let mut last_problem = String::new();
    // Oldest first, so the newest meetings are the ones a full list keeps.
    for (meeting, label) in meetings.into_iter().rev() {
        match meeting_share(pool, &meeting, &label).await {
            Ok((_, _, share)) => shares.push(share),
            Err(EnrollError::Unavailable(message)) => return Err(message),
            Err(EnrollError::Meeting(message)) => last_problem = message,
        }
    }
    if shares.is_empty() {
        if tried == 1 {
            return Err(last_problem);
        }
        return Err(format!(
            "None of {name}'s last {tried} meetings has clear call audio of them. Learning a voice needs meetings recorded with Save audio on, where they speak for turns of 2 to 15 seconds."
        ));
    }
    Ok(store_shares(&person_id, &name, shares, meeting_id.is_none())?)
}

/// Voices Meetily knows, each under its contact's current name. A voice whose
/// contact no longer exists is forgotten here.
#[tauri::command]
pub async fn list_voice_profiles(state: tauri::State<'_, crate::state::AppState>) -> Result<Vec<VoiceProfileInfo>, String> {
    let people: HashMap<String, String> = sqlx::query_as::<_, (String, String)>("SELECT id, display_name FROM people")
        .fetch_all(state.db_manager.pool()).await.map_err(|error| error.to_string())?
        .into_iter().collect();
    let _guard = PROFILE_WRITE.lock().map_err(|_| "Voice profile lock poisoned")?;
    let mut profiles = load().map_err(|error| error.to_string())?;
    if reconcile_with_contacts(&mut profiles, &people) {
        save(&profiles).map_err(|error| error.to_string())?;
    }
    Ok(profiles.iter().map(VoiceProfile::info).collect())
}

#[tauri::command]
pub fn delete_voice_profile(person_id: String) -> Result<(), String> {
    edit_profiles(|profiles| forget(profiles, &person_id)).map_err(|error| error.to_string())
}

/// Loads the saved voices, applies a change, and saves them if it changed any.
fn edit_profiles(change: impl FnOnce(&mut Vec<VoiceProfile>) -> bool) -> Result<()> {
    let _guard = PROFILE_WRITE.lock().map_err(|_| anyhow::anyhow!("Voice profile lock poisoned"))?;
    let mut profiles = load()?;
    if change(&mut profiles) {
        save(&profiles)?;
    }
    Ok(())
}

fn rename(profiles: &mut [VoiceProfile], person_id: &str, name: &str) -> bool {
    let mut changed = false;
    for profile in profiles.iter_mut().filter(|profile| profile.person_id == person_id && profile.name != name) {
        profile.name = name.to_string();
        changed = true;
    }
    changed
}

/// The kept contact learns from both voices' meetings, or takes over the
/// merged contact's voice when it had none.
fn merge(profiles: &mut Vec<VoiceProfile>, source_id: &str, target_id: &str, target_name: &str) -> bool {
    let Some(index) = profiles.iter().position(|profile| profile.person_id == source_id) else {
        return rename(profiles, target_id, target_name);
    };
    let source = profiles.remove(index);
    if let Some(target) = profiles.iter_mut().find(|profile| profile.person_id == target_id) {
        if let Ok(combined) = build_profile(target_id.to_string(), target_name.to_string(), merge_shares(target.shares(), source.shares())) {
            *target = combined;
        }
    } else {
        profiles.push(VoiceProfile { person_id: target_id.to_string(), ..source });
    }
    rename(profiles, target_id, target_name);
    true
}

fn forget(profiles: &mut Vec<VoiceProfile>, person_id: &str) -> bool {
    let before = profiles.len();
    profiles.retain(|profile| profile.person_id != person_id);
    profiles.len() != before
}

/// `people` maps each contact id to its current name.
fn reconcile_with_contacts(profiles: &mut Vec<VoiceProfile>, people: &HashMap<String, String>) -> bool {
    let before = profiles.len();
    profiles.retain(|profile| people.contains_key(&profile.person_id));
    let mut changed = profiles.len() != before;
    for profile in profiles.iter_mut() {
        if let Some(name) = people.get(&profile.person_id) {
            if &profile.name != name {
                profile.name = name.clone();
                changed = true;
            }
        }
    }
    changed
}

// Contact edits keep the voices in step, so a matched voice is always named
// and linked like its contact. A failure here never fails the contact edit.

pub fn contact_renamed(person_id: &str, name: &str) {
    if let Err(error) = edit_profiles(|profiles| rename(profiles, person_id, name)) {
        log::warn!("Could not rename a voice profile: {error}");
    }
}

pub fn contacts_merged(source_id: &str, target_id: &str, target_name: &str) {
    if let Err(error) = edit_profiles(|profiles| merge(profiles, source_id, target_id, target_name)) {
        log::warn!("Could not move a voice profile to the merged contact: {error}");
    }
}

pub fn contact_deleted(person_id: &str) {
    if let Err(error) = edit_profiles(|profiles| forget(profiles, person_id)) {
        log::warn!("Could not forget a deleted contact's voice: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn matching_requires_margin_and_correct_dimension() {
        let mut vector = vec![0.0; 128]; vector[0] = 1.0;
        let profile = VoiceProfile { person_id: "p1".into(), name: "Alice".into(), embedding: vector.clone(), samples: 2, model: MODEL.into(), sources: Vec::new() };
        assert_eq!(best_match(&vector, &[profile.clone()]).unwrap().name, "Alice");
        assert!(best_match(&vector, &[profile.clone(), profile]).is_none());
        assert!(best_match(&[1.0, 0.0], &[]).is_none());
    }

    fn voice(person_id: &str, name: &str) -> VoiceProfile {
        let mut embedding = vec![0.0; 128];
        embedding[0] = 1.0;
        VoiceProfile { person_id: person_id.into(), name: name.into(), embedding, samples: 2, model: MODEL.into(), sources: Vec::new() }
    }

    /// A share of `turns` turns pointing along axis `axis`.
    fn share(meeting_id: &str, axis: usize, turns: u32) -> VoiceSource {
        let mut sum = vec![0.0; 128];
        sum[axis] = turns as f32;
        VoiceSource { meeting_id: meeting_id.into(), sum, turns }
    }

    #[test]
    fn renaming_a_contact_renames_only_their_voice() {
        let mut profiles = vec![voice("p1", "Alice"), voice("p2", "Bob")];
        assert!(rename(&mut profiles, "p1", "Alice Smith"));
        assert_eq!(profiles[0].name, "Alice Smith");
        assert_eq!(profiles[1].name, "Bob");
        assert!(!rename(&mut profiles, "p1", "Alice Smith"));
    }

    #[test]
    fn merging_contacts_combines_their_voices() {
        // Only the merged contact had a voice: it moves to the kept contact.
        let mut profiles = vec![voice("dup", "Al")];
        assert!(merge(&mut profiles, "dup", "kept", "Alice"));
        assert_eq!((profiles[0].person_id.as_str(), profiles[0].name.as_str()), ("kept", "Alice"));

        // Both had one: the kept contact learns from both.
        let mut profiles = vec![voice("dup", "Al"), voice("kept", "Alice")];
        assert!(merge(&mut profiles, "dup", "kept", "Alice"));
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].person_id, "kept");
        assert_eq!(profiles[0].samples, 4);
        assert_eq!(profiles[0].info().meetings, 2);

        // Neither had one: nothing to save.
        let mut profiles = vec![voice("other", "Bob")];
        assert!(!merge(&mut profiles, "dup", "kept", "Alice"));
    }

    #[test]
    fn deleted_and_missing_contacts_lose_their_voices() {
        let mut profiles = vec![voice("p1", "Alice"), voice("p2", "Bob")];
        assert!(forget(&mut profiles, "p2"));
        assert!(!forget(&mut profiles, "p2"));
        assert_eq!(profiles.len(), 1);

        let mut profiles = vec![voice("p1", "Alice"), voice("gone", "Carol")];
        let people = HashMap::from([("p1".to_string(), "Alice Smith".to_string())]);
        assert!(reconcile_with_contacts(&mut profiles, &people));
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].name, "Alice Smith");
        assert!(!reconcile_with_contacts(&mut profiles, &people));
    }

    #[test]
    fn learning_from_a_meeting_again_replaces_its_share() {
        let first = build_profile("p1".into(), "Alice".into(), merge_shares(Vec::new(), vec![share("m1", 0, 4)])).unwrap();
        let again = merge_shares(first.shares(), vec![share("m1", 0, 6)]);
        assert_eq!(again.len(), 1);
        assert_eq!(build_profile("p1".into(), "Alice".into(), again).unwrap().samples, 6);
    }

    #[test]
    fn a_new_meeting_adds_to_the_voice() {
        let first = build_profile("p1".into(), "Alice".into(), vec![share("m1", 0, 3)]).unwrap();
        let updated = build_profile("p1".into(), "Alice".into(), merge_shares(first.shares(), vec![share("m2", 1, 3)])).unwrap();
        assert_eq!((updated.samples, updated.info().meetings), (6, 2));
        // Equal turns on two axes point between them.
        assert!((updated.embedding[0] - updated.embedding[1]).abs() < 1e-6);
    }

    #[test]
    fn an_older_profile_counts_as_one_earlier_share() {
        let legacy = voice("p1", "Alice");
        let shares = merge_shares(legacy.shares(), vec![share("m1", 1, 2)]);
        assert_eq!(shares.len(), 2);
        assert_eq!(shares[0].meeting_id, "");
        assert_eq!(shares[0].turns, 2);
    }

    #[test]
    fn only_the_latest_meetings_are_kept() {
        let shares: Vec<_> = (0..MAX_SOURCES + 3).map(|index| share(&format!("m{index}"), 0, 1)).collect();
        let kept = merge_shares(Vec::new(), shares);
        assert_eq!(kept.len(), MAX_SOURCES);
        assert_eq!(kept[0].meeting_id, "m3");
    }

    #[test]
    fn turns_are_taken_from_across_the_meeting() {
        let turns: Vec<u32> = (0..100).collect();
        let picked = spread(&turns, 20);
        assert_eq!(picked.len(), 20);
        assert_eq!((picked[0], picked[19]), (0, 95));
        assert_eq!(spread(&turns[..5], 20).len(), 5);
    }

    #[test]
    fn a_voice_needs_two_clear_turns() {
        assert!(build_profile("p1".into(), "Alice".into(), vec![share("m1", 0, 1)]).is_err());
        assert!(build_profile("p1".into(), "Alice".into(), vec![share("m1", 0, 1), share("m2", 0, 1)]).is_ok());
    }
}

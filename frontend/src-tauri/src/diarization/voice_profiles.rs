//! Opt-in WeSpeaker voice profiles for named people. A profile is enrolled only
//! from user-labeled, non-overlapping system-track turns; anonymous diarization
//! channel numbers are never treated as durable identities.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use std::sync::Mutex;
use std::collections::HashMap;
use sqlx::SqlitePool;

use super::models::DiarizationModels;

const MODEL: &str = "wespeaker-resnet34-LM/lda-128";
// Read-only recording qualification found genuine post-LDA scores around 0.56–0.73.
// Require repeated evidence and a competitor margin instead of a single 0.80 hit.
const MATCH_THRESHOLD: f32 = 0.55;
const MATCH_MARGIN: f32 = 0.12;
const DEFAULT_PROFILE_LIMIT: usize = 50;
/// Clear turns learned from one meeting, spread across it.
// A compute/storage budget, not a universally optimal biometric sample count.
const LEARN_TURNS: usize = 12;
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

static ENROLL_WORKER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static ENROLL_MODELS: Mutex<Option<DiarizationModels>> = Mutex::new(None);
static MANUAL_LEARNING: AtomicBool = AtomicBool::new(false);
static CONSENSUS: OnceLock<AtomicBool> = OnceLock::new();
static ENABLED: OnceLock<AtomicBool> = OnceLock::new();
static PROFILE_WRITE: Mutex<()> = Mutex::new(());
static LIVE_MATCHER: Mutex<Option<LiveMatcher>> = Mutex::new(None);

struct LiveMatcher {
    models: DiarizationModels,
    profiles: Vec<VoiceProfile>,
    evidence: HashMap<String, Vec<Vec<f32>>>,
    pending: HashMap<String, Vec<f32>>,
    pending_end: HashMap<String, f64>,
    blocked: std::collections::HashSet<String>,
}

/// Identity matching supplements Nemotron's meeting-local channels; it does not
/// run a second diarization engine or infer a name from the channel number.
pub fn start_live_matcher() -> Result<()> {
    let mut guard = LIVE_MATCHER.lock().map_err(|_| anyhow::anyhow!("Live profile lock poisoned"))?;
    *guard = None;
    let profiles = load_for_matching()?;
    if profiles.is_empty() { return Ok(()); }
    let models = DiarizationModels::load(&super::diarization_model_dir())?;
    *guard = Some(LiveMatcher { models, profiles, evidence: HashMap::new(), pending: HashMap::new(), pending_end: HashMap::new(), blocked: Default::default() });
    Ok(())
}

pub fn stop_live_matcher() {
    if let Ok(mut guard) = LIVE_MATCHER.lock() { *guard = None; }
}

/// Called on a blocking ASR worker, never on the capture thread.
pub fn name_live_nemotron_turn(label: &str, samples: &[f32], start_seconds: f64) -> Option<String> {
    // Only diarizer-confirmed single-speaker ranges are biometric evidence.
    let ranges = super::live_nemotron::clear_audio_ranges(label, start_seconds, samples.len());
    if ranges.is_empty() { return None; }
    let mut guard = LIVE_MATCHER.lock().ok()?;
    let matcher = guard.as_mut()?;
    if matcher.blocked.contains(label) { return None; }
    for (first, last) in ranges.into_iter().take(MATCH_TURNS) {
        let start = start_seconds + first as f64 / 16_000.0;
        let end = start_seconds + last as f64 / 16_000.0;
        let pending = matcher.pending.entry(label.to_string()).or_default();
        if let Some(previous_end) = matcher.pending_end.get(label) {
            if end <= *previous_end { continue; } // Never count replayed/out-of-order audio twice.
            if start < *previous_end - 0.001 || start > *previous_end + 0.25 { pending.clear(); }
        }
        append_live_profile_audio(pending, &samples[first..last]);
        matcher.pending_end.insert(label.to_string(), end);
        if pending.len() < 32_000 { continue; }
        let audio = std::mem::take(pending); // Independent samples, never re-embed the same pending audio.
        match matcher.models.embed(&audio).ok().and_then(normalized_vector) {
            Some(vector) => push_match_evidence(matcher.evidence.entry(label.to_string()).or_default(), vector),
            None => log::debug!("Named voice matching: unusable sample for {label}"),
        }
    }
    let vectors = matcher.evidence.get(label)?;
    confirmed_match(vectors, &matcher.profiles).map(|profile| profile.name.clone())
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
    let rows: Vec<_> = segments.iter().map(|segment|
        (format!("Speaker {}", segment.speaker), Some(segment.start as f64), Some(segment.end as f64))).collect();
    let speakers: std::collections::BTreeSet<_> = segments.iter().map(|segment| segment.speaker).collect();
    let mut names = HashMap::new();
    for speaker in speakers {
        let windows = spread(&enrollment_windows(&rows, &format!("Speaker {speaker}")), MATCH_TURNS);
        let vectors = embed_windows(&audio, &windows, &mut models)?;
        if let Some(profile) = confirmed_match(&vectors, &profiles) {
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
    if !value { if let Ok(mut models) = ENROLL_MODELS.lock() { *models = None; } }
    Ok(())
}

static AUTO_SAVE: OnceLock<AtomicBool> = OnceLock::new();
fn auto_save_flag() -> &'static AtomicBool {
    AUTO_SAVE.get_or_init(|| AtomicBool::new(std::fs::read_to_string(
        crate::paths::install_data_root().join("voice_profiles_auto_save.txt")
    ).map(|text| text.trim() == "true").unwrap_or(false)))
}
#[tauri::command]
pub fn get_voice_profiles_auto_save() -> bool { auto_save_flag().load(Ordering::Relaxed) }
#[tauri::command]
pub fn set_voice_profiles_auto_save(value: bool) -> Result<(), String> {
    let file = crate::paths::install_data_root().join("voice_profiles_auto_save.txt");
    if let Some(parent) = file.parent() { std::fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    std::fs::write(file, value.to_string()).map_err(|error| error.to_string())?;
    auto_save_flag().store(value, Ordering::Relaxed);
    Ok(())
}

fn consensus_flag() -> &'static AtomicBool {
    CONSENSUS.get_or_init(|| AtomicBool::new(std::fs::read_to_string(
        crate::paths::install_data_root().join("voice_profiles_consensus.txt")
    ).map(|text| text.trim() == "true").unwrap_or(false)))
}
#[tauri::command]
pub fn get_voice_profiles_consensus() -> bool { consensus_flag().load(Ordering::Relaxed) }
#[tauri::command]
pub fn set_voice_profiles_consensus(value: bool) -> Result<(), String> {
    let file = crate::paths::install_data_root().join("voice_profiles_consensus.txt");
    if let Some(parent) = file.parent() { std::fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    std::fs::write(file, if value { "true" } else { "false" }).map_err(|error| error.to_string())?;
    consensus_flag().store(value, Ordering::Relaxed);
    Ok(())
}

const MIN_MATCH_THRESHOLD: f32 = 0.35;
const MAX_MATCH_THRESHOLD: f32 = 0.95;
static MATCH_SCORE: OnceLock<AtomicU32> = OnceLock::new();
fn valid_match_threshold(value: f32) -> bool {
    value.is_finite() && (MIN_MATCH_THRESHOLD..=MAX_MATCH_THRESHOLD).contains(&value)
}
fn match_score() -> &'static AtomicU32 {
    MATCH_SCORE.get_or_init(|| {
        let value = std::fs::read_to_string(crate::paths::install_data_root().join("voice_profiles_match_threshold.txt"))
            .ok().and_then(|text| text.trim().parse::<f32>().ok())
            .filter(|value| valid_match_threshold(*value)).unwrap_or(MATCH_THRESHOLD);
        AtomicU32::new(value.to_bits())
    })
}
#[tauri::command]
pub fn get_voice_profiles_match_threshold() -> f32 {
    f32::from_bits(match_score().load(Ordering::Relaxed))
}
#[tauri::command]
pub fn set_voice_profiles_match_threshold(value: f32) -> Result<(), String> {
    if !valid_match_threshold(value) { return Err("Matching score must be between 0.35 and 0.95".into()); }
    let file = crate::paths::install_data_root().join("voice_profiles_match_threshold.txt");
    if let Some(parent) = file.parent() { std::fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    std::fs::write(file, value.to_string()).map_err(|error| error.to_string())?;
    match_score().store(value.to_bits(), Ordering::Relaxed);
    Ok(())
}

static PROFILE_LIMIT: OnceLock<std::sync::atomic::AtomicUsize> = OnceLock::new();
fn read_profile_limit(path: &Path) -> usize {
    std::fs::read_to_string(path).ok().and_then(|text| text.trim().parse().ok()).unwrap_or(DEFAULT_PROFILE_LIMIT)
}
fn profile_limit() -> &'static std::sync::atomic::AtomicUsize {
    PROFILE_LIMIT.get_or_init(|| std::sync::atomic::AtomicUsize::new(read_profile_limit(
        &crate::paths::install_data_root().join("voice_profiles_limit.txt"))))
}
fn capacity_reached(count: usize, limit: usize) -> bool { limit != 0 && count >= limit }
#[tauri::command]
pub fn get_voice_profiles_limit() -> usize { profile_limit().load(Ordering::Relaxed) }
#[tauri::command]
pub fn set_voice_profiles_limit(value: usize) -> Result<(), String> {
    // Share enrollment's lock so a limit change cannot race its capacity check.
    let _guard = PROFILE_WRITE.lock().map_err(|_| "Voice profile lock poisoned")?;
    let file = crate::paths::install_data_root().join("voice_profiles_limit.txt");
    if let Some(parent) = file.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    std::fs::write(file, value.to_string()).map_err(|e| e.to_string())?;
    profile_limit().store(value, Ordering::Relaxed);
    Ok(())
}

static AUTO_SAMPLES: OnceLock<AtomicU32> = OnceLock::new();
fn auto_samples() -> &'static AtomicU32 {
    AUTO_SAMPLES.get_or_init(|| AtomicU32::new(std::fs::read_to_string(crate::paths::install_data_root().join("voice_profiles_auto_samples.txt"))
        .ok().and_then(|text| text.trim().parse::<u32>().ok()).filter(|value| (2..=12).contains(value)).unwrap_or(12)))
}
#[tauri::command]
pub fn get_voice_profiles_auto_samples() -> u32 { auto_samples().load(Ordering::Relaxed) }
#[tauri::command]
pub fn set_voice_profiles_auto_samples(value: u32) -> Result<(), String> {
    if !(2..=12).contains(&value) { return Err("Automatic sample limit must be between 2 and 12".into()); }
    let file = crate::paths::install_data_root().join("voice_profiles_auto_samples.txt");
    if let Some(parent) = file.parent() { std::fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    std::fs::write(file, value.to_string()).map_err(|error| error.to_string())?;
    auto_samples().store(value, Ordering::Relaxed); Ok(())
}
#[tauri::command]
pub async fn detach_live_voice_match(speaker_channel: String) -> Result<(), String> {
    if !speaker_channel.strip_prefix("Speaker ").is_some_and(|number| number.parse::<usize>().is_ok_and(|value| (1..=8).contains(&value))) {
        return Err("Choose a single remote speaker channel".into());
    }
    tokio::task::spawn_blocking(move || {
        let mut guard = LIVE_MATCHER.lock().map_err(|error| error.to_string())?;
        if let Some(matcher) = guard.as_mut() {
            matcher.blocked.insert(speaker_channel.clone());
            matcher.evidence.remove(&speaker_channel); matcher.pending.remove(&speaker_channel);
        }
        drop(guard);
        super::online::detach_voice_match(&speaker_channel);
        Ok(())
    }).await.map_err(|error| error.to_string())?
}

fn automatic_update_allowed(person_id: &str, share: &VoiceSource, profiles: &[VoiceProfile]) -> bool {
    !profiles.iter().any(|profile| profile.person_id == person_id)
        || best_match(&share.sum, profiles).is_some_and(|profile| profile.person_id == person_id)
}

/// Native ownership keeps enrollment alive after navigation. At most eight
/// jobs may wait/run, with one enrollment at a time; capture never does inference.
pub fn auto_save_named_voices<R: tauri::Runtime>(app: tauri::AppHandle<R>, pool: SqlitePool, meeting_id: String, speaker: Option<String>) {
    use tauri::Emitter;
    if !enabled() || !get_voice_profiles_auto_save() { return; }
    static SLOTS: OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = match SLOTS.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(8))).clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            let _ = app.emit("voice-profile-auto-save-result", serde_json::json!({"error": "Automatic voice saving is busy. Use Learn voice on the contact to retry."}));
            return;
        }
    };
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let _worker = ENROLL_WORKER.lock().await;
        if !enabled() || !get_voice_profiles_auto_save() { return; }
        // A completed name must be read from the same stable attribution used
        // for enrollment, never halfway through post-call transcript replacement.
        let _labels = super::operation_guard().await;
        let result: Result<(), String> = async {
            let named: Vec<(String, String)> = sqlx::query_as(
                "SELECT ps.person_id, ps.speaker_label FROM person_speakers ps WHERE ps.meeting_id = ? AND (? IS NULL OR ps.speaker_label = ?) AND EXISTS (SELECT 1 FROM transcripts t WHERE t.meeting_id = ps.meeting_id AND t.speaker = ps.speaker_label)"
            ).bind(&meeting_id).bind(&speaker).bind(&speaker).fetch_all(&pool).await.map_err(|error| error.to_string())?;
            for (person_id, label) in named {
                if !crate::database::repositories::person::is_person_name(&label) { continue; }
                let _ = app.emit("voice-profile-auto-save-result", serde_json::json!({"name": label, "personId": person_id, "status": "learning"}));
                let enrollment: Result<String, String> = async {
                    let (_, name, share) = meeting_share_limit(&pool, &meeting_id, &label, get_voice_profiles_auto_samples() as usize).await.map_err(String::from)?;
                    let profiles = load().map_err(|error| error.to_string())?;
                    if !automatic_update_allowed(&person_id, &share, &profiles) {
                        return Err("New samples do not clearly confirm the existing voice. Existing samples were kept; review the speaker labels before using Learn more turns.".into());
                    }
                    store_shares(&person_id, &name, vec![share], false, false).map_err(String::from)?;
                    Ok(name)
                }.await;
                match enrollment {
                    Ok(name) => { let _ = app.emit("voice-profile-auto-save-result", serde_json::json!({"name": name, "personId": person_id, "status": "saved"})); }
                    Err(error) => {
                        log::warn!("Automatic voice saving for {label} failed: {error}");
                        let _ = app.emit("voice-profile-auto-save-result", serde_json::json!({"personId": person_id, "status": "failed", "error": format!("{label}: {error}")}));
                    }
                }
            }
            Ok(())
        }.await;
        if let Err(error) = result {
            log::warn!("Automatic voice saving failed: {error}");
            let _ = app.emit("voice-profile-auto-save-result", serde_json::json!({"error": error}));
        }
    });
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
    best_match_with_mode(embedding, profiles, get_voice_profiles_consensus())
}

/// Experimental session consensus weights meetings equally, so one long or
/// contaminated recording cannot win just by supplying more turns. At least
/// multiple real meeting shares use consensus; single-session profiles use their aggregate.
fn best_match_with_mode<'a>(embedding: &[f32], profiles: &'a [VoiceProfile], consensus: bool) -> Option<&'a VoiceProfile> {
    best_match_with_options(embedding, profiles, consensus, get_voice_profiles_match_threshold())
}
fn best_match_with_options<'a>(embedding: &[f32], profiles: &'a [VoiceProfile], consensus: bool, threshold: f32) -> Option<&'a VoiceProfile> {
    let mut ranked: Vec<(f32, &VoiceProfile)> = profiles.iter().filter_map(|profile| {
        let score = if consensus {
            let mut scores: Vec<f32> = profile.sources.iter()
                .filter(|source| !source.meeting_id.is_empty() && source.turns >= 2)
                .filter_map(|source| similarity(embedding, &source.sum))
                .filter(|score| score.is_finite()).collect();
            if scores.len() < 2 {
                similarity(embedding, &profile.embedding)?
            } else {
            scores.sort_by(f32::total_cmp);
            // Strict majority support, plus two independent sessions minimum.
            if scores.iter().filter(|score| **score >= threshold).count() < (scores.len() / 2 + 1).max(2) { return None; }
            let middle = scores.len() / 2;
            if scores.len() % 2 == 0 { (scores[middle - 1] + scores[middle]) / 2.0 } else { scores[middle] }
            }
        } else { similarity(embedding, &profile.embedding)? };
        score.is_finite().then_some((score, profile))
    }).collect();
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
    let (score, profile) = *ranked.first()?;
    let runner_up = ranked.get(1).map(|entry| entry.0).unwrap_or(-1.0);
    (score >= threshold && score - runner_up >= MATCH_MARGIN).then_some(profile)
}

/// Bounded independent evidence shared by both live engines and post-call matching.
pub fn push_match_evidence(vectors: &mut Vec<Vec<f32>>, vector: Vec<f32>) {
    if vectors.len() >= MATCH_TURNS { vectors.remove(0); }
    vectors.push(vector);
}

pub fn confirmed_match<'a>(vectors: &[Vec<f32>], profiles: &'a [VoiceProfile]) -> Option<&'a VoiceProfile> {
    confirmed_match_with_mode(vectors, profiles, get_voice_profiles_consensus())
}

fn confirmed_match_with_mode<'a>(vectors: &[Vec<f32>], profiles: &'a [VoiceProfile], consensus: bool) -> Option<&'a VoiceProfile> {
    if vectors.len() < 2 || vectors.iter().any(|vector| vector.len() != 128 || vector.iter().any(|value| !value.is_finite())) { return None; }
    let threshold = get_voice_profiles_match_threshold();
    // Uncertain samples abstain; conflicting confident identities still vote.
    // Require two independent hits, a supermajority, and aggregate confirmation.
    let votes: Vec<_> = vectors.iter().filter_map(|vector|
        best_match_with_options(vector, profiles, consensus, threshold).map(|profile| (profile, vector))).collect();
    let candidate = profiles.iter().max_by_key(|profile| votes.iter().filter(|(voter, _)| voter.person_id == profile.person_id).count())?;
    let agreeing: Vec<_> = votes.iter().filter(|(profile, _)| profile.person_id == candidate.person_id).collect();
    if agreeing.len() < 2 || agreeing.len() * 3 < votes.len() * 2 { return None; }
    let mut mean = vec![0.0; 128];
    for (_, vector) in agreeing { for (target, value) in mean.iter_mut().zip(vector.iter()) { *target += value; } }
    best_match_with_options(&mean, profiles, consensus, threshold)
        .filter(|profile| profile.person_id == candidate.person_id)
}

#[derive(Clone, Debug, Serialize)]
pub struct PossibleVoiceMatch { pub person_id: String, pub name: String, pub score: f32 }

/// Suggestions never relabel audio or train a profile. Only explicit UI acceptance does.
pub fn possible_match(vectors: &[Vec<f32>], profiles: &[VoiceProfile]) -> Option<PossibleVoiceMatch> {
    if vectors.len() < 2 { return None; }
    let floor = (get_voice_profiles_match_threshold() - 0.15).max(MIN_MATCH_THRESHOLD);
    let mut mean = vec![0.0; 128];
    for vector in vectors {
        if vector.len() != 128 || vector.iter().any(|value| !value.is_finite()) { return None; }
        for (target, value) in mean.iter_mut().zip(vector) { *target += value; }
    }
    let mut ranked: Vec<_> = profiles.iter().filter_map(|profile| similarity(&mean, &profile.embedding).map(|score| (score, profile))).collect();
    ranked.sort_by(|a,b| b.0.total_cmp(&a.0));
    let (score, profile) = *ranked.first()?;
    if score < floor || score - ranked.get(1).map(|entry| entry.0).unwrap_or(-1.0) < 0.04 { return None; }
    // Two windows must support the same candidate; an evenly split mixed turn cannot suggest a name.
    let supporting = vectors.iter().filter(|vector| best_match_with_options(vector, profiles, false, floor)
        .is_some_and(|candidate| candidate.person_id == profile.person_id)).count();
    if supporting < 2 { return None; }
    Some(PossibleVoiceMatch { person_id: profile.person_id.clone(), name: profile.name.clone(), score })
}

#[tauri::command]
pub async fn get_possible_voice_match(state: tauri::State<'_, crate::state::AppState>, meeting_id: Option<String>, speaker: String) -> Result<Option<PossibleVoiceMatch>, String> {
    if !enabled() || !speaker.strip_prefix("Speaker ").is_some_and(|number| number.parse::<usize>().is_ok()) { return Ok(None); }
    let Some(meeting_id) = meeting_id else {
        if let Ok(guard) = LIVE_MATCHER.try_lock() {
            if let Some(matcher) = guard.as_ref() {
                if matcher.blocked.contains(&speaker) { return Ok(None); }
                return Ok(matcher.evidence.get(&speaker).and_then(|vectors| possible_match(vectors, &matcher.profiles)));
            }
        }
        return Ok(super::online::possible_voice_match(&speaker));
    };
    static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let _slot = SLOTS.try_acquire().map_err(|_| "Voice suggestions are busy. Try again shortly.".to_string())?;
    // One inference owner shared with enrollment. Navigating away cannot create unbounded parallel model work.
    let _worker = ENROLL_WORKER.lock().await;
    let pool = state.db_manager.pool();
    let folder: Option<String> = sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id = ?")
        .bind(&meeting_id).fetch_optional(pool).await.map_err(|error| error.to_string())?.flatten();
    let Some(folder) = folder else { return Ok(None); };
    let track = PathBuf::from(folder).join("system.mp4");
    if !track.is_file() { return Ok(None); }
    let rows: Vec<(String, Option<f64>, Option<f64>)> = sqlx::query_as("SELECT COALESCE(speaker, ''), audio_start_time, audio_end_time FROM transcripts WHERE meeting_id = ? ORDER BY audio_start_time")
        .bind(&meeting_id).fetch_all(pool).await.map_err(|error| error.to_string())?;
    let windows = spread(&enrollment_windows(&rows, &speaker), MATCH_TURNS);
    if windows.len() < 2 { return Ok(None); }
    tokio::task::spawn_blocking(move || {
        let profiles = load_for_matching().map_err(|error| error.to_string())?;
        let vectors = embed_turns(&track, &windows).map_err(|error| error.to_string())?;
        Ok(possible_match(&vectors, &profiles))
    }).await.map_err(|error| error.to_string())?
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
    // One cached model owns all enrollment inference. Blocking workers hold this
    // mutex; the audio callback never uses it. Reuse avoids loading every meeting.
    let mut cached = ENROLL_MODELS.lock().map_err(|_| anyhow::anyhow!("Voice model lock poisoned"))?;
    if cached.is_none() { *cached = Some(DiarizationModels::load(&super::diarization_model_dir())?); }
    embed_windows(&audio, turns, cached.as_mut().unwrap())
}

fn embed_turns_with_models(track: &Path, turns: &[(f64, f64)], model_dir: &Path) -> Result<Vec<Vec<f32>>> {
    let audio = crate::audio::decoder::decode_audio_file(track)?.to_whisper_format();
    let mut models = DiarizationModels::load(model_dir)?;
    embed_windows(&audio, turns, &mut models)
}

fn normalized_vector(mut vector: Vec<f32>) -> Option<Vec<f32>> {
    if vector.len() != 128 || vector.iter().any(|value| !value.is_finite()) { return None; }
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if !norm.is_finite() || norm <= 1e-6 { return None; }
    for value in &mut vector { *value /= norm; }
    Some(vector)
}

fn embed_windows(audio: &[f32], turns: &[(f64, f64)], models: &mut DiarizationModels) -> Result<Vec<Vec<f32>>> {
    let mut vectors = Vec::new();
    let mut last_problem = None;
    for &(start, end) in turns.iter().take(LEARN_TURNS) {
        let first = (start * 16_000.0) as usize;
        let last = (end * 16_000.0) as usize;
        if first >= last || last > audio.len() {
            last_problem = Some("Named voice timing extends beyond the saved system track".to_string());
            continue;
        }
        match models.embed(&audio[first..last]) {
            Ok(vector) => match normalized_vector(vector) {
                Some(vector) => vectors.push(vector),
                None => last_problem = Some("Voice model returned an invalid embedding".into()),
            },
            Err(error) => last_problem = Some(format!("Voice model could not learn a sample: {error:#}")),
        }
    }
    if vectors.len() < 2 {
        if let Some(problem) = last_problem { bail!("{problem}"); }
    }
    Ok(vectors)
}

/// Join adjacent live chunks, remove other remote voices, then split into
/// independent 2–4 s windows. Local-mic overlap cannot contaminate system.mp4.
fn enrollment_windows(rows: &[(String, Option<f64>, Option<f64>)], speaker: &str) -> Vec<(f64, f64)> {
    let valid = |start: f64, end: f64| start.is_finite() && end.is_finite() && start >= 0.0 && end > start;
    let mut own = Vec::new();
    let mut others = Vec::new();
    for (label, start, end) in rows {
        let (Some(start), Some(end)) = (start, end) else { continue; };
        if !valid(*start, *end) { continue; }
        if label == speaker { own.push((*start, *end)); }
        else if !label.eq_ignore_ascii_case("You") && !label.eq_ignore_ascii_case("microphone") {
            others.push((*start, *end));
        }
    }
    own.sort_by(|a, b| a.0.total_cmp(&b.0));
    others.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut ranges: Vec<(f64, f64)> = Vec::new();
    for (start, end) in own {
        if let Some(last) = ranges.last_mut() {
            let overlaps_other = others.iter().any(|&(a, b)| a < start && b > last.1);
            if start <= last.1 + 0.25 && !overlaps_other { last.1 = last.1.max(end); continue; }
        }
        ranges.push((start, end));
    }
    let mut clear = Vec::new();
    for (start, end) in ranges {
        let mut cursor = start;
        for &(a, b) in &others {
            if b <= cursor { continue; }
            if a >= end { break; }
            if a > cursor { clear.push((cursor, a.min(end))); }
            cursor = cursor.max(b);
            if cursor >= end { break; }
        }
        if cursor < end { clear.push((cursor, end)); }
    }
    let mut windows = Vec::new();
    for (start, end) in clear {
        let duration = end - start;
        if duration < 2.0 { continue; }
        // Balanced windows avoid dropping a short remainder or reusing audio.
        let count = (duration / 4.0).ceil().min((duration / 2.0).floor()) as usize;
        for index in 0..count {
            windows.push((start + duration * index as f64 / count as f64,
                start + duration * (index + 1) as f64 / count as f64));
        }
    }
    windows
}

/// One meeting's share of a named speaker's voice, with the contact it
/// belongs to.
async fn meeting_share(pool: &SqlitePool, meeting_id: &str, speaker: &str) -> Result<(String, String, VoiceSource), EnrollError> {
    meeting_share_limit(pool, meeting_id, speaker, LEARN_TURNS).await
}

async fn meeting_share_limit(
    pool: &SqlitePool,
    meeting_id: &str,
    speaker: &str,
    limit: usize,
) -> Result<(String, String, VoiceSource), EnrollError> {
    use EnrollError::{Meeting, Unavailable};
    let failed = |error: sqlx::Error| Meeting(error.to_string());
    if !enabled() {
        return Err(Unavailable("Turn on Voice profiles in Settings > Voice Profiles first.".into()));
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
    let clear = enrollment_windows(&rows, speaker);
    let turns = spread(&clear, limit);
    let no_clear_turn = || Meeting(format!(
        "{name} has no clear call-audio sample of at least 2 seconds in this meeting."
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
fn store_shares(person_id: &str, name: &str, shares: Vec<VoiceSource>, replace: bool, only_first: bool) -> Result<VoiceProfileInfo, EnrollError> {
    use EnrollError::{Meeting, Unavailable};
    let _guard = PROFILE_WRITE.lock().map_err(|_| Unavailable("Voice profile lock poisoned".into()))?;
    let mut profiles = load().map_err(|error| Unavailable(error.to_string()))?;
    let existing = profiles.iter().position(|profile| profile.person_id == person_id);
    if only_first {
        if let Some(index) = existing { return Ok(profiles[index].info()); }
    }
    let earlier = match existing {
        Some(index) if !replace => profiles[index].shares(),
        _ => Vec::new(),
    };
    let profile = build_profile(person_id.to_string(), name.to_string(), merge_shares(earlier, shares))
        .map_err(|error| Meeting(error.to_string()))?;
    let limit = get_voice_profiles_limit();
    if existing.is_none() && capacity_reached(profiles.len(), limit) {
        return Err(Unavailable(format!("Saved voice profile limit ({limit}) reached. Increase it or set 0 for unlimited in Settings > Voice Profiles.")));
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
    let _worker = ENROLL_WORKER.lock().await;
    let _labels = super::operation_guard().await;
    let (person_id, name, share) = meeting_share(state.db_manager.pool(), &meeting_id, &speaker).await?;
    Ok(store_shares(&person_id, &name, vec![share], false, false)?)
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
    let _worker = ENROLL_WORKER.lock().await;
    let _labels = super::operation_guard().await;
    enroll_person_from_pool(state.db_manager.pool(), person_id, meeting_id).await
}

async fn enroll_person_from_pool(pool: &SqlitePool, person_id: String, meeting_id: Option<String>) -> Result<VoiceProfileInfo, String> {
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
    Ok(store_shares(&person_id, &name, shares, meeting_id.is_none(), false)?)
}

#[tauri::command]
pub fn get_voice_profile_learning_busy() -> bool { MANUAL_LEARNING.load(Ordering::SeqCst) }

/// The owned task keeps the entire bulk operation alive after WebView navigation.
/// Work is serial with automatic/manual enrollment and does not touch capture.
#[tauri::command]
pub async fn queue_voice_profile_learning(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    person_id: Option<String>,
) -> Result<(), String> {
    use tauri::Emitter;
    if !enabled() { return Err("Turn on Voice profiles in Settings > Voice Profiles first.".into()); }
    if !super::pyannote_models_available() { return Err("Download speaker models in Transcription first.".into()); }
    let ids = match person_id {
        Some(id) => vec![id],
        None => {
            let _guard = PROFILE_WRITE.lock().map_err(|_| "Voice profile lock poisoned")?;
            load().map_err(|error| error.to_string())?.into_iter().map(|profile| profile.person_id).collect()
        }
    };
    if ids.is_empty() { return Err("No saved voice profiles to learn.".into()); }
    if MANUAL_LEARNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("Voice learning is already running. Wait for its result before starting again.".into());
    }
    let pool = state.db_manager.pool().clone();
    tauri::async_runtime::spawn(async move {
        struct Reset;
        impl Drop for Reset { fn drop(&mut self) { MANUAL_LEARNING.store(false, Ordering::SeqCst); } }
        let _reset = Reset;
        let _worker = ENROLL_WORKER.lock().await;
        let mut saved = 0;
        let mut failed = 0;
        let total = ids.len();
        for id in ids {
            let name: String = sqlx::query_scalar("SELECT display_name FROM people WHERE id = ?")
                .bind(&id).fetch_optional(&pool).await.ok().flatten().unwrap_or_else(|| "Contact".into());
            let _ = app.emit("voice-profile-learning-result", serde_json::json!({"personId": id, "name": name, "status": "learning"}));
            let result = {
                let _labels = super::operation_guard().await;
                enroll_person_from_pool(&pool, id.clone(), None).await
            };
            match result {
                Ok(profile) => {
                    saved += 1;
                    let _ = app.emit("voice-profile-learning-result", serde_json::json!({"personId": id, "name": profile.name, "status": "saved", "samples": profile.samples, "meetings": profile.meetings}));
                }
                Err(error) => {
                    failed += 1;
                    let _ = app.emit("voice-profile-learning-result", serde_json::json!({"personId": id, "name": name, "status": "failed", "error": error}));
                }
            }
        }
        let _ = app.emit("voice-profile-learning-result", serde_json::json!({"status": "complete", "saved": saved, "failed": failed, "total": total}));
    });
    Ok(())
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
    #[test]
    fn profile_capacity_supports_default_custom_and_unlimited_limits() {
        assert!(!super::capacity_reached(49, 50));
        assert!(super::capacity_reached(50, 50));
        assert!(!super::capacity_reached(50, 100));
        assert!(super::capacity_reached(50, 10));
        assert!(!super::capacity_reached(usize::MAX, 0));
    }
    #[test]
    fn profile_limit_loads_persisted_zero_and_falls_back_for_invalid_data() {
        let dir = tempfile::tempdir().unwrap(); let file = dir.path().join("limit.txt");
        assert_eq!(super::read_profile_limit(&file), 50);
        for (text, expected) in [("0", 0), ("125", 125), ("-1", 50), ("bad", 50)] {
            std::fs::write(&file, text).unwrap();
            assert_eq!(super::read_profile_limit(&file), expected);
        }
    }

    use super::*;
    fn row(label: &str, start: f64, end: f64) -> (String, Option<f64>, Option<f64>) {
        (label.into(), Some(start), Some(end))
    }
    #[test]
    fn enrollment_joins_short_live_chunks_and_keeps_independent_samples() {
        let rows = vec![row("Alice", 0.0, 1.7), row("Alice", 1.7, 3.4), row("Alice", 3.4, 5.1)];
        let windows = enrollment_windows(&rows, "Alice");
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].1, windows[1].0);
        assert_eq!((windows[0].0, windows[1].1), (0.0, 5.1));
        assert!(windows.iter().all(|(a, b)| *b - *a >= 2.0));
    }
    #[test]
    fn enrollment_excludes_remote_overlap_but_keeps_local_mic_overlap() {
        let rows = vec![row("Alice", 0.0, 10.0), row("You", 0.0, 10.0), row("Bob", 4.0, 6.0)];
        assert_eq!(enrollment_windows(&rows, "Alice"), vec![(0.0, 4.0), (6.0, 10.0)]);
    }
    #[test]
    fn enrollment_does_not_bridge_another_voice_or_duplicate_audio() {
        let rows = vec![row("Alice", 0.0, 2.0), row("Alice", 2.2, 4.2), row("Bob", 2.0, 2.2), row("Alice", 0.5, 1.5)];
        assert_eq!(enrollment_windows(&rows, "Alice"), vec![(0.0, 2.0), (2.2, 4.2)]);
        assert!(enrollment_windows(&[row("Alice", f64::NAN, 3.0), row("Alice", 5.0, 4.0), row("Alice", 0.0, 1.0)], "Alice").is_empty());
    }

    #[test]
    #[ignore = "Requires an explicitly provided saved source track and WeSpeaker model directory; read-only"]
    fn enrollment_track_diagnostic() {
        let track = PathBuf::from(std::env::var("MEETILY_ENROLL_TRACK").expect("MEETILY_ENROLL_TRACK"));
        let models = PathBuf::from(std::env::var("MEETILY_ENROLL_MODELS").expect("MEETILY_ENROLL_MODELS"));
        let turns: Vec<(f64, f64)> = serde_json::from_str(&std::env::var("MEETILY_ENROLL_TURNS").expect("MEETILY_ENROLL_TURNS")).unwrap();
        let rows: Vec<_> = turns.into_iter().map(|(start, end)| row("Named test voice", start, end)).collect();
        let turns = spread(&enrollment_windows(&rows, "Named test voice"), 4);
        let started = std::time::Instant::now();
        let vectors = embed_turns_with_models(&track, &turns, &models).expect("Read-only enrollment extraction failed");
        println!("Successfully extracted {} enrollment vectors in {:?}; no profile written", vectors.len(), started.elapsed());
        assert!(vectors.len() >= 2, "Enrollment did not extract two eligible samples");
    }

    #[test]
    #[ignore = "Requires explicit local recordings, profiles and WeSpeaker models; read-only"]
    fn voice_matching_recording_diagnostic() {
        #[derive(Deserialize)]
        struct Case { track: PathBuf, label: String, ranges: Vec<(f64, f64)> }
        let cases: Vec<Case> = serde_json::from_slice(&std::fs::read(std::env::var("MEETILY_MATCH_CASES").unwrap()).unwrap()).unwrap();
        let profiles: Vec<VoiceProfile> = serde_json::from_slice(&std::fs::read(std::env::var("MEETILY_MATCH_PROFILES").unwrap()).unwrap()).unwrap();
        let mut models = DiarizationModels::load(&PathBuf::from(std::env::var("MEETILY_MATCH_MODELS").unwrap())).unwrap();
        for case in cases {
            let audio = crate::audio::decoder::decode_audio_file(&case.track).unwrap().to_whisper_format();
            let rows: Vec<_> = case.ranges.iter().map(|(a,b)| row(&case.label, *a, *b)).collect();
            let windows = spread(&enrollment_windows(&rows, &case.label), MATCH_TURNS);
            let mut evidence = Vec::new();
            for (start,end) in windows {
                let vector = models.embed(&audio[(start*16000.0) as usize..(end*16000.0) as usize]).unwrap();
                evidence.push(vector.clone());
                let mut scores: Vec<_> = profiles.iter().filter_map(|p| similarity(&vector,&p.embedding).map(|score| (score,p))).collect();
                scores.sort_by(|a,b| b.0.total_cmp(&a.0));
                println!("case {} {:.2}-{:.2} top={:.3} runner_up={:.3} default={:?} consensus={:?}", case.label, start,end,scores[0].0,scores[1].0,best_match_with_mode(&vector,&profiles,false).map(|p|p.name.as_str()),best_match_with_mode(&vector,&profiles,true).map(|p|p.name.as_str()));
            }
            println!("EVIDENCE {} {} samples={} default={:?} consensus={:?}", case.label, case.track.file_name().unwrap().to_string_lossy(), evidence.len(), confirmed_match_with_mode(&evidence,&profiles,false).map(|p|p.name.as_str()),confirmed_match_with_mode(&evidence,&profiles,true).map(|p|p.name.as_str()));
        }
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

    #[test]
    fn tentative_matches_need_repeated_evidence_and_reject_mixed_identity() {
        let alice = voice("a", "Alice");
        let mut query = vec![0.0; 128]; query[0] = 0.48; query[2] = (1.0_f32 - 0.48*0.48).sqrt();
        assert!(best_match_with_options(&query, &[alice.clone()], false, 0.55).is_none());
        assert!(possible_match(&[query.clone()], &[alice.clone()]).is_none());
        assert_eq!(possible_match(&[query.clone(), query], &[alice.clone()]).unwrap().name, "Alice");
        let mut bob = voice("b", "Bob"); bob.embedding[0] = 0.0; bob.embedding[1] = 1.0;
        assert!(possible_match(&[alice.embedding.clone(), bob.embedding.clone()], &[alice,bob]).is_none());
    }

    #[test]
    fn automatic_updates_reject_conflicting_identity_and_invalid_sample_budgets() {
        assert!(set_voice_profiles_auto_samples(1).is_err());
        assert!(set_voice_profiles_auto_samples(13).is_err());
        let alice = voice("alice", "Alice");
        let mut bob = voice("bob", "Bob"); bob.embedding[0] = 0.0; bob.embedding[1] = 1.0;
        let profiles = vec![alice, bob];
        assert!(automatic_update_allowed("alice", &share("meeting",0,12), &profiles));
        assert!(!automatic_update_allowed("alice", &share("meeting",1,12), &profiles));
        assert!(automatic_update_allowed("new", &share("meeting",1,12), &profiles));
        let mut sources = vec![share("old",0,12)];
        for index in 0..20 { sources = merge_shares(sources, vec![share(&index.to_string(),0,12)]); }
        assert_eq!(sources.len(), MAX_SOURCES);
        assert_eq!(sources.iter().map(|source| source.turns).sum::<u32>(), 144);
    }

    #[test]
    fn threshold_validation_and_stricter_matching() {
        for value in [f32::NAN, f32::INFINITY, 0.34, 0.96] { assert!(!valid_match_threshold(value)); }
        for value in [0.35, 0.55, 0.95] { assert!(valid_match_threshold(value)); }
        let profile = voice("p1", "Alice");
        let mut query = vec![0.0; 128]; query[0] = 0.6; query[1] = 0.8;
        assert!(best_match_with_options(&query, &[profile.clone()], false, 0.55).is_some());
        assert!(best_match_with_options(&query, &[profile], false, 0.80).is_none());
    }

    #[test]
    fn repeated_matching_rejects_mixed_voices_and_bounds_evidence() {
        let alice = voice("p1", "Alice");
        let mut bob = voice("p2", "Bob"); bob.embedding[0] = 0.0; bob.embedding[1] = 1.0;
        let profiles = vec![alice.clone(), bob.clone()];
        assert!(confirmed_match_with_mode(&[alice.embedding.clone()], &profiles, false).is_none());
        assert!(confirmed_match_with_mode(&[alice.embedding.clone(), bob.embedding.clone()], &profiles, false).is_none());
        assert_eq!(confirmed_match_with_mode(&[alice.embedding.clone(), alice.embedding.clone()], &profiles, false).unwrap().name, "Alice");
        let mut uncertain = vec![0.0; 128]; uncertain[2] = 1.0;
        assert_eq!(confirmed_match_with_mode(&[alice.embedding.clone(), uncertain, alice.embedding.clone()], &profiles, false).unwrap().name, "Alice");
        let mut evidence = vec![];
        for _ in 0..20 { push_match_evidence(&mut evidence, alice.embedding.clone()); }
        assert_eq!(evidence.len(), MATCH_TURNS);
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
    fn consensus_requires_independent_meeting_support_and_margin() {
        let mut vector = vec![0.0; 128]; vector[0] = 1.0;
        let mut alice = voice("p1", "Alice");
        assert_eq!(best_match_with_mode(&vector, &[alice.clone()], true).unwrap().name, "Alice");
        alice.sources = vec![share("one", 0, 12), share("two", 1, 2)];
        assert!(best_match_with_mode(&vector, &[alice.clone()], true).is_none());
        alice.sources.push(share("three", 0, 2));
        assert_eq!(best_match_with_mode(&vector, &[alice.clone()], true).unwrap().name, "Alice");
        let mut bob = alice.clone(); bob.person_id = "p2".into(); bob.name = "Bob".into();
        assert!(best_match_with_mode(&vector, &[alice, bob], true).is_none());
    }

    #[test]
    fn enrollment_vectors_reject_invalid_values_and_normalize() {
        assert!(normalized_vector(vec![0.0; 128]).is_none());
        assert!(normalized_vector(vec![f32::NAN; 128]).is_none());
        assert!(normalized_vector(vec![f32::INFINITY; 128]).is_none());
        assert!(normalized_vector(vec![1.0; 127]).is_none());
        let normalized = normalized_vector(vec![2.0; 128]).unwrap();
        assert!((normalized.iter().map(|v| v*v).sum::<f32>() - 1.0).abs() < 1e-5);
        assert_eq!(spread(&(0..1000).collect::<Vec<_>>(), LEARN_TURNS).len(), 12);
        assert_eq!(LEARN_TURNS * MAX_SOURCES, 144);
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

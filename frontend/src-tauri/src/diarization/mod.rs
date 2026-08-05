//! Speaker diarization ("who spoke when") for recorded meetings.
//!
//! Pipeline (all on-device, ONNX Runtime via `ort`):
//!   1. Load the meeting WAV, downmix to mono and resample to 16 kHz.
//!   2. Slide a 10 s window over the audio and run pyannote `segmentation-3.0`,
//!      decoding its 7-class powerset output into per-frame activity for up to
//!      3 *local* speakers within that window.
//!   3. For every local speaker in every window, concatenate its active audio
//!      and extract a WeSpeaker ResNet34 embedding, projected through the VBx
//!      x-vector LDA transform and length-normalized.
//!   4. Cluster all embeddings (agglomerative, cosine) to obtain *global*
//!      speaker identities, then map each local region to its global speaker.
//!   5. Merge adjacent same-speaker regions into final segments.
//!
//! Models live install-locally in `<install>/data/models/diarization`.

pub mod clustering;
pub mod download;
pub mod dsp;
pub mod models;
pub mod online;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use models::{DiarizationModels, MAX_LOCAL_SPEAKERS};

/// 10 second analysis window (pyannote segmentation-3.0 was trained on 10 s).
const WINDOW_SECONDS: f32 = 10.0;
/// Minimum speech needed to attempt an embedding at all.
const MIN_EMBED_SECONDS: f32 = 0.5;
/// Minimum speech for a turn to be trusted to *define* a speaker cluster.
///
/// Turns shorter than this (typically speech clipped by a window edge) yield
/// noisy embeddings; letting them seed clusters causes speaker over-splitting.
/// They are still labeled — by nearest centroid — just not used to form clusters.
const MIN_CLUSTER_SECONDS: f32 = 1.5;
/// Gap below which two same-speaker segments are merged.
const MERGE_GAP_SECONDS: f32 = 0.5;
/// Default cosine-distance stop threshold for agglomerative clustering.
///
/// Calibrated against real recordings with confirmed speaker counts:
///
/// | recording        | truth | @0.60 |
/// |------------------|-------|-------|
/// | solo presenter   | 1     | 1 ✓   |
/// | team call        | 5     | 5 ✓   |
/// | panel            | 6     | 8     |
/// | interview        | 3     | 2     |
///
/// A single distance threshold cannot satisfy every recording — how far apart
/// two voices land depends on mic, codec and room. 0.60 is the best compromise
/// found, and critically it never invents speakers in single-speaker audio.
/// When the count is known, pass `num_speakers` to bypass the threshold: doing
/// so resolves all of the above exactly.
const DEFAULT_THRESHOLD: f32 = 0.60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiarizationSegment {
    /// Seconds from the start of the recording.
    pub start: f32,
    pub end: f32,
    /// Global speaker index (0-based).
    pub speaker: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiarizationResult {
    pub segments: Vec<DiarizationSegment>,
    pub num_speakers: usize,
    /// Total audio duration in seconds.
    pub duration: f32,
}

/// Required model files.
const REQUIRED_FILES: [&str; 3] = [
    "segmentation-3.0-fp16.onnx",
    "wespeaker-resnet34-LM.onnx",
    "xvec_transform.npz",
];

/// Directory of the models shipped inside the app bundle, resolved once at
/// startup from Tauri's resource directory.
static BUNDLED_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Record where the bundled diarization models live (called during setup).
pub fn set_bundled_dir(dir: PathBuf) {
    let _ = BUNDLED_DIR.set(dir);
}

/// True when every required model file exists in `dir`.
fn dir_has_models(dir: &Path) -> bool {
    REQUIRED_FILES.iter().all(|f| dir.join(f).exists())
}

/// Where the app's *writable* diarization model directory is â€” the target for
/// manual installs and downloads.
pub fn diarization_user_model_dir() -> PathBuf {
    crate::paths::models_dir().join("diarization")
}

/// Resolve the directory the models should actually be loaded from.
///
/// A user-supplied copy in the install-local data folder wins (so models can be
/// swapped or upgraded without rebuilding), otherwise the copy bundled with the
/// app is used. Falls back to the user directory so downloads have a target.
pub fn diarization_model_dir() -> PathBuf {
    let user_dir = diarization_user_model_dir();
    if dir_has_models(&user_dir) {
        return user_dir;
    }
    if let Some(bundled) = BUNDLED_DIR.get() {
        if dir_has_models(bundled) {
            return bundled.clone();
        }
    }
    user_dir
}

/// Whether all required model files are present (bundled or user-supplied).
pub fn models_available() -> bool {
    dir_has_models(&diarization_model_dir())
}

/// One local speaker's activity inside one window.
struct LocalTurn {
    /// Absolute (start, end) regions in seconds.
    regions: Vec<(f32, f32)>,
    /// Concatenated active audio for embedding.
    audio: Vec<f32>,
    /// Total speech duration in seconds (audio.len() / sample_rate).
    speech_secs: f32,
}

/// Run the full diarization pipeline on a WAV file, using whichever model
/// directory the app resolved (user override, else bundled).
pub fn diarize_file(
    wav_path: &std::path::Path,
    num_speakers: Option<usize>,
    threshold: Option<f32>,
) -> Result<DiarizationResult> {
    let model_dir = diarization_model_dir();
    if !models_available() {
        return Err(anyhow!(
            "Diarization models not found in {}. Expected segmentation-3.0-fp16.onnx, \
             wespeaker-resnet34-LM.onnx and xvec_transform.npz.",
            model_dir.display()
        ));
    }
    diarize_file_with_models(wav_path, &model_dir, num_speakers, threshold)
}

/// Extract just the per-turn speaker embeddings for a recording.
///
/// Exposed for offline evaluation of embedding quality (see the diagnostic in
/// this module's tests) — the clustering step is skipped entirely.
pub fn embeddings_for_debug(wav_path: &Path, model_dir: &Path) -> Result<Vec<Vec<f32>>> {
    let (samples, sr) = dsp::read_wav(wav_path)?;
    let samples = if sr != dsp::SAMPLE_RATE {
        crate::audio::audio_processing::resample_audio(&samples, sr, dsp::SAMPLE_RATE)
    } else {
        samples
    };
    let mut models = DiarizationModels::load(model_dir)?;
    let turns = collect_turns(&mut models, &samples)?;
    let mut out = Vec::new();
    for turn in &turns {
        if turn.speech_secs >= MIN_CLUSTER_SECONDS {
            if let Ok(e) = models.embed(&turn.audio) {
                out.push(e);
            }
        }
    }
    Ok(out)
}

/// Run the pipeline against an explicit model directory.
///
/// Kept separate from [`diarize_file`] so the pipeline can be exercised
/// headlessly (tests / offline evaluation) without a running Tauri app to
/// resolve bundled resource paths.
pub fn diarize_file_with_models(
    wav_path: &std::path::Path,
    model_dir: &Path,
    num_speakers: Option<usize>,
    threshold: Option<f32>,
) -> Result<DiarizationResult> {
    if !wav_path.exists() {
        return Err(anyhow!("Recording not found: {}", wav_path.display()));
    }
    if !dir_has_models(model_dir) {
        return Err(anyhow!(
            "Diarization models not found in {}",
            model_dir.display()
        ));
    }

    // 1. Load + resample to 16 kHz mono.
    let (samples, sr) = dsp::read_wav(wav_path)?;
    let samples = if sr != dsp::SAMPLE_RATE {
        log::info!("ðŸŽšï¸ Diarization: resampling {} Hz â†’ {} Hz", sr, dsp::SAMPLE_RATE);
        crate::audio::audio_processing::resample_audio(&samples, sr, dsp::SAMPLE_RATE)
    } else {
        samples
    };
    let total = samples.len();
    let duration = total as f32 / dsp::SAMPLE_RATE as f32;
    if total == 0 {
        return Ok(DiarizationResult { segments: Vec::new(), num_speakers: 0, duration: 0.0 });
    }
    log::info!("ðŸ§‘â€ðŸ¤â€ðŸ§‘ Diarization starting: {:.1}s of audio", duration);

    let mut models = DiarizationModels::load(model_dir)?;

    // 2. Slide windows, decode segmentation, collect local turns.
    // 2. Slide windows, decode segmentation, collect local turns.
    let turns = collect_turns(&mut models, &samples)?;

    if turns.is_empty() {
        log::info!("ðŸ§‘â€ðŸ¤â€ðŸ§‘ Diarization: no speech detected");
        return Ok(DiarizationResult { segments: Vec::new(), num_speakers: 0, duration });
    }

    // 3. Embed each local turn.
    let mut embeddings: Vec<Vec<f32>> = Vec::with_capacity(turns.len());
    let mut kept: Vec<usize> = Vec::with_capacity(turns.len());
    for (i, turn) in turns.iter().enumerate() {
        match models.embed(&turn.audio) {
            Ok(e) => {
                embeddings.push(e);
                kept.push(i);
            }
            Err(e) => log::debug!("Skipping turn {} (embedding failed: {})", i, e),
        }
    }
    if embeddings.is_empty() {
        return Ok(DiarizationResult { segments: Vec::new(), num_speakers: 0, duration });
    }
    log::info!("ðŸ§‘â€ðŸ¤â€ðŸ§‘ Diarization: {} turns embedded", embeddings.len());

    // 4. Cluster into global speakers.
    //
    // Only turns with enough speech are allowed to *define* clusters — short
    // fragments (usually speech clipped by a window edge) have noisy embeddings
    // and would otherwise spawn phantom speakers. Every remaining turn is then
    // attached to whichever cluster centroid it most resembles, so nothing
    // loses its label.
    let thresh = threshold.unwrap_or(DEFAULT_THRESHOLD);
    let strong: Vec<usize> = (0..embeddings.len())
        .filter(|&i| turns[kept[i]].speech_secs >= MIN_CLUSTER_SECONDS)
        .collect();

    let labels: Vec<usize> = if strong.len() >= 2 {
        log::info!(
            "🧑‍🤝‍🧑 Clustering on {} reliable turns ({} short turns assigned by similarity)",
            strong.len(),
            embeddings.len() - strong.len()
        );
        let strong_embeddings: Vec<Vec<f32>> =
            strong.iter().map(|&i| embeddings[i].clone()).collect();
        let strong_labels = clustering::agglomerative(&strong_embeddings, num_speakers, thresh);

        let k = strong_labels.iter().copied().max().map(|m| m + 1).unwrap_or(0);
        let dim = embeddings[0].len();

        // Cluster centroids (mean of members, re-normalized).
        let mut centroids = vec![vec![0f32; dim]; k];
        let mut counts = vec![0f32; k];
        for (pos, &i) in strong.iter().enumerate() {
            let c = strong_labels[pos];
            counts[c] += 1.0;
            for d in 0..dim {
                centroids[c][d] += embeddings[i][d];
            }
        }
        for c in 0..k {
            if counts[c] > 0.0 {
                for d in 0..dim {
                    centroids[c][d] /= counts[c];
                }
                let norm = centroids[c].iter().map(|v| v * v).sum::<f32>().sqrt();
                if norm > 1e-8 {
                    for d in 0..dim {
                        centroids[c][d] /= norm;
                    }
                }
            }
        }

        let mut labels = vec![0usize; embeddings.len()];
        for (pos, &i) in strong.iter().enumerate() {
            labels[i] = strong_labels[pos];
        }
        let strong_set: std::collections::HashSet<usize> = strong.iter().copied().collect();
        for i in 0..embeddings.len() {
            if strong_set.contains(&i) {
                continue;
            }
            // Nearest centroid by cosine similarity.
            let mut best = 0usize;
            let mut best_sim = f32::NEG_INFINITY;
            for c in 0..k {
                let sim: f32 = (0..dim).map(|d| embeddings[i][d] * centroids[c][d]).sum();
                if sim > best_sim {
                    best_sim = sim;
                    best = c;
                }
            }
            labels[i] = best;
        }
        labels
    } else {
        // Too little reliable speech to be selective — cluster everything.
        clustering::agglomerative(&embeddings, num_speakers, thresh)
    };

    let num_found = labels.iter().copied().max().map(|m| m + 1).unwrap_or(0);

    // 5. Expand to segments, sort, merge adjacent same-speaker runs.
    let mut segments: Vec<DiarizationSegment> = Vec::new();
    for (k, &turn_idx) in kept.iter().enumerate() {
        let speaker = labels[k];
        for &(s, e) in &turns[turn_idx].regions {
            segments.push(DiarizationSegment { start: s, end: e, speaker });
        }
    }
    segments.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));

    let mut merged: Vec<DiarizationSegment> = Vec::with_capacity(segments.len());
    for seg in segments {
        if let Some(last) = merged.last_mut() {
            if last.speaker == seg.speaker && seg.start - last.end <= MERGE_GAP_SECONDS {
                if seg.end > last.end {
                    last.end = seg.end;
                }
                continue;
            }
        }
        merged.push(seg);
    }

    log::info!(
        "âœ… Diarization complete: {} speakers, {} segments over {:.1}s",
        num_found, merged.len(), duration
    );

    Ok(DiarizationResult { segments: merged, num_speakers: num_found, duration })
}

// ============================================================================
// Tauri commands
// ============================================================================

/// Are the diarization models installed?
#[tauri::command]
pub async fn diarization_models_available() -> Result<bool, String> {
    Ok(models_available())
}

/// The writable folder where a user can drop their own models to override the
/// bundled ones (also the download target).
#[tauri::command]
pub async fn diarization_model_directory() -> Result<String, String> {
    Ok(diarization_user_model_dir().to_string_lossy().to_string())
}

/// Total size of the diarization model download, in bytes.
#[tauri::command]
pub async fn diarization_download_size() -> Result<u64, String> {
    Ok(download::total_download_bytes())
}

/// Download the diarization models from this fork's GitHub release.
/// Progress is emitted as `diarization-download-progress` events.
#[tauri::command]
pub async fn download_diarization_models<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    download::download_models(&app).await.map_err(|e| {
        log::error!("Diarization model download failed: {}", e);
        e.to_string()
    })
}

/// Rename every transcript segment belonging to one speaker in a meeting.
///
/// Automatic speaker identification is a heuristic and will sometimes be wrong,
/// and it can never recover who is who in meetings recorded before it existed.
/// This lets the user state the truth directly — including marking a speaker as
/// themselves by naming them "You", which the UI renders with their display
/// name.
///
/// Returns the number of segments relabelled.
#[tauri::command]
pub async fn rename_meeting_speaker(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    from: String,
    to: String,
) -> Result<u64, String> {
    let to = to.trim();
    if to.is_empty() {
        return Err("Speaker name cannot be empty".to_string());
    }

    let result = sqlx::query(
        "UPDATE transcripts SET speaker = ? WHERE meeting_id = ? AND speaker = ?",
    )
    .bind(to)
    .bind(&meeting_id)
    .bind(&from)
    .execute(state.db_manager.pool())
    .await
    .map_err(|e| format!("Failed to rename speaker: {}", e))?;

    let n = result.rows_affected();
    log::info!(
        "🧑‍🤝‍🧑 Renamed speaker '{}' → '{}' across {} segments of meeting {}",
        from, to, n, meeting_id
    );
    Ok(n)
}

/// Run diarization on a recording and return speaker-labeled time segments.
#[tauri::command]
pub async fn diarize_recording(
    audio_path: String,
    num_speakers: Option<usize>,
    threshold: Option<f32>,
) -> Result<DiarizationResult, String> {
    let path = PathBuf::from(&audio_path);
    // Model inference is CPU-heavy; keep it off the async runtime's core threads.
    tokio::task::spawn_blocking(move || diarize_file(&path, num_speakers, threshold))
        .await
        .map_err(|e| format!("Diarization task failed: {}", e))?
        .map_err(|e| {
            log::error!("Diarization failed: {}", e);
            e.to_string()
        })
}

#[derive(Debug, Clone, Serialize)]
pub struct MeetingDiarizationResult {
    pub num_speakers: usize,
    /// Number of transcript segments that received a speaker label.
    pub labeled: usize,
    /// (transcript_id, speaker_label) pairs, e.g. ("transcript-â€¦", "Speaker 1").
    pub assignments: Vec<(String, String)>,
}

/// Audio container extensions a meeting recording may use. Recordings are
/// normally written as `audio.mp4`; `.wav` covers imports and older saves.
const AUDIO_EXTS: [&str; 5] = ["mp4", "m4a", "wav", "mp3", "webm"];

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.iter().any(|a| a.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

/// Newest audio file directly inside `dir`, if any.
fn newest_audio_in(dir: &Path) -> Option<PathBuf> {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_file() && is_audio_file(&path) {
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            found.push((mtime, path));
        }
    }
    found.sort_by_key(|(t, _)| *t);
    found.pop().map(|(_, p)| p)
}

/// Locate a meeting's recording.
///
/// Recordings are saved per-meeting as `<recordings folder>/<meeting name>/audio.mp4`,
/// so we search: the meeting's own `folder_path`, then each meeting subfolder of
/// the configured recordings folder, then the install-local data root (tray saves).
fn find_meeting_audio(folder_path: Option<String>, meeting_title: Option<&str>) -> Option<PathBuf> {
    // 1. The meeting's recorded folder (or a direct file path).
    if let Some(folder) = folder_path.as_deref() {
        let p = PathBuf::from(folder);
        if p.is_file() && is_audio_file(&p) {
            return Some(p);
        }
        if p.is_dir() {
            if let Some(found) = newest_audio_in(&p) {
                return Some(found);
            }
        }
    }

    // 2. The configured recordings folder, matched by meeting title.
    let recordings_root = crate::audio::recording_preferences::get_default_recordings_folder();
    if recordings_root.is_dir() {
        if let Some(title) = meeting_title {
            // Folder names are sanitized versions of the meeting title, and get a
            // timestamp suffix, so match on prefix rather than equality.
            let needle = title.to_lowercase();
            for entry in std::fs::read_dir(&recordings_root).ok()?.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let name = dir
                    .file_name()
                    .map(|n| n.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if name.starts_with(&needle) || needle.starts_with(name.as_str()) {
                    if let Some(found) = newest_audio_in(&dir) {
                        return Some(found);
                    }
                }
            }
        }
    }

    // 3. Install-local data root (where tray/UI stop-recording saves land).
    newest_audio_in(&crate::paths::install_data_root())
}

/// Decode any supported audio container to a temporary 16 kHz mono WAV using
/// the bundled ffmpeg. Returns the original path unchanged if it's already WAV.
fn ensure_wav(path: &Path) -> Result<(PathBuf, bool)> {
    if path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("wav"))
        .unwrap_or(false)
    {
        return Ok((path.to_path_buf(), false));
    }

    let ffmpeg = crate::audio::ffmpeg::find_ffmpeg_path()
        .ok_or_else(|| anyhow!("ffmpeg not found — cannot decode {}", path.display()))?;

    let out = std::env::temp_dir().join(format!(
        "meetily-diarize-{}.wav",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));

    log::info!("🎞️ Decoding {} → 16 kHz mono WAV for diarization", path.display());
    let mut cmd = std::process::Command::new(&ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i",
    ])
    .arg(path)
    .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
    .arg(&out);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let status = cmd
        .status()
        .map_err(|e| anyhow!("Failed to run ffmpeg: {}", e))?;
    if !status.success() || !out.exists() {
        return Err(anyhow!("ffmpeg failed to decode {}", path.display()));
    }
    Ok((out, true))
}

/// Diarize a meeting's recording and assign "Speaker N" labels to its
/// transcript segments (by maximum time overlap), persisting them.
#[tauri::command]
pub async fn diarize_meeting(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    audio_path: Option<String>,
    num_speakers: Option<usize>,
    threshold: Option<f32>,
) -> Result<MeetingDiarizationResult, String> {
    let pool = state.db_manager.pool();

    // Resolve the recording.
    let meeting: Option<(Option<String>, String)> =
        sqlx::query_as("SELECT folder_path, title FROM meetings WHERE id = ?")
            .bind(&meeting_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("Failed to read meeting: {}", e))?;

    let (folder_path, title) = match meeting {
        Some((f, t)) => (f, Some(t)),
        None => (None, None),
    };

    let source = match audio_path {
        Some(p) => PathBuf::from(p),
        None => find_meeting_audio(folder_path, title.as_deref()).ok_or_else(|| {
            format!(
                "No recording found for this meeting. Looked in the meeting folder, \
                 {} and the app data folder.",
                crate::audio::recording_preferences::get_default_recordings_folder().display()
            )
        })?,
    };
    log::info!("🧑‍🤝‍🧑 Diarizing meeting {} using {}", meeting_id, source.display());

    // Run the (CPU-heavy) pipeline off the async core threads. Non-WAV
    // recordings (the normal case: audio.mp4) are decoded first.
    let result = tokio::task::spawn_blocking(move || -> Result<DiarizationResult> {
        let (wav, is_temp) = ensure_wav(&source)?;
        let out = diarize_file(&wav, num_speakers, threshold);
        if is_temp {
            let _ = std::fs::remove_file(&wav);
        }
        out
    })
    .await
    .map_err(|e| format!("Diarization task failed: {}", e))?
    .map_err(|e| e.to_string())?;

    // Load transcript segments with their recording-relative timings, plus any
    // label they already carry from live diarization.
    let rows: Vec<(String, Option<f64>, Option<f64>, Option<String>)> = sqlx::query_as(
        "SELECT id, audio_start_time, audio_end_time, speaker FROM transcripts WHERE meeting_id = ?",
    )
    .bind(&meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to read transcripts: {}", e))?;

    // Work out which of the freshly-clustered speakers is the local user.
    //
    // Live diarization could tell, because it saw mic-vs-system levels before
    // mixing. This offline pass only has the mixed recording, so that signal is
    // gone — but the live labels are still in the database. Whichever new
    // speaker covers the most time that was previously marked "You" is the user.
    let user_ranges: Vec<(f32, f32)> = rows
        .iter()
        .filter(|(_, _, _, spk)| {
            spk.as_deref()
                .map(|s| s.eq_ignore_ascii_case("you"))
                .unwrap_or(false)
        })
        .filter_map(|(_, s, e, _)| match (s, e) {
            (Some(s), Some(e)) if e > s => Some((*s as f32, *e as f32)),
            _ => None,
        })
        .collect();

    let user_speaker: Option<usize> = if user_ranges.is_empty() {
        None
    } else {
        let mut overlap_per_speaker: std::collections::HashMap<usize, f32> =
            std::collections::HashMap::new();
        for seg in &result.segments {
            for (us, ue) in &user_ranges {
                let ov = seg.end.min(*ue) - seg.start.max(*us);
                if ov > 0.0 {
                    *overlap_per_speaker.entry(seg.speaker).or_insert(0.0) += ov;
                }
            }
        }
        overlap_per_speaker
            .into_iter()
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(spk, _)| spk)
    };

    if let Some(u) = user_speaker {
        log::info!("🧑‍🤝‍🧑 Speaker {} identified as the local user", u + 1);
    }

    // Assign each segment the speaker with the greatest temporal overlap.
    let mut assignments: Vec<(String, String)> = Vec::new();
    for (id, start, end, _) in rows {
        let (s, e) = match (start, end) {
            (Some(s), Some(e)) if e > s => (s as f32, e as f32),
            _ => continue, // no timing info â€” can't map reliably
        };

        let mut best_overlap = 0f32;
        let mut best_speaker: Option<usize> = None;
        for seg in &result.segments {
            let ov = seg.end.min(e) - seg.start.max(s);
            if ov > best_overlap {
                best_overlap = ov;
                best_speaker = Some(seg.speaker);
            }
        }

        if let Some(spk) = best_speaker {
            // "You" is a marker the frontend swaps for the user's display name.
            let label = if Some(spk) == user_speaker {
                "You".to_string()
            } else {
                format!("Speaker {}", spk + 1)
            };
            sqlx::query("UPDATE transcripts SET speaker = ? WHERE id = ?")
                .bind(&label)
                .bind(&id)
                .execute(pool)
                .await
                .map_err(|e| format!("Failed to save speaker label: {}", e))?;
            assignments.push((id, label));
        }
    }

    log::info!(
        "âœ… Meeting {} diarized: {} speakers, {} segments labeled",
        meeting_id,
        result.num_speakers,
        assignments.len()
    );

    Ok(MeetingDiarizationResult {
        num_speakers: result.num_speakers,
        labeled: assignments.len(),
        assignments,
    })
}

/// Slide the analysis window over samples, decode segmentation and
/// collect one [LocalTurn] per local speaker per window.
fn collect_turns(models: &mut DiarizationModels, samples: &[f32]) -> Result<Vec<LocalTurn>> {
    let total = samples.len();
    let duration = total as f32 / dsp::SAMPLE_RATE as f32;
    let window_len = (WINDOW_SECONDS * dsp::SAMPLE_RATE as f32) as usize;
    let mut turns: Vec<LocalTurn> = Vec::new();
    let mut win_start = 0usize;

    while win_start < total {
        let win_end = (win_start + window_len).min(total);
        let mut window: Vec<f32> = samples[win_start..win_end].to_vec();
        // Pad the final (short) window so the model always sees 10 s.
        if window.len() < window_len {
            window.resize(window_len, 0.0);
        }

        let activity = models.segment_window(&window)?;
        let frames = activity.len();
        if frames == 0 {
            win_start += window_len;
            continue;
        }
        // Frame duration derived from the model's own output resolution.
        let frame_secs = WINDOW_SECONDS / frames as f32;
        let samples_per_frame = (frame_secs * dsp::SAMPLE_RATE as f32) as usize;
        let win_start_secs = win_start as f32 / dsp::SAMPLE_RATE as f32;

        for spk in 0..MAX_LOCAL_SPEAKERS {
            // Contiguous runs of frames where this local speaker is active.
            let mut regions: Vec<(f32, f32)> = Vec::new();
            let mut audio: Vec<f32> = Vec::new();
            let mut run_start: Option<usize> = None;

            for f in 0..=frames {
                let active = f < frames && activity[f][spk];
                if active && run_start.is_none() {
                    run_start = Some(f);
                } else if !active {
                    if let Some(rs) = run_start.take() {
                        let s_secs = win_start_secs + rs as f32 * frame_secs;
                        let e_secs = win_start_secs + f as f32 * frame_secs;
                        // Clamp to real audio (the padded tail isn't real).
                        let e_secs = e_secs.min(duration);
                        if e_secs > s_secs {
                            regions.push((s_secs, e_secs));
                            // Gather samples for the embedding — but ONLY from
                            // frames where this speaker is the sole active one.
                            // Overlapped speech is assigned to every speaker
                            // talking, so including it would blend two voices
                            // into both embeddings and blur them together.
                            for fi in rs..f {
                                let exclusive =
                                    activity[fi].iter().filter(|&&a| a).count() == 1;
                                if !exclusive {
                                    continue;
                                }
                                let a = win_start + fi * samples_per_frame;
                                let b = (a + samples_per_frame).min(total);
                                if b > a && a < total {
                                    audio.extend_from_slice(&samples[a..b]);
                                }
                            }
                        }
                    }
                }
            }

            let speech_secs = audio.len() as f32 / dsp::SAMPLE_RATE as f32;
            if !regions.is_empty() && speech_secs >= MIN_EMBED_SECONDS {
                turns.push(LocalTurn { regions, audio, speech_secs });
            }
        }

        win_start += window_len;
    }
    Ok(turns)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Headless evaluation of the diarization pipeline against a real
    /// recording. Skipped unless both env vars are set, e.g.:
    ///
    /// ```text
    /// DIARIZE_WAV=...\sample.wav DIARIZE_MODELS=...\resources\diarization \
    ///   cargo test --release --features cuda diarize_sample -- --nocapture
    /// ```
    #[test]
    fn diarize_sample() {
        let (wav, models) = match (
            std::env::var("DIARIZE_WAV"),
            std::env::var("DIARIZE_MODELS"),
        ) {
            (Ok(w), Ok(m)) => (w, m),
            _ => {
                eprintln!("skipping: set DIARIZE_WAV and DIARIZE_MODELS");
                return;
            }
        };
        // Optional diagnostic: dump the pairwise cosine-distance distribution
        // of the speaker embeddings. Well-separated embeddings should be
        // clearly bimodal (same-speaker pairs low, different-speaker high).
        if std::env::var("DIARIZE_DIAG").is_ok() {
            let embs = embeddings_for_debug(
                std::path::Path::new(&wav),
                std::path::Path::new(&models),
            )
            .expect("embedding extraction failed");
            println!("\n=== EMBEDDING DIAGNOSTIC ===");
            println!("turns embedded : {}", embs.len());
            if embs.len() >= 2 {
                let mut d: Vec<f32> = Vec::new();
                for i in 0..embs.len() {
                    for j in (i + 1)..embs.len() {
                        let dot: f32 = embs[i].iter().zip(&embs[j]).map(|(a, b)| a * b).sum();
                        d.push(1.0 - dot);
                    }
                }
                d.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let pct = |p: f32| d[((d.len() as f32 - 1.0) * p) as usize];
                println!("pairwise cosine distance over {} pairs:", d.len());
                println!("  min {:.3}  p10 {:.3}  p25 {:.3}  median {:.3}", d[0], pct(0.10), pct(0.25), pct(0.50));
                println!("  p75 {:.3}  p90 {:.3}  max {:.3}", pct(0.75), pct(0.90), d[d.len() - 1]);
                println!("  spread (p90-p10) = {:.3}", pct(0.90) - pct(0.10));
                let mut hist = [0usize; 10];
                for &v in &d { let b = ((v.max(0.0).min(0.999)) * 10.0) as usize; hist[b] += 1; }
                for (b, n) in hist.iter().enumerate() {
                    let bar = "#".repeat(((*n as f32 / d.len() as f32) * 60.0).round() as usize);
                    println!("  {:.1}-{:.1} |{} {}", b as f32 / 10.0, (b + 1) as f32 / 10.0, bar, n);
                }
            }
            println!("=== END DIAGNOSTIC ===\n");
            return;
        }
        // Optional sweep: DIARIZE_SWEEP="0.65,0.70,0.75" runs each threshold
        // in one process so the build cost is paid once.
        if let Ok(sweep) = std::env::var("DIARIZE_SWEEP") {
            println!("\n=== THRESHOLD SWEEP: {} ===", wav);
            for t in sweep.split(',') {
                let t: f32 = match t.trim().parse() { Ok(v) => v, Err(_) => continue };
                let r = diarize_file_with_models(
                    std::path::Path::new(&wav),
                    std::path::Path::new(&models),
                    None,
                    Some(t),
                ).expect("diarization failed");
                let mut talk = std::collections::BTreeMap::<usize, f32>::new();
                for s in &r.segments { *talk.entry(s.speaker).or_insert(0.0) += s.end - s.start; }
                let mut dist: Vec<String> = talk.values()
                    .map(|v| format!("{:.0}%", (v / r.duration) * 100.0)).collect();
                dist.sort_by(|a, b| b.len().cmp(&a.len()));
                println!(
                    "  thr {:.2} -> {} speakers, {} segments   [{}]",
                    t, r.num_speakers, r.segments.len(), dist.join(" ")
                );
            }
            println!("=== END SWEEP ===\n");
            return;
        }
        let threshold = std::env::var("DIARIZE_THRESHOLD")
            .ok()
            .and_then(|v| v.parse::<f32>().ok());
        let num_speakers = std::env::var("DIARIZE_SPEAKERS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok());

        let started = std::time::Instant::now();
        let result = diarize_file_with_models(
            std::path::Path::new(&wav),
            std::path::Path::new(&models),
            num_speakers,
            threshold,
        )
        .expect("diarization failed");

        println!("\n=== DIARIZATION RESULT ===");
        println!("audio duration : {:.1}s", result.duration);
        println!("wall time      : {:.1}s", started.elapsed().as_secs_f32());
        println!("threshold      : {:?}", threshold);
        println!("speakers found : {}", result.num_speakers);
        println!("segments       : {}", result.segments.len());
        println!("--------------------------");
        let mut talk = std::collections::BTreeMap::<usize, f32>::new();
        for s in &result.segments {
            *talk.entry(s.speaker).or_insert(0.0) += s.end - s.start;
            println!(
                "{:>7.2} -> {:>7.2}  ({:>5.2}s)  Speaker {}",
                s.start,
                s.end,
                s.end - s.start,
                s.speaker + 1
            );
        }
        println!("--------------------------");
        for (spk, secs) in &talk {
            println!(
                "Speaker {} total: {:.1}s ({:.0}% of audio)",
                spk + 1,
                secs,
                (secs / result.duration) * 100.0
            );
        }
        println!("==========================\n");
    }
}

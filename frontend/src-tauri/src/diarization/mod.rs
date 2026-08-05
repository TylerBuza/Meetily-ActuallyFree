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

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use models::{DiarizationModels, MAX_LOCAL_SPEAKERS};

/// 10 second analysis window (pyannote segmentation-3.0 was trained on 10 s).
const WINDOW_SECONDS: f32 = 10.0;
/// Minimum speech needed for a stable embedding.
const MIN_EMBED_SECONDS: f32 = 0.5;
/// Gap below which two same-speaker segments are merged.
const MERGE_GAP_SECONDS: f32 = 0.5;
/// Default cosine-distance stop threshold for clustering.
const DEFAULT_THRESHOLD: f32 = 0.65;

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

/// Where the app's *writable* diarization model directory is — the target for
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
}

/// Run the full diarization pipeline on a WAV file.
pub fn diarize_file(
    wav_path: &std::path::Path,
    num_speakers: Option<usize>,
    threshold: Option<f32>,
) -> Result<DiarizationResult> {
    if !wav_path.exists() {
        return Err(anyhow!("Recording not found: {}", wav_path.display()));
    }
    let model_dir = diarization_model_dir();
    if !models_available() {
        return Err(anyhow!(
            "Diarization models not found in {}. Expected segmentation-3.0-fp16.onnx, \
             wespeaker-resnet34-LM.onnx and xvec_transform.npz.",
            model_dir.display()
        ));
    }

    // 1. Load + resample to 16 kHz mono.
    let (samples, sr) = dsp::read_wav(wav_path)?;
    let samples = if sr != dsp::SAMPLE_RATE {
        log::info!("🎚️ Diarization: resampling {} Hz → {} Hz", sr, dsp::SAMPLE_RATE);
        crate::audio::audio_processing::resample_audio(&samples, sr, dsp::SAMPLE_RATE)
    } else {
        samples
    };
    let total = samples.len();
    let duration = total as f32 / dsp::SAMPLE_RATE as f32;
    if total == 0 {
        return Ok(DiarizationResult { segments: Vec::new(), num_speakers: 0, duration: 0.0 });
    }
    log::info!("🧑‍🤝‍🧑 Diarization starting: {:.1}s of audio", duration);

    let mut models = DiarizationModels::load(&model_dir)?;

    // 2. Slide windows, decode segmentation, collect local turns.
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
                            // Gather the corresponding samples for embedding.
                            let a = win_start + rs * samples_per_frame;
                            let b = (win_start + f * samples_per_frame).min(total);
                            if b > a && a < total {
                                audio.extend_from_slice(&samples[a..b.min(total)]);
                            }
                        }
                    }
                }
            }

            let speech_secs = audio.len() as f32 / dsp::SAMPLE_RATE as f32;
            if !regions.is_empty() && speech_secs >= MIN_EMBED_SECONDS {
                turns.push(LocalTurn { regions, audio });
            }
        }

        win_start += window_len;
    }

    if turns.is_empty() {
        log::info!("🧑‍🤝‍🧑 Diarization: no speech detected");
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
    log::info!("🧑‍🤝‍🧑 Diarization: {} turns embedded", embeddings.len());

    // 4. Cluster into global speakers.
    let labels = clustering::agglomerative(
        &embeddings,
        num_speakers,
        threshold.unwrap_or(DEFAULT_THRESHOLD),
    );
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
        "✅ Diarization complete: {} speakers, {} segments over {:.1}s",
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
    /// (transcript_id, speaker_label) pairs, e.g. ("transcript-…", "Speaker 1").
    pub assignments: Vec<(String, String)>,
}

/// Locate the recording WAV for a meeting: prefer the meeting's own folder,
/// then fall back to the install-local data root (where tray/UI saves land).
fn find_meeting_wav(folder_path: Option<String>, meeting_id: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(folder) = folder_path {
        let p = PathBuf::from(folder);
        if p.is_dir() {
            candidates.push(p);
        } else if p.extension().map(|e| e.eq_ignore_ascii_case("wav")).unwrap_or(false) && p.exists() {
            return Some(p);
        }
    }
    candidates.push(crate::paths::install_data_root());

    for dir in candidates {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut wavs: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e.eq_ignore_ascii_case("wav")).unwrap_or(false) {
                // Prefer a file whose name mentions the meeting id.
                if path
                    .file_name()
                    .map(|n| n.to_string_lossy().contains(meeting_id))
                    .unwrap_or(false)
                {
                    return Some(path);
                }
                let mtime = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                wavs.push((mtime, path));
            }
        }
        if !wavs.is_empty() {
            wavs.sort_by_key(|(t, _)| *t);
            return wavs.pop().map(|(_, p)| p);
        }
    }
    None
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
    let folder: Option<(Option<String>,)> =
        sqlx::query_as("SELECT folder_path FROM meetings WHERE id = ?")
            .bind(&meeting_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("Failed to read meeting: {}", e))?;

    let wav = match audio_path {
        Some(p) => PathBuf::from(p),
        None => find_meeting_wav(folder.and_then(|f| f.0), &meeting_id)
            .ok_or_else(|| "No recording (.wav) found for this meeting".to_string())?,
    };
    log::info!("🧑‍🤝‍🧑 Diarizing meeting {} using {}", meeting_id, wav.display());

    // Run the (CPU-heavy) pipeline off the async core threads.
    let wav_for_task = wav.clone();
    let result = tokio::task::spawn_blocking(move || {
        diarize_file(&wav_for_task, num_speakers, threshold)
    })
    .await
    .map_err(|e| format!("Diarization task failed: {}", e))?
    .map_err(|e| e.to_string())?;

    // Load transcript segments with their recording-relative timings.
    let rows: Vec<(String, Option<f64>, Option<f64>)> = sqlx::query_as(
        "SELECT id, audio_start_time, audio_end_time FROM transcripts WHERE meeting_id = ?",
    )
    .bind(&meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to read transcripts: {}", e))?;

    // Assign each segment the speaker with the greatest temporal overlap.
    let mut assignments: Vec<(String, String)> = Vec::new();
    for (id, start, end) in rows {
        let (s, e) = match (start, end) {
            (Some(s), Some(e)) if e > s => (s as f32, e as f32),
            _ => continue, // no timing info — can't map reliably
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
            let label = format!("Speaker {}", spk + 1);
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
        "✅ Meeting {} diarized: {} speakers, {} segments labeled",
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

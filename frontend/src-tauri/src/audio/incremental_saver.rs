use std::path::{Path, PathBuf};
use anyhow::{Result, anyhow};
use log::{info, warn, error};
use super::encode::{encode_lossless_checkpoint, AAC_OUTPUT_ARGS};
use super::recording_state::AudioChunk;
use serde::{Serialize, Deserialize};

use super::ffmpeg::find_ffmpeg_path;

/// metadata.json field that records how the saved `{track}.mp4` files were produced.
pub const AUDIO_LAYOUT_FIELD: &str = "audio_layout";
/// Each saved track is one AAC stream: only the encoder's 1024-sample priming
/// precedes the audio. Older recordings joined 30 s AAC checkpoints without
/// re-encoding, so each checkpoint added its own priming and padding.
pub const AUDIO_LAYOUT_SINGLE_STREAM: &str = "single_stream";

/// Checkpoints written by this version: lossless, so each track is encoded to AAC once.
pub const CHECKPOINT_EXTENSION: &str = "flac";
/// AAC checkpoints left by older versions; still joined when recovering a crashed recording.
pub const LEGACY_CHECKPOINT_EXTENSION: &str = "mp4";

fn ffconcat_file_line(path: &std::path::Path) -> String {
    let escaped = path.to_string_lossy().replace('\'', "'\\''");
    format!("file '{}'\n", escaped)
}

/// Audio data for one track
#[derive(Clone)]
struct AudioData {
    data: Vec<f32>,
}

/// Incremental audio saver that writes lossless checkpoints every 30 seconds
/// to minimize memory usage and enable crash recovery. `finalize` encodes the
/// checkpoints to AAC once.
///
/// `track` selects the output basename (`audio`, `mic`, `system`) so a meeting
/// can keep separate source tracks for offline diarization plus a mixed file
/// for playback.
pub struct IncrementalAudioSaver {
    checkpoint_buffer: Vec<AudioData>,
    checkpoint_interval_samples: usize,  // 30s at 48kHz = 1,440,000 samples
    checkpoint_count: u32,
    checkpoints_dir: PathBuf,
    meeting_folder: PathBuf,
    sample_rate: u32,
    /// Basename without extension: "audio" | "mic" | "system"
    track: String,
}

impl IncrementalAudioSaver {
    /// Create a new incremental saver for the mixed playback track (`audio.mp4`).
    pub fn new(meeting_folder: PathBuf, sample_rate: u32) -> Result<Self> {
        Self::new_track(meeting_folder, sample_rate, "audio")
    }

    /// Create a saver for a named track (`audio`, `mic`, or `system`).
    pub fn new_track(meeting_folder: PathBuf, sample_rate: u32, track: &str) -> Result<Self> {
        let track = track.trim().to_ascii_lowercase();
        if track.is_empty() {
            return Err(anyhow!("track name must not be empty"));
        }
        let checkpoints_dir = meeting_folder.join(".checkpoints").join(&track);

        std::fs::create_dir_all(&checkpoints_dir).map_err(|e| {
            anyhow!(
                "Failed to create checkpoints dir {}: {}",
                checkpoints_dir.display(),
                e
            )
        })?;

        Ok(Self {
            checkpoint_buffer: Vec::new(),
            checkpoint_interval_samples: sample_rate as usize * 30, // 30 seconds
            checkpoint_count: 0,
            checkpoints_dir,
            meeting_folder,
            sample_rate,
            track,
        })
    }

    /// Add an audio chunk to the buffer
    /// Automatically saves a checkpoint when buffer reaches 30 seconds
    pub fn add_chunk(&mut self, chunk: AudioChunk) -> Result<()> {
        let audio_data = AudioData {
            data: chunk.data,
            // sample_rate: chunk.sample_rate,
        };

        self.checkpoint_buffer.push(audio_data);

        // Calculate total samples in buffer
        let total_samples: usize = self.checkpoint_buffer
            .iter()
            .map(|c| c.data.len())
            .sum();

        // Save checkpoint when buffer reaches threshold (30 seconds)
        if total_samples >= self.checkpoint_interval_samples {
            self.save_checkpoint()?;
            self.checkpoint_buffer.clear();
        }

        Ok(())
    }

    /// Save current buffer as a checkpoint file
    fn save_checkpoint(&mut self) -> Result<()> {
        // Concatenate all chunks in buffer
        let audio_data: Vec<f32> = self.checkpoint_buffer
            .iter()
            .flat_map(|c| &c.data)
            .cloned()
            .collect();

        if audio_data.is_empty() {
            warn!("Attempted to save empty checkpoint, skipping");
            return Ok(());
        }

        // Generate checkpoint filename
        let checkpoint_path = self.checkpoints_dir
            .join(self.checkpoint_file_name(self.checkpoint_count));

        // Lossless checkpoint; finalize encodes the whole track once.
        encode_lossless_checkpoint(
            bytemuck::cast_slice(&audio_data),
            self.sample_rate,
            1,  // mono
            &checkpoint_path
        )?;

        let duration_seconds = audio_data.len() as f32 / self.sample_rate as f32;
        self.checkpoint_count += 1;

        info!(
            "Saved {} checkpoint {}: {:.2}s ({} samples)",
            self.track,
            self.checkpoint_count,
            duration_seconds,
            audio_data.len()
        );

        Ok(())
    }

    /// Finalize the recording: save final checkpoint, encode all checkpoints once, cleanup
    ///
    /// Returns the path to the final merged `{track}.mp4` file
    pub async fn finalize(&mut self) -> Result<PathBuf> {
        info!("Finalizing incremental recording track '{}'...", self.track);

        // Save final buffer if not empty
        if !self.checkpoint_buffer.is_empty() {
            info!(
                "Saving final {} checkpoint with remaining {} chunks",
                self.track,
                self.checkpoint_buffer.len()
            );
            self.save_checkpoint()?;
            self.checkpoint_buffer.clear();
        }

        if self.checkpoint_count == 0 {
            return Err(anyhow!(
                "No audio checkpoints to merge for track '{}' - recording may have failed",
                self.track
            ));
        }

        // Encode all checkpoints into one AAC stream
        let final_audio_path = self.meeting_folder.join(format!("{}.mp4", self.track));
        let files: Vec<PathBuf> = (0..self.checkpoint_count)
            .map(|i| self.checkpoints_dir.join(self.checkpoint_file_name(i)))
            .collect();
        if let Some(missing) = files.iter().find(|path| !path.exists()) {
            return Err(anyhow!("Checkpoint file missing: {}", missing.display()));
        }
        let list_file = self.checkpoints_dir.join("concat_list.txt");
        let output = final_audio_path.clone();
        let started = std::time::Instant::now();
        // The encode takes about 0.35 s per minute of audio; keep it off the
        // async runtime threads. RecordingSaver finalizes tracks concurrently.
        tokio::task::spawn_blocking(move || merge_checkpoint_files(&files, &list_file, &output))
            .await
            .map_err(|e| anyhow!("Merge task failed: {}", e))??;
        info!(
            "Encoded {} {} checkpoints in {:.1}s",
            self.checkpoint_count,
            self.track,
            started.elapsed().as_secs_f64()
        );

        // Clean up this track's checkpoints directory
        info!(
            "Cleaning up {} {} checkpoint files",
            self.checkpoint_count, self.track
        );
        if let Err(e) = std::fs::remove_dir_all(&self.checkpoints_dir) {
            warn!("Failed to clean up checkpoints directory: {}", e);
            // Non-fatal - user can manually delete
        }
        // Removes only when all sibling tracks have also finished.
        if let Some(parent) = self.checkpoints_dir.parent() {
            let _ = std::fs::remove_dir(parent);
        }

        info!("Finalized track: {}", final_audio_path.display());

        Ok(final_audio_path)
    }

    fn checkpoint_file_name(&self, index: u32) -> String {
        format!("{}_chunk_{:03}.{}", self.track, index, CHECKPOINT_EXTENSION)
    }

    /// Get the meeting folder path
    pub fn get_meeting_folder(&self) -> &PathBuf {
        &self.meeting_folder
    }

    /// Get current checkpoint count
    pub fn get_checkpoint_count(&self) -> u32 {
        self.checkpoint_count
    }
}

/// Index from a `{track}_chunk_{index}.{ext}` name. Indexes have at least three
/// digits, so a name sort alone misorders recordings longer than 999 checkpoints.
fn checkpoint_index(path: &Path) -> Option<u32> {
    path.file_stem()?.to_str()?.rsplit('_').next()?.parse().ok()
}

/// Checkpoint files in `dir`, in recording order: this version's lossless files,
/// or the legacy AAC files of a recording made by an older version.
pub(crate) fn list_checkpoint_files(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut lossless = Vec::new();
    let mut legacy = Vec::new();
    for entry in std::fs::read_dir(dir)?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        match path.extension().and_then(|e| e.to_str()) {
            Some(CHECKPOINT_EXTENSION) => lossless.push(path),
            Some(LEGACY_CHECKPOINT_EXTENSION) => legacy.push(path),
            _ => {}
        }
    }
    let mut files = if lossless.is_empty() { legacy } else { lossless };
    files.sort_by_cached_key(|path| (checkpoint_index(path), path.clone()));
    Ok(files)
}

fn is_lossless_checkpoint(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some(CHECKPOINT_EXTENSION)
}

/// Merge checkpoint files into `output` (an MP4) with FFmpeg's concat demuxer.
/// Lossless checkpoints are encoded once to AAC-LC, so the file is continuous with
/// a single encoder priming. Legacy AAC checkpoints are joined without
/// re-encoding; each keeps its own priming and padding, as in older versions.
pub(crate) fn merge_checkpoint_files(files: &[PathBuf], list_file: &Path, output: &Path) -> Result<()> {
    if files.is_empty() {
        return Err(anyhow!("No audio checkpoints to merge"));
    }
    let mut list_content = String::new();
    for file in files {
        // Absolute paths (required with -safe 0)
        list_content.push_str(&ffconcat_file_line(&file.canonicalize()?));
    }
    std::fs::write(list_file, list_content)?;

    let ffmpeg_path = find_ffmpeg_path()
        .ok_or_else(|| anyhow!("FFmpeg not found. Please install FFmpeg to finalize recordings."))?;
    info!("Using FFmpeg at: {:?}", ffmpeg_path);

    let mut command = std::process::Command::new(ffmpeg_path);
    command.args(["-f", "concat", "-safe", "0", "-i"]).arg(list_file);
    if files.iter().all(|file| is_lossless_checkpoint(file)) {
        command.args(AAC_OUTPUT_ARGS);
    } else {
        // `-f mp4`: recovery writes to a temporary name without an .mp4 extension.
        command.args(["-c", "copy", "-f", "mp4"]);
    }
    command.arg("-y").arg(output);

    // Hide console window on Windows to prevent CMD popup during finalization
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let ffmpeg_output = command.output()?;
    if !ffmpeg_output.status.success() {
        let stderr = String::from_utf8_lossy(&ffmpeg_output.stderr);
        error!("FFmpeg merge failed: {}", stderr);
        return Err(anyhow!("FFmpeg concat failed: {}", stderr));
    }
    if !output.is_file() {
        return Err(anyhow!("Merged audio file was not created: {}", output.display()));
    }
    info!("Merged {} checkpoints → {}", files.len(), output.display());
    Ok(())
}

/// Record in an existing metadata.json that the saved tracks are single AAC
/// streams; other fields are kept. A missing metadata.json is left missing.
pub(crate) fn mark_single_stream_layout(folder: &Path) -> Result<()> {
    let path = folder.join("metadata.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let mut value: serde_json::Value = serde_json::from_str(&raw)?;
    value
        .as_object_mut()
        .ok_or_else(|| anyhow!("metadata.json root must be an object"))?
        .insert(AUDIO_LAYOUT_FIELD.to_string(), serde_json::json!(AUDIO_LAYOUT_SINGLE_STREAM));
    let temp = folder.join(format!(".metadata.json.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, serde_json::to_string_pretty(&value)?)?;
    std::fs::rename(&temp, &path)?;
    Ok(())
}

/// Audio recovery status for transcript recovery feature
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioRecoveryStatus {
    pub status: String, // "success" | "partial" | "failed" | "none"
    pub chunk_count: u32,
    pub estimated_duration_seconds: f64,
    pub audio_file_path: Option<String>,
    pub message: String,
}

/// Recover one track from its checkpoint folder after a crash. The transcript
/// recovery system calls this through `recover_audio_from_checkpoints`.
fn recover_checkpoint_track(
    checkpoints_dir: &Path,
    output_path: &Path,
    expected_count: Option<u32>,
) -> Result<u32, String> {
    // Lossless checkpoints from this version, or AAC checkpoints from an older one
    let mut checkpoint_files = list_checkpoint_files(checkpoints_dir)
        .map_err(|e| format!("Failed to read {}: {e}", checkpoints_dir.display()))?;
    if checkpoint_files.is_empty() {
        return Err(format!("No checkpoints found in {}", checkpoints_dir.display()));
    }
    if let Some(expected) = expected_count {
        if checkpoint_files.len() < expected as usize {
            return Err(format!(
                "{} has {} checkpoints; expected at least {expected}",
                checkpoints_dir.display(),
                checkpoint_files.len()
            ));
        }
        checkpoint_files.truncate(expected as usize);
    }

    let concat_file = checkpoints_dir.join("concat_list.txt");
    let temp_output = output_path.with_extension("mp4.recovering");
    let _ = std::fs::remove_file(&temp_output);
    if let Err(e) = merge_checkpoint_files(&checkpoint_files, &concat_file, &temp_output) {
        let _ = std::fs::remove_file(&temp_output);
        return Err(format!("FFmpeg failed for {}: {e}", output_path.display()));
    }
    if !temp_output.is_file() {
        return Err(format!("FFmpeg did not create {}", temp_output.display()));
    }
    if output_path.exists() {
        std::fs::remove_file(output_path)
            .map_err(|e| format!("Failed to replace {}: {e}", output_path.display()))?;
    }
    std::fs::rename(&temp_output, output_path)
        .map_err(|e| format!("Failed to promote {}: {e}", output_path.display()))?;
    std::fs::write(checkpoints_dir.join(".recovered"), b"ok")
        .map_err(|e| format!("Failed to mark recovered track: {e}"))?;
    let _ = std::fs::remove_file(concat_file);
    Ok(checkpoint_files.len() as u32)
}

/// Source-track checkpoint folders (every `.checkpoints/<track>/` except the
/// mixed `audio` track), sorted by name. Tracks are found on disk, so any track
/// a recording created is recovered and cleaned up.
fn source_track_names(checkpoints_root: &Path) -> Vec<String> {
    let mut tracks: Vec<String> = std::fs::read_dir(checkpoints_root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .filter(|name| name != "audio")
        .collect();
    tracks.sort();
    tracks
}

#[tauri::command]
pub async fn recover_audio_from_checkpoints(
    meeting_folder: String,
    _sample_rate: u32
) -> Result<AudioRecoveryStatus, String> {
    info!("Starting audio recovery for folder: {}", meeting_folder);
    // Lossless checkpoints are encoded to AAC here; keep that off the async runtime.
    tokio::task::spawn_blocking(move || recover_meeting_audio(&PathBuf::from(meeting_folder)))
        .await
        .map_err(|e| format!("Audio recovery task failed: {e}"))?
}

fn recover_meeting_audio(folder_path: &Path) -> Result<AudioRecoveryStatus, String> {
    let checkpoints_root = folder_path.join(".checkpoints");
    // New format stores each track in its own subfolder. Recover mixed playback
    // exactly as legacy recovery did; source tracks remain optional diagnostics.
    let checkpoints_dir = if checkpoints_root.join("audio").is_dir() {
        checkpoints_root.join("audio")
    } else {
        checkpoints_root.clone()
    };

    if !checkpoints_dir.exists() {
        info!("No checkpoints directory found at: {}", checkpoints_dir.display());
        return Ok(AudioRecoveryStatus {
            status: "none".to_string(),
            chunk_count: 0,
            estimated_duration_seconds: 0.0,
            audio_file_path: None,
            message: "No audio checkpoints found".to_string(),
        });
    }

    let lossless = list_checkpoint_files(&checkpoints_dir)
        .map(|files| files.first().is_some_and(|file| is_lossless_checkpoint(file)))
        .unwrap_or(false);
    let output_path = folder_path.join("audio.mp4");
    let chunk_count = match recover_checkpoint_track(&checkpoints_dir, &output_path, None) {
        Ok(count) => count,
        Err(error) if error.starts_with("No checkpoints") => {
            return Ok(AudioRecoveryStatus {
                status: "none".to_string(),
                chunk_count: 0,
                estimated_duration_seconds: 0.0,
                audio_file_path: None,
                message: error,
            });
        }
        Err(error) => {
            error!("Mixed audio recovery failed: {error}");
            return Ok(AudioRecoveryStatus {
                status: "failed".to_string(),
                chunk_count: 0,
                estimated_duration_seconds: 0.0,
                audio_file_path: None,
                message: error,
            });
        }
    };

    // Source tracks are encoded concurrently: each encode is one FFmpeg process.
    let tracks = if checkpoints_dir == checkpoints_root {
        Vec::new()
    } else {
        source_track_names(&checkpoints_root)
    };
    let source_failures: Vec<String> = std::thread::scope(|scope| {
        let handles: Vec<_> = tracks
            .iter()
            .map(|track| {
                let track_dir = checkpoints_root.join(track);
                let output = folder_path.join(format!("{track}.mp4"));
                (track, scope.spawn(move || recover_checkpoint_track(&track_dir, &output, Some(chunk_count))))
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|(track, handle)| {
                let result = handle
                    .join()
                    .unwrap_or_else(|_| Err("recovery thread panicked".to_string()));
                result.err().map(|error| {
                    warn!("Could not recover {track} track: {error}");
                    format!("{track}: {error}")
                })
            })
            .collect()
    });

    if lossless {
        if let Err(e) = mark_single_stream_layout(folder_path) {
            warn!("Failed to record the audio layout in metadata.json: {}", e);
        }
    }

    let status = if source_failures.is_empty() { "success" } else { "partial" };
    let message = if source_failures.is_empty() {
        format!("Successfully recovered {chunk_count} audio chunks and available source tracks")
    } else {
        format!("Recovered mixed audio; source-track recovery failed ({})", source_failures.join("; "))
    };
    Ok(AudioRecoveryStatus {
        status: status.to_string(),
        chunk_count,
        estimated_duration_seconds: chunk_count as f64 * 30.0,
        audio_file_path: Some(output_path.to_string_lossy().into_owned()),
        message,
    })
}

/// Clean up checkpoint files after successful recording or recovery
/// This command is called by the frontend after successful save to clean up checkpoint files
#[tauri::command]
pub async fn cleanup_checkpoints(meeting_folder: String) -> Result<(), String> {
    info!("Cleaning up checkpoints for folder: {}", meeting_folder);

    let folder_path = PathBuf::from(&meeting_folder);
    let checkpoints_root = folder_path.join(".checkpoints");

    if checkpoints_root.exists() {
        if checkpoints_root.join("audio").is_dir() {
            let tracks = std::iter::once("audio".to_string())
                .chain(source_track_names(&checkpoints_root));
            for track in tracks {
                let track_dir = checkpoints_root.join(&track);
                if folder_path.join(format!("{track}.mp4")).is_file()
                    && track_dir.join(".recovered").is_file()
                {
                    std::fs::remove_dir_all(&track_dir)
                        .map_err(|e| format!("Failed to remove {}: {e}", track_dir.display()))?;
                }
            }
            let _ = std::fs::remove_dir(&checkpoints_root);
        } else if folder_path.join("audio.mp4").is_file() {
            std::fs::remove_dir_all(&checkpoints_root)
                .map_err(|e| format!("Failed to remove checkpoints directory: {e}"))?;
        }
        info!("Cleaned checkpoints for successfully recovered tracks");
    } else {
        info!("No checkpoints directory to clean up");
    }

    Ok(())
}

/// Check if a meeting folder has audio checkpoint files
/// Returns true if the mixed track's checkpoint folder contains lossless (current)
/// or AAC (older version) checkpoint files
#[tauri::command]
pub async fn has_audio_checkpoints(meeting_folder: String) -> Result<bool, String> {
    let folder_path = PathBuf::from(&meeting_folder);
    let checkpoints_root = folder_path.join(".checkpoints");
    let checkpoints_dir = if checkpoints_root.join("audio").is_dir() {
        checkpoints_root.join("audio")
    } else {
        checkpoints_root
    };

    // Check if checkpoints directory exists
    if !checkpoints_dir.exists() {
        return Ok(false);
    }

    let files = list_checkpoint_files(&checkpoints_dir)
        .map_err(|e| format!("Failed to read checkpoints directory: {}", e))?;
    Ok(!files.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use super::super::recording_state::DeviceType;

    #[test]
    fn concat_paths_escape_apostrophes() {
        let line = ffconcat_file_line(std::path::Path::new("/Users/O'Brien/audio.mp4"));
        assert_eq!(line, "file '/Users/O'\\''Brien/audio.mp4'\n");
    }

    #[tokio::test]
    async fn test_checkpoint_creation() {
        // Create temp meeting folder
        let temp_dir = tempdir().unwrap();
        let meeting_folder = temp_dir.path().join("Test_Meeting");
        std::fs::create_dir_all(&meeting_folder).unwrap();
        std::fs::create_dir_all(meeting_folder.join(".checkpoints")).unwrap();

        let mut saver = IncrementalAudioSaver::new(
            meeting_folder.clone(),
            48000
        ).unwrap();

        // Add 60 seconds worth of audio (should create 2 checkpoints)
        for i in 0..120 {  // 120 chunks of 0.5s each
            let chunk = AudioChunk {
                data: vec![0.5f32; 24000],  // 0.5s at 48kHz
                sample_rate: 48000,
                timestamp: i as f64 * 0.5,  // timestamp in seconds
                chunk_id: i as u64,
                device_type: DeviceType::Microphone,
            };
            saver.add_chunk(chunk).unwrap();
        }

        // Verify 2 checkpoints created
        assert_eq!(saver.checkpoint_count, 2);

        // Finalize and verify merge
        let final_path = saver.finalize().await.unwrap();
        assert!(final_path.exists());

        // Verify checkpoints directory deleted
        assert!(!meeting_folder.join(".checkpoints").exists());
    }

    #[tokio::test]
    async fn test_empty_recording() {
        let temp_dir = tempdir().unwrap();
        let meeting_folder = temp_dir.path().join("Empty_Test");
        std::fs::create_dir_all(&meeting_folder).unwrap();
        std::fs::create_dir_all(meeting_folder.join(".checkpoints")).unwrap();

        let mut saver = IncrementalAudioSaver::new(
            meeting_folder.clone(),
            48000
        ).unwrap();

        // Try to finalize without adding any chunks
        let result = saver.finalize().await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("No audio checkpoints"));
    }

    const RATE: usize = 48_000;
    /// One AAC frame: the tolerance for a single encode's priming/padding.
    const AAC_FRAME: i64 = 1024;

    /// Feeds `samples` to `saver` in 0.6 s chunks, as the pipeline does.
    fn feed(saver: &mut IncrementalAudioSaver, samples: &[f32]) {
        for (n, chunk) in samples.chunks(28_800).enumerate() {
            saver
                .add_chunk(AudioChunk {
                    data: chunk.to_vec(),
                    sample_rate: RATE as u32,
                    timestamp: n as f64 * 0.6,
                    chunk_id: n as u64,
                    device_type: DeviceType::Microphone,
                })
                .unwrap();
        }
    }

    /// Silence with a unit impulse at each index in `impulses`.
    fn impulses(total: usize, impulses: &[usize]) -> Vec<f32> {
        let mut samples = vec![0.0f32; total];
        for &i in impulses {
            samples[i] = 1.0;
        }
        samples
    }

    fn tone(total: usize) -> Vec<f32> {
        (0..total).map(|i| (i as f32 * 0.05).sin() * 0.3).collect()
    }

    fn decoded_mono(path: &Path) -> Vec<f32> {
        let decoded = crate::audio::decoder::decode_audio_file(path).unwrap();
        assert_eq!(decoded.channels, 1);
        assert_eq!(decoded.sample_rate as usize, RATE);
        decoded.samples
    }

    /// Index of the largest absolute sample within `radius` of `around`.
    fn peak_near(samples: &[f32], around: usize, radius: usize) -> usize {
        let (lo, hi) = (around.saturating_sub(radius), (around + radius).min(samples.len()));
        (lo..hi)
            .max_by(|&a, &b| samples[a].abs().partial_cmp(&samples[b].abs()).unwrap())
            .unwrap()
    }

    fn write_checkpoints(dir: &Path, track: &str, count: usize, lossless: bool) {
        std::fs::create_dir_all(dir).unwrap();
        let samples = tone(RATE);
        for k in 0..count {
            let data: &[u8] = bytemuck::cast_slice(&samples);
            if lossless {
                let path = dir.join(format!("{track}_chunk_{k:03}.flac"));
                crate::audio::encode::encode_lossless_checkpoint(data, RATE as u32, 1, &path).unwrap();
            } else {
                let path = dir.join(format!("{track}_chunk_{k:03}.mp4"));
                crate::audio::encode::encode_single_audio(data, RATE as u32, 1, &path).unwrap();
            }
        }
    }

    fn read_metadata(folder: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(folder.join("metadata.json")).unwrap()).unwrap()
    }

    /// Joining AAC checkpoints with `-c copy` added about 1800 samples (37 ms) per
    /// checkpoint. Encoding once keeps the saved length and every impulse within
    /// one AAC frame of the input, however many checkpoints the recording has.
    #[tokio::test]
    async fn finalize_keeps_length_and_timing_across_checkpoints() {
        let temp_dir = tempdir().unwrap();
        let meeting_folder = temp_dir.path().join("Aligned");
        let mut saver = IncrementalAudioSaver::new(meeting_folder.clone(), RATE as u32).unwrap();

        // Three full 30 s checkpoints and a 10 s final one.
        const TOTAL: usize = 3 * 1_440_000 + 480_000;
        const IMPULSES: [usize; 4] = [0, 1_440_000, 3_600_000, TOTAL - 48_000];
        feed(&mut saver, &impulses(TOTAL, &IMPULSES));
        assert_eq!(saver.get_checkpoint_count(), 3);

        let path = saver.finalize().await.unwrap();
        assert_eq!(saver.get_checkpoint_count(), 4);
        assert_eq!(path, meeting_folder.join("audio.mp4"));
        let decoded = decoded_mono(&path);

        // One encode: at most the encoder's 1024-sample priming precedes the audio.
        let extra = decoded.len() as i64 - TOTAL as i64;
        assert!(
            (extra - AAC_FRAME).abs() <= AAC_FRAME,
            "decoded {} samples for {TOTAL} input samples ({extra:+})",
            decoded.len()
        );
        let offset = peak_near(&decoded, 0, 4096) as i64;
        assert!(offset <= AAC_FRAME + 64, "first impulse at {offset}");
        for &i in &IMPULSES[1..] {
            let peak = peak_near(&decoded, i + offset as usize, 4800) as i64;
            // Within 1 ms of the first impulse's offset.
            assert!((peak - i as i64 - offset).abs() <= 48, "impulse at {i}: peak {peak}, offset {offset}");
        }
        assert!(!meeting_folder.join(".checkpoints").exists());
    }

    /// Every track created with `new_track`, whatever its name, gets lossless
    /// checkpoints and one encode, and the tracks stay the same length.
    #[tokio::test]
    async fn all_tracks_are_encoded_once_and_stay_aligned() {
        let temp_dir = tempdir().unwrap();
        let meeting_folder = temp_dir.path().join("Tracks");
        const TOTAL: usize = 2 * 1_440_000 + 240_000;
        let signal = impulses(TOTAL, &[0, TOTAL - 48_000]);
        let tracks = ["audio", "mic", "system", "mic_raw"];
        let mut savers: Vec<_> = tracks
            .iter()
            .map(|t| IncrementalAudioSaver::new_track(meeting_folder.clone(), RATE as u32, t).unwrap())
            .collect();
        for saver in &mut savers {
            feed(saver, &signal);
        }
        for track in tracks {
            let dir = meeting_folder.join(".checkpoints").join(track);
            let files = list_checkpoint_files(&dir).unwrap();
            assert_eq!(files.len(), 2, "{track}");
            assert!(files.iter().all(|f| is_lossless_checkpoint(f)), "{track}: {files:?}");
        }

        let results = futures_util::future::join_all(savers.iter_mut().map(|s| s.finalize())).await;
        let lengths: Vec<usize> = results
            .into_iter()
            .zip(tracks)
            .map(|(result, track)| {
                let path = result.unwrap();
                assert_eq!(path, meeting_folder.join(format!("{track}.mp4")));
                decoded_mono(&path).len()
            })
            .collect();
        for len in &lengths {
            assert!((*len as i64 - TOTAL as i64 - AAC_FRAME).abs() <= AAC_FRAME, "{lengths:?}");
        }
        assert!(lengths.windows(2).all(|w| w[0] == w[1]), "{lengths:?}");
        assert!(!meeting_folder.join(".checkpoints").exists());
    }

    #[tokio::test]
    async fn recovery_encodes_lossless_checkpoints_of_every_track_and_marks_the_layout() {
        let temp_dir = tempdir().unwrap();
        let folder = temp_dir.path().join("Crashed");
        let checkpoints = folder.join(".checkpoints");
        for track in ["audio", "mic", "system", "mic_raw"] {
            write_checkpoints(&checkpoints.join(track), track, 2, true);
        }
        std::fs::write(folder.join("metadata.json"), r#"{"status":"recording"}"#).unwrap();
        assert!(has_audio_checkpoints(folder.to_string_lossy().to_string()).await.unwrap());

        let status = recover_audio_from_checkpoints(folder.to_string_lossy().to_string(), 48000)
            .await
            .unwrap();
        assert_eq!(status.status, "success", "{}", status.message);
        assert_eq!(status.chunk_count, 2);
        for track in ["audio", "mic", "system", "mic_raw"] {
            let len = decoded_mono(&folder.join(format!("{track}.mp4"))).len() as i64;
            assert!((len - 2 * RATE as i64 - AAC_FRAME).abs() <= AAC_FRAME, "{track}: {len}");
        }
        let metadata = read_metadata(&folder);
        assert_eq!(metadata[AUDIO_LAYOUT_FIELD], AUDIO_LAYOUT_SINGLE_STREAM);
        assert_eq!(metadata["status"], "recording");

        cleanup_checkpoints(folder.to_string_lossy().to_string()).await.unwrap();
        assert!(!checkpoints.exists());
    }

    /// Recordings made by an older version left AAC checkpoints. They are still
    /// joined without re-encoding, and the file is not marked single-stream.
    #[tokio::test]
    async fn recovery_joins_legacy_aac_checkpoints() {
        let temp_dir = tempdir().unwrap();
        let folder = temp_dir.path().join("Legacy");
        let checkpoints = folder.join(".checkpoints");
        write_checkpoints(&checkpoints.join("audio"), "audio", 2, false);
        write_checkpoints(&checkpoints.join("mic"), "mic", 2, false);
        std::fs::write(folder.join("metadata.json"), r#"{"status":"recording"}"#).unwrap();
        assert!(has_audio_checkpoints(folder.to_string_lossy().to_string()).await.unwrap());

        let status = recover_audio_from_checkpoints(folder.to_string_lossy().to_string(), 48000)
            .await
            .unwrap();
        assert_eq!(status.status, "success", "{}", status.message);
        assert!(folder.join("audio.mp4").is_file());
        assert!(folder.join("mic.mp4").is_file());
        assert!(!folder.join("audio.mp4.recovering").exists());
        assert!(read_metadata(&folder).get(AUDIO_LAYOUT_FIELD).is_none());

        cleanup_checkpoints(folder.to_string_lossy().to_string()).await.unwrap();
        assert!(!checkpoints.exists());
    }

    /// Single-folder layout from before per-track folders: `.checkpoints/audio_chunk_*.mp4`.
    #[tokio::test]
    async fn recovery_joins_flat_legacy_checkpoints() {
        let temp_dir = tempdir().unwrap();
        let folder = temp_dir.path().join("Flat");
        write_checkpoints(&folder.join(".checkpoints"), "audio", 2, false);

        let status = recover_audio_from_checkpoints(folder.to_string_lossy().to_string(), 48000)
            .await
            .unwrap();
        assert_eq!(status.status, "success", "{}", status.message);
        assert!(folder.join("audio.mp4").is_file());
        assert!(!folder.join("metadata.json").exists());
    }

    #[test]
    fn checkpoint_listing_prefers_lossless_files_in_recording_order() {
        let temp_dir = tempdir().unwrap();
        let dir = temp_dir.path();
        for name in [
            "mic_chunk_1000.flac",
            "mic_chunk_101.flac",
            "mic_chunk_002.flac",
            "mic_chunk_000.mp4",
            "concat_list.txt",
            ".recovered",
        ] {
            std::fs::write(dir.join(name), b"").unwrap();
        }
        let names: Vec<_> = list_checkpoint_files(dir)
            .unwrap()
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["mic_chunk_002.flac", "mic_chunk_101.flac", "mic_chunk_1000.flac"]);

        for name in ["mic_chunk_1000.flac", "mic_chunk_101.flac", "mic_chunk_002.flac"] {
            std::fs::remove_file(dir.join(name)).unwrap();
        }
        let legacy = list_checkpoint_files(dir).unwrap();
        assert_eq!(legacy, [dir.join("mic_chunk_000.mp4")]);
    }
}

use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;
use anyhow::Result;
use log::{info, warn, error};
use tauri::{AppHandle, Runtime, Emitter};
use tokio::sync::mpsc;
use serde::{Serialize, Deserialize};
use std::path::PathBuf;

use super::recording_state::AudioChunk;
use super::audio_processing::create_meeting_folder;
use super::incremental_saver::IncrementalAudioSaver;

/// Structured transcript segment for JSON export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub id: String,
    pub text: String,
    pub audio_start_time: f64, // Seconds from recording start
    pub audio_end_time: f64,   // Seconds from recording start
    pub duration: f64,          // Segment duration in seconds
    pub display_time: String,   // Formatted time for display like "[02:15]"
    pub confidence: f32,
    pub sequence_id: u64,
    /// Live speaker label ("You" / "Guest" / "Speaker N"). Must ride along from
    /// the transcript-update event into transcripts.json — the post-call UI and
    /// offline diarize both depend on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
}

/// Meeting metadata structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingMetadata {
    pub version: String,
    pub meeting_id: Option<String>,
    pub meeting_name: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub duration_seconds: Option<f64>,
    pub devices: DeviceInfo,
    pub audio_file: String,
    /// Dedicated local-user track for reliable offline identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic_audio_file: Option<String>,
    /// Dedicated system/remote track for remote-speaker clustering.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_audio_file: Option<String>,
    pub transcript_file: String,
    pub sample_rate: u32,
    pub status: String,  // "recording", "completed", "error"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub microphone: Option<String>,
    pub system_audio: Option<String>,
}

/// New recording saver using incremental saving strategy.
/// Writes three tracks when auto-save is on:
///   - `audio.mp4`  mixed playback
///   - `mic.mp4`    local user (You)
///   - `system.mp4` remote / computer audio
pub struct RecordingSaver {
    mixed_saver: Option<Arc<AsyncMutex<IncrementalAudioSaver>>>,
    mic_saver: Option<Arc<AsyncMutex<IncrementalAudioSaver>>>,
    system_saver: Option<Arc<AsyncMutex<IncrementalAudioSaver>>>,
    recordings_folder: Option<PathBuf>,
    meeting_folder: Option<PathBuf>,
    meeting_name: Option<String>,
    metadata: Option<MeetingMetadata>,
    transcript_segments: Arc<Mutex<Vec<TranscriptSegment>>>,
    chunk_receiver: Option<mpsc::UnboundedReceiver<AudioChunk>>,
    is_saving: Arc<Mutex<bool>>,
    accumulation_handle: Option<tokio::task::JoinHandle<()>>,
}

impl RecordingSaver {
    pub fn new() -> Self {
        Self {
            mixed_saver: None,
            mic_saver: None,
            system_saver: None,
            recordings_folder: None,
            meeting_folder: None,
            meeting_name: None,
            metadata: None,
            transcript_segments: Arc::new(Mutex::new(Vec::new())),
            chunk_receiver: None,
            is_saving: Arc::new(Mutex::new(false)),
            accumulation_handle: None,
        }
    }

    /// Set the meeting name for this recording session
    pub fn set_meeting_name(&mut self, name: Option<String>) {
        self.meeting_name = name;
    }

    pub fn set_recordings_folder(&mut self, path: PathBuf) {
        self.recordings_folder = Some(path);
    }

    /// Set device information in metadata
    pub fn set_device_info(&mut self, mic_name: Option<String>, sys_name: Option<String>) {
        if let Some(ref mut metadata) = self.metadata {
            metadata.devices.microphone = mic_name;
            metadata.devices.system_audio = sys_name;

            // Write updated metadata to disk if folder exists
            if let Some(folder) = &self.meeting_folder {
                let metadata_clone = metadata.clone();
                if let Err(e) = self.write_metadata(folder, &metadata_clone) {
                    warn!("Failed to update metadata with device info: {}", e);
                }
            }
        }
    }

    /// Add or update a structured transcript segment (upserts based on sequence_id)
    /// Also saves incrementally to disk
    pub fn add_transcript_segment(&self, segment: TranscriptSegment) {
        Self::upsert_transcript_segment(&self.transcript_segments, segment);

        // NEW: Save incrementally to disk
        if let Some(folder) = &self.meeting_folder {
            if let Err(e) = self.write_transcripts_json(folder) {
                warn!("Failed to write incremental transcript update: {}", e);
            }
        }
    }

    pub(crate) fn transcript_segments_handle(&self) -> Arc<Mutex<Vec<TranscriptSegment>>> {
        self.transcript_segments.clone()
    }

    pub(crate) fn upsert_transcript_segment(
        transcript_segments: &Arc<Mutex<Vec<TranscriptSegment>>>,
        segment: TranscriptSegment,
    ) {
        if let Ok(mut segments) = transcript_segments.lock() {
            // Check if segment with same sequence_id exists (update it)
            if let Some(existing) = segments.iter_mut().find(|s| s.sequence_id == segment.sequence_id) {
                *existing = segment.clone();
                info!("Updated transcript segment {} (seq: {}) - total segments: {}",
                      segment.id, segment.sequence_id, segments.len());
            } else {
                // New segment, add it
                segments.push(segment.clone());
                info!("Added new transcript segment {} (seq: {}) - total segments: {}",
                      segment.id, segment.sequence_id, segments.len());
            }
        } else {
            error!("Failed to lock transcript segments for adding segment {}", segment.id);
        }
    }

    /// Legacy method for backward compatibility - converts text to basic segment
    pub fn add_transcript_chunk(&self, text: String) {
        let segment = TranscriptSegment {
            id: format!("seg_{}", chrono::Utc::now().timestamp_millis()),
            text,
            audio_start_time: 0.0,
            audio_end_time: 0.0,
            duration: 0.0,
            display_time: "[00:00]".to_string(),
            confidence: 1.0,
            sequence_id: 0,
            speaker: None,
        };
        self.add_transcript_segment(segment);
    }

    /// Start accumulation with optional incremental saving
    ///
    /// # Arguments
    /// * `auto_save` - If true, creates checkpoints and enables saving. If false, audio chunks are discarded.
    pub fn start_accumulation(
        &mut self,
        auto_save: bool,
    ) -> Result<mpsc::UnboundedSender<AudioChunk>> {
        if auto_save {
            info!("Initializing incremental audio saver for recording (auto-save ENABLED)");
        } else {
            info!("Starting recording without audio saving (auto-save DISABLED - transcripts only)");
        }

        // Initialization must succeed before any producer can send chunks. If
        // auto-save is enabled with no saver targets, every chunk is otherwise
        // accepted by the channel and silently discarded.
        let name = self
            .meeting_name
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Meeting name is required before recording starts"))?;
        self.initialize_meeting_folder(&name, auto_save)?;
        if auto_save {
            info!("Successfully initialized meeting folder with checkpoints");
        } else {
            info!("Successfully initialized meeting folder (transcripts only)");
        }

        // Create the channel only after the destination is ready.
        let (sender, receiver) = mpsc::unbounded_channel::<AudioChunk>();
        self.chunk_receiver = Some(receiver);

        // Start accumulation task
        let mixed_saver = self.mixed_saver.clone();
        let mic_saver = self.mic_saver.clone();
        let system_saver = self.system_saver.clone();
        let save_audio = auto_save;

        if let Some(mut receiver) = self.chunk_receiver.take() {
            self.accumulation_handle = Some(tokio::spawn(async move {
                use super::recording_state::DeviceType;
                info!("Recording saver accumulation task started (save_audio: {})", save_audio);

                while let Some(chunk) = receiver.recv().await {
                    if !save_audio {
                        continue;
                    }

                    let target = match chunk.device_type {
                        DeviceType::Mixed => mixed_saver.as_ref(),
                        DeviceType::Microphone => mic_saver.as_ref(),
                        DeviceType::System => system_saver.as_ref(),
                    };

                    if let Some(saver_arc) = target {
                        let mut saver_guard = saver_arc.lock().await;
                        if let Err(e) = saver_guard.add_chunk(chunk) {
                            error!("Failed to add chunk to track saver: {}", e);
                        }
                    }
                }

                info!("Recording saver accumulation task ended");
            }));
        }

        // Set saving flag
        if let Ok(mut is_saving) = self.is_saving.lock() {
            *is_saving = true;
        }

        Ok(sender)
    }

    /// Initialize meeting folder structure and metadata
    ///
    /// # Arguments
    /// * `meeting_name` - Name of the meeting
    /// * `create_checkpoints` - Whether to create .checkpoints/ directory and IncrementalAudioSaver
    fn initialize_meeting_folder(&mut self, meeting_name: &str, create_checkpoints: bool) -> Result<()> {
        let base_folder = self
            .recordings_folder
            .clone()
            .unwrap_or_else(super::recording_preferences::get_default_recordings_folder);

        // Create meeting folder structure (with or without .checkpoints/ subdirectory)
        let meeting_folder = create_meeting_folder(&base_folder, meeting_name, create_checkpoints)?;

        // Three tracks: mixed playback + separate mic/system for offline diarization
        if create_checkpoints {
            let mixed = IncrementalAudioSaver::new_track(meeting_folder.clone(), 48000, "audio")?;
            let mic = IncrementalAudioSaver::new_track(meeting_folder.clone(), 48000, "mic")?;
            let system = IncrementalAudioSaver::new_track(meeting_folder.clone(), 48000, "system")?;
            self.mixed_saver = Some(Arc::new(AsyncMutex::new(mixed)));
            self.mic_saver = Some(Arc::new(AsyncMutex::new(mic)));
            self.system_saver = Some(Arc::new(AsyncMutex::new(system)));
            info!(
                "✅ Dual-track audio savers initialized (audio/mic/system) for: {}",
                meeting_name
            );
        } else {
            info!("⚠️  Skipped incremental audio saver (auto-save disabled)");
        }

        // Create initial metadata
        let metadata = MeetingMetadata {
            version: "1.0".to_string(),
            meeting_id: None,  // Will be set by backend
            meeting_name: Some(meeting_name.to_string()),
            created_at: chrono::Utc::now().to_rfc3339(),
            completed_at: None,
            duration_seconds: None,
            devices: DeviceInfo {
                microphone: None,  // Could be enhanced to store actual device names
                system_audio: None,
            },
            audio_file: if create_checkpoints { "audio.mp4".to_string() } else { "".to_string() },
            mic_audio_file: create_checkpoints.then(|| "mic.mp4".to_string()),
            system_audio_file: create_checkpoints.then(|| "system.mp4".to_string()),
            transcript_file: "transcripts.json".to_string(),
            sample_rate: 48000,
            status: "recording".to_string(),
        };

        // Write initial metadata.json
        self.write_metadata(&meeting_folder, &metadata)?;

        self.meeting_folder = Some(meeting_folder);
        self.metadata = Some(metadata);

        Ok(())
    }

    /// Write metadata.json to disk (atomic write with temp file)
    fn write_metadata(&self, folder: &PathBuf, metadata: &MeetingMetadata) -> Result<()> {
        let metadata_path = folder.join("metadata.json");
        let temp_path = folder.join(".metadata.json.tmp");

        let json_string = serde_json::to_string_pretty(metadata)?;
        std::fs::write(&temp_path, json_string)?;
        std::fs::rename(&temp_path, &metadata_path)?;  // Atomic

        Ok(())
    }

    /// Write transcripts.json to disk (atomic write with temp file and validation)
    fn write_transcripts_json(&self, folder: &PathBuf) -> Result<()> {
        // Clone segments to avoid holding lock during I/O
        let segments_clone = if let Ok(segments) = self.transcript_segments.lock() {
            segments.clone()
        } else {
            error!("Failed to lock transcript segments for writing");
            return Err(anyhow::anyhow!("Failed to lock transcript segments"));
        };

        info!("Writing {} transcript segments to JSON", segments_clone.len());

        let transcript_path = folder.join("transcripts.json");
        let temp_path = folder.join(".transcripts.json.tmp");

        // Create JSON structure
        let json = serde_json::json!({
            "version": "1.0",
            "segments": segments_clone,
            "last_updated": chrono::Utc::now().to_rfc3339(),
            "total_segments": segments_clone.len()
        });

        // Serialize to pretty JSON string
        let json_string = serde_json::to_string_pretty(&json)
            .map_err(|e| {
                error!("Failed to serialize transcripts to JSON: {}", e);
                anyhow::anyhow!("JSON serialization failed: {}", e)
            })?;

        // Write to temp file with error handling
        std::fs::write(&temp_path, &json_string)
            .map_err(|e| {
                error!("Failed to write transcript temp file to {}: {}", temp_path.display(), e);
                anyhow::anyhow!("Failed to write temp file: {}", e)
            })?;

        // Verify temp file was written correctly
        if !temp_path.exists() {
            error!("Temp transcript file does not exist after write: {}", temp_path.display());
            return Err(anyhow::anyhow!("Temp file verification failed"));
        }

        // Atomic rename
        std::fs::rename(&temp_path, &transcript_path)
            .map_err(|e| {
                error!("Failed to rename transcript file from {} to {}: {}",
                       temp_path.display(), transcript_path.display(), e);
                anyhow::anyhow!("Failed to rename transcript file: {}", e)
            })?;

        info!("✅ Successfully wrote transcripts.json with {} segments", segments_clone.len());
        Ok(())
    }

    pub fn get_stats(&self) -> (usize, u32) {
        if let Some(ref saver) = self.mixed_saver {
            if let Ok(guard) = saver.try_lock() {
                (guard.get_checkpoint_count() as usize, 48000)
            } else {
                (0, 48000)
            }
        } else {
            (0, 48000)
        }
    }

    /// Stop and save using incremental saving approach
    ///
    /// # Arguments
    /// * `app` - Tauri app handle for emitting events
    /// * `recording_duration` - Actual recording duration in seconds (from RecordingState)
    pub async fn stop_and_save<R: Runtime>(
        &mut self,
        app: &AppHandle<R>,
        recording_duration: Option<f64>
    ) -> Result<Option<String>, String> {
        info!("Stopping recording saver");

        // The pipeline has already stopped and dropped its sender. Drain every
        // queued track chunk before taking the saver locks for finalization.
        if let Ok(mut is_saving) = self.is_saving.lock() {
            *is_saving = false;
        }
        if let Some(handle) = self.accumulation_handle.take() {
            handle.await.map_err(|e| format!("Recording saver task failed: {e}"))?;
        }

        // Check if incremental saver exists (indicates auto_save was enabled)
        let should_save_audio = self.mixed_saver.is_some();

        if !should_save_audio {
            info!("⚠️  No audio saver initialized (auto-save was disabled) - skipping audio finalization");
            if let Some(folder) = &self.meeting_folder {
                self.write_transcripts_json(folder)
                    .map_err(|e| format!("Failed to save final transcripts: {e}"))?;
            }
            info!("✅ Final transcripts saved");
            return Ok(None);
        }

        // Finalize all tracks. Mixed is required; mic/system are best-effort
        // (one side may be silent the whole meeting).
        async fn finalize_track(
            saver: &Option<Arc<AsyncMutex<IncrementalAudioSaver>>>,
            label: &str,
            required: bool,
        ) -> Result<Option<PathBuf>, String> {
            let Some(saver_arc) = saver else {
                return if required {
                    Err(format!("No {label} saver initialized"))
                } else {
                    Ok(None)
                };
            };
            let mut guard = saver_arc.lock().await;
            match guard.finalize().await {
                Ok(path) => {
                    info!("✅ Finalized {label}: {}", path.display());
                    Ok(Some(path))
                }
                Err(e) => {
                    if required {
                        error!("❌ Failed to finalize {label}: {e}");
                        Err(format!("Failed to finalize {label}: {e}"))
                    } else {
                        warn!("⚠️ Optional track {label} not finalized: {e}");
                        Ok(None)
                    }
                }
            }
        }

        let final_audio_path = finalize_track(&self.mixed_saver, "audio (mixed)", true)
            .await?
            .ok_or_else(|| "Mixed audio path missing".to_string())?;
        let mic_audio_path = finalize_track(&self.mic_saver, "mic", false).await?;
        let system_audio_path = finalize_track(&self.system_saver, "system", false).await?;

        // Save final transcripts.json with validation
        if let Some(folder) = &self.meeting_folder {
            if let Err(e) = self.write_transcripts_json(folder) {
                error!("❌ Failed to write final transcripts: {}", e);
                return Err(format!("Failed to save transcripts: {}", e));
            }

            // Verify transcripts were written correctly
            let transcript_path = folder.join("transcripts.json");
            if !transcript_path.exists() {
                error!("❌ Transcript file was not created at: {}", transcript_path.display());
                return Err("Transcript file verification failed".to_string());
            }
            info!("✅ Transcripts saved and verified at: {}", transcript_path.display());
        }

        // Update metadata to completed status with actual recording duration
        if let (Some(folder), Some(mut metadata)) = (&self.meeting_folder, self.metadata.clone()) {
            metadata.status = "completed".to_string();
            metadata.completed_at = Some(chrono::Utc::now().to_rfc3339());
            metadata.mic_audio_file = mic_audio_path
                .as_ref()
                .map(|path| path.file_name().unwrap_or_default().to_string_lossy().into_owned());
            metadata.system_audio_file = system_audio_path
                .as_ref()
                .map(|path| path.file_name().unwrap_or_default().to_string_lossy().into_owned());

            // Use actual recording duration from RecordingState (more accurate than transcript segments)
            // Falls back to last transcript segment if duration not provided
            metadata.duration_seconds = recording_duration.or_else(|| {
                if let Ok(segments) = self.transcript_segments.lock() {
                    segments.last().map(|seg| seg.audio_end_time)
                } else {
                    None
                }
            });

            if let Err(e) = self.write_metadata(folder, &metadata) {
                error!("❌ Failed to update metadata to completed: {}", e);
                return Err(format!("Failed to update metadata: {}", e));
            }

            info!("✅ Metadata updated with duration: {:?}s", metadata.duration_seconds);
        }

        // Emit save event with audio and transcript paths
        let save_event = serde_json::json!({
            "audio_file": final_audio_path.to_string_lossy(),
            "transcript_file": self.meeting_folder.as_ref()
                .map(|f| f.join("transcripts.json").to_string_lossy().to_string()),
            "meeting_name": self.meeting_name,
            "meeting_folder": self.meeting_folder.as_ref()
                .map(|f| f.to_string_lossy().to_string())
        });

        if let Err(e) = app.emit("recording-saved", &save_event) {
            warn!("Failed to emit recording-saved event: {}", e);
        }

        // Clean up transcript segments
        if let Ok(mut segments) = self.transcript_segments.lock() {
            segments.clear();
        }

        Ok(Some(final_audio_path.to_string_lossy().to_string()))
    }

    /// Get the meeting folder path (for passing to backend)
    pub fn get_meeting_folder(&self) -> Option<&PathBuf> {
        self.meeting_folder.as_ref()
    }

    /// Get accumulated transcript segments (for reload sync)
    pub fn get_transcript_segments(&self) -> Vec<TranscriptSegment> {
        if let Ok(segments) = self.transcript_segments.lock() {
            segments.clone()
        } else {
            Vec::new()
        }
    }

    /// Get meeting name (for reload sync)
    pub fn get_meeting_name(&self) -> Option<String> {
        self.meeting_name.clone()
    }
}

impl Default for RecordingSaver {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(text: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: "seg_1".to_string(),
            text: text.to_string(),
            audio_start_time: 1.0,
            audio_end_time: 2.0,
            duration: 1.0,
            display_time: "[00:01]".to_string(),
            confidence: 0.9,
            sequence_id: 1,
            speaker: Some("You".to_string()),
        }
    }

    #[test]
    fn detached_transcript_handle_updates_recording_saver() {
        let saver = RecordingSaver::new();
        let handle = saver.transcript_segments_handle();

        RecordingSaver::upsert_transcript_segment(&handle, segment("first"));
        RecordingSaver::upsert_transcript_segment(&handle, segment("updated"));

        let segments = saver.get_transcript_segments();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "updated");
    }

    #[tokio::test]
    async fn accumulation_fails_before_accepting_chunks_when_save_root_is_invalid() {
        let temp = tempfile::tempdir().unwrap();
        let invalid_root = temp.path().join("not-a-directory");
        std::fs::write(&invalid_root, b"file").unwrap();

        let mut saver = RecordingSaver::new();
        saver.set_recordings_folder(invalid_root);
        saver.set_meeting_name(Some("Test meeting".to_string()));

        assert!(saver.start_accumulation(true).is_err());
    }
}

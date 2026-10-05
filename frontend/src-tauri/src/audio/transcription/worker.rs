//! Transcription worker pool: consumes VAD speech segments and produces
//! transcript lines, which are emitted to the UI as `transcript-update` events.
//!
//! ## Where the input comes from
//! Segments arrive from `AudioPipeline` and are **mixed** mic+system audio at
//! 16 kHz. Their `device_type` is a placeholder and carries no speaker
//! information — see the pipeline module docs.
//!
//! ## Speaker labelling
//! Each segment is labelled before being emitted:
//!
//! 1. **Live diarization** (preferred) — `crate::diarization::online` embeds the
//!    segment and matches it against voices heard so far, yielding
//!    "Speaker 1/2/3". Active only when the diarization models are installed.
//! 2. **Capture-source fallback** — reads `device_type`, which for mixed audio
//!    can only ever produce "You". Retained purely so transcripts still carry
//!    some label without the models.
//!
//! The label travels to the frontend as `TranscriptUpdate.source`, which
//! `TranscriptContext` maps onto `Transcript.speaker` for rendering. Running the
//! "Speakers" action on a finished meeting re-runs full offline diarization and
//! overwrites these live labels with more accurate ones.

use super::engine::TranscriptionEngine;
use super::provider::TranscriptionError;
use crate::audio::AudioChunk;
use crate::database::repositories::vocabulary::VocabularyRepository;
use crate::state::AppState;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime};

// Sequence counter for transcript updates
static SEQUENCE_COUNTER: AtomicU64 = AtomicU64::new(0);

// Speech detection flag - reset per recording session
static SPEECH_DETECTED_EMITTED: AtomicBool = AtomicBool::new(false);

/// Reset the speech detected flag for a new recording session
pub fn reset_speech_detected_flag() {
    SPEECH_DETECTED_EMITTED.store(false, Ordering::SeqCst);
    info!("🔍 SPEECH_DETECTED_EMITTED reset to: {}", SPEECH_DETECTED_EMITTED.load(Ordering::SeqCst));
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranscriptUpdate {
    pub text: String,
    pub timestamp: String, // Wall-clock time for reference (e.g., "14:30:05")
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_channel: Option<String>,
    pub sequence_id: u64,
    pub chunk_start_time: f64, // Legacy field, kept for compatibility
    pub is_partial: bool,
    pub confidence: f32,
    // NEW: Recording-relative timestamps for playback sync
    pub audio_start_time: f64, // Seconds from recording start (e.g., 125.3)
    pub audio_end_time: f64,   // Seconds from recording start (e.g., 128.6)
    pub duration: f64,          // Segment duration in seconds (e.g., 3.3)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<crate::database::models::WordTiming>>,
}

/// Final mic turns wait briefly for ASR from the aligned system source. The
/// pipeline often queues mic first, so an immediate emit cannot compare the
/// remote text. The pending queue and wait are bounded; stop flushes it.
struct LiveDuplicateFilter {
    system: VecDeque<(TranscriptUpdate, Vec<f32>)>,
    pending_mic: VecDeque<(TranscriptUpdate, Vec<f32>, std::time::Instant)>,
}

impl LiveDuplicateFilter {
    fn new() -> Self { Self { system: VecDeque::new(), pending_mic: VecDeque::new() } }

    fn duplicate(&self, mic: &TranscriptUpdate, mic_envelope: &[f32]) -> bool {
        self.system.iter().any(|(remote, system_envelope)| crate::audio::echo_guard::duplicated_mic_with_envelope(
            &mic.text, mic.audio_start_time, mic.audio_end_time, mic_envelope, mic.audio_start_time,
            &remote.text, remote.audio_start_time, remote.audio_end_time, system_envelope, remote.audio_start_time,
        ))
    }

    fn accept(&mut self, update: TranscriptUpdate, microphone: bool, envelope: Vec<f32>) -> Vec<TranscriptUpdate> {
        if microphone {
            if self.duplicate(&update, &envelope) { return Vec::new(); }
            if self.pending_mic.len() >= 4 {
                let oldest = self.pending_mic.pop_front().unwrap().0;
                self.pending_mic.push_back((update, envelope, std::time::Instant::now()));
                return vec![oldest];
            }
            self.pending_mic.push_back((update, envelope, std::time::Instant::now()));
            return Vec::new();
        }
        let newest_start = update.audio_start_time;
        self.system.push_back((update.clone(), envelope));
        while self.system.front().is_some_and(|(old, _)| old.audio_end_time < newest_start - 15.0) {
            self.system.pop_front();
        }
        let mut ready = vec![update];
        let mut waiting = VecDeque::new();
        while let Some((mic, mic_envelope, since)) = self.pending_mic.pop_front() {
            if self.duplicate(&mic, &mic_envelope) { continue; }
            if ready[0].audio_end_time >= mic.audio_end_time + 0.3 {
                ready.push(mic);
            } else {
                waiting.push_back((mic, mic_envelope, since));
            }
        }
        self.pending_mic = waiting;
        ready
    }

    fn flush_due(&mut self, force: bool) -> Vec<TranscriptUpdate> {
        let mut ready = Vec::new();
        while self.pending_mic.front().is_some_and(|(_, _, since)|
            force || since.elapsed() >= std::time::Duration::from_millis(800)) {
            let (mic, mic_envelope, _) = self.pending_mic.pop_front().unwrap();
            if !self.duplicate(&mic, &mic_envelope) { ready.push(mic); }
        }
        ready
    }
}

fn should_emit_transcript(transcript: &str, _confidence: Option<f32>) -> bool {
    let trimmed = transcript.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Content alone cannot distinguish a valid short reply from hallucination.
    true
}

#[cfg(test)]
mod playback_tests {
    use super::{LiveDuplicateFilter, TranscriptUpdate};

    fn turn(text: &str, source: &str, start: f64, end: f64) -> TranscriptUpdate {
        TranscriptUpdate {
            text: text.into(), timestamp: String::new(), source: source.into(), speaker_channel: None,
            sequence_id: 0, chunk_start_time: start, is_partial: false,
            confidence: 0.9, audio_start_time: start, audio_end_time: end,
            duration: end - start,
            words: None,
        }
    }

    #[test]
    fn delayed_system_turn_removes_duplicate_mic_but_keeps_local_speech() {
        let mut filter = LiveDuplicateFilter::new();
        let duplicate = turn("Lucky you're beautiful because there's nothing up here. What does he mean?", "You", 55.8, 60.88);
        assert!(filter.accept(duplicate, true, Vec::new()).is_empty());
        let remote = turn("Lucky you're beautiful because there's nothing up here. What? That's mean.", "Scarlett", 55.62, 60.73);
        assert_eq!(filter.accept(remote, false, Vec::new()).len(), 1);
        assert!(filter.flush_due(true).is_empty());

        let local = turn("I disagree because my microphone is on", "You", 65.0, 67.0);
        assert!(filter.accept(local, true, Vec::new()).is_empty());
        let retained = filter.flush_due(true);
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].source, "You");
    }
}

// NOTE: get_transcript_history and get_recording_meeting_name functions
// have been moved to recording_commands.rs where they have access to RECORDING_MANAGER

/// Optimized parallel transcription task ensuring ZERO chunk loss
pub fn start_transcription_task<R: Runtime>(
    app: AppHandle<R>,
    inputs: crate::audio::near_live::LiveTranscriptionInputs,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let crate::audio::near_live::LiveTranscriptionInputs {
            final_chunks: transcription_receiver,
            mut microphone_previews,
            mut system_previews,
        } = inputs;
        info!("🚀 Starting optimized parallel transcription task - guaranteeing zero chunk loss");

        let initial_prompt = match app.try_state::<AppState>() {
            Some(state) => match VocabularyRepository::get_effective(state.db_manager.pool(), None).await {
                Ok(prompt) => prompt,
                Err(error) => {
                    warn!("Failed to load Whisper vocabulary: {}", error);
                    None
                }
            },
            None => None,
        };

        // Initialize transcription engine (Whisper or Parakeet based on config)
        let transcription_engine = match super::engine::get_or_init_transcription_engine(&app).await {
            Ok(engine) => engine,
            Err(e) => {
                error!("Failed to initialize transcription engine: {}", e);
                let _ = app.emit("transcription-error", serde_json::json!({
                    "error": e,
                    "userMessage": "Recording failed: Unable to initialize speech recognition. Please check your model settings.",
                    "actionable": true
                }));
                return;
            }
        };

        // Create parallel workers for faster processing while preserving ALL chunks
        const NUM_WORKERS: usize = 1; // Serial processing ensures transcripts emit in chronological order
        let (work_sender, work_receiver) = tokio::sync::mpsc::unbounded_channel::<AudioChunk>();
        let work_receiver = Arc::new(tokio::sync::Mutex::new(work_receiver));

        // Track completion: AtomicU64 for chunks queued, AtomicU64 for chunks completed
        let chunks_queued = Arc::new(AtomicU64::new(0));
        let chunks_completed = Arc::new(AtomicU64::new(0));
        let input_finished = Arc::new(AtomicBool::new(false));

        // Provisional windows never enter the final transcript channel. One
        // decoder task shares the loaded Parakeet model, consumes only the
        // newest window per source, and yields whenever final chunks are queued.
        let preview_handle = match &transcription_engine {
            TranscriptionEngine::Parakeet(engine) if crate::audio::near_live::enabled() => {
                let engine = engine.clone();
                let app = app.clone();
                let queued = chunks_queued.clone();
                let completed = chunks_completed.clone();
                let finished = input_finished.clone();
                Some(tokio::spawn(async move {
                    let (mut mic_open, mut system_open) = (true, true);
                    while (mic_open || system_open) && !finished.load(Ordering::SeqCst) {
                        let preview = tokio::select! {
                            result = microphone_previews.changed(), if mic_open => {
                                if result.is_err() { mic_open = false; continue; }
                                microphone_previews.borrow_and_update().clone()
                            }
                            result = system_previews.changed(), if system_open => {
                                if result.is_err() { system_open = false; continue; }
                                system_previews.borrow_and_update().clone()
                            }
                        };
                        let Some(chunk) = preview else { continue; };
                        if queued.load(Ordering::SeqCst) > completed.load(Ordering::SeqCst) + 1 { continue; }
                        let source = match chunk.device_type {
                            crate::audio::recording_state::DeviceType::Microphone => "microphone",
                            crate::audio::recording_state::DeviceType::System => "system",
                            crate::audio::recording_state::DeviceType::Mixed => continue,
                        };
                        let start = chunk.timestamp;
                        let end = start + chunk.data.len() as f64 / 16_000.0;
                        let began = std::time::Instant::now();
                        match engine.transcribe_audio(chunk.data).await {
                            Ok(text) if !text.trim().is_empty()
                                && !finished.load(Ordering::SeqCst) => {
                                info!("Near-live {source} preview {:.2}-{:.2}s decoded in {}ms", start, end, began.elapsed().as_millis());
                                let _ = app.emit("near-live-caption", serde_json::json!({
                                    "source": source, "start_time": start,
                                    "end_time": end, "text": text.trim(),
                                }));
                            }
                            Err(error) => warn!("Near-live preview failed: {error}"),
                            _ => {}
                        }
                    }
                }))
            }
            _ => None,
        };

        info!("📊 Starting {} transcription worker{} (serial mode for ordered emission)", NUM_WORKERS, if NUM_WORKERS == 1 { "" } else { "s" });

        // Spawn worker tasks
        let mut worker_handles = Vec::new();
        for worker_id in 0..NUM_WORKERS {
            let engine_clone = match &transcription_engine {
                TranscriptionEngine::Whisper(e) => TranscriptionEngine::Whisper(e.clone()),
                TranscriptionEngine::Parakeet(e) => TranscriptionEngine::Parakeet(e.clone()),
                TranscriptionEngine::Provider(p) => TranscriptionEngine::Provider(p.clone()),
            };
            let app_clone = app.clone();
            let initial_prompt_clone = initial_prompt.clone();
            let work_receiver_clone = work_receiver.clone();
            let chunks_completed_clone = chunks_completed.clone();
            let input_finished_clone = input_finished.clone();
            let chunks_queued_clone = chunks_queued.clone();

            let worker_handle = tokio::spawn(async move {
                info!("👷 Worker {} started", worker_id);
                let mut duplicate_filter = crate::audio::echo_guard::enabled()
                    .then(LiveDuplicateFilter::new);

                // PRE-VALIDATE model state to avoid repeated async calls per chunk
                let initial_model_loaded = engine_clone.is_model_loaded().await;
                let current_model = engine_clone
                    .get_current_model()
                    .await
                    .unwrap_or_else(|| "unknown".to_string());

                let engine_name = engine_clone.provider_name();

                if initial_model_loaded {
                    info!(
                        "✅ Worker {} pre-validation: {} model '{}' is loaded and ready",
                        worker_id, engine_name, current_model
                    );
                } else {
                    warn!("⚠️ Worker {} pre-validation: {} model not loaded - chunks may be skipped", worker_id, engine_name);
                }

                loop {
                    // Try to get a chunk to process
                    let chunk = {
                        let mut receiver = work_receiver_clone.lock().await;
                        match tokio::time::timeout(std::time::Duration::from_millis(250), receiver.recv()).await {
                            Ok(chunk) => chunk,
                            Err(_) => {
                                if let Some(filter) = &mut duplicate_filter {
                                    for update in filter.flush_due(false) {
                                        let _ = app_clone.emit("transcript-update", &update);
                                    }
                                }
                                continue;
                            }
                        }
                    };

                    match chunk {
                        Some(chunk) => {
                            // PERFORMANCE OPTIMIZATION: Reduce logging in hot path
                            // Only log every 10th chunk per worker to reduce I/O overhead
                            let should_log_this_chunk = chunk.chunk_id % 10 == 0;

                            if should_log_this_chunk {
                                info!(
                                    "👷 Worker {} processing chunk {} with {} samples",
                                    worker_id,
                                    chunk.chunk_id,
                                    chunk.data.len()
                                );
                            }

                            // Check if model is still loaded before processing
                            if !engine_clone.is_model_loaded().await {
                                warn!("⚠️ Worker {}: Model unloaded, but continuing to preserve chunk {}", worker_id, chunk.chunk_id);
                                // Still count as completed even if we can't process
                                chunks_completed_clone.fetch_add(1, Ordering::SeqCst);
                                continue;
                            }

                            let chunk_timestamp = chunk.timestamp;
                            let chunk_duration = chunk.data.len() as f64 / chunk.sample_rate as f64;
                            let duplicate_envelope = duplicate_filter.as_ref()
                                .map(|_| crate::audio::echo_guard::rms_envelope(&chunk.data));
                            let capture_source = match &chunk.device_type {
                                crate::audio::recording_state::DeviceType::Microphone => "microphone",
                                crate::audio::recording_state::DeviceType::System => "system",
                                crate::audio::recording_state::DeviceType::Mixed => "mixed",
                            };

                            // Speaker label for this segment.
                            //
                            // Dual-path STT (AudioPipeline) sends mic and system as
                            // separate chunks with a real `device_type`. Mic audio is
                            // always the local user → "You" (UI substitutes their
                            // display name). System audio is remote parties →
                            // diarize into Speaker N when models are available.
                            crate::audio::common::mark_stt_activity();
                        let nemotron_remote = matches!(chunk.device_type, crate::audio::recording_state::DeviceType::System)
                            && crate::diarization::live_nemotron::active();
                        let profile_samples = nemotron_remote.then(|| chunk.data.clone());
                        let mut speaker_channel = None;
                        let mut chunk_source = match &chunk.device_type {
                                crate::audio::recording_state::DeviceType::Microphone => {
                                    // Still feed the online diarizer so it learns the
                                    // user's voice embedding for later offline refine.
                                    let _ = crate::diarization::online::assign_speaker(
                                        &chunk.data,
                                        true,
                                    );
                                    "You".to_string()
                                }
                                crate::audio::recording_state::DeviceType::System => {
                                    match crate::diarization::online::assign_speaker(
                                        &chunk.data,
                                        false,
                                    ) {
                                        Some(s) if s.is_user => {
                                            // System path shouldn't be the user; keep a speaker id.
                                            format!("Speaker {}", s.index + 1)
                                        }
                                        Some(s) => {
                                            let channel = format!("Speaker {}", s.index + 1);
                                            speaker_channel = Some(channel.clone());
                                            s.profile_name.unwrap_or(channel)
                                        },
                                        None => "Guest".to_string(),
                                    }
                                }
                                // Mixed is for disk only — never STT'd.
                                crate::audio::recording_state::DeviceType::Mixed => {
                                    chunks_completed_clone.fetch_add(1, Ordering::SeqCst);
                                    continue;
                                }
                            };

                            // Transcribe with provider-agnostic approach
                            match transcribe_chunk_with_provider(
                                &engine_clone,
                                chunk,
                                initial_prompt_clone.as_deref(),
                            )
                            .await
                            {
                            Ok((transcript, confidence_opt, is_partial, words_opt)) => {
                                if nemotron_remote {
                                    // Inference runs concurrently with ASR. Wait only for bounded
                                    // lookahead here, never on the capture or Tokio worker thread.
                                    let attribution = tokio::task::spawn_blocking(move || {
                                        let label = crate::diarization::live_nemotron::label(chunk_timestamp, chunk_duration)?;
                                        let name = profile_samples.as_deref()
                                            .and_then(|samples| crate::diarization::voice_profiles::name_live_nemotron_turn(&label, samples, chunk_timestamp));
                                        Some((name.unwrap_or_else(|| label.clone()), label))
                                    }).await.ok().flatten();
                                    if let Some((name, channel)) = attribution { chunk_source = name; speaker_channel = Some(channel); }
                                    else { chunk_source = "Guest".into(); }
                                }
                                    let confidence_str = match confidence_opt {
                                        Some(c) => format!("{:.2}", c),
                                        None => "N/A".to_string(),
                                    };

                                    info!("🔍 Worker {} transcription result: text='{}', confidence={}, partial={}",
                                          worker_id, transcript, confidence_str, is_partial);

                                    if should_emit_transcript(&transcript, confidence_opt) {
                                        // PERFORMANCE: Only log transcription results, not every processing step
                                        info!("✅ Worker {} transcribed: {} (confidence: {}, partial: {})",
                                              worker_id, transcript, confidence_str, is_partial);

                                        // Emit speech-detected event for frontend UX (only on first detection per session)
                                        // This is lightweight and provides better user feedback
                                        let current_flag = SPEECH_DETECTED_EMITTED.load(Ordering::SeqCst);
                                        info!("🔍 Checking speech-detected flag: current={}, will_emit={}", current_flag, !current_flag);

                                        if !current_flag {
                                            SPEECH_DETECTED_EMITTED.store(true, Ordering::SeqCst);
                                            match app_clone.emit("speech-detected", serde_json::json!({
                                                "message": "Speech activity detected"
                                            })) {
                                                Ok(_) => info!("🎤 ✅ First speech detected - successfully emitted speech-detected event"),
                                                Err(e) => error!("🎤 ❌ Failed to emit speech-detected event: {}", e),
                                            }
                                        } else {
                                            info!("🔍 Speech already detected in this session, not re-emitting");
                                        }

                                        // Generate sequence ID and calculate timestamps FIRST
                                        let sequence_id = SEQUENCE_COUNTER.fetch_add(1, Ordering::SeqCst);
                                        let audio_start_time = chunk_timestamp; // Already in seconds from recording start
                                        let audio_end_time = chunk_timestamp + chunk_duration;

                                        // Save structured transcript segment to recording manager (only final results)
                                        // Save ALL segments (partial and final) to ensure complete JSON
                                        // Create structured segment with full timestamp data
                                        // NOTE: This is now handled via the transcript-update event emission below
                                        // The recording_commands module listens to these events and saves them
                                        // This decouples the transcription worker from direct RECORDING_MANAGER access

                                        // Emit transcript update with NEW recording-relative timestamps

                                        let update = TranscriptUpdate {
                                            text: transcript,
                                            timestamp: format_current_timestamp(), // Wall-clock for reference
                                            source: chunk_source.clone(),
                                            speaker_channel: speaker_channel.clone(),
                                            sequence_id,
                                            chunk_start_time: chunk_timestamp, // Legacy compatibility
                                            is_partial,
                                            confidence: confidence_opt.unwrap_or(0.85), // Default for providers without confidence
                                            // NEW: Recording-relative timestamps for sync
                                            audio_start_time,
                                            audio_end_time,
                                            duration: chunk_duration,
                                            words: words_opt,
                                        };

                                        let updates = match &mut duplicate_filter {
                                            Some(filter) => {
                                                let mut u = filter.accept(update, capture_source == "microphone", duplicate_envelope.unwrap_or_default());
                                                u.extend(filter.flush_due(false));
                                                u
                                            }
                                            None => vec![update],
                                        };
                                        for update in updates {
                                            if let Err(e) = app_clone.emit("transcript-update", &update) {
                                                error!("Worker {}: Failed to emit transcript update: {}", worker_id, e);
                                            }
                                        }
                                        // PERFORMANCE: Removed verbose logging of every emission
                                    } else if !transcript.trim().is_empty() && should_log_this_chunk
                                    {
                                        // PERFORMANCE: Only log low-confidence results occasionally
                                        if let Some(c) = confidence_opt {
                                            info!("Worker {} low-confidence transcription (confidence: {:.2}), skipping", worker_id, c);
                                        }
                                    }
                                }
                                Err(e) => {
                                    // Improved error handling with specific cases
                                    match e {
                                        TranscriptionError::AudioTooShort { .. } => {
                                            // Skip silently, this is expected for very short chunks
                                            info!("Worker {}: {}", worker_id, e);
                                            let _ = app_clone.emit("near-live-finalized", serde_json::json!({
                                                "source": capture_source,
                                                "end_time": chunk_timestamp + chunk_duration,
                                            }));
                                            chunks_completed_clone.fetch_add(1, Ordering::SeqCst);
                                            continue;
                                        }
                                        TranscriptionError::ModelNotLoaded => {
                                            warn!("Worker {}: Model unloaded during transcription", worker_id);
                                            chunks_completed_clone.fetch_add(1, Ordering::SeqCst);
                                            continue;
                                        }
                                        _ => {
                                            warn!("Worker {}: Transcription failed: {}", worker_id, e);
                                            let _ = app_clone.emit("transcription-warning", e.to_string());
                                        }
                                    }
                                }
                            }

                            let _ = app_clone.emit("near-live-finalized", serde_json::json!({
                                "source": capture_source,
                                "end_time": chunk_timestamp + chunk_duration,
                            }));

                            // Mark chunk as completed
                            let completed =
                                chunks_completed_clone.fetch_add(1, Ordering::SeqCst) + 1;
                            let queued = chunks_queued_clone.load(Ordering::SeqCst);

                            // PERFORMANCE: Only log progress every 5th chunk to reduce I/O overhead
                            if completed % 5 == 0 || should_log_this_chunk {
                                info!(
                                    "Worker {}: Progress {}/{} chunks ({:.1}%)",
                                    worker_id,
                                    completed,
                                    queued,
                                    (completed as f64 / queued.max(1) as f64 * 100.0)
                                );
                            }

                            // Emit progress event for frontend
                            let progress_percentage = if queued > 0 {
                                (completed as f64 / queued as f64 * 100.0) as u32
                            } else {
                                100
                            };

                            let _ = app_clone.emit("transcription-progress", serde_json::json!({
                                "worker_id": worker_id,
                                "chunks_completed": completed,
                                "chunks_queued": queued,
                                "progress_percentage": progress_percentage,
                                "message": format!("Worker {} processing... ({}/{})", worker_id, completed, queued)
                            }));
                        }
                        None => {
                            // No more chunks available
                            if input_finished_clone.load(Ordering::SeqCst) {
                                // Double-check that all queued chunks are actually completed
                                let final_queued = chunks_queued_clone.load(Ordering::SeqCst);
                                let final_completed = chunks_completed_clone.load(Ordering::SeqCst);

                                if final_completed >= final_queued {
                                    if let Some(filter) = &mut duplicate_filter {
                                        for update in filter.flush_due(true) {
                                            let _ = app_clone.emit("transcript-update", &update);
                                        }
                                    }
                                    info!(
                                        "👷 Worker {} finishing - all {}/{} chunks processed",
                                        worker_id, final_completed, final_queued
                                    );
                                    break;
                                } else {
                                    warn!("👷 Worker {} detected potential chunk loss: {}/{} completed, waiting...", worker_id, final_completed, final_queued);
                                    // AGGRESSIVE POLLING: Reduced from 50ms to 5ms for faster chunk detection during shutdown
                                    tokio::time::sleep(tokio::time::Duration::from_millis(5)).await;
                                }
                            } else {
                                // AGGRESSIVE POLLING: Reduced from 10ms to 1ms for faster response during shutdown
                                tokio::time::sleep(tokio::time::Duration::from_millis(1)).await;
                            }
                        }
                    }
                }

                info!("👷 Worker {} completed", worker_id);
            });

            worker_handles.push(worker_handle);
        }

        // Main dispatcher: receive chunks and distribute to workers
        let mut receiver = transcription_receiver;
        while let Some(chunk) = receiver.recv().await {
            let queued = chunks_queued.fetch_add(1, Ordering::SeqCst) + 1;
            info!(
                "📥 Dispatching chunk {} to workers (total queued: {})",
                chunk.chunk_id, queued
            );

            if let Err(_) = work_sender.send(chunk) {
                error!("❌ Failed to send chunk to workers - this should not happen!");
                break;
            }
        }

        // Signal that input is finished
        input_finished.store(true, Ordering::SeqCst);
        if let Some(handle) = preview_handle { let _ = handle.await; }
        drop(work_sender); // Close the channel to signal workers

        let total_chunks_queued = chunks_queued.load(Ordering::SeqCst);
        info!("📭 Input finished with {} total chunks queued. Waiting for all {} workers to complete...",
              total_chunks_queued, NUM_WORKERS);

        // Emit final chunk count to frontend
        let _ = app.emit("transcription-queue-complete", serde_json::json!({
            "total_chunks": total_chunks_queued,
            "message": format!("{} chunks queued for processing - waiting for completion", total_chunks_queued)
        }));

        // Wait for all workers to complete
        for (worker_id, handle) in worker_handles.into_iter().enumerate() {
            if let Err(e) = handle.await {
                error!("❌ Worker {} panicked: {:?}", worker_id, e);
            } else {
                info!("✅ Worker {} completed successfully", worker_id);
            }
        }

        // Final verification with retry logic to catch any stragglers
        let mut verification_attempts = 0;
        const MAX_VERIFICATION_ATTEMPTS: u32 = 10;

        loop {
            let final_queued = chunks_queued.load(Ordering::SeqCst);
            let final_completed = chunks_completed.load(Ordering::SeqCst);

            if final_queued == final_completed {
                info!(
                    "🎉 ALL {} chunks processed successfully - ZERO chunks lost!",
                    final_completed
                );
                break;
            } else if verification_attempts < MAX_VERIFICATION_ATTEMPTS {
                verification_attempts += 1;
                warn!("⚠️ Chunk count mismatch (attempt {}): {} queued, {} completed - waiting for stragglers...",
                     verification_attempts, final_queued, final_completed);

                // Wait a bit for any remaining chunks to be processed
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            } else {
                error!(
                    "❌ CRITICAL: After {} attempts, chunk loss detected: {} queued, {} completed",
                    MAX_VERIFICATION_ATTEMPTS, final_queued, final_completed
                );

                // Emit critical error event
                let _ = app.emit(
                    "transcript-chunk-loss-detected",
                    serde_json::json!({
                        "chunks_queued": final_queued,
                        "chunks_completed": final_completed,
                        "chunks_lost": final_queued - final_completed,
                        "message": "Some transcript chunks may have been lost during shutdown"
                    }),
                );
                break;
            }
        }

        info!("✅ Parallel transcription task completed - all workers finished, ready for model unload");
    })
}

/// Transcribe audio chunk using the appropriate provider (Whisper, Parakeet, or trait-based)
/// Returns: (text, confidence Option, is_partial, words Option)
async fn transcribe_chunk_with_provider(
    engine: &TranscriptionEngine,
    chunk: AudioChunk,
    initial_prompt: Option<&str>,
) -> std::result::Result<(String, Option<f32>, bool, Option<Vec<crate::database::models::WordTiming>>), TranscriptionError> {
    // Convert to 16kHz mono for transcription
    let transcription_data = if chunk.sample_rate != 16000 {
        crate::audio::audio_processing::resample_audio(&chunk.data, chunk.sample_rate, 16000)
    } else {
        chunk.data
    };

    // Skip VAD processing here since the pipeline already extracted speech using VAD
    let speech_samples = transcription_data;

    // Check for empty samples - improved error handling
    if speech_samples.is_empty() {
        warn!(
            "Audio chunk {} is empty, skipping transcription",
            chunk.chunk_id
        );
        return Err(TranscriptionError::AudioTooShort {
            samples: 0,
            minimum: 1600, // 100ms at 16kHz
        });
    }

    // Calculate energy
    let energy: f32 =
        speech_samples.iter().map(|&x| x * x).sum::<f32>() / speech_samples.len() as f32;
    let rms = energy.sqrt();
    let peak = speech_samples.iter().fold(0.0f32, |m, &x| m.max(x.abs()));

    // Skip silent chunks to avoid Whisper silence hallucinations
    if peak == 0.0 {
        info!(
            "Audio chunk {} has near-zero energy (rms: {:.6}, peak: {:.6}), skipping transcription",
            chunk.chunk_id, rms, peak
        );
        return Ok((String::new(), Some(1.0), false, None));
    }

    info!(
        "Processing speech audio chunk {} with {} samples (rms: {:.6}, peak: {:.6})",
        chunk.chunk_id,
        speech_samples.len(),
        rms,
        peak
    );

    // Transcribe using the appropriate engine (with improved error handling)
    match engine {
        TranscriptionEngine::Whisper(whisper_engine) => {
            // Get language preference from global state
            let language = crate::get_language_preference_internal();

            match whisper_engine
                .transcribe_audio_with_words(speech_samples, language, initial_prompt, chunk.timestamp)
                .await
            {
                Ok((text, confidence, is_partial, words)) => {
                    let cleaned_text = text.trim().to_string();
                    if cleaned_text.is_empty() {
                        return Ok((String::new(), Some(confidence), is_partial, None));
                    }

                    // Quiet replies such as "you" and "thanks" remain valid speech.
                    // Native no-speech checks own rejection, not a phrase blacklist.

                    info!(
                        "Whisper transcription complete for chunk {}: '{}' (confidence: {:.2}, partial: {})",
                        chunk.chunk_id, cleaned_text, confidence, is_partial
                    );

                    Ok((cleaned_text, Some(confidence), is_partial, words))
                }
                Err(e) => {
                    error!(
                        "Whisper transcription failed for chunk {}: {}",
                        chunk.chunk_id, e
                    );

                    let transcription_error = TranscriptionError::EngineFailed(e.to_string());
                    Err(transcription_error)
                }
            }
        }
        TranscriptionEngine::Parakeet(parakeet_engine) => {
            if crate::audio::word_timestamps::enabled() {
                match parakeet_engine.transcribe_audio_with_words(speech_samples, chunk.timestamp).await {
                    Ok((text, words)) => {
                        let cleaned_text = text.trim().to_string();
                        if cleaned_text.is_empty() {
                            return Ok((String::new(), None, false, None));
                        }

                        info!(
                            "Parakeet transcription complete for chunk {}: '{}' ({} words)",
                            chunk.chunk_id, cleaned_text, words.len()
                        );

                        Ok((cleaned_text, None, false, Some(words)))
                    }
                    Err(e) => {
                        error!(
                            "Parakeet transcription failed for chunk {}: {}",
                            chunk.chunk_id, e
                        );

                        let transcription_error = TranscriptionError::EngineFailed(e.to_string());
                        Err(transcription_error)
                    }
                }
            } else {
                match parakeet_engine.transcribe_audio(speech_samples).await {
                    Ok(text) => {
                        let cleaned_text = text.trim().to_string();
                        if cleaned_text.is_empty() {
                            return Ok((String::new(), None, false, None));
                        }

                        info!(
                            "Parakeet transcription complete for chunk {}: '{}'",
                            chunk.chunk_id, cleaned_text
                        );

                        // Parakeet doesn't provide confidence or partial results
                        Ok((cleaned_text, None, false, None))
                    }
                    Err(e) => {
                        error!(
                            "Parakeet transcription failed for chunk {}: {}",
                            chunk.chunk_id, e
                        );

                        let transcription_error = TranscriptionError::EngineFailed(e.to_string());
                        Err(transcription_error)
                    }
                }
            }
        }
        TranscriptionEngine::Provider(provider) => {
            // NEW: Trait-based provider (clean, unified interface)
            let language = crate::get_language_preference_internal();

            match provider.transcribe(speech_samples, language).await {
                Ok(result) => {
                    let cleaned_text = result.text.trim().to_string();
                    if cleaned_text.is_empty() {
                        return Ok((String::new(), result.confidence, result.is_partial, None));
                    }

                    let confidence_str = match result.confidence {
                        Some(c) => format!("confidence: {:.2}", c),
                        None => "no confidence".to_string(),
                    };

                    info!(
                        "{} transcription complete for chunk {}: '{}' ({}, partial: {})",
                        provider.provider_name(),
                        chunk.chunk_id,
                        cleaned_text,
                        confidence_str,
                        result.is_partial
                    );

                    Ok((cleaned_text, result.confidence, result.is_partial, result.words))
                }
                Err(e) => {
                    error!(
                        "{} transcription failed for chunk {}: {}",
                        provider.provider_name(),
                        chunk.chunk_id,
                        e
                    );
                    Err(e)
                }
            }
        }
    }
}

/// Format current timestamp (wall-clock time)
fn format_current_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();

    let hours = (now.as_secs() / 3600) % 24;
    let minutes = (now.as_secs() / 60) % 60;
    let seconds = now.as_secs() % 60;

    format!("{:02}:{:02}:{:02}", hours, minutes, seconds)
}

/// Format recording-relative time as [MM:SS]
#[allow(dead_code)]
fn format_recording_time(seconds: f64) -> String {
    let total_seconds = seconds.floor() as u64;
    let minutes = total_seconds / 60;
    let secs = total_seconds % 60;

    format!("[{:02}:{:02}]", minutes, secs)
}

#[cfg(test)]
mod tests {
    use super::should_emit_transcript;

    #[test]
    fn short_transcript_is_not_rejected_by_placeholder_confidence() {
        assert!(should_emit_transcript("yes", Some(0.13)));
        assert!(should_emit_transcript("you", Some(0.13)));
        assert!(should_emit_transcript("You.", Some(0.9)));
        assert!(should_emit_transcript("thanks", None));
        assert!(!should_emit_transcript("   ", Some(0.9)));
    }
}

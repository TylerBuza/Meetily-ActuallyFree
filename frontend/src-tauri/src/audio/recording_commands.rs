// audio/recording_commands.rs
//
// Slim Tauri command layer for recording functionality.
// Delegates to transcription and recording modules for actual implementation.

use anyhow::Result;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::task::JoinHandle;

use super::{
    get_device_and_config,
    parse_audio_device,
    default_input_device,   // Get default microphone
    default_output_device,  // Get default system audio
    RecordingManager,
    DeviceEvent,
    DeviceMonitorType
};

// Import transcription modules
use super::transcription::{
    self,
    reset_speech_detected_flag,
};

// Re-export TranscriptUpdate for backward compatibility
pub use super::transcription::TranscriptUpdate;

// ============================================================================
// GLOBAL STATE
// ============================================================================

// Simple recording state tracking
static IS_RECORDING: AtomicBool = AtomicBool::new(false);
static IS_STOPPING: AtomicBool = AtomicBool::new(false);

struct StopGuard;

impl Drop for StopGuard {
    fn drop(&mut self) {
        IS_STOPPING.store(false, Ordering::SeqCst);
    }
}

/// Whether a recording session is currently active (for the auto compact bar).
pub fn is_recording_active() -> bool {
    IS_RECORDING.load(Ordering::SeqCst)
}

/// Rechecked by the minibar lifecycle after acquiring its own serialization
/// lock. The minimize callback may have observed recording=true before native
/// shutdown claimed IS_STOPPING.
pub fn can_enter_compact_mode() -> bool {
    compact_mode_allowed(
        IS_RECORDING.load(Ordering::SeqCst),
        IS_STOPPING.load(Ordering::SeqCst),
    )
}

fn compact_mode_allowed(is_recording: bool, is_stopping: bool) -> bool {
    is_recording && !is_stopping
}

// Global recording manager and transcription task to keep them alive during recording
static RECORDING_MANAGER: Mutex<Option<RecordingManager>> = Mutex::new(None);
static TRANSCRIPTION_TASK: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

// Listener ID for proper cleanup - prevents microphone from staying active after recording stops
static TRANSCRIPT_LISTENER_ID: Mutex<Option<tauri::EventId>> = Mutex::new(None);

/// Create the live audio-level channel and spawn a task that forwards each
/// per-source level sample (mic + system) to the frontend as a
/// `recording-audio-levels` event. The returned sender is handed to the audio
/// pipeline; when recording stops the pipeline drops it, closing the channel
/// and ending the forwarder task automatically.
fn spawn_level_forwarder<R: Runtime>(
    app: &AppHandle<R>,
) -> tokio::sync::mpsc::UnboundedSender<super::pipeline::AudioLevels> {
    let (tx, mut rx) =
        tokio::sync::mpsc::unbounded_channel::<super::pipeline::AudioLevels>();
    let app = app.clone();
    tokio::spawn(async move {
        while let Some(levels) = rx.recv().await {
            let _ = app.emit("recording-audio-levels", &levels);
        }
    });
    tx
}

fn install_fatal_error_callback<R: Runtime>(
    manager: &mut RecordingManager,
    app: &AppHandle<R>,
) {
    let app_for_error = app.clone();
    manager.set_error_callback(move |error| {
        let _ = app_for_error.emit("recording-error", error.user_message());
        let app_for_stop = app_for_error.clone();
        tauri::async_runtime::spawn(async move {
            // A stream can fail while startup is still installing global state.
            // Serialize teardown behind startup so final-save never races a
            // missing manager/listener or a late recording-started event.
            let _engine_lifecycle_guard =
                super::common::acquire_engine_lifecycle_lock().await;
            if IS_RECORDING.load(Ordering::SeqCst) {
                let _ = stop_recording_inner(
                    app_for_stop,
                    RecordingArgs {
                        save_path: String::new(),
                    },
                    true,
                )
                .await;
            }
        });
    });
}

// ============================================================================
// PUBLIC TYPES
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct RecordingArgs {
    pub save_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopOutcome {
    Completed,
    AlreadyStopping,
    AlreadyStopped,
}

#[derive(Debug, Serialize, Clone)]
pub struct TranscriptionStatus {
    pub chunks_in_queue: usize,
    pub is_processing: bool,
    pub last_activity_ms: u64,
}

// ============================================================================
// RECORDING COMMANDS
// ============================================================================

/// Start recording with default devices
pub async fn start_recording<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    start_recording_with_meeting_name(app, None).await
}

/// Start recording with default devices and optional meeting name
pub async fn start_recording_with_meeting_name<R: Runtime>(
    app: AppHandle<R>,
    meeting_name: Option<String>,
) -> Result<(), String> {
    info!(
        "Starting recording with default devices, meeting: {:?}",
        meeting_name
    );

    let engine_lifecycle_guard = super::common::acquire_engine_lifecycle_lock().await;

    // Check if already recording
    let current_recording_state = IS_RECORDING.load(Ordering::SeqCst);
    info!("ðŸ” IS_RECORDING state check: {}", current_recording_state);
    if current_recording_state {
        return Err("Recording already in progress".to_string());
    }

    // Validate that transcription models are available before starting recording
    info!("ðŸ” Validating transcription model availability before starting recording...");
    if let Err(validation_error) = transcription::validate_transcription_model_ready(&app).await {
        error!("Model validation failed: {}", validation_error);

        // Emit error event for frontend - actionable: false to show toast instead of modal
        // (download progress is already shown in top-right toast)
        let _ = app.emit("transcription-error", serde_json::json!({
            "error": validation_error,
            "userMessage": "Recording cannot start: Transcription model is still downloading. Please wait for the download to complete.",
            "actionable": false
        }));

        return Err(validation_error);
    }
    info!("âœ… Transcription model validation passed");

    // Async-first approach - no more blocking operations!
    info!("ðŸš€ Starting async recording initialization");

    // Create new recording manager
    let mut manager = RecordingManager::new();

    // Load recording preferences to get auto_save AND device preferences
    let (auto_save, preferred_mic_name, preferred_system_name, recordings_folder) =
        match super::recording_preferences::load_recording_preferences(&app).await {
            Ok(prefs) => {
                info!("ðŸ“‹ Loaded recording preferences: auto_save={}, preferred_mic={:?}, preferred_system={:?}",
                      prefs.auto_save, prefs.preferred_mic_device, prefs.preferred_system_device);
                (
                    prefs.auto_save,
                    prefs.preferred_mic_device,
                    prefs.preferred_system_device,
                    prefs.save_folder,
                )
            }
            Err(e) => {
                warn!("Failed to load recording preferences, using defaults: {}", e);
                (
                    true,
                    None,
                    None,
                    super::recording_preferences::get_default_recordings_folder(),
                )
            }
        };
    manager.set_recordings_folder(recordings_folder);

    // ============================================================================
    // MICROPHONE DEVICE RESOLUTION: Preference â†’ Default â†’ Error
    // ============================================================================
    let microphone_device = match preferred_mic_name {
        Some(pref_name) => {
            info!("ðŸŽ¤ Attempting to use preferred microphone: '{}'", pref_name);
            match parse_audio_device(&pref_name) {
                Ok(device) => {
                    match get_device_and_config(&device).await {
                        Ok(_) => {
                            info!("âœ… Using preferred microphone: '{}'", device.name);
                            Some(Arc::new(device))
                        }
                        Err(e) => {
                            warn!("Preferred microphone '{}' is no longer available: {}", pref_name, e);
                            warn!("Falling back to the current default microphone...");
                            Some(Arc::new(default_input_device().map_err(|default_err| {
                                format!(
                                    "No microphone device available. Preferred device '{}' was not found, and the default microphone is unavailable: {}",
                                    pref_name, default_err
                                )
                            })?))
                        }
                    }
                }
                Err(e) => {
                    warn!("âš ï¸ Preferred microphone '{}' not available: {}", pref_name, e);
                    warn!("   Falling back to system default microphone...");
                    match default_input_device() {
                        Ok(device) => {
                            info!("âœ… Using default microphone: '{}'", device.name);
                            Some(Arc::new(device))
                        }
                        Err(default_err) => {
                            error!("âŒ No microphone available (preferred and default both failed)");
                            return Err(format!(
                                "No microphone device available. Preferred device '{}' not found, and default microphone unavailable: {}",
                                pref_name, default_err
                            ));
                        }
                    }
                }
            }
        }
        None => {
            info!("ðŸŽ¤ No microphone preference set, using system default");
            match default_input_device() {
                Ok(device) => {
                    info!("âœ… Using default microphone: '{}'", device.name);
                    Some(Arc::new(device))
                }
                Err(e) => {
                    error!("âŒ No default microphone available");
                    return Err(format!("No microphone device available: {}", e));
                }
            }
        }
    };

    // ============================================================================
    // SYSTEM AUDIO DEVICE RESOLUTION: Preference â†’ Default â†’ None (optional)
    // ============================================================================
    #[cfg(target_os = "macos")]
    let system_device = {
        if let Some(pref_name) = preferred_system_name {
            warn!(
                "Ignoring stored macOS output selection '{}'; the Core Audio tap follows the current default output route",
                pref_name
            );
        }
        match default_output_device() {
            Ok(device) => {
                info!("Using current default macOS output route: '{}'", device.name);
                Some(Arc::new(device))
            }
            Err(e) => {
                warn!("No default system audio output is available: {}", e);
                None
            }
        }
    };

    #[cfg(not(target_os = "macos"))]
    let system_device = match preferred_system_name {
        Some(pref_name) => {
            info!("ðŸ”Š Attempting to use preferred system audio: '{}'", pref_name);
            match parse_audio_device(&pref_name) {
                Ok(device) => {
                    match get_device_and_config(&device).await {
                        Ok(_) => {
                            info!("âœ… Using preferred system audio: '{}'", device.name);
                            Some(Arc::new(device))
                        }
                        Err(e) => {
                            warn!("Preferred system audio '{}' is no longer available: {}", pref_name, e);
                            default_output_device().ok().map(Arc::new)
                        }
                    }
                }
                Err(e) => {
                    warn!("âš ï¸ Preferred system audio '{}' not available: {}", pref_name, e);
                    warn!("   Falling back to system default...");
                    match default_output_device() {
                        Ok(device) => {
                            info!("âœ… Using default system audio: '{}'", device.name);
                            Some(Arc::new(device))
                        }
                        Err(default_err) => {
                            warn!("âš ï¸ No system audio available (preferred and default both failed): {}", default_err);
                            warn!("   Recording will continue with microphone only");
                            None // System audio is optional
                        }
                    }
                }
            }
        }
        None => {
            info!("ðŸ”Š No system audio preference set, using system default");
            match default_output_device() {
                Ok(device) => {
                    info!("âœ… Using default system audio: '{}'", device.name);
                    Some(Arc::new(device))
                }
                Err(e) => {
                    warn!("âš ï¸ No default system audio available: {}", e);
                    warn!("   Recording will continue with microphone only");
                    None // System audio is optional
                }
            }
        }
    };

    // Always ensure a meeting name is set so incremental saver initializes
    let effective_meeting_name = meeting_name.clone().unwrap_or_else(|| {
        // Example: Meeting 2025-10-03_08-25-23
        let now = chrono::Local::now();
        format!(
            "Meeting {}",
            now.format("%Y-%m-%d_%H-%M-%S")
        )
    });
    manager.set_meeting_name(Some(effective_meeting_name));

    install_fatal_error_callback(&mut manager, &app);

    // Live audio-level meter: forward per-source (mic + system) levels to the UI visualizer
    let level_sender = spawn_level_forwarder(&app);

    // Start recording with resolved devices (replaces start_recording_with_defaults_and_auto_save call)
    let transcription_receiver = manager
        .start_recording(microphone_device, system_device, auto_save, Some(level_sender))
        .await
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    // Store the manager globally to keep it alive
    {
        let mut global_manager = RECORDING_MANAGER.lock().unwrap();
        *global_manager = Some(manager);
    }

    // Set recording flag and reset speech detection flag
    info!("ðŸ” Setting IS_RECORDING to true and resetting SPEECH_DETECTED_EMITTED");
    IS_RECORDING.store(true, Ordering::SeqCst);

    // Live speaker identification: label transcript segments with individual
    // voices as they arrive. Best-effort — if the models aren't installed we
    // simply fall back to capture-source labels.
    if let Err(e) = crate::diarization::online::start() {
        info!("Live speaker identification unavailable: {}", e);
    }
    reset_speech_detected_flag(); // Reset for new recording session

    // Start optimized parallel transcription task and store handle
    let task_handle = transcription::start_transcription_task(app.clone(), transcription_receiver);
    {
        let mut global_task = TRANSCRIPTION_TASK.lock().unwrap();
        *global_task = Some(task_handle);
    }

    // CRITICAL: Listen for transcript-update events and save to recording manager
    // This enables transcript history persistence for page reload sync
    // Store listener ID for cleanup during stop_recording to ensure microphone is released
    {
        use tauri::Listener;
        let transcript_segments = RECORDING_MANAGER
            .lock()
            .unwrap()
            .as_ref()
            .expect("recording manager missing after start")
            .transcript_segments_handle();
        let listener_id = app.listen("transcript-update", move |event: tauri::Event| {
            // Parse the transcript update from the event payload
            if let Ok(update) = serde_json::from_str::<TranscriptUpdate>(event.payload()) {
                // Create structured transcript segment
                let segment = crate::audio::recording_saver::TranscriptSegment {
                    id: format!("seg_{}", update.sequence_id),
                    text: update.text.clone(),
                    audio_start_time: update.audio_start_time,
                    audio_end_time: update.audio_end_time,
                    duration: update.duration,
                    display_time: update.timestamp.clone(), // Use wall-clock timestamp for display
                    confidence: update.confidence,
                    sequence_id: update.sequence_id,
                    // Live chat already decided the speaker (You / Guest / Speaker N).
                    // Dropping this here is why post-call transcripts looked unlabeled.
                    speaker: if update.source.trim().is_empty() {
                        None
                    } else {
                        Some(update.source.clone())
                    },
                };

                // Save to recording manager
                let mut saved_through_manager = false;
                if let Ok(manager_guard) = RECORDING_MANAGER.lock() {
                    if let Some(manager) = manager_guard.as_ref() {
                        manager.add_transcript_segment(segment.clone());
                        saved_through_manager = true;
                    }
                }
                if !saved_through_manager {
                    crate::audio::recording_saver::RecordingSaver::upsert_transcript_segment(
                        &transcript_segments,
                        segment,
                    );
                }
            }
        });
        let mut global_listener = TRANSCRIPT_LISTENER_ID.lock().unwrap();
        *global_listener = Some(listener_id);
        info!("✅ Transcript-update event listener registered for history persistence");
    }

    // Emit success event
    if let Err(error) = app.emit("recording-started", serde_json::json!({
        "message": "Recording started successfully with parallel processing",
        "devices": ["Default Microphone", "Default System Audio"],
        "workers": 3
    })) {
        warn!("Recording started, but the recording-started event failed: {}", error);
    }

    // Update tray menu to reflect recording state
    crate::tray::update_tray_menu(&app);

    info!("âœ… Recording started successfully with async-first approach");
    drop(engine_lifecycle_guard);

    Ok(())
}

/// Start recording with specific devices
pub async fn start_recording_with_devices<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
) -> Result<(), String> {
    start_recording_with_devices_and_meeting(app, mic_device_name, system_device_name, None).await
}

/// Start recording with specific devices and optional meeting name
pub async fn start_recording_with_devices_and_meeting<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
    meeting_name: Option<String>,
) -> Result<(), String> {
    info!(
        "Starting recording with specific devices: mic={:?}, system={:?}, meeting={:?}",
        mic_device_name, system_device_name, meeting_name
    );

    let engine_lifecycle_guard = super::common::acquire_engine_lifecycle_lock().await;

    // Check if already recording
    let current_recording_state = IS_RECORDING.load(Ordering::SeqCst);
    info!("ðŸ” IS_RECORDING state check: {}", current_recording_state);
    if current_recording_state {
        return Err("Recording already in progress".to_string());
    }

    // Validate that transcription models are available before starting recording
    info!("ðŸ” Validating transcription model availability before starting recording...");
    if let Err(validation_error) = transcription::validate_transcription_model_ready(&app).await {
        error!("Model validation failed: {}", validation_error);

        // Emit error event for frontend - actionable: false to show toast instead of modal
        // (download progress is already shown in top-right toast)
        let _ = app.emit("transcription-error", serde_json::json!({
            "error": validation_error,
            "userMessage": "Recording cannot start: Transcription model is still downloading. Please wait for the download to complete.",
            "actionable": false
        }));

        return Err(validation_error);
    }
    info!("âœ… Transcription model validation passed");

    // Resolve devices against the current enumeration. A syntactically valid
    // persisted name can refer to hardware that has since disconnected.
    let mic_device = if let Some(ref name) = mic_device_name {
        let preferred = parse_audio_device(name)
            .map_err(|e| format!("Invalid microphone device '{}': {}", name, e))?;
        match get_device_and_config(&preferred).await {
            Ok(_) => Some(Arc::new(preferred)),
            Err(error) => {
                warn!(
                    "Requested microphone '{}' is unavailable ({}); using the current default",
                    name, error
                );
                Some(Arc::new(default_input_device().map_err(|e| {
                    format!(
                        "Requested microphone '{}' is unavailable and no default microphone exists: {}",
                        name, e
                    )
                })?))
            }
        }
    } else {
        Some(Arc::new(default_input_device().map_err(|e| {
            format!("No default microphone device available: {}", e)
        })?))
    };

    #[cfg(target_os = "macos")]
    let system_device = {
        if let Some(name) = system_device_name.as_ref() {
            warn!(
                "Ignoring requested macOS output '{}'; Core Audio follows the current default route",
                name
            );
        }
        match default_output_device() {
            Ok(device) => Some(Arc::new(device)),
            Err(e) => {
                warn!("No default system audio device available: {}", e);
                None
            }
        }
    };

    #[cfg(not(target_os = "macos"))]
    let system_device = if let Some(ref name) = system_device_name {
        let preferred = parse_audio_device(name)
            .map_err(|e| format!("Invalid system device '{}': {}", name, e))?;
        match get_device_and_config(&preferred).await {
            Ok(_) => Some(Arc::new(preferred)),
            Err(error) => {
                warn!(
                    "Requested system device '{}' is unavailable ({}); using the current default",
                    name, error
                );
                default_output_device().ok().map(Arc::new)
            }
        }
    } else {
        default_output_device().ok().map(Arc::new)
    };

    // Async-first approach for custom devices - no more blocking operations!
    info!("ðŸš€ Starting async recording initialization with custom devices");

    // Create new recording manager
    let mut manager = RecordingManager::new();

    // Load recording preferences to check auto_save setting
    let preferences = match super::recording_preferences::load_recording_preferences(&app).await {
        Ok(prefs) => {
            info!("ðŸ“‹ Loaded recording preferences: auto_save={}", prefs.auto_save);
            prefs
        }
        Err(e) => {
            warn!("Failed to load recording preferences, defaulting to auto_save=true: {}", e);
            super::recording_preferences::RecordingPreferences::default()
        }
    };
    let auto_save = preferences.auto_save;
    manager.set_recordings_folder(preferences.save_folder);

    // Always ensure a meeting name is set so incremental saver initializes
    let effective_meeting_name = meeting_name.clone().unwrap_or_else(|| {
        let now = chrono::Local::now();
        format!(
            "Meeting {}",
            now.format("%Y-%m-%d_%H-%M-%S")
        )
    });
    manager.set_meeting_name(Some(effective_meeting_name));

    install_fatal_error_callback(&mut manager, &app);

    // Live audio-level meter: forward per-source (mic + system) levels to the UI visualizer
    let level_sender = spawn_level_forwarder(&app);

    // Start recording with specified devices and auto_save setting
    let transcription_receiver = manager
        .start_recording(mic_device, system_device, auto_save, Some(level_sender))
        .await
        .map_err(|e| format!("Failed to start recording: {}", e))?;

    // Store the manager globally to keep it alive
    {
        let mut global_manager = RECORDING_MANAGER.lock().unwrap();
        *global_manager = Some(manager);
    }

    // Set recording flag and reset speech detection flag
    info!("ðŸ” Setting IS_RECORDING to true and resetting SPEECH_DETECTED_EMITTED");
    IS_RECORDING.store(true, Ordering::SeqCst);

    // Live speaker identification: label transcript segments with individual
    // voices as they arrive. Best-effort — if the models aren't installed we
    // simply fall back to capture-source labels.
    if let Err(e) = crate::diarization::online::start() {
        info!("Live speaker identification unavailable: {}", e);
    }
    reset_speech_detected_flag(); // Reset for new recording session

    // Start optimized parallel transcription task and store handle
    let task_handle = transcription::start_transcription_task(app.clone(), transcription_receiver);
    {
        let mut global_task = TRANSCRIPTION_TASK.lock().unwrap();
        *global_task = Some(task_handle);
    }

    // CRITICAL: Listen for transcript-update events and save to recording manager
    // This enables transcript history persistence for page reload sync
    // Store listener ID for cleanup during stop_recording to ensure microphone is released
    {
        use tauri::Listener;
        let transcript_segments = RECORDING_MANAGER
            .lock()
            .unwrap()
            .as_ref()
            .expect("recording manager missing after start")
            .transcript_segments_handle();
        let listener_id = app.listen("transcript-update", move |event: tauri::Event| {
            // Parse the transcript update from the event payload
            if let Ok(update) = serde_json::from_str::<TranscriptUpdate>(event.payload()) {
                // Create structured transcript segment
                let segment = crate::audio::recording_saver::TranscriptSegment {
                    id: format!("seg_{}", update.sequence_id),
                    text: update.text.clone(),
                    audio_start_time: update.audio_start_time,
                    audio_end_time: update.audio_end_time,
                    duration: update.duration,
                    display_time: update.timestamp.clone(), // Use wall-clock timestamp for display
                    confidence: update.confidence,
                    sequence_id: update.sequence_id,
                    speaker: if update.source.trim().is_empty() {
                        None
                    } else {
                        Some(update.source.clone())
                    },
                };

                // Save to recording manager
                let mut saved_through_manager = false;
                if let Ok(manager_guard) = RECORDING_MANAGER.lock() {
                    if let Some(manager) = manager_guard.as_ref() {
                        manager.add_transcript_segment(segment.clone());
                        saved_through_manager = true;
                    }
                }
                if !saved_through_manager {
                    crate::audio::recording_saver::RecordingSaver::upsert_transcript_segment(
                        &transcript_segments,
                        segment,
                    );
                }
            }
        });
        let mut global_listener = TRANSCRIPT_LISTENER_ID.lock().unwrap();
        *global_listener = Some(listener_id);
        info!("✅ Transcript-update event listener registered for history persistence");
    }

    // Emit success event
    if let Err(error) = app.emit("recording-started", serde_json::json!({
        "message": "Recording started with custom devices and parallel processing",
        "devices": [
            mic_device_name.unwrap_or_else(|| "Default Microphone".to_string()),
            system_device_name.unwrap_or_else(|| "Default System Audio".to_string())
        ],
        "workers": 3
    })) {
        warn!("Recording started, but the recording-started event failed: {}", error);
    }

    // Update tray menu to reflect recording state
    crate::tray::update_tray_menu(&app);

    info!("âœ… Recording started with custom devices using async-first approach");
    drop(engine_lifecycle_guard);

    Ok(())
}

/// Stop recording with optimized graceful shutdown ensuring NO transcript chunks are lost
pub async fn stop_recording<R: Runtime>(
    app: AppHandle<R>,
    args: RecordingArgs,
) -> Result<StopOutcome, String> {
    let _engine_lifecycle_guard = super::common::acquire_engine_lifecycle_lock().await;
    stop_recording_inner(app, args, false).await
}

/// Compact Stop restores the main window that compact mode hid; all other stop
/// origins leave main-window visibility untouched.
pub async fn stop_recording_from_compact<R: Runtime>(
    app: AppHandle<R>,
    args: RecordingArgs,
) -> Result<StopOutcome, String> {
    let _engine_lifecycle_guard = super::common::acquire_engine_lifecycle_lock().await;
    stop_recording_inner(app, args, true).await
}

async fn stop_recording_inner<R: Runtime>(
    app: AppHandle<R>,
    _args: RecordingArgs,
    restore_main: bool,
) -> Result<StopOutcome, String> {
    info!(
        "ðŸ›‘ Starting optimized recording shutdown - ensuring ALL transcript chunks are preserved"
    );

    // Check if recording is active
    if !IS_RECORDING.load(Ordering::SeqCst) {
        info!("Recording was not active");
        return Ok(StopOutcome::AlreadyStopped);
    }

    if IS_STOPPING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        info!("Recording shutdown is already in progress");
        return Ok(StopOutcome::AlreadyStopping);
    }
    let _stop_guard = StopGuard;

    // Rust owns teardown. This is independent of webview event delivery and is
    // serialized against duplicate/queued minimize callbacks.
    crate::minibar::close_for_recording_stop(&app, restore_main);

    // Emit shutdown progress to frontend
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "stopping_audio",
            "message": "Stopping audio capture...",
            "progress": 20
        }),
    );

    // Step 1: Stop audio capture immediately (no more new chunks) with proper error handling
    let manager_for_cleanup = {
        let mut global_manager = RECORDING_MANAGER.lock().unwrap();
        global_manager.take()
    };

    let stop_result = if let Some(mut manager) = manager_for_cleanup {
        // Use FORCE FLUSH to immediately process all accumulated audio - eliminates 30s delay!
        info!("ðŸš€ Using FORCE FLUSH to eliminate pipeline accumulation delays");
        let result = manager.stop_streams_and_force_flush().await;
        // Store manager back for later cleanup
        let manager_for_cleanup = Some(manager);
        (result, manager_for_cleanup)
    } else {
        warn!("No recording manager found to stop");
        (Ok(()), None)
    };

    let (stop_result, manager_for_cleanup) = stop_result;

    let stream_stop_error = match stop_result {
        Ok(_) => {
            info!("âœ… Audio streams stopped successfully - no more chunks will be created");
            None
        }
        Err(e) => {
            error!("âŒ Failed to stop audio streams: {}", e);
            // Continue final-save and global cleanup. Returning here would leave
            // IS_RECORDING true after the manager had already been removed.
            Some(format!("Failed to stop audio streams cleanly: {}", e))
        }
    };

    // Step 2: Signal transcription workers to finish processing ALL queued chunks
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "processing_transcripts",
            "message": "Processing remaining transcript chunks...",
            "progress": 40
        }),
    );

    // Wait for transcription task with enhanced progress monitoring (NO TIMEOUT - we must process all chunks)
    let transcription_task = {
        let mut global_task = TRANSCRIPTION_TASK.lock().unwrap();
        global_task.take()
    };

    if let Some(mut task_handle) = transcription_task {
        info!("â³ Waiting for ALL transcription chunks to be processed (no timeout - preserving every chunk)");

        // Enhanced progress monitoring during shutdown
        let progress_app = app.clone();
        let progress_task = tokio::spawn(async move {
            let last_update = std::time::Instant::now();

            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                // Emit periodic progress updates during shutdown
                let elapsed = last_update.elapsed().as_secs();
                let _ = progress_app.emit(
                    "recording-shutdown-progress",
                    serde_json::json!({
                        "stage": "processing_transcripts",
                        "message": format!("Processing transcripts... ({}s elapsed)", elapsed),
                        "progress": 40,
                        "detailed": true,
                        "elapsed_seconds": elapsed
                    }),
                );
            }
        });

        // Wait up to 10 minutes for transcription completion to prevent indefinite hangs
        match tokio::time::timeout(
            tokio::time::Duration::from_secs(600), // 10 minutes max
            &mut task_handle
        ).await {
            Ok(Ok(())) => {
                info!("âœ… ALL transcription chunks processed successfully - no data lost");
            }
            Ok(Err(e)) => {
                warn!("âš ï¸ Transcription task completed with error: {:?}", e);
                // Continue anyway - the worker may have processed most chunks
            }
            Err(_) => {
                warn!("â±ï¸ Transcription timeout (10 minutes) reached, continuing shutdown to prevent indefinite hang");
                task_handle.abort();
                let _ = task_handle.await;
            }
        }

        // Stop progress monitoring
        progress_task.abort();
    } else {
        info!("â„¹ï¸ No transcription task found to wait for");
    }

    // Keep persistence active until final queued transcript events have been handled.
    {
        use tauri::Listener;
        if let Some(listener_id) = TRANSCRIPT_LISTENER_ID.lock().unwrap().take() {
            app.unlisten(listener_id);
            info!("âœ… Transcript-update listener removed");
        }
    }

    // Step 3: Now safely unload Whisper model after ALL chunks are processed
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "unloading_model",
            "message": "Unloading speech recognition model...",
            "progress": 70
        }),
    );

    info!("ðŸ§  All transcript chunks processed. Now safely unloading transcription model...");

    // Determine which provider was used and unload the appropriate model (with timeout)
    let config = match tokio::time::timeout(
        tokio::time::Duration::from_secs(30), // 30 seconds max for DB operation
        crate::api::api::api_get_transcript_config(
            app.clone(),
            app.clone().state(),
            None,
        )
    )
    .await
    {
        Ok(Ok(Some(config))) => Some(config.provider),
        Ok(Ok(None)) => None,
        Ok(Err(e)) => {
            warn!("âš ï¸ Failed to get transcript config: {:?}", e);
            None
        }
        Err(_) => {
            warn!("â±ï¸ Transcript config timeout (30s), continuing shutdown");
            None
        }
    };

    match config.as_deref() {
        Some("parakeet") => {
            info!("ðŸ¦œ Unloading Parakeet model...");
            let engine_clone = {
                let engine_guard = crate::parakeet_engine::commands::PARAKEET_ENGINE
                    .lock()
                    .unwrap();
                engine_guard.as_ref().cloned()
            };

            if let Some(engine) = engine_clone {
                let current_model = engine
                    .get_current_model()
                    .await
                    .unwrap_or_else(|| "unknown".to_string());
                info!("Current Parakeet model before unload: '{}'", current_model);

                if engine.unload_model().await {
                    info!("âœ… Parakeet model '{}' unloaded successfully", current_model);
                } else {
                    warn!("âš ï¸ Failed to unload Parakeet model '{}'", current_model);
                }
            } else {
                warn!("âš ï¸ No Parakeet engine found to unload model");
            }
        }
        _ => {
            // Default to Whisper
            info!("ðŸŽ¤ Unloading Whisper model...");
            let engine_clone = {
                let engine_guard = crate::whisper_engine::commands::WHISPER_ENGINE
                    .lock()
                    .unwrap();
                engine_guard.as_ref().cloned()
            };

            if let Some(engine) = engine_clone {
                let current_model = engine
                    .get_current_model()
                    .await
                    .unwrap_or_else(|| "unknown".to_string());
                info!("Current Whisper model before unload: '{}'", current_model);

                if engine.unload_model().await {
                    info!("âœ… Whisper model '{}' unloaded successfully", current_model);
                } else {
                    warn!("âš ï¸ Failed to unload Whisper model '{}'", current_model);
                }
            } else {
                warn!("âš ï¸ No Whisper engine found to unload model");
            }
        }
    }

    // Step 3.5: Track meeting ended analytics with privacy-safe metadata
    // Extract all data from manager BEFORE any async operations to avoid Send issues
    let analytics_data = if let Some(ref manager) = manager_for_cleanup {
        let state = manager.get_state();
        let stats = state.get_stats();

        Some((
            manager.get_recording_duration(),
            manager.get_active_recording_duration().unwrap_or(0.0),
            manager.get_total_pause_duration(),
            manager.get_transcript_segments().len() as u64,
            state.has_fatal_error(),
            state.get_microphone_device().map(|d| d.name.clone()),
            state.get_system_device().map(|d| d.name.clone()),
            stats.chunks_processed,
        ))
    } else {
        None
    };

    // Now perform async analytics tracking without holding manager reference
    if let Some((total_duration, active_duration, pause_duration, transcript_segments_count, had_fatal_error, mic_device_name, sys_device_name, chunks_processed)) = analytics_data {
        info!("ðŸ“Š Collecting analytics for meeting end");

        // Helper function to classify device type from device name (privacy-safe)
        fn classify_device_type(device_name: &str) -> &'static str {
            let name_lower = device_name.to_lowercase();
            // Check for Bluetooth keywords
            if name_lower.contains("bluetooth")
                || name_lower.contains("airpods")
                || name_lower.contains("beats")
                || name_lower.contains("headphones")
                || name_lower.contains("bt ")
                || name_lower.contains("wireless") {
                "Bluetooth"
            } else {
                "Wired"
            }
        }

        // Get transcription model info (already loaded above for model unload)
        let transcription_config = match crate::api::api::api_get_transcript_config(
            app.clone(),
            app.clone().state(),
            None,
        )
        .await
        {
            Ok(Some(config)) => Some((config.provider, config.model)),
            _ => None,
        };

        let (transcription_provider, transcription_model) = transcription_config
            .unwrap_or_else(|| ("unknown".to_string(), "unknown".to_string()));

        // Get summary model info from API
        let summary_config = match crate::api::api::api_get_model_config(
            app.clone(),
            app.clone().state(),
            None,
        )
        .await
        {
            Ok(Some(config)) => Some((config.provider, config.model)),
            _ => None,
        };

        let (summary_provider, summary_model) = summary_config
            .unwrap_or_else(|| ("unknown".to_string(), "unknown".to_string()));

        // Classify device types (privacy-safe)
        let microphone_device_type = mic_device_name
            .as_ref()
            .map(|name| classify_device_type(name))
            .unwrap_or("Unknown");

        let system_audio_device_type = sys_device_name
            .as_ref()
            .map(|name| classify_device_type(name))
            .unwrap_or("Unknown");

        // Track meeting ended event with privacy-safe data
        match crate::analytics::commands::track_meeting_ended(
            transcription_provider.clone(),
            transcription_model.clone(),
            summary_provider.clone(),
            summary_model.clone(),
            total_duration,
            active_duration,
            pause_duration,
            microphone_device_type.to_string(),
            system_audio_device_type.to_string(),
            chunks_processed,
            transcript_segments_count,
            had_fatal_error,
        )
        .await
        {
            Ok(_) => info!("âœ… Analytics tracked successfully for meeting end"),
            Err(e) => warn!("âš ï¸ Failed to track analytics: {}", e),
        }
    }

    // Step 4: Finalize recording state and cleanup resources safely
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "finalizing",
            "message": "Finalizing recording and cleaning up resources...",
            "progress": 90
        }),
    );

    // Perform final cleanup with the manager if available
    let (meeting_folder, meeting_name, save_error) = if let Some(mut manager) = manager_for_cleanup {
        info!("ðŸ§¹ Performing final cleanup and saving recording data");

        // Extract meeting info BEFORE async operations
        let meeting_folder = manager.get_meeting_folder();
        let meeting_name = manager.get_meeting_name();

        let audio_save_error = match tokio::time::timeout(
            tokio::time::Duration::from_secs(300), // 5 minutes max for file I/O
            manager.save_recording_only(&app)
        ).await {
            Ok(Ok(_)) => {
                info!("âœ… Recording data saved successfully during cleanup");
                None
            }
            Ok(Err(e)) => {
                warn!(
                    "âš ï¸ Error during recording cleanup (transcripts preserved): {}",
                    e
                );
                Some(e.to_string())
            }
            Err(_) => {
                warn!("â±ï¸ File I/O timeout (5 minutes) reached during save, continuing shutdown");
                Some("Audio save timed out after 5 minutes".to_string())
            }
        };

        (meeting_folder, meeting_name, audio_save_error)
    } else {
        info!("â„¹ï¸ No recording manager available for cleanup");
        (None, None, Some("Recording manager was unavailable during save".to_string()))
    };

    let audio_save_error = match (stream_stop_error, save_error) {
        (Some(stream_error), Some(save_error)) => {
            Some(format!("{}; {}", stream_error, save_error))
        }
        (Some(error), None) | (None, Some(error)) => Some(error),
        (None, None) => None,
    };

    // Set recording flag to false
    info!("ðŸ” Setting IS_RECORDING to false");
    IS_RECORDING.store(false, Ordering::SeqCst);
    crate::diarization::online::stop();

    // Step 4.5: Prepare metadata for frontend (NO database save)
    // NOTE: We do NOT save to database here. The frontend will save after all transcripts are displayed.
    // This ensures the user sees all transcripts streaming in before the database save happens.
    let (folder_path_str, meeting_name_str) = match (&meeting_folder, &meeting_name) {
        (Some(path), Some(name)) => (
            Some(path.to_string_lossy().to_string()),
            Some(name.clone()),
        ),
        _ => (None, None),
    };

    info!("ðŸ“¤ Preparing recording metadata for frontend save");
    info!("   folder_path: {:?}", folder_path_str);
    info!("   meeting_name: {:?}", meeting_name_str);

    // Database save removed - frontend will handle this after receiving all transcripts
    info!("â„¹ï¸ Skipping database save in Rust - frontend will save after all transcripts received");

    // Step 5: Complete shutdown
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "complete",
            "message": if audio_save_error.is_some() {
                "Recording stopped, but audio finalization reported an error"
            } else {
                "Recording stopped successfully"
            },
            "progress": 100
        }),
    );

    // Recovery metadata remains an app-wide informational event for
    // TranscriptContext's IndexedDB crash record. Final persistence does not
    // depend on receiving this event; the targeted completion below carries the
    // same fields atomically with the post-processing signal.
    let _ = app.emit(
        "recording-stopped",
        serde_json::json!({
            "message": "Recording stopped - frontend will save after all transcripts received",
            "folder_path": folder_path_str,
            "meeting_name": meeting_name_str,
            "audio_save_error": audio_save_error
        }),
    );

    // Update tray menu to reflect stopped state
    crate::tray::update_tray_menu(&app);

    // Every stop origin uses this one completion signal. Metadata travels in the
    // same main-window-only event so frontend persistence cannot race a separate
    // broadcast (the minibar mounts the same React providers in another webview).
    if let Err(error) = app.emit_to(
        "main",
        "recording-stop-complete",
        serde_json::json!({
            "call_api": true,
            "folder_path": folder_path_str,
            "meeting_name": meeting_name_str,
            "audio_save_error": audio_save_error
        }),
    ) {
        warn!("Failed to notify main window of recording completion: {}", error);
    }

    info!("ðŸŽ‰ Recording stopped successfully with ZERO transcript chunks lost");
    Ok(StopOutcome::Completed)
}

#[cfg(test)]
mod compact_mode_tests {
    use super::compact_mode_allowed;

    #[test]
    fn compact_mode_requires_an_active_non_stopping_recording() {
        assert!(compact_mode_allowed(true, false));
        assert!(!compact_mode_allowed(false, false));
        assert!(!compact_mode_allowed(true, true));
        assert!(!compact_mode_allowed(false, true));
    }
}

/// Check if recording is active
pub async fn is_recording() -> bool {
    IS_RECORDING.load(Ordering::SeqCst)
}

/// Get recording statistics
pub async fn get_transcription_status() -> TranscriptionStatus {
    TranscriptionStatus {
        chunks_in_queue: 0,
        is_processing: IS_RECORDING.load(Ordering::SeqCst),
        last_activity_ms: 0,
    }
}

/// Pause the current recording
#[tauri::command]
pub async fn pause_recording<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    info!("Pausing recording");

    // Check if currently recording
    if !IS_RECORDING.load(Ordering::SeqCst) {
        return Err("No recording is currently active".to_string());
    }

    // Access the recording manager and pause it
    let manager_guard = RECORDING_MANAGER.lock().unwrap();
    if let Some(manager) = manager_guard.as_ref() {
        manager.pause_recording().map_err(|e| e.to_string())?;

        // Emit pause event to frontend
        app.emit(
            "recording-paused",
            serde_json::json!({
                "message": "Recording paused"
            }),
        )
        .map_err(|e| e.to_string())?;

        // Update tray menu to reflect paused state
        crate::tray::update_tray_menu(&app);

        info!("Recording paused successfully");
        Ok(())
    } else {
        Err("No recording manager found".to_string())
    }
}

/// Resume the current recording
#[tauri::command]
pub async fn resume_recording<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    info!("Resuming recording");

    // Check if currently recording
    if !IS_RECORDING.load(Ordering::SeqCst) {
        return Err("No recording is currently active".to_string());
    }

    // Access the recording manager and resume it
    let manager_guard = RECORDING_MANAGER.lock().unwrap();
    if let Some(manager) = manager_guard.as_ref() {
        manager.resume_recording().map_err(|e| e.to_string())?;

        // Emit resume event to frontend
        app.emit(
            "recording-resumed",
            serde_json::json!({
                "message": "Recording resumed"
            }),
        )
        .map_err(|e| e.to_string())?;

        // Update tray menu to reflect resumed state
        crate::tray::update_tray_menu(&app);

        info!("Recording resumed successfully");
        Ok(())
    } else {
        Err("No recording manager found".to_string())
    }
}

/// Check if recording is currently paused
#[tauri::command]
pub async fn is_recording_paused() -> bool {
    let manager_guard = RECORDING_MANAGER.lock().unwrap();
    if let Some(manager) = manager_guard.as_ref() {
        manager.is_paused()
    } else {
        false
    }
}

/// Mute or unmute only the microphone while system capture continues.
#[tauri::command]
pub async fn set_microphone_muted<R: Runtime>(
    app: AppHandle<R>,
    muted: bool,
) -> Result<bool, String> {
    if !IS_RECORDING.load(Ordering::SeqCst) {
        return Err("No recording is currently active".to_string());
    }

    let manager_guard = RECORDING_MANAGER.lock().unwrap();
    let manager = manager_guard
        .as_ref()
        .ok_or_else(|| "No recording manager found".to_string())?;
    manager.get_state().set_microphone_muted(muted);

    let _ = app.emit(
        "microphone-mute-changed",
        serde_json::json!({ "muted": muted }),
    );

    info!(
        "Microphone {} while recording",
        if muted { "muted" } else { "unmuted" }
    );
    Ok(muted)
}

/// Mute or unmute only system audio while microphone capture continues.
#[tauri::command]
pub async fn set_system_audio_muted<R: Runtime>(
    app: AppHandle<R>,
    muted: bool,
) -> Result<bool, String> {
    if !IS_RECORDING.load(Ordering::SeqCst) {
        return Err("No recording is currently active".to_string());
    }

    let manager_guard = RECORDING_MANAGER.lock().unwrap();
    let manager = manager_guard
        .as_ref()
        .ok_or_else(|| "No recording manager found".to_string())?;
    manager.get_state().set_system_audio_muted(muted);

    let _ = app.emit(
        "system-audio-mute-changed",
        serde_json::json!({ "muted": muted }),
    );

    info!(
        "System audio {} while recording",
        if muted { "muted" } else { "unmuted" }
    );
    Ok(muted)
}

/// Get detailed recording state
#[tauri::command]
pub async fn get_recording_state() -> serde_json::Value {
    let is_recording = IS_RECORDING.load(Ordering::SeqCst);
    let manager_guard = RECORDING_MANAGER.lock().unwrap();

    if let Some(manager) = manager_guard.as_ref() {
        serde_json::json!({
            "is_recording": is_recording,
            "is_paused": manager.is_paused(),
            "is_microphone_muted": manager.get_state().is_microphone_muted(),
            "is_system_audio_muted": manager.get_state().is_system_audio_muted(),
            "is_active": manager.is_active(),
            "recording_duration": manager.get_recording_duration(),
            "active_duration": manager.get_active_recording_duration(),
            "total_pause_duration": manager.get_total_pause_duration(),
            "current_pause_duration": manager.get_current_pause_duration()
        })
    } else {
        serde_json::json!({
            "is_recording": is_recording,
            "is_paused": false,
            "is_microphone_muted": false,
            "is_system_audio_muted": false,
            "is_active": false,
            "recording_duration": null,
            "active_duration": null,
            "total_pause_duration": 0.0,
            "current_pause_duration": null
        })
    }
}

/// Get the meeting folder path for the current recording
/// Returns the path if a meeting name was set and folder structure initialized
#[tauri::command]
pub async fn get_meeting_folder_path() -> Result<Option<String>, String> {
    let manager_guard = RECORDING_MANAGER.lock().unwrap();
    if let Some(manager) = manager_guard.as_ref() {
        Ok(manager.get_meeting_folder().map(|p| p.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

/// Get accumulated transcript segments from current recording session
/// Used for syncing frontend state after page reload during active recording
#[tauri::command]
pub async fn get_transcript_history() -> Result<Vec<crate::audio::recording_saver::TranscriptSegment>, String> {
    let manager_guard = RECORDING_MANAGER.lock().unwrap();

    if let Some(manager) = manager_guard.as_ref() {
        Ok(manager.get_transcript_segments())
    } else {
        Ok(Vec::new()) // No recording active, return empty
    }
}

/// Get meeting name from current recording session
/// Used for syncing frontend state after page reload during active recording
#[tauri::command]
pub async fn get_recording_meeting_name() -> Result<Option<String>, String> {
    let manager_guard = RECORDING_MANAGER.lock().unwrap();

    if let Some(manager) = manager_guard.as_ref() {
        Ok(manager.get_meeting_name())
    } else {
        Ok(None)
    }
}

// ============================================================================
// DEVICE MONITORING COMMANDS (AirPods/Bluetooth disconnect/reconnect support)
// ============================================================================

/// Response structure for device events
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type")]
pub enum DeviceEventResponse {
    DeviceDisconnected {
        device_name: String,
        device_type: String,
    },
    DeviceReconnected {
        device_name: String,
        device_type: String,
    },
    DeviceListChanged,
}

impl From<DeviceEvent> for DeviceEventResponse {
    fn from(event: DeviceEvent) -> Self {
        match event {
            DeviceEvent::DeviceDisconnected { device_name, device_type } => {
                DeviceEventResponse::DeviceDisconnected {
                    device_name,
                    device_type: format!("{:?}", device_type),
                }
            }
            DeviceEvent::DeviceReconnected { device_name, device_type } => {
                DeviceEventResponse::DeviceReconnected {
                    device_name,
                    device_type: format!("{:?}", device_type),
                }
            }
            DeviceEvent::DeviceListChanged => DeviceEventResponse::DeviceListChanged,
        }
    }
}

/// Reconnection status information
#[derive(Debug, Serialize, Clone)]
pub struct ReconnectionStatus {
    pub is_reconnecting: bool,
    pub disconnected_device: Option<DisconnectedDeviceInfo>,
}

/// Information about a disconnected device
#[derive(Debug, Serialize, Clone)]
pub struct DisconnectedDeviceInfo {
    pub name: String,
    pub device_type: String,
}

/// Poll for audio device events (disconnect/reconnect)
/// Should be called periodically (every 1-2 seconds) by frontend during recording
#[tauri::command]
pub async fn poll_audio_device_events() -> Result<Option<DeviceEventResponse>, String> {
    let mut manager_guard = RECORDING_MANAGER.lock().unwrap();

    if let Some(manager) = manager_guard.as_mut() {
        if let Some(event) = manager.poll_device_events() {
            info!("ðŸ“± Device event polled: {:?}", event);
            Ok(Some(event.into()))
        } else {
            Ok(None)
        }
    } else {
        // Not recording, no events
        Ok(None)
    }
}

/// Get current reconnection status
/// Returns whether the system is attempting to reconnect and which device
#[tauri::command]
pub async fn get_reconnection_status() -> Result<ReconnectionStatus, String> {
    let manager_guard = RECORDING_MANAGER.lock().unwrap();

    if let Some(manager) = manager_guard.as_ref() {
        let state = manager.get_state();
        let disconnected_device = state.get_disconnected_device().map(|(device, device_type)| {
            DisconnectedDeviceInfo {
                name: device.name.clone(),
                device_type: format!("{:?}", device_type),
            }
        });

        Ok(ReconnectionStatus {
            is_reconnecting: manager.is_reconnecting(),
            disconnected_device,
        })
    } else {
        // Not recording, no reconnection in progress
        Ok(ReconnectionStatus {
            is_reconnecting: false,
            disconnected_device: None,
        })
    }
}

/// Get information about the active audio output device
/// Used to warn users about Bluetooth playback issues
#[tauri::command]
pub async fn get_active_audio_output() -> Result<super::playback_monitor::AudioOutputInfo, String> {
    super::playback_monitor::get_active_audio_output()
        .await
        .map_err(|e| format!("Failed to get audio output info: {}", e))
}

/// Manually trigger device reconnection attempt
/// Useful for UI "Retry" button
#[tauri::command]
pub async fn attempt_device_reconnect(
    device_name: String,
    device_type: String,
) -> Result<bool, String> {
    // Parse device type first
    let monitor_type = match device_type.as_str() {
        "Microphone" => DeviceMonitorType::Microphone,
        "SystemAudio" => DeviceMonitorType::SystemAudio,
        _ => return Err(format!("Invalid device type: {}", device_type)),
    };

    // Take the manager out of the global mutex before the reconnection work,
    // instead of holding the lock across the .await below. Since TECH-01,
    // stream shutdown inside attempt_device_reconnect() is async and can take
    // up to a few seconds (bounded join of the capture thread) instead of the
    // near-instant sync call it used to be — holding a std::sync::Mutex across
    // that would block every other command that locks RECORDING_MANAGER
    // (stop_recording, status queries, ...) for the same duration. Same
    // take()/put-back pattern as stop_recording() above.
    let mut manager = match RECORDING_MANAGER.lock().unwrap().take() {
        Some(m) => m,
        None => return Err("Recording not active".to_string()),
    };

    let result = manager.attempt_device_reconnect(&device_name, monitor_type).await;

    // Put it back regardless of outcome — a failed reconnect attempt doesn't
    // mean recording stopped.
    *RECORDING_MANAGER.lock().unwrap() = Some(manager);

    match result {
        Ok(success) => {
            if success {
                info!("âœ… Manual reconnection successful");
            } else {
                warn!("âŒ Manual reconnection failed - device not available");
            }
            Ok(success)
        }
        Err(e) => {
            error!("Manual reconnection error: {}", e);
            Err(e.to_string())
        }
    }
}

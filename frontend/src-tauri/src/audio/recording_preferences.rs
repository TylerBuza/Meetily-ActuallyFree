//! Where meeting audio recordings are saved, and the user's preferences for it.
//!
//! ⚠️ Recordings are the one thing this otherwise-portable app does **not** put
//! under `<exe dir>/data` (see `crate::paths`). They live in a user-facing media
//! folder so people can find, play and share them with normal tools:
//!
//! | OS      | Default location                                  |
//! |---------|---------------------------------------------------|
//! | Windows | `%USERPROFILE%\Music\meetily-recordings`           |
//! | macOS   | `~/Movies/meetily-recordings`                      |
//! | Linux   | `~/Videos/meetily-recordings` (or Documents)       |
//!
//! Layout is `<folder>/<sanitized meeting name>/audio.mp4`, alongside
//! `metadata.json` and `transcripts.json`.
//!
//! Two things regularly catch people out:
//!   1. The container is **`.mp4`**, not `.wav` — anything reading recordings
//!      back (e.g. diarization) must decode it first.
//!   2. The folder is **not** the app data root, so searching only there finds
//!      nothing. See `diarization::find_meeting_audio` for the correct lookup.

use log::{info, warn};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use anyhow::Result;

/// Hot mic gain for the live capture path (f32 bits). Updated whenever prefs save.
static MIC_GAIN_BITS: Lazy<AtomicU32> =
    Lazy::new(|| AtomicU32::new(1.0f32.to_bits()));

/// Current mic gain multiplier (0.5–3.0). Applied after mic loudness normalize.
pub fn mic_gain() -> f32 {
    f32::from_bits(MIC_GAIN_BITS.load(Ordering::Relaxed)).clamp(0.5, 3.0)
}

fn set_mic_gain_runtime(gain: f32) {
    MIC_GAIN_BITS.store(gain.clamp(0.5, 3.0).to_bits(), Ordering::Relaxed);
}
#[cfg(target_os = "macos")]
use log::error;

#[cfg(target_os = "macos")]
use crate::audio::capture::AudioCaptureBackend;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecordingPreferences {
    pub save_folder: PathBuf,
    pub auto_save: bool,
    pub file_format: String,
    #[serde(default)]
    pub preferred_mic_device: Option<String>,
    #[serde(default)]
    pub preferred_system_device: Option<String>,
    /// Extra gain on the local mic after loudness normalize (0.5–3.0, default 1.0).
    #[serde(default = "default_mic_gain")]
    pub mic_gain: f32,
    #[cfg(target_os = "macos")]
    #[serde(default)]
    pub system_audio_backend: Option<String>,
}

fn default_mic_gain() -> f32 {
    1.0
}

impl Default for RecordingPreferences {
    fn default() -> Self {
        Self {
            save_folder: get_default_recordings_folder(),
            auto_save: true,
            file_format: "mp4".to_string(),
            preferred_mic_device: None,
            preferred_system_device: None,
            mic_gain: 1.0,
            #[cfg(target_os = "macos")]
            system_audio_backend: Some("coreaudio".to_string()),
        }
    }
}

/// Get the default recordings folder based on platform
pub fn get_default_recordings_folder() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        // Windows: %USERPROFILE%\Music\meetily-recordings
        if let Some(music_dir) = dirs::audio_dir() {
            music_dir.join("meetily-recordings")
        } else {
            // Fallback to Documents if Music folder is not available
            dirs::document_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("meetily-recordings")
        }
    }

    #[cfg(target_os = "macos")]
    {
        // macOS: ~/Movies/meetily-recordings
        if let Some(movies_dir) = dirs::video_dir() {
            movies_dir.join("meetily-recordings")
        } else {
            // Fallback to Documents if Movies folder is not available
            dirs::document_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("meetily-recordings")
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        // Linux/Others: ~/Documents/meetily-recordings
        dirs::document_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("meetily-recordings")
    }
}

/// Ensure the recordings directory exists
pub fn ensure_recordings_directory(path: &PathBuf) -> Result<()> {
    if !path.exists() {
        std::fs::create_dir_all(path)?;
        info!("Created recordings directory: {:?}", path);
    }
    Ok(())
}

/// Generate a unique filename for a recording
pub fn generate_recording_filename(format: &str) -> String {
    let now = chrono::Utc::now();
    let timestamp = now.format("%Y%m%d_%H%M%S");
    format!("recording_{}.{}", timestamp, format)
}

/// Load recording preferences from store
pub async fn load_recording_preferences<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<RecordingPreferences> {
    // Try to load from Tauri store
    let store = match app.store("recording_preferences.json") {
        Ok(store) => store,
        Err(e) => {
            warn!("Failed to access store: {}, using defaults", e);
            return Ok(RecordingPreferences::default());
        }
    };

    // Try to get the preferences from store
    let prefs = if let Some(value) = store.get("preferences") {
        match serde_json::from_value::<RecordingPreferences>(value.clone()) {
            Ok(p) => {
                info!("Loaded recording preferences from store");
                // Update macOS backend to current value if needed
                #[cfg(target_os = "macos")]
                let p = {
                    let mut p = p;
                    let backend = crate::audio::capture::get_current_backend();
                    p.system_audio_backend = Some(backend.to_string());
                    p
                };
                p
            }
            Err(e) => {
                warn!("Failed to deserialize preferences: {}, using defaults", e);
                RecordingPreferences::default()
            }
        }
    } else {
        info!("No stored preferences found, using defaults");
        RecordingPreferences::default()
    };

    set_mic_gain_runtime(prefs.mic_gain);
    info!("Loaded recording preferences: save_folder={:?}, auto_save={}, format={}, mic={:?}, system={:?}, mic_gain={:.2}",
          prefs.save_folder, prefs.auto_save, prefs.file_format,
          prefs.preferred_mic_device, prefs.preferred_system_device, prefs.mic_gain);
    Ok(prefs)
}

/// Save recording preferences to store
pub async fn save_recording_preferences<R: Runtime>(
    app: &AppHandle<R>,
    preferences: &RecordingPreferences,
) -> Result<()> {
    let mut preferences = preferences.clone();
    preferences.mic_gain = preferences.mic_gain.clamp(0.5, 3.0);
    set_mic_gain_runtime(preferences.mic_gain);

    info!("Saving recording preferences: save_folder={:?}, auto_save={}, format={}, mic={:?}, system={:?}, mic_gain={:.2}",
          preferences.save_folder, preferences.auto_save, preferences.file_format,
          preferences.preferred_mic_device, preferences.preferred_system_device, preferences.mic_gain);

    // Get or create store
    let store = app
        .store("recording_preferences.json")
        .map_err(|e| anyhow::anyhow!("Failed to access store: {}", e))?;

    // Serialize preferences to JSON value
    let prefs_value = serde_json::to_value(&preferences)
        .map_err(|e| anyhow::anyhow!("Failed to serialize preferences: {}", e))?;

    // Save to store
    store.set("preferences", prefs_value);

    // Persist to disk
    store
        .save()
        .map_err(|e| anyhow::anyhow!("Failed to save store to disk: {}", e))?;

    info!("Successfully persisted recording preferences to disk");

    // Save backend preference to global config
    #[cfg(target_os = "macos")]
    if let Some(backend_str) = &preferences.system_audio_backend {
        if let Some(backend) = AudioCaptureBackend::from_string(backend_str) {
            info!("Setting audio capture backend to: {:?}", backend);
            crate::audio::capture::set_current_backend(backend);
        }
    }

    // Ensure the directory exists
    ensure_recordings_directory(&preferences.save_folder)?;

    Ok(())
}

/// Tauri commands for recording preferences
#[tauri::command]
pub async fn get_recording_preferences<R: Runtime>(
    app: AppHandle<R>,
) -> Result<RecordingPreferences, String> {
    load_recording_preferences(&app)
        .await
        .map_err(|e| format!("Failed to load recording preferences: {}", e))
}

#[tauri::command]
pub async fn set_recording_preferences<R: Runtime>(
    app: AppHandle<R>,
    preferences: RecordingPreferences,
) -> Result<(), String> {
    save_recording_preferences(&app, &preferences)
        .await
        .map_err(|e| format!("Failed to save recording preferences: {}", e))
}

#[tauri::command]
pub async fn get_default_recordings_folder_path() -> Result<String, String> {
    let path = get_default_recordings_folder();
    Ok(path.to_string_lossy().to_string())
}

/// Delete a just-written meeting folder (used when a take is discarded as too short).
/// Only removes paths under the configured recordings root for safety.
#[tauri::command]
pub async fn discard_recording_folder<R: Runtime>(
    app: AppHandle<R>,
    folder_path: String,
) -> Result<(), String> {
    let path = PathBuf::from(&folder_path);
    if folder_path.trim().is_empty() {
        return Ok(());
    }
    if !path.exists() {
        return Ok(());
    }

    let path_canon = path.canonicalize().map_err(|e| e.to_string())?;

    let preferences = load_recording_preferences(&app)
        .await
        .map_err(|e| format!("Failed to load recording preferences: {e}"))?;
    let roots = [
        preferences.save_folder,
        get_default_recordings_folder(),
        crate::paths::install_data_root(),
    ];
    let roots_canon: Vec<PathBuf> = roots
        .into_iter()
        .map(|root| root.canonicalize().unwrap_or(root))
        .collect();
    let is_root = roots_canon.iter().any(|root| path_canon == *root);
    let is_meeting_folder = !is_root && roots_canon.iter().any(|root| path_canon.starts_with(root));
    if !is_meeting_folder {
        return Err("Refusing to delete path outside recordings folders".into());
    }

    if path_canon.is_dir() {
        std::fs::remove_dir_all(&path_canon).map_err(|e| format!("Failed to discard folder: {e}"))?;
        info!("Discarded short recording folder: {}", path_canon.display());
    } else if path_canon.is_file() {
        std::fs::remove_file(&path_canon).map_err(|e| format!("Failed to discard file: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_recordings_folder<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let preferences = load_recording_preferences(&app)
        .await
        .map_err(|e| format!("Failed to load preferences: {}", e))?;

    // Ensure directory exists before trying to open it
    ensure_recordings_directory(&preferences.save_folder)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    let folder_path = preferences.save_folder.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&folder_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&folder_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&folder_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    info!("Opened recordings folder: {}", folder_path);
    Ok(())
}

#[tauri::command]
pub async fn select_recording_folder<R: Runtime>(
    _app: AppHandle<R>,
) -> Result<Option<String>, String> {
    // Use Tauri's dialog to select folder
    // For now, return None - this would need to be implemented with tauri-plugin-dialog
    // when it's available in the Cargo.toml
    warn!("Folder selection not yet implemented - using dialog plugin");
    Ok(None)
}

// Backend selection commands

/// Get available audio capture backends for the current platform
#[tauri::command]
pub async fn get_available_audio_backends() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let backends = crate::audio::capture::get_available_backends();
        Ok(backends.iter().map(|b| b.to_string()).collect())
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Only ScreenCaptureKit available on non-macOS
        Ok(vec!["screencapturekit".to_string()])
    }
}

/// Get current audio capture backend
#[tauri::command]
pub async fn get_current_audio_backend() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let backend = crate::audio::capture::get_current_backend();
        Ok(backend.to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok("screencapturekit".to_string())
    }
}

/// Set audio capture backend
#[tauri::command]
pub async fn set_audio_backend(backend: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use crate::audio::capture::AudioCaptureBackend;
        use crate::audio::permissions::{
            check_screen_recording_permission, request_screen_recording_permission,
        };

        let backend_enum = AudioCaptureBackend::from_string(&backend)
            .ok_or_else(|| format!("Invalid backend: {}", backend))?;

        // If switching to Core Audio, log information about Audio Capture permission
        if backend_enum == AudioCaptureBackend::CoreAudio {
            info!("🔐 Core Audio backend requires Audio Capture permission (macOS 14.2+)");
            info!("📍 Permission dialog will appear automatically when recording starts");

            // Check if permission is already granted (this is informational only)
            if !check_screen_recording_permission() {
                warn!("⚠️  Audio Capture permission may not be granted");

                // Attempt to open System Settings (opens System Settings)
                if let Err(e) = request_screen_recording_permission() {
                    error!("Failed to open System Settings: {}", e);
                }

                return Err(
                    "Core Audio requires Audio Capture permission. \
                    The permission dialog will appear when you start recording. \
                    If already denied, enable it in System Settings → Privacy & Security → Audio Capture, \
                    then restart the app.".to_string()
                );
            }

            info!(
                "✅ Core Audio backend selected - permission check will occur at recording start"
            );
        }

        info!("Setting audio backend to: {:?}", backend_enum);
        crate::audio::capture::set_current_backend(backend_enum);
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        if backend != "screencapturekit" {
            return Err(format!(
                "Backend {} not available on this platform",
                backend
            ));
        }
        Ok(())
    }
}

/// Get backend information (name and description)
#[derive(Serialize)]
pub struct BackendInfo {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[tauri::command]
pub async fn get_audio_backend_info() -> Result<Vec<BackendInfo>, String> {
    #[cfg(target_os = "macos")]
    {
        use crate::audio::capture::AudioCaptureBackend;

        let backends = AudioCaptureBackend::available_backends()
            .into_iter()
            .map(|backend| BackendInfo {
                id: backend.to_string(),
                name: backend.name().to_string(),
                description: backend.description().to_string(),
            })
            .collect();
        Ok(backends)
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(vec![BackendInfo {
            id: "screencapturekit".to_string(),
            name: "ScreenCaptureKit".to_string(),
            description: "Default system audio capture".to_string(),
        }])
    }
}


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
#[cfg(any(target_os = "macos", test))]
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_store::StoreExt;

use anyhow::Result;
#[cfg(any(target_os = "macos", test))]
use anyhow::{anyhow, Context};

/// Hot source gains for the live capture path (f32 bits). Updated whenever prefs save.
static MIC_GAIN_BITS: Lazy<AtomicU32> = Lazy::new(|| AtomicU32::new(1.0f32.to_bits()));
static SYSTEM_GAIN_BITS: Lazy<AtomicU32> = Lazy::new(|| AtomicU32::new(1.0f32.to_bits()));

/// Current mic gain multiplier (0.5–3.0). Applied after mic loudness normalize.
pub fn mic_gain() -> f32 {
    f32::from_bits(MIC_GAIN_BITS.load(Ordering::Relaxed)).clamp(0.5, 3.0)
}

fn set_mic_gain_runtime(gain: f32) {
    MIC_GAIN_BITS.store(gain.clamp(0.5, 3.0).to_bits(), Ordering::Relaxed);
}

/// Current system-audio gain multiplier (0.5–3.0).
pub fn system_gain() -> f32 {
    f32::from_bits(SYSTEM_GAIN_BITS.load(Ordering::Relaxed)).clamp(0.5, 3.0)
}

fn set_system_gain_runtime(gain: f32) {
    SYSTEM_GAIN_BITS.store(gain.clamp(0.5, 3.0).to_bits(), Ordering::Relaxed);
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
    /// Gain applied to system audio before meters, VAD, retained tracks, and mixing.
    #[serde(default = "default_system_gain")]
    pub system_gain: f32,
    #[cfg(target_os = "macos")]
    #[serde(default)]
    pub system_audio_backend: Option<String>,
}

fn default_mic_gain() -> f32 {
    1.0
}

fn default_system_gain() -> f32 {
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
            system_gain: 1.0,
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
    #[cfg(target_os = "macos")]
    reject_current_app_bundle_path(path)?;

    std::fs::create_dir_all(path)?;
    if !path.is_dir() {
        return Err(anyhow::anyhow!(
            "Recording path is not a directory: {}",
            path.display()
        ));
    }

    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let probe = path.join(format!(
        ".meetily-write-test-{}-{nonce}",
        std::process::id()
    ));
    let mut probe_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|error| {
        anyhow::anyhow!(
            "Recording directory is not writable ({}): {}",
            path.display(),
            error
        )
    })?;
    std::io::Write::write_all(&mut probe_file, b"ok")?;
    drop(probe_file);
    std::fs::remove_file(&probe)?;
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn resolve_path_for_containment(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .context("Failed to resolve the current directory")?
            .join(path)
    };
    let mut resolved = PathBuf::new();

    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Prefix(_) | Component::RootDir => {
                resolved.push(component.as_os_str());
            }
            Component::Normal(_) => {
                resolved.push(component.as_os_str());
                if resolved.exists() {
                    resolved = resolved.canonicalize().with_context(|| {
                        format!("Failed to resolve path {}", resolved.display())
                    })?;
                }
            }
        }
    }

    Ok(resolved)
}

#[cfg(any(target_os = "macos", test))]
fn reject_path_inside_bundle(path: &Path, bundle_root: &Path) -> Result<()> {
    let candidate = resolve_path_for_containment(path)?;
    let bundle = resolve_path_for_containment(bundle_root)?;

    if candidate == bundle || candidate.starts_with(&bundle) {
        return Err(anyhow!(
            "The recordings folder cannot be inside the Meetily app bundle. Choose a folder in Movies, Music, Documents, or another writable location."
        ));
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn current_app_bundle_root() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .ancestors()
        .find_map(|ancestor| {
            ancestor
                .extension()
                .and_then(|extension| extension.to_str())
                .filter(|extension| extension.eq_ignore_ascii_case("app"))
                .map(|_| ancestor.to_path_buf())
    })
}

#[cfg(target_os = "macos")]
fn reject_current_app_bundle_path(path: &Path) -> Result<()> {
    if let Some(bundle_root) = current_app_bundle_root() {
        reject_path_inside_bundle(path, &bundle_root)?;
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

    #[cfg(target_os = "macos")]
    let prefs = if let Err(error) = reject_current_app_bundle_path(&prefs.save_folder) {
        warn!(
            "Ignoring recordings folder inside the app bundle ({}): {error}",
            prefs.save_folder.display()
        );
        let corrected = RecordingPreferences {
            save_folder: get_default_recordings_folder(),
            ..prefs
        };
        if let Ok(value) = serde_json::to_value(&corrected) {
            store.set("preferences", value);
            if let Err(error) = store.save() {
                warn!("Failed to persist corrected recordings folder: {error}");
            }
        }
        corrected
    } else {
        prefs
    };

    set_mic_gain_runtime(prefs.mic_gain);
    set_system_gain_runtime(prefs.system_gain);
    info!("Loaded recording preferences: save_folder={:?}, auto_save={}, format={}, mic={:?}, system={:?}, mic_gain={:.2}, system_gain={:.2}",
          prefs.save_folder, prefs.auto_save, prefs.file_format,
           prefs.preferred_mic_device, prefs.preferred_system_device, prefs.mic_gain,
           prefs.system_gain);
    Ok(prefs)
}

/// Save recording preferences to store
pub async fn save_recording_preferences<R: Runtime>(
    app: &AppHandle<R>,
    preferences: &RecordingPreferences,
) -> Result<()> {
    let mut preferences = preferences.clone();
    preferences.mic_gain = preferences.mic_gain.clamp(0.5, 3.0);
    preferences.system_gain = preferences.system_gain.clamp(0.5, 3.0);
    // Validate first so a bad custom path is never persisted and reused on the
    // next recording startup.
    ensure_recordings_directory(&preferences.save_folder)?;

    info!("Saving recording preferences: save_folder={:?}, auto_save={}, format={}, mic={:?}, system={:?}, mic_gain={:.2}, system_gain={:.2}",
          preferences.save_folder, preferences.auto_save, preferences.file_format,
           preferences.preferred_mic_device, preferences.preferred_system_device,
           preferences.mic_gain, preferences.system_gain);

    // Get or create store
    let store = app
        .store("recording_preferences.json")
        .map_err(|e| anyhow::anyhow!("Failed to access store: {}", e))?;

    // Serialize preferences to JSON value
    let prefs_value = serde_json::to_value(&preferences)
        .map_err(|e| anyhow::anyhow!("Failed to serialize preferences: {}", e))?;

    // Keep the cached store consistent with disk if persistence fails.
    let previous_value = store.get("preferences");
    store.set("preferences", prefs_value);
    if let Err(error) = store.save() {
        if let Some(previous_value) = previous_value {
            store.set("preferences", previous_value);
        } else {
            store.delete("preferences");
        }
        return Err(anyhow::anyhow!("Failed to save store to disk: {}", error));
    }

    set_mic_gain_runtime(preferences.mic_gain);
    set_system_gain_runtime(preferences.system_gain);
    info!("Successfully persisted recording preferences to disk");

    // Save backend preference to global config
    #[cfg(target_os = "macos")]
    if let Some(backend_str) = &preferences.system_audio_backend {
        if let Some(backend) = AudioCaptureBackend::from_string(backend_str) {
            info!("Setting audio capture backend to: {:?}", backend);
            crate::audio::capture::set_current_backend(backend);
        }
    }

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

#[tauri::command]
pub async fn select_recording_folder<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(app
            .dialog()
            .file()
            .set_title("Choose recordings folder")
            .blocking_pick_folder()
            .map(|path| path.to_string()))
    })
    .await
    .map_err(|error| format!("Recording folder dialog failed: {error}"))?
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
    // Reject equality in a separate pass. A custom root can be nested beneath
    // the default root and must not pass merely because it is that root's child.
    let is_root = roots_canon.iter().any(|root| path_canon == *root);
    let is_meeting_folder = !is_root && roots_canon.iter().any(|root| path_canon.starts_with(root));
    if !is_meeting_folder {
        return Err("Refusing to delete path outside recordings folders".into());
    }

    if path_canon.is_dir() {
        std::fs::remove_dir_all(&path_canon)
            .map_err(|e| format!("Failed to discard folder: {e}"))?;
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

        let backend_enum = AudioCaptureBackend::from_string(&backend)
            .ok_or_else(|| format!("Invalid backend: {}", backend))?;

        // Selection cannot prove permission: denied taps can still open and emit
        // zeros. Onboarding/Recheck owns the up-to-five-second audible probe.
        if backend_enum == AudioCaptureBackend::CoreAudio {
            info!("🔐 Core Audio backend requires Audio Capture permission (macOS 14.2+)");
            info!("📍 Onboarding or Recheck verifies the tap while system audio is playing");
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn old_preferences_default_system_gain_to_unity() {
        let preferences: RecordingPreferences = serde_json::from_value(serde_json::json!({
            "save_folder": "recordings",
            "auto_save": true,
            "file_format": "mp4",
            "mic_gain": 1.4
        }))
        .expect("legacy preferences should deserialize");

        assert_eq!(preferences.system_gain, 1.0);
    }

    #[test]
    fn app_bundle_and_descendants_are_rejected_as_recording_folders() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "meetily-recording-path-test-{}-{unique}",
            std::process::id()
        ));
        let bundle = root.join("Meetily.app");
        let sibling = root.join("recordings");
        std::fs::create_dir_all(&bundle).unwrap();

        assert!(reject_path_inside_bundle(&bundle, &bundle).is_err());
        assert!(reject_path_inside_bundle(&bundle.join("Contents/new"), &bundle).is_err());
        assert!(reject_path_inside_bundle(&sibling, &bundle).is_ok());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_parent_traversal_into_app_bundle_is_rejected() {
        use std::os::unix::fs::symlink;

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "meetily-recording-symlink-test-{}-{unique}",
            std::process::id()
        ));
        let bundle = root.join("Meetily.app");
        let executable_dir = bundle.join("Contents/MacOS");
        let link = root.join("app-executable-dir");
        std::fs::create_dir_all(&executable_dir).unwrap();
        symlink(&executable_dir, &link).unwrap();

        let traversal = link.join("../Resources/recordings");
        assert!(reject_path_inside_bundle(&traversal, &bundle).is_err());

        std::fs::remove_dir_all(root).unwrap();
    }
}

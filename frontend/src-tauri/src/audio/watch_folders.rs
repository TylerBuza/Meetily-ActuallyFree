use anyhow::Result;
use log::{error, info};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

const WATCH_EXTENSIONS: [&str; 11] = [
    "mp4", "mov", "mkv", "webm", "avi", "mp3", "wav", "m4a", "aac", "flac", "ogg",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchFolderConfig {
    pub enabled: bool,
    pub folders: Vec<String>,
}

impl Default for WatchFolderConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            folders: Vec::new(),
        }
    }
}

fn config_path() -> PathBuf {
    crate::paths::install_data_root().join("watch_folders.json")
}

fn processed_path() -> PathBuf {
    crate::paths::install_data_root().join("watch_processed.json")
}

pub fn load_config() -> WatchFolderConfig {
    let p = config_path();
    if !p.exists() {
        return WatchFolderConfig::default();
    }
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_config(config: &WatchFolderConfig) -> Result<()> {
    let p = config_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(config)?;
    std::fs::write(&p, json)?;
    Ok(())
}

fn load_processed() -> HashSet<String> {
    let p = processed_path();
    if !p.exists() {
        return HashSet::new();
    }
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_processed(processed: &HashSet<String>) -> Result<()> {
    let p = processed_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string(processed)?;
    std::fs::write(&p, json)?;
    Ok(())
}

static WORKER_INITIALIZED: AtomicBool = AtomicBool::new(false);

/// Start the background watch folder monitoring loop
pub fn init_watch_folder_worker<R: Runtime>(app: AppHandle<R>) {
    if WORKER_INITIALIZED.swap(true, Ordering::SeqCst) {
        return;
    }

    tauri::async_runtime::spawn(async move {
        info!("👀 Watch folder background worker started");
        let mut file_sizes: HashMap<PathBuf, (u64, u32)> = HashMap::new();

        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;

            let config = load_config();
            if !config.enabled || config.folders.is_empty() {
                file_sizes.clear();
                continue;
            }

            let mut processed = load_processed();
            let mut newly_processed = false;

            for folder_str in &config.folders {
                let folder = PathBuf::from(folder_str);
                if !folder.is_dir() {
                    continue;
                }

                let entries = match std::fs::read_dir(&folder) {
                    Ok(e) => e,
                    Err(_) => continue,
                };

                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_file() {
                        continue;
                    }

                    // Check extension
                    let ext = path
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.to_lowercase())
                        .unwrap_or_default();

                    if !WATCH_EXTENSIONS.contains(&ext.as_str()) {
                        continue;
                    }

                    // Ignore temporary / partial files
                    let filename = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or_default();
                    if filename.starts_with('.') || filename.ends_with(".tmp") || filename.ends_with(".crdownload") || filename.starts_with('~') {
                        continue;
                    }

                    let canonical_key = path.to_string_lossy().to_string();
                    if processed.contains(&canonical_key) {
                        continue;
                    }

                    // Check file size stability (ensure external write/copy has finished)
                    let current_size = match std::fs::metadata(&path) {
                        Ok(m) => m.len(),
                        Err(_) => continue,
                    };

                    if current_size == 0 {
                        continue;
                    }

                    let entry_stat = file_sizes.entry(path.clone()).or_insert((current_size, 0));
                    if entry_stat.0 == current_size {
                        entry_stat.1 += 1;
                    } else {
                        *entry_stat = (current_size, 1);
                    }

                    // Must remain stable for at least 2 checks (5-10 seconds)
                    if entry_stat.1 >= 2 {
                        // Check if file is readable (not locked by writing process)
                        if let Ok(file) = std::fs::File::open(&path) {
                            drop(file);
                            file_sizes.remove(&path);

                            info!("📂 Watch folder found new file: {:?}", path);
                            processed.insert(canonical_key.clone());
                            newly_processed = true;

                            let _ = app.emit(
                                "watch-folder-importing",
                                serde_json::json!({
                                    "filename": filename,
                                    "folder": folder_str,
                                    "path": canonical_key,
                                }),
                            );

                            let app_clone = app.clone();
                            let file_path_str = canonical_key.clone();
                            let title = path
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or("Imported Recording")
                                .to_string();

                            tauri::async_runtime::spawn(async move {
                                let res = crate::audio::import::start_import(
                                    app_clone,
                                    file_path_str,
                                    title,
                                    None,
                                    None,
                                    None,
                                    Some(true),
                                    None,
                                    None,
                                )
                                .await;

                                if let Err(e) = res {
                                    error!("Watch folder import failed: {}", e);
                                }
                            });
                        }
                    }
                }
            }

            if newly_processed {
                let _ = save_processed(&processed);
            }
        }
    });
}

// ----------------------------------------------------------------------------
// Tauri IPC Commands
// ----------------------------------------------------------------------------

#[tauri::command]
pub async fn api_get_watch_folders() -> Result<WatchFolderConfig, String> {
    Ok(load_config())
}

#[tauri::command]
pub async fn api_set_watch_folders(
    enabled: bool,
    folders: Vec<String>,
) -> Result<WatchFolderConfig, String> {
    let clean_folders: Vec<String> = folders
        .into_iter()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect();

    let config = WatchFolderConfig {
        enabled,
        folders: clean_folders,
    };
    save_config(&config).map_err(|e| e.to_string())?;
    Ok(config)
}

#[tauri::command]
pub async fn api_add_watch_folder(folder: String) -> Result<WatchFolderConfig, String> {
    let mut config = load_config();
    let folder_trim = folder.trim().to_string();
    if !folder_trim.is_empty() && !config.folders.contains(&folder_trim) {
        config.folders.push(folder_trim);
        save_config(&config).map_err(|e| e.to_string())?;
    }
    Ok(config)
}

#[tauri::command]
pub async fn api_remove_watch_folder(folder: String) -> Result<WatchFolderConfig, String> {
    let mut config = load_config();
    config.folders.retain(|f| f != folder.trim());
    save_config(&config).map_err(|e| e.to_string())?;
    Ok(config)
}

#[tauri::command]
pub async fn api_pick_watch_folder<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(app
            .dialog()
            .file()
            .set_title("Choose Folder to Watch")
            .blocking_pick_folder()
            .map(|path| path.to_string()))
    })
    .await
    .map_err(|error| format!("Watch folder dialog failed: {error}"))?
}

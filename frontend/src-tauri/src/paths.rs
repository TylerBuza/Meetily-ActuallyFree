//! Platform-safe local path resolution.
//!
//! Windows and Linux prefer a self-contained `data` directory beside the
//! executable. macOS always uses `~/Library/Application Support/Meetily` because
//! its executable lives inside the signed app bundle; writing runtime data there
//! invalidates the bundle signature.
//!
//! On portable platforms, everything is placed under `<exe_dir>/data`. If that
//! directory is not writable (for example, under `C:\Program Files`), storage
//! transparently falls back to the OS data directory.

use std::path::PathBuf;
use std::sync::OnceLock;

/// The subfolder (relative to the executable) that holds portable app data.
#[cfg(not(target_os = "macos"))]
const DATA_SUBDIR: &str = "data";
/// Folder name used under the OS data directory.
const FALLBACK_APP_NAME: &str = "Meetily";
/// Bundle identifier of earlier macOS builds, shared with upstream Meetily.
/// Still the identifier on Windows/Linux.
const LEGACY_IDENTIFIER: &str = "com.meetily.ai";

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Returns the app-managed data root, creating it if needed. Resolved once and
/// cached for the lifetime of the process.
///
/// This is the single source of truth that replaces every previous use of
/// Tauri's `app_data_dir()` and `dirs::data_dir()` for app-managed storage.
pub fn install_data_root() -> PathBuf {
    ROOT.get_or_init(|| {
        #[cfg(target_os = "macos")]
        {
            let root = os_data_root();
            log::info!("📁 macOS data root: {}", root.display());
            root
        }

        #[cfg(not(target_os = "macos"))]
        {
            // Preferred: next to the executable, under `data/`.
            if let Some(exe_dir) = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            {
                let candidate = exe_dir.join(DATA_SUBDIR);
                if ensure_writable(&candidate) {
                    log::info!("📁 Portable data root: {}", candidate.display());
                    return candidate;
                }
                log::warn!(
                    "Install directory not writable ({}); falling back to OS data dir",
                    candidate.display()
                );
            }

            let fallback = os_data_root();
            log::info!("📁 Fallback data root: {}", fallback.display());
            fallback
        }
    })
    .clone()
}

fn os_data_root() -> PathBuf {
    let root = dirs::data_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(FALLBACK_APP_NAME);
    let _ = std::fs::create_dir_all(&root);
    root
}

/// Directory that holds all downloaded speech/LLM models
/// (`<root>/models`). Mirrors the previous `app_data_dir/models` layout.
pub fn models_dir() -> PathBuf {
    let dir = install_data_root().join("models");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// One-time, non-destructive migration of a previous (scattered) install.
///
/// Earlier builds stored data under the OS application-data directory
/// (`%APPDATA%\<id>` / `~/Library/Application Support/<id>`). To honor the
/// current layout without forcing users to re-download gigabytes of models or
/// lose meeting history, on first run we COPY the known legacy items into the
/// current data root. The original files are left
/// untouched (users can delete the old folder afterward). Guarded by a marker
/// file so it only ever runs once, and best-effort so it can never break start.
pub fn migrate_legacy_data<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;

    let root = install_data_root();
    let marker = root.join(".migrated_from_appdata");
    if marker.exists() {
        return;
    }

    // The legacy OS app-data directory (what old builds used).
    let legacy = match legacy_app_data_dir(app) {
        Some(p) => p,
        None => {
            let _ = std::fs::write(&marker, b"no-legacy");
            return;
        }
    };

    if legacy == root || !legacy.exists() {
        let _ = std::fs::write(&marker, b"no-legacy");
        return;
    }

    log::info!(
        "🚚 Portable migration: checking legacy data at {}",
        legacy.display()
    );

    // Known app-managed items. Only copied when missing locally, so re-running
    // (marker deleted) never clobbers newer local data.
    const ITEMS: [&str; 6] = [
        "models",
        "templates",
        "meeting_minutes.sqlite",
        "meeting_minutes.db",
        "notifications.json",
        "recordings",
    ];

    let mut copied_any = false;
    for item in ITEMS {
        let src = legacy.join(item);
        let dst = root.join(item);
        if src.exists() && !dst.exists() {
            log::info!("🚚 Migrating '{}' → {}", item, dst.display());
            match copy_path_recursive(&src, &dst) {
                Ok(_) => copied_any = true,
                Err(e) => log::warn!("Migration of '{}' failed (skipping): {}", item, e),
            }
        }
    }

    if copied_any {
        log::info!("✅ Portable migration complete. You can delete the old folder: {}", legacy.display());
    } else {
        log::info!("Portable migration: nothing to migrate.");
    }

    let _ = std::fs::write(&marker, b"done");
}

/// Tauri's app-data directory under the legacy identifier. Equal to
/// `app_data_dir()` wherever the identifier is unchanged.
fn legacy_app_data_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    use tauri::Manager;
    Some(app.path().app_data_dir().ok()?.with_file_name(LEGACY_IDENTIFIER))
}

/// One-time copy of Tauri plugin stores (onboarding, recording preferences, …)
/// from the legacy identifier's app-data dir, so a new bundle identifier keeps
/// the user's settings. Must run before any `app.store(...)` call.
pub fn migrate_plugin_stores<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;

    let (Ok(current), Some(legacy)) = (app.path().app_data_dir(), legacy_app_data_dir(app)) else {
        return;
    };
    if current == legacy {
        return;
    }
    let marker = current.join(".migrated_plugin_stores");
    if marker.exists() {
        return;
    }
    match copy_missing_json_files(&legacy, &current) {
        Ok(n) if n > 0 => log::info!("🚚 Migrated {} settings file(s) from {}", n, legacy.display()),
        Ok(_) => {}
        Err(e) => log::warn!("Settings migration from {} failed: {}", legacy.display(), e),
    }
    let _ = std::fs::create_dir_all(&current);
    let _ = std::fs::write(&marker, b"done");
}

/// Copy top-level `*.json` files from `src` into `dst` unless `dst` already has
/// them. A missing `src` copies nothing. Returns the number of files copied.
fn copy_missing_json_files(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<usize> {
    let entries = match std::fs::read_dir(src) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let mut copied = 0;
    for entry in entries {
        let from = entry?.path();
        let Some(name) = from.file_name() else { continue };
        let to = dst.join(name);
        if from.is_file() && from.extension().is_some_and(|ext| ext == "json") && !to.exists() {
            std::fs::create_dir_all(dst)?;
            std::fs::copy(&from, &to)?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// Recursively copy a file or directory. Best-effort: per-entry failures are
/// propagated so the caller can log, but partial progress is retained.
fn copy_path_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            let from = entry.path();
            let to = dst.join(entry.file_name());
            copy_path_recursive(&from, &to)?;
        }
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dst)?;
    }
    Ok(())
}

/// Ensure `dir` exists and is writable by probing an actual file write.
#[cfg(not(target_os = "macos"))]
fn ensure_writable(dir: &PathBuf) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write_test");
    match std::fs::write(&probe, b"ok") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::copy_missing_json_files;

    #[test]
    fn copies_only_missing_top_level_json_files() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("onboarding-status.json"), "old").unwrap();
        std::fs::write(src.path().join("recording_preferences.json"), "old").unwrap();
        std::fs::write(src.path().join("meeting_minutes.sqlite"), "db").unwrap();
        std::fs::create_dir(src.path().join("models")).unwrap();
        std::fs::write(dst.path().join("recording_preferences.json"), "new").unwrap();

        assert_eq!(copy_missing_json_files(src.path(), dst.path()).unwrap(), 1);
        let read = |name| std::fs::read_to_string(dst.path().join(name)).unwrap();
        assert_eq!(read("onboarding-status.json"), "old");
        assert_eq!(read("recording_preferences.json"), "new");
        assert!(!dst.path().join("meeting_minutes.sqlite").exists());
        assert!(!dst.path().join("models").exists());
        assert_eq!(copy_missing_json_files(&src.path().join("absent"), dst.path()).unwrap(), 0);
    }
}

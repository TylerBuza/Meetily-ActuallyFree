//! Portable / install-local path resolution.
//!
//! Meetily - Actually Free is designed to be **self-contained**: every piece of
//! runtime data it manages (Whisper/Parakeet/built-in LLM models, the SQLite
//! database, summary templates, notification settings, caches) lives inside the
//! program's own install directory instead of being scattered across
//! `%APPDATA%` (Windows) or `~/Library/Application Support` (macOS).
//!
//! Everything is placed under `<exe_dir>/data`, keeping the executable folder
//! tidy while guaranteeing the whole app "travels together" — copy/move the
//! install folder and all models + history come with it.
//!
//! If the executable directory is not writable (e.g. the app was installed into
//! a read-only location such as `C:\Program Files`), we transparently fall back
//! to the OS data directory so the app still works.

use std::path::PathBuf;
use std::sync::OnceLock;

/// The subfolder (relative to the executable) that holds all app data.
const DATA_SUBDIR: &str = "data";
/// Fallback folder name used under the OS data dir when the install directory
/// is not writable.
const FALLBACK_APP_NAME: &str = "Meetily";

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Returns the install-local data root (`<exe_dir>/data`), creating it if
/// needed. Resolved once and cached for the lifetime of the process.
///
/// This is the single source of truth that replaces every previous use of
/// Tauri's `app_data_dir()` and `dirs::data_dir()` for app-managed storage.
pub fn install_data_root() -> PathBuf {
    ROOT.get_or_init(|| {
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

        // Fallback: OS data dir under our app name (keeps the app functional
        // even from a read-only install location).
        let fallback = dirs::data_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(FALLBACK_APP_NAME);
        let _ = std::fs::create_dir_all(&fallback);
        log::info!("📁 Fallback data root: {}", fallback.display());
        fallback
    })
    .clone()
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
/// portable design without forcing users to re-download gigabytes of models or
/// lose meeting history, on first run of the portable build we COPY the known
/// legacy items into the install-local root. The original files are left
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
    let legacy = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(_) => {
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

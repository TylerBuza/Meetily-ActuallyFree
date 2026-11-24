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

/// Carries user state over from the legacy bundle identifier (`com.meetily.ai`)
/// when this build uses another one (macOS). A no-op where the identifier is
/// unchanged (Windows/Linux).
///
/// Must run before `tauri::Builder` builds the app: Tauri creates the config
/// window, and with it the WKWebView and its website-data store, *before* the
/// `setup` hook runs, and plugin stores must not be opened before they exist.
///
/// Returns true when the onboarding status was carried over. Onboarding is then
/// skipped, but macOS privacy grants (Microphone, Audio Capture) are keyed by
/// bundle identifier and do not carry over, so the caller must ask for them
/// again.
pub fn migrate_from_legacy_identifier(identifier: &str) -> bool {
    if identifier == LEGACY_IDENTIFIER {
        return false;
    }
    #[cfg(target_os = "macos")]
    migrate_webview_storage(identifier);

    // Tauri's `app_data_dir()` is `<OS data dir>/<identifier>` on every
    // platform; no AppHandle exists yet.
    let Some(data_dir) = dirs::data_dir() else { return false };
    migrate_plugin_stores(&data_dir.join(LEGACY_IDENTIFIER), &data_dir.join(identifier))
}

/// One-time copy of Tauri plugin stores (onboarding, recording preferences, …)
/// from the legacy identifier's app-data dir, so a new bundle identifier keeps
/// the user's settings. The marker is written only after a complete copy, so a
/// failed attempt is retried on the next launch (files already copied are kept).
/// Returns true when `onboarding-status.json` was copied in this run.
fn migrate_plugin_stores(legacy: &std::path::Path, current: &std::path::Path) -> bool {
    let marker = current.join(".migrated_plugin_stores");
    if marker.exists() {
        return false;
    }
    match copy_missing_json_files(legacy, current) {
        Ok(copied) => {
            if !copied.is_empty() {
                log::info!("🚚 Migrated settings {:?} from {}", copied, legacy.display());
            }
            if let Err(e) = std::fs::create_dir_all(current)
                .and_then(|_| std::fs::write(&marker, b"done"))
            {
                log::warn!("Could not record settings migration in {}: {}", current.display(), e);
            }
            copied.iter().any(|name| name == "onboarding-status.json")
        }
        Err(e) => {
            log::warn!("Settings migration from {} failed (will retry next launch): {}", legacy.display(), e);
            false
        }
    }
}

/// Copy top-level `*.json` files from `src` into `dst` unless `dst` already has
/// them. A missing `src` copies nothing. Each file is written to a temporary
/// name and renamed, so an interrupted copy never leaves a truncated store
/// that would block a retry. Returns the names of the files copied.
fn copy_missing_json_files(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<Vec<String>> {
    let entries = match std::fs::read_dir(src) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut copied = Vec::new();
    for entry in entries {
        let from = entry?.path();
        let Some(name) = from.file_name().and_then(|n| n.to_str()) else { continue };
        let to = dst.join(name);
        if from.is_file() && from.extension().is_some_and(|ext| ext == "json") && !to.exists() {
            std::fs::create_dir_all(dst)?;
            let partial = dst.join(format!(".{name}.migrating"));
            std::fs::copy(&from, &partial)?;
            std::fs::rename(&partial, &to)?;
            copied.push(name.to_string());
        }
    }
    Ok(copied)
}

/// One-time copy of the WKWebView website data (localStorage: Labs, name,
/// theme, languages, provider/model map; IndexedDB: transcript recovery) from
/// `~/Library/WebKit/com.meetily.ai`. The page origin (`tauri://localhost`) is
/// identical, so the copied data applies unchanged.
///
/// WebKit names each origin's folder under `WebsiteData/Default/` by hashing
/// the origin with `WebsiteData/Default/salt`, so the whole `WebsiteData` tree
/// (salt included) is copied, never merged. It is assembled in a staging
/// folder and renamed into place, and only when the new store holds no
/// website data yet: a store the new identifier has already used is never
/// replaced. That check, not a marker, makes this one-time.
#[cfg(target_os = "macos")]
fn migrate_webview_storage(identifier: &str) {
    // An unbundled dev binary keys its WebKit store by executable name, not
    // by identifier; leave it alone.
    let bundled = std::env::current_exe()
        .map(|exe| exe.ancestors().any(|dir| dir.extension().is_some_and(|ext| ext == "app")))
        .unwrap_or(false);
    if !bundled {
        return;
    }
    let Some(webkit) = dirs::home_dir().map(|home| home.join("Library/WebKit")) else { return };
    match replace_unused_website_data(
        &webkit.join(LEGACY_IDENTIFIER).join("WebsiteData"),
        &webkit.join(identifier).join("WebsiteData"),
    ) {
        Ok(true) => log::info!("🚚 Migrated WebView storage from {}", webkit.join(LEGACY_IDENTIFIER).display()),
        Ok(false) => {}
        Err(e) => log::warn!("WebView storage migration failed (will retry next launch): {}", e),
    }
}

/// Replace `current` with a copy of `legacy` when `legacy` has website data and
/// `current` has none. Returns whether a copy was made.
#[cfg(any(target_os = "macos", test))]
fn replace_unused_website_data(legacy: &std::path::Path, current: &std::path::Path) -> std::io::Result<bool> {
    if !has_website_data(legacy) || has_website_data(current) {
        return Ok(false);
    }
    let parent = current.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
    let staging = parent.join(".WebsiteData.migrating");
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    copy_path_recursive(legacy, &staging)?;
    // `current` may exist from a launch that created the store but stored
    // nothing; it holds no origin data (checked above).
    if current.exists() {
        std::fs::remove_dir_all(current)?;
    }
    std::fs::rename(&staging, current)?;
    Ok(true)
}

/// Whether a WebKit `WebsiteData` folder holds per-origin storage: an origin
/// folder under `Default/` (current partitioned layout; `Default/salt` is a
/// file), or entries in the older flat `LocalStorage/` / `IndexedDB/` folders.
/// A freshly created store has only the empty skeleton and databases such as
/// `ResourceLoadStatistics`, which do not count.
#[cfg(any(target_os = "macos", test))]
fn has_website_data(website_data: &std::path::Path) -> bool {
    let entries = |dir: &str| {
        std::fs::read_dir(website_data.join(dir)).into_iter().flatten().flatten().map(|e| e.path())
    };
    entries("Default").any(|p| p.is_dir())
        || entries("IndexedDB").any(|p| p.is_dir())
        || entries("LocalStorage").any(|p| p.extension().is_some_and(|ext| ext == "localstorage"))
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
    use super::{copy_missing_json_files, has_website_data, migrate_plugin_stores, replace_unused_website_data};
    use std::fs;
    use std::path::Path;

    #[test]
    fn copies_only_missing_top_level_json_files() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        fs::write(src.path().join("onboarding-status.json"), "old").unwrap();
        fs::write(src.path().join("recording_preferences.json"), "old").unwrap();
        fs::write(src.path().join("meeting_minutes.sqlite"), "db").unwrap();
        fs::create_dir(src.path().join("models")).unwrap();
        fs::write(dst.path().join("recording_preferences.json"), "new").unwrap();

        assert_eq!(copy_missing_json_files(src.path(), dst.path()).unwrap(), vec!["onboarding-status.json"]);
        let read = |name| fs::read_to_string(dst.path().join(name)).unwrap();
        assert_eq!(read("onboarding-status.json"), "old");
        assert_eq!(read("recording_preferences.json"), "new");
        assert!(!dst.path().join("meeting_minutes.sqlite").exists());
        assert!(!dst.path().join("models").exists());
        assert!(copy_missing_json_files(&src.path().join("absent"), dst.path()).unwrap().is_empty());
    }

    #[test]
    fn plugin_store_marker_is_written_only_after_a_successful_copy() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("legacy");
        let current = root.path().join("current");
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("onboarding-status.json"), "old").unwrap();
        // A file where the destination folder should be makes the copy fail.
        fs::write(&current, "not a directory").unwrap();

        assert!(!migrate_plugin_stores(&legacy, &current));
        fs::remove_file(&current).unwrap();
        assert!(!current.join(".migrated_plugin_stores").exists());

        // Retried on the next launch, then recorded and not repeated.
        assert!(migrate_plugin_stores(&legacy, &current));
        assert!(current.join(".migrated_plugin_stores").exists());
        fs::remove_file(current.join("onboarding-status.json")).unwrap();
        assert!(!migrate_plugin_stores(&legacy, &current));
    }

    /// The layout WebKit creates under `~/Library/WebKit/<id>/WebsiteData`.
    fn website_data(dir: &Path, salt: &str, origin_dir: Option<&str>) {
        for sub in ["Default", "IndexedDB", "LocalStorage", "ResourceLoadStatistics"] {
            fs::create_dir_all(dir.join(sub)).unwrap();
        }
        fs::write(dir.join("Default/salt"), salt).unwrap();
        fs::write(dir.join("ResourceLoadStatistics/observations.db"), "stats").unwrap();
        if let Some(origin) = origin_dir {
            let storage = dir.join("Default").join(origin).join(origin).join("LocalStorage");
            fs::create_dir_all(&storage).unwrap();
            fs::write(storage.join("localstorage.sqlite3"), salt).unwrap();
        }
    }

    #[test]
    fn website_data_requires_origin_storage() {
        let root = tempfile::tempdir().unwrap();
        let fresh = root.path().join("fresh");
        website_data(&fresh, "new-salt", None);
        assert!(!has_website_data(&fresh));
        assert!(!has_website_data(&root.path().join("absent")));

        let used = root.path().join("used");
        website_data(&used, "old-salt", Some("hash"));
        assert!(has_website_data(&used));

        let flat = root.path().join("flat");
        fs::create_dir_all(flat.join("LocalStorage")).unwrap();
        fs::write(flat.join("LocalStorage/tauri_localhost_0.localstorage"), "x").unwrap();
        assert!(has_website_data(&flat));
    }

    #[test]
    fn website_data_replaces_a_fresh_store_with_the_legacy_one() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("com.meetily.ai/WebsiteData");
        let current = root.path().join("new.id/WebsiteData");
        website_data(&legacy, "old-salt", Some("hash"));

        // First launch: nothing exists yet for the new identifier.
        assert!(replace_unused_website_data(&legacy, &current).unwrap());
        assert_eq!(fs::read_to_string(current.join("Default/salt")).unwrap(), "old-salt");
        assert!(current.join("Default/hash/hash/LocalStorage/localstorage.sqlite3").exists());
        assert!(legacy.join("Default/hash").exists(), "the legacy store is left in place");
        assert!(!root.path().join("new.id/.WebsiteData.migrating").exists());

        // Already migrated (or used): never replaced again.
        assert!(!replace_unused_website_data(&legacy, &current).unwrap());

        // A store the new identifier created but never stored data in is replaced
        // whole, salt included, so origin folder names keep matching.
        fs::remove_dir_all(&current).unwrap();
        website_data(&current, "new-salt", None);
        assert!(replace_unused_website_data(&legacy, &current).unwrap());
        assert_eq!(fs::read_to_string(current.join("Default/salt")).unwrap(), "old-salt");
        assert_eq!(
            fs::read_to_string(current.join("ResourceLoadStatistics/observations.db")).unwrap(),
            "stats"
        );

        // Nothing to migrate from.
        let empty = root.path().join("other.id/WebsiteData");
        assert!(!replace_unused_website_data(&root.path().join("absent"), &empty).unwrap());
        assert!(!empty.exists());
    }
}

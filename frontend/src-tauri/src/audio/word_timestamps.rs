//! Opt-in word-level timestamping for transcripts and interactive playback sync.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static ENABLED: OnceLock<AtomicBool> = OnceLock::new();

fn path() -> std::path::PathBuf {
    crate::paths::install_data_root().join("word_timestamps_enabled.txt")
}

fn flag() -> &'static AtomicBool {
    ENABLED.get_or_init(|| {
        let saved = std::fs::read_to_string(path())
            .map(|value| value.trim() == "true")
            .unwrap_or(false);
        AtomicBool::new(saved)
    })
}

pub fn enabled() -> bool {
    flag().load(Ordering::Relaxed)
}

#[tauri::command]
pub fn get_word_timestamps_enabled() -> bool {
    enabled()
}

#[tauri::command]
pub fn set_word_timestamps_enabled(value: bool) -> Result<(), String> {
    let file = path();
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(file, if value { "true" } else { "false" })
        .map_err(|error| error.to_string())?;
    flag().store(value, Ordering::Relaxed);
    Ok(())
}

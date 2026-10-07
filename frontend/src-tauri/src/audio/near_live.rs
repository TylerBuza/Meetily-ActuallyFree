//! Opt-in near-live caption segmentation. This changes only future capture
//! sessions; the saved transcription path still owns final transcript turns.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tokio::sync::{mpsc, watch};
use super::AudioChunk;

static ENABLED: OnceLock<AtomicBool> = OnceLock::new();

fn path() -> std::path::PathBuf {
    crate::paths::install_data_root().join("near_live_captions_enabled.txt")
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

/// Cut continuous speech at a quiet frame even without a VAD pause.
pub fn vad_timing(near_live: bool, real_time: bool) -> (u32, u32) {
    if near_live { (350, 2000) } else if real_time { (350, 3500) } else { (800, 6000) }
}

// Watch channels keep only the newest provisional window per source. Capture
// never waits for ASR, and a slow decoder cannot build an unbounded preview queue.
#[derive(Clone)]
pub struct PreviewSenders {
    pub microphone: watch::Sender<Option<AudioChunk>>,
    pub system: watch::Sender<Option<AudioChunk>>,
}

#[derive(Debug)]
pub struct LiveTranscriptionInputs {
    pub final_chunks: mpsc::UnboundedReceiver<AudioChunk>,
    pub microphone_previews: watch::Receiver<Option<AudioChunk>>,
    pub system_previews: watch::Receiver<Option<AudioChunk>>,
}

#[cfg(test)]
mod tests {
    use super::vad_timing;
    #[test]
    fn near_live_caps_continuous_speech() {
        assert_eq!(vad_timing(true, false), (350, 2000));
        assert_eq!(vad_timing(true, true), (350, 2000));
        assert_eq!(vad_timing(false, true), (350, 3500));
        assert_eq!(vad_timing(false, false), (800, 6000));
    }
}

#[tauri::command]
pub fn get_near_live_captions_enabled() -> bool {
    enabled()
}

#[tauri::command]
pub fn set_near_live_captions_enabled(value: bool) -> Result<(), String> {
    let file = path();
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(file, if value { "true" } else { "false" })
        .map_err(|error| error.to_string())?;
    flag().store(value, Ordering::Relaxed);
    Ok(())
}

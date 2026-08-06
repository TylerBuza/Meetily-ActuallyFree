//! Meeting Detection.
//!
//! A lightweight background monitor that watches the list of running processes
//! and, when it sees a known meeting/conferencing app start (Zoom, Teams,
//! Slack huddles, Webex, …), emits a `meeting-detected` event so the
//! UI can offer a one-click "Start recording". Fully local — no network, no
//! telemetry; just process-name matching via `sysinfo`.
//!
//! Everything is user-configurable and persisted install-locally in
//! `meeting_detection.json`: the poll interval, the list of app keywords to
//! watch, and an "ignored apps" list to suppress false positives.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime};

/// Global run flag for the monitor loop. Setting this to `false` makes the
/// currently-running loop exit on its next tick.
static MONITOR_RUNNING: AtomicBool = AtomicBool::new(false);
/// Current settings, shared with the running loop so changes apply live.
static SETTINGS: Mutex<Option<MeetingDetectionSettings>> = Mutex::new(None);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MeetingDetectionSettings {
    /// Master on/off switch.
    pub enabled: bool,
    /// How often to scan the process list, in seconds.
    pub interval_secs: u64,
    /// Process-name keywords that indicate a meeting app (matched
    /// case-insensitively as substrings of the executable name).
    pub meeting_apps: Vec<String>,
    /// Process-name keywords to always ignore (suppress false positives).
    pub ignored_apps: Vec<String>,
    /// Also raise a native OS notification (handled on the frontend) in
    /// addition to the in-app prompt.
    pub notify: bool,
}

impl Default for MeetingDetectionSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_secs: 15,
            meeting_apps: default_meeting_apps(),
            ignored_apps: Vec::new(),
            notify: true,
        }
    }
}

/// Default keyword list. Deliberately excludes bare "meet" to avoid matching
/// this app's own process ("meetily") and unrelated software.
fn default_meeting_apps() -> Vec<String> {
    [
        "zoom",
        "teams",
        "msteams",
        "slack",
        "webex",
        "gotomeeting",
        "bluejeans",
        "chime",
        "skype",
        "ringcentral",
        "whereby",
        "jitsi",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Map a matched keyword to a friendly display name for the notification.
fn friendly_name(keyword: &str) -> String {
    match keyword {
        "zoom" => "Zoom",
        "teams" | "msteams" => "Microsoft Teams",
        "slack" => "Slack",
        "webex" => "Webex",
        "gotomeeting" => "GoToMeeting",
        "bluejeans" => "BlueJeans",
        "chime" => "Amazon Chime",
        "skype" => "Skype",
        "ringcentral" => "RingCentral",
        "whereby" => "Whereby",
        "jitsi" => "Jitsi",
        other => other,
    }
    .to_string()
}

fn config_path() -> std::path::PathBuf {
    crate::paths::install_data_root().join("meeting_detection.json")
}

fn load_settings_from_disk() -> MeetingDetectionSettings {
    let path = config_path();
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(mut settings) = serde_json::from_slice::<MeetingDetectionSettings>(&bytes) {
            sanitize_settings(&mut settings);
            return settings;
        }
    }
    MeetingDetectionSettings::default()
}

/// Drop keywords we no longer detect from a loaded config. Discord was removed
/// from the default list, but existing installs may still have it persisted in
/// `meeting_detection.json`; strip it here so it isn't detected anymore.
fn sanitize_settings(settings: &mut MeetingDetectionSettings) {
    settings
        .meeting_apps
        .retain(|k| k.trim().to_lowercase() != "discord");
}

fn save_settings_to_disk(settings: &MeetingDetectionSettings) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// Payload emitted when a meeting app is detected.
#[derive(Clone, Serialize)]
struct MeetingDetectedPayload {
    /// Friendly app name, e.g. "Zoom".
    app: String,
    /// Raw process name that matched, e.g. "zoom.exe".
    process: String,
    /// Whether the user asked for a native notification too.
    notify: bool,
}

/// Scan the process list once and, if a (non-ignored) meeting app is present,
/// return `(friendly_name, process_name)`.
///
/// On Windows we prefer apps that are *actively* using the microphone or camera
/// (CapabilityAccessManager "in use" markers). Process-only matches still work as
/// a fallback when no capability signal is available.
fn scan_for_meeting_app(settings: &MeetingDetectionSettings) -> Option<(String, String)> {
    use sysinfo::System;

    let mut sys = System::new_all();
    sys.refresh_all();

    let ignored: Vec<String> = settings
        .ignored_apps
        .iter()
        .map(|s| s.to_lowercase())
        .filter(|s| !s.trim().is_empty())
        .collect();

    #[cfg(windows)]
    let media_in_use = windows_media_in_use_exes();
    #[cfg(not(windows))]
    let media_in_use: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Prefer a meeting app that is currently holding mic or camera.
    if !media_in_use.is_empty() {
        for process in sys.processes().values() {
            let name = process.name().to_string_lossy().to_lowercase();
            if name.is_empty() {
                continue;
            }
            if ignored.iter().any(|ig| name.contains(ig)) {
                continue;
            }
            let stem = name.trim_end_matches(".exe");
            if !media_in_use.iter().any(|m| m.contains(stem) || stem.contains(m.as_str())) {
                continue;
            }
            for keyword in &settings.meeting_apps {
                let kw = keyword.trim().to_lowercase();
                if kw.is_empty() {
                    continue;
                }
                if process_matches_keyword(&name, &kw) {
                    return Some((friendly_name(&kw), name));
                }
            }
        }
        // Mic/cam in use by something that isn't a known meeting keyword —
        // still surface a soft signal so the user can record.
        if let Some(exe) = media_in_use.iter().next() {
            let label = exe
                .trim_end_matches(".exe")
                .split(|c: char| !c.is_ascii_alphanumeric())
                .find(|t| t.len() > 2)
                .unwrap_or("Meeting app");
            let pretty = {
                let mut c = label.chars();
                match c.next() {
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                    None => "Meeting app".into(),
                }
            };
            return Some((pretty, exe.clone()));
        }
    }

    // Fallback: process name only (macOS/Linux, or Windows when CAM has no signal).
    for process in sys.processes().values() {
        let name = process.name().to_string_lossy().to_lowercase();
        if name.is_empty() {
            continue;
        }
        if ignored.iter().any(|ig| name.contains(ig)) {
            continue;
        }
        for keyword in &settings.meeting_apps {
            let kw = keyword.trim().to_lowercase();
            if kw.is_empty() {
                continue;
            }
            if process_matches_keyword(&name, &kw) {
                return Some((friendly_name(&kw), name));
            }
        }
    }
    None
}

/// Windows: executables currently holding microphone or webcam via
/// CapabilityAccessManager NonPackaged consent-store entries
/// (LastUsedTimeStart > LastUsedTimeStop ⇒ in use).
#[cfg(windows)]
fn windows_media_in_use_exes() -> std::collections::HashSet<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let mut out = std::collections::HashSet::new();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for cap in ["microphone", "webcam"] {
        let path = format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\{cap}\\NonPackaged"
        );
        let Ok(root) = hkcu.open_subkey(&path) else {
            continue;
        };
        let Ok(keys) = root.enum_keys().collect::<Result<Vec<_>, _>>() else {
            continue;
        };
        for key_name in keys {
            let Ok(sub) = root.open_subkey(&key_name) else {
                continue;
            };
            // Values are FILETIME-like u64; Start > Stop means currently open.
            let start: u64 = sub.get_value("LastUsedTimeStart").unwrap_or(0);
            let stop: u64 = sub.get_value("LastUsedTimeStop").unwrap_or(0);
            if start == 0 {
                continue;
            }
            // 0xFFFFFFFFFFFFFFFF stop means "still in use" on some builds;
            // otherwise start > stop.
            let in_use = stop == u64::MAX || start > stop;
            if !in_use {
                continue;
            }
            // Key names look like C:#Program Files#...#Teams.exe
            let exe = key_name
                .rsplit('#')
                .next()
                .unwrap_or(&key_name)
                .to_lowercase();
            if exe.ends_with(".exe") {
                out.insert(exe);
            }
        }
    }
    out
}

/// Does a process name match a meeting-app keyword?
///
/// We deliberately do NOT use a raw substring test. Naive `contains("teams")`
/// famously matches `steamservice.exe` (Steam) — `s[teams]ervice` — and reports
/// a phantom "Microsoft Teams meeting." Instead we split the process name into
/// alphanumeric tokens (so `.exe`, `-`, `_`, spaces, and digits are boundaries)
/// and require a *token* to start with the keyword. This keeps forgiving
/// matches that should work — `ms-teams.exe` -> ["ms","teams"], `webexmta.exe`
/// -> ["webexmta"] — while rejecting keywords buried mid-word like the Steam
/// service.
fn process_matches_keyword(process_name: &str, keyword: &str) -> bool {
    process_name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|token| !token.is_empty() && token.starts_with(keyword))
}

#[cfg(test)]
mod tests {
    use super::process_matches_keyword;

    #[test]
    fn matches_real_meeting_apps() {
        assert!(process_matches_keyword("teams.exe", "teams"));
        assert!(process_matches_keyword("ms-teams.exe", "teams"));
        assert!(process_matches_keyword("msteams.exe", "msteams"));
        assert!(process_matches_keyword("zoom.exe", "zoom"));
        assert!(process_matches_keyword("webexmta.exe", "webex"));
        assert!(process_matches_keyword("slack.exe", "slack"));
    }

    #[test]
    fn rejects_mid_word_false_positives() {
        // The reported bug: Steam's service is not a Teams meeting.
        assert!(!process_matches_keyword("steamservice.exe", "teams"));
        assert!(!process_matches_keyword("steam.exe", "teams"));
        assert!(!process_matches_keyword("steamwebhelper.exe", "teams"));
    }
}

/// Start (or restart) the background monitor with the given settings.
fn start_monitor<R: Runtime>(app: &AppHandle<R>) {
    // Signal any existing loop to stop, then start a fresh one.
    MONITOR_RUNNING.store(false, Ordering::SeqCst);

    let settings = {
        let guard = SETTINGS.lock().unwrap();
        guard.clone().unwrap_or_default()
    };
    if !settings.enabled {
        log::info!("Meeting detection disabled; monitor not started");
        return;
    }

    MONITOR_RUNNING.store(true, Ordering::SeqCst);
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        log::info!("🔍 Meeting detection monitor started");
        // Whether we've already alerted for the currently-ongoing meeting app,
        // so we prompt once per meeting rather than every tick.
        let mut alerted = false;

        // Give the loop a moment before the first heavy scan.
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        while MONITOR_RUNNING.load(Ordering::SeqCst) {
            let current = {
                let guard = SETTINGS.lock().unwrap();
                guard.clone().unwrap_or_default()
            };
            if !current.enabled {
                break;
            }

            match scan_for_meeting_app(&current) {
                Some((friendly, process)) => {
                    if !alerted {
                        alerted = true;
                        log::info!("🔔 Meeting app detected: {} ({})", friendly, process);
                        let _ = app.emit(
                            "meeting-detected",
                            MeetingDetectedPayload {
                                app: friendly,
                                process,
                                notify: current.notify,
                            },
                        );
                    }
                }
                None => {
                    // Meeting app closed — re-arm so the next meeting prompts again.
                    alerted = false;
                }
            }

            let interval = current.interval_secs.clamp(3, 3600);
            tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
        }

        MONITOR_RUNNING.store(false, Ordering::SeqCst);
        log::info!("🔍 Meeting detection monitor stopped");
    });
}

/// Called once at app startup to load persisted settings and start the monitor
/// if the user had it enabled.
pub fn initialize<R: Runtime>(app: &AppHandle<R>) {
    let settings = load_settings_from_disk();
    {
        let mut guard = SETTINGS.lock().unwrap();
        *guard = Some(settings.clone());
    }
    if settings.enabled {
        start_monitor(app);
    }
}

// ============================================================================
// Tauri commands
// ============================================================================

#[tauri::command]
pub async fn get_meeting_detection_settings() -> Result<MeetingDetectionSettings, String> {
    let guard = SETTINGS.lock().unwrap();
    Ok(guard.clone().unwrap_or_else(load_settings_from_disk))
}

#[tauri::command]
pub async fn set_meeting_detection_settings<R: Runtime>(
    app: AppHandle<R>,
    settings: MeetingDetectionSettings,
) -> Result<(), String> {
    // Sanity-clamp the interval.
    let mut settings = settings;
    settings.interval_secs = settings.interval_secs.clamp(3, 3600);

    save_settings_to_disk(&settings)?;
    {
        let mut guard = SETTINGS.lock().unwrap();
        *guard = Some(settings.clone());
    }

    // Apply immediately: (re)start or stop the monitor.
    if settings.enabled {
        start_monitor(&app);
    } else {
        MONITOR_RUNNING.store(false, Ordering::SeqCst);
    }
    Ok(())
}

/// Manually (re)start the monitor using current settings.
#[tauri::command]
pub async fn start_meeting_detection<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    start_monitor(&app);
    Ok(())
}

/// Manually stop the monitor.
#[tauri::command]
pub async fn stop_meeting_detection() -> Result<(), String> {
    MONITOR_RUNNING.store(false, Ordering::SeqCst);
    Ok(())
}

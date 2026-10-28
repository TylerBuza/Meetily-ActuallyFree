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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime};

/// Global run flag for the monitor loop. Setting this to `false` makes the
/// currently-running loop exit on its next tick.
static MONITOR_GENERATION: AtomicU64 = AtomicU64::new(0);
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
    /// Windows CapabilityAccessManager reports active mic/camera use.
    active_media: bool,
}

#[derive(Clone, Serialize)]
struct MeetingEndedPayload {
    app: String,
    process: String,
}

/// True for our own process — never treat Meetily as a "meeting app".
fn is_self_process(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("meetily") || n.contains("meetily-actually")
}

/// Scan the process list once and, if a (non-ignored) meeting app is present,
/// return `(friendly_name, process_name)`.
///
/// On Windows, when CapabilityAccessManager reports mic/camera holders, we only
/// alert if a *known* meeting app is among them. We never invent a name from a
/// random exe (that produced the nonsense "Meetily meeting detected" toast when
/// this app itself held the mic).
fn scan_for_meeting_app(settings: &MeetingDetectionSettings) -> Option<(String, String, bool)> {
    use sysinfo::System;

    let mut sys = System::new_all();
    sys.refresh_all();

    let ignored: Vec<String> = settings
        .ignored_apps
        .iter()
        .map(|s| s.to_lowercase())
        .filter(|s| !s.trim().is_empty())
        .collect();

    let is_skipped = |name: &str| -> bool {
        if name.is_empty() || is_self_process(name) {
            return true;
        }
        ignored.iter().any(|ig| name.contains(ig))
    };

    #[cfg(windows)]
    let media_in_use: std::collections::HashSet<String> = windows_media_in_use_exes()
        .into_iter()
        .filter(|e| !is_self_process(e))
        .collect();
    #[cfg(target_os = "macos")]
    let media_in_use: std::collections::HashSet<String> = macos_mic_in_use_names(&sys)
        .into_iter()
        .filter(|e| !is_self_process(e))
        .collect();
    #[cfg(not(any(windows, target_os = "macos")))]
    let media_in_use: std::collections::HashSet<String> = std::collections::HashSet::new();

    #[cfg(windows)]
    let browser_meeting_pids = windows_browser_meeting_pids();

    let matches_media = |name: &str| -> bool {
        if media_in_use.is_empty() {
            return true; // no CAM signal → don't require it
        }
        media_in_use.iter().any(|holder| media_holder_matches(name, holder))
    };

    // 1) Known meeting app that is actively using mic/camera (best signal).
    if !media_in_use.is_empty() {
        for process in sys.processes().values() {
            let name = process.name().to_string_lossy().to_lowercase();
            if is_skipped(&name) || !matches_media(&name) {
                continue;
            }
            #[cfg(windows)]
            if is_browser(&name) && browser_meeting_pids.contains(&process.pid().as_u32()) {
                return Some(("Browser meeting".into(), name, true));
            }
            for keyword in &settings.meeting_apps {
                let kw = keyword.trim().to_lowercase();
                if kw.is_empty() {
                    continue;
                }
                if process_matches_keyword(&name, &kw) {
                    return Some((friendly_name(&kw), name, true));
                }
            }
        }
        // CAM has holders but none are known meeting apps (e.g. only Meetily or
        // a browser). Do not fall through to process-only — that re-fires on idle
        // Zoom/Teams sitting in the tray.
        return None;
    }

    // 2) No CAM signal: process-name match only (Linux / older Windows). macOS
    // always has the Core Audio microphone signal, so a running app that is not
    // using the mic (idle Zoom, its `zoomupdater`) is not a meeting.
    #[cfg(not(target_os = "macos"))]
    for process in sys.processes().values() {
        let name = process.name().to_string_lossy().to_lowercase();
        if is_skipped(&name) {
            continue;
        }
        for keyword in &settings.meeting_apps {
            let kw = keyword.trim().to_lowercase();
            if kw.is_empty() {
                continue;
            }
            if process_matches_keyword(&name, &kw) {
                return Some((friendly_name(&kw), name, false));
            }
        }
    }
    None
}

/// macOS: lowercase names of processes currently capturing from a microphone,
/// per Core Audio. Meeting apps' helpers carry the app name ("Slack Helper").
#[cfg(target_os = "macos")]
fn macos_mic_in_use_names(sys: &sysinfo::System) -> std::collections::HashSet<String> {
    let Ok(processes) = cidre::core_audio::Process::list() else {
        return Default::default();
    };
    processes
        .into_iter()
        .filter(|p| p.is_running_input().unwrap_or(false))
        .filter_map(|p| {
            let pid = u32::try_from(p.pid().ok()?).ok()?;
            let process = sys.process(sysinfo::Pid::from_u32(pid))?;
            Some(process.name().to_string_lossy().to_lowercase())
        })
        .filter(|name| !name.trim().is_empty())
        .collect()
}

/// macOS: whether a process with this (lowercase) name is still running.
#[cfg(target_os = "macos")]
fn process_is_running(name: &str) -> bool {
    use sysinfo::{ProcessRefreshKind, RefreshKind, System};
    let sys = System::new_with_specifics(RefreshKind::new().with_processes(ProcessRefreshKind::new()));
    let running = sys
        .processes()
        .values()
        .any(|process| process.name().to_string_lossy().to_lowercase() == name);
    running
}

/// Shortest name that may match another by substring. An empty or very short
/// name ("", ".exe", "a") would otherwise be contained in, or contain, almost
/// any process name.
const MIN_SUBSTRING_MATCH_LEN: usize = 4;

/// Does a running process (`name`) correspond to a mic/camera holder? Exact
/// names always match; otherwise one name must contain the other (a holder
/// path or a helper may differ slightly from the process name), and the
/// contained name must be at least `MIN_SUBSTRING_MATCH_LEN` characters.
fn media_holder_matches(name: &str, holder: &str) -> bool {
    let stem = name.trim().trim_end_matches(".exe");
    let holder = holder.trim().trim_end_matches(".exe");
    if stem.is_empty() || holder.is_empty() {
        return false;
    }
    if stem == holder {
        return true;
    }
    let long_enough = |s: &str| s.chars().count() >= MIN_SUBSTRING_MATCH_LEN;
    (long_enough(stem) && holder.contains(stem)) || (long_enough(holder) && stem.contains(holder))
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
        for suffix in ["NonPackaged", ""] {
            let path = format!(
                "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\{cap}\\{suffix}"
            );
            let Ok(root) = hkcu.open_subkey(&path) else { continue };
            let Ok(keys) = root.enum_keys().collect::<Result<Vec<_>, _>>() else { continue };
            for key_name in keys {
            if key_name.eq_ignore_ascii_case("NonPackaged") { continue; }
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
            } else if key_name.to_lowercase().contains("msteams") {
                // Packaged Teams stores a package family name rather than an exe.
                out.insert("ms-teams.exe".into());
            }
            }
        }
    }
    out
}

#[cfg(windows)]
fn is_browser(name: &str) -> bool {
    matches!(name, "chrome.exe" | "msedge.exe" | "firefox.exe")
}

#[cfg(windows)]
fn windows_browser_meeting_pids() -> std::collections::HashSet<u32> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible};
    unsafe extern "system" fn visit(hwnd: HWND, state: isize) -> i32 {
        let matches = &mut *(state as *mut std::collections::HashSet<u32>);
        if IsWindowVisible(hwnd) == 0 { return 1; }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 || len > 1024 { return 1; }
        let mut title = vec![0u16; len as usize + 1];
        let copied = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
        if copied <= 0 { return 1; }
        let title = String::from_utf16_lossy(&title[..copied as usize]).to_lowercase();
        if browser_title_is_meeting(&title) {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid != 0 { matches.insert(pid); }
        }
        1
    }
    let mut matches = std::collections::HashSet::new();
    unsafe { EnumWindows(Some(visit), &mut matches as *mut _ as isize); }
    matches
}

#[cfg(windows)]
fn browser_title_is_meeting(title: &str) -> bool {
    let title = title.to_lowercase();
    ["google meet", "meet.google.com", "zoom meeting", "zoom.us/j/", "meeting | microsoft teams", "teams.microsoft.com", "slack huddle"]
        .iter().any(|needle| title.contains(needle))
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
    use super::{is_self_process, media_holder_matches, meeting_has_ended, process_matches_keyword};
    use std::time::Duration;

    #[test]
    fn never_treats_meetily_as_a_meeting() {
        assert!(is_self_process("meetily.exe"));
        assert!(is_self_process("Meetily - Actually Free.exe"));
        assert!(!is_self_process("ms-teams.exe"));
    }

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

    #[test]
    fn zoom_keyword_also_matches_its_updater_so_macos_needs_the_mic_signal() {
        // Name matching alone cannot tell Zoom's updater from a call; on macOS
        // the scan therefore requires a process that is using the microphone.
        assert!(process_matches_keyword("zoomupdater", "zoom"));
    }

    #[test]
    fn media_holder_matching_needs_real_names() {
        assert!(media_holder_matches("slack helper", "slack helper"));
        assert!(media_holder_matches("ms-teams.exe", "ms-teams.exe"));
        assert!(media_holder_matches("zoom.exe", "zoom"));
        assert!(media_holder_matches("zoom.us", "zoom"));
        // An empty or tiny name must not match every process.
        assert!(!media_holder_matches("", "zoom.us"));
        assert!(!media_holder_matches(".exe", "zoom.exe"));
        assert!(!media_holder_matches("zoom.us", ""));
        assert!(!media_holder_matches("zoom.us", "  "));
        assert!(!media_holder_matches("a", "slack helper"));
        assert!(!media_holder_matches("slack helper", "a"));
    }

    #[test]
    fn a_call_is_not_ended_within_the_short_grace() {
        assert!(!meeting_has_ended(Duration::from_secs(30), false));
        assert!(!meeting_has_ended(Duration::from_secs(30), true));
        assert!(meeting_has_ended(Duration::from_secs(45), false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_waits_out_a_muted_microphone_while_the_app_runs() {
        assert!(!meeting_has_ended(Duration::from_secs(5 * 60), true));
        assert!(meeting_has_ended(Duration::from_secs(10 * 60), true));
        // The app quit: the call is over after the short grace.
        assert!(meeting_has_ended(Duration::from_secs(60), false));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn other_platforms_keep_the_short_grace() {
        assert!(meeting_has_ended(Duration::from_secs(60), true));
    }

    #[cfg(windows)]
    #[test]
    fn browser_title_requires_meeting_context() {
        assert!(super::browser_title_is_meeting("Google Meet - Project Sync"));
        assert!(super::browser_title_is_meeting("Meeting | Microsoft Teams - Edge"));
        assert!(!super::browser_title_is_meeting("Meetily documentation - Chrome"));
        assert!(!super::browser_title_is_meeting("Microsoft Teams home - Edge"));
    }
}

/// How long a detected call may go without its signal before `meeting-ended`
/// (which stops a recording that Labs meeting automation started).
const MEETING_END_GRACE: std::time::Duration = std::time::Duration::from_secs(45);

/// macOS: the signal is "the app is capturing from the microphone", and some
/// apps stop capturing while the user is muted. So while the matched process
/// is still running, a call ends only after this much longer idle time; once
/// the process has exited, `MEETING_END_GRACE` applies.
#[cfg(target_os = "macos")]
const MACOS_MIC_IDLE_END_GRACE: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Whether a call whose signal has been missing for `missing` has ended.
/// `process_running` (the matched process still exists) only matters on macOS.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn meeting_has_ended(missing: std::time::Duration, process_running: bool) -> bool {
    if missing < MEETING_END_GRACE {
        return false;
    }
    #[cfg(target_os = "macos")]
    if process_running && missing < MACOS_MIC_IDLE_END_GRACE {
        return false;
    }
    true
}

/// Start (or restart) the background monitor with the given settings.
fn start_monitor<R: Runtime>(app: &AppHandle<R>) {
    // A generation token prevents an old sleeping loop from reviving after a restart.
    let generation = MONITOR_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    let settings = {
        let guard = SETTINGS.lock().unwrap();
        guard.clone().unwrap_or_default()
    };
    if !settings.enabled {
        log::info!("Meeting detection disabled; monitor not started");
        return;
    }

    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        log::info!("🔍 Meeting detection monitor started");
        // Whether we've already alerted for the currently-ongoing meeting app,
        // so we prompt once per meeting rather than every tick.
        let mut alerted: Option<(String, String, bool)> = None;
        let mut missing_since: Option<std::time::Instant> = None;

        // Give the loop a moment before the first heavy scan.
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        while MONITOR_GENERATION.load(Ordering::SeqCst) == generation {
            let current = {
                let guard = SETTINGS.lock().unwrap();
                guard.clone().unwrap_or_default()
            };
            if !current.enabled {
                break;
            }

            let scan_settings = current.clone();
            let scan = match tokio::task::spawn_blocking(move || scan_for_meeting_app(&scan_settings)).await {
                Ok(scan) => scan,
                Err(error) => { log::warn!("Meeting detection scan failed: {error}"); None }
            };
            if MONITOR_GENERATION.load(Ordering::SeqCst) != generation { break; }
            // A process-only fallback must not keep a formerly active meeting
            // alive after its microphone lease ends while the app stays open.
            let scan = match (alerted.as_ref(), scan) {
                (Some((_, process, true)), Some((_, candidate, false))) if process == &candidate => None,
                (_, other) => other,
            };
            match scan {
                Some((friendly, process, active_media)) => {
                    missing_since = None;
                    if alerted.as_ref() != Some(&(friendly.clone(), process.clone(), active_media)) {
                        alerted = Some((friendly.clone(), process.clone(), active_media));
                        log::info!("🔔 Meeting app detected: {} ({})", friendly, process);
                        let _ = app.emit(
                            "meeting-detected",
                            MeetingDetectedPayload {
                                app: friendly,
                                process,
                                notify: current.notify,
                                active_media,
                            },
                        );
                    }
                }
                None => {
                    if let Some((app_name, process, _)) = &alerted {
                        let missing = missing_since.get_or_insert_with(std::time::Instant::now).elapsed();
                        // Rescan processes only once the short grace is over.
                        #[cfg(target_os = "macos")]
                        let running = missing >= MEETING_END_GRACE && {
                            let name = process.clone();
                            tokio::task::spawn_blocking(move || process_is_running(&name))
                                .await
                                .unwrap_or(true)
                        };
                        #[cfg(not(target_os = "macos"))]
                        let running = false;
                        let ended = meeting_has_ended(missing, running);
                        if ended {
                            let _ = app.emit("meeting-ended", MeetingEndedPayload { app: app_name.clone(), process: process.clone() });
                            alerted = None;
                            missing_since = None;
                        }
                    }
                }
            }

            let interval = current.interval_secs.clamp(3, 3600);
            tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
        }

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
        MONITOR_GENERATION.fetch_add(1, Ordering::SeqCst);
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
    MONITOR_GENERATION.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

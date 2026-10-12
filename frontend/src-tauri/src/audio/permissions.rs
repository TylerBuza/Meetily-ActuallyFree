// macOS audio permissions handling.
//
// The `screen_recording` names are legacy IPC/API names. Current macOS capture
// uses Audio Capture permission and a Core Audio process tap, not screen video.
// `check_screen_recording_permission` reports platform support only; the audible
// up-to-five-second probe below is the actual runtime verification.
use anyhow::Result;
use log::{info, warn, error};

#[cfg(target_os = "macos")]
use std::process::Command;

/// Check whether the platform supports the Audio Capture permission flow.
///
/// Note: Core Audio taps require NSAudioCaptureUsageDescription in Info.plist.
/// When the app first attempts to create a Core Audio tap, macOS will automatically
/// show a permission dialog to the user. If permission is denied, the tap will return
/// silence (all zeros).
///
/// This function returns true because the actual permission prompt happens automatically
/// when AudioHardwareCreateProcessTap is called by the cidre library.
#[cfg(target_os = "macos")]
pub fn check_screen_recording_permission() -> bool {
    info!("ℹ️  Core Audio tap requires Audio Capture permission (macOS 14.2+)");
    info!("📍 Permission dialog will appear automatically when recording starts");
    info!("   If already granted: System Settings → Privacy & Security → Audio Capture");

    // Always return true - the actual permission dialog is triggered by Core Audio API
    true
}

#[cfg(not(target_os = "macos"))]
pub fn check_screen_recording_permission() -> bool {
    true // Not required on other platforms
}

/// Request Audio Capture permission from the user
/// This will open System Settings to the Privacy & Security page
#[cfg(target_os = "macos")]
pub fn request_screen_recording_permission() -> Result<()> {
    info!("🔐 Opening System Settings for Audio Capture permission...");

    // Open System Settings to Privacy & Security page
    // Note: There's no direct URL for Audio Capture, so we open the main Privacy page
    let result = Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security")
        .spawn();

    match result {
        Ok(_) => {
            info!("✅ Opened System Settings - navigate to Privacy & Security → Audio Capture");
            info!("👉 Please enable Audio Capture permission and restart the app");
            Ok(())
        }
        Err(e) => {
            error!("❌ Failed to open System Settings: {}", e);
            Err(anyhow::anyhow!("Failed to open System Settings: {}", e))
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_recording_permission() -> Result<()> {
    Ok(()) // Not required on other platforms
}

/// Check and request Audio Capture permission if not granted
/// Returns true if permission is granted, false otherwise
pub fn ensure_screen_recording_permission() -> bool {
    if check_screen_recording_permission() {
        return true;
    }

    warn!("Audio Capture permission not granted - requesting...");

    if let Err(e) = request_screen_recording_permission() {
        error!("Failed to request Audio Capture permission: {}", e);
        return false;
    }

    false // Permission will be granted after restart
}

/// Tauri command to check Screen Recording permission
#[tauri::command]
pub async fn check_screen_recording_permission_command() -> bool {
    check_screen_recording_permission()
}

/// Tauri command to request Screen Recording permission
#[tauri::command]
pub async fn request_screen_recording_permission_command() -> Result<(), String> {
    request_screen_recording_permission()
        .map_err(|e| e.to_string())
}

/// Trigger the system-audio permission request and probe functional capture.
/// Returns Ok(true) only when the started tap receives audible system audio;
/// false can mean denial, silence, or another capture initialization failure.
#[cfg(target_os = "macos")]
pub fn trigger_system_audio_permission() -> Result<bool> {
    info!("🔐 Triggering Audio Capture permission request...");

    match crate::audio::capture::CoreAudioCapture::new() {
        Ok(capture) => {
            info!("✅ Core Audio tap created; starting native capture probe");
            let detected = capture.probe(std::time::Duration::from_secs(5))?;
            if detected {
                info!("✅ Native system audio capture verified");
            } else {
                warn!(
                    "Audio Capture returned silence; permission may be denied or no audio was playing"
                );
            }
            Ok(detected)
        }
        Err(e) => {
            let error_msg = e.to_string().to_lowercase();
            if error_msg.contains("permission") || error_msg.contains("denied") {
                info!("🔐 Audio Capture permission denied");
                info!("👉 Please grant Audio Capture permission in System Settings");
                return Ok(false);
            }
            warn!("⚠️ Failed to create Core Audio tap: {}", e);
            // If tap creation fails for other reasons, still return false
            // as we can't verify permission status
            Ok(false)
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn trigger_system_audio_permission() -> Result<bool> {
    // System audio permissions not required on other platforms
    info!("System audio permissions not required on this platform");
    Ok(true)
}

/// Trigger Audio Capture permission and test for audible samples for up to five
/// seconds. False is not a definitive denial status because silence is identical.
#[tauri::command]
pub async fn trigger_system_audio_permission_command() -> Result<bool, String> {
    // Run in blocking task to avoid blocking the async runtime
    tokio::task::spawn_blocking(|| {
        trigger_system_audio_permission()
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| e.to_string())
}

/// macOS Audio Capture authorization as TCC records it, read without starting a
/// tap or prompting. `Unknown` means the status could not be read; callers then
/// fall back to the audible probe above.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemAudioPermission {
    Granted,
    Denied,
    NotDetermined,
    Unknown,
}

impl SystemAudioPermission {
    /// Maps a `TCCAccessPreflight` result: 0 granted, 1 denied, 2 not yet asked.
    fn from_preflight(code: i32) -> Self {
        match code {
            0 => Self::Granted,
            1 => Self::Denied,
            2 => Self::NotDetermined,
            _ => Self::Unknown,
        }
    }
}

/// Argument that makes the app binary print its Audio Capture preflight code
/// and exit before Tauri starts; see `fresh_process_status`.
pub const AUDIO_CAPTURE_STATUS_ARG: &str = "--audio-capture-status";

/// Reads the Audio Capture permission without touching audio hardware.
///
/// Apple publishes no query for `kTCCServiceAudioCapture`, and a running tap
/// returns zeros both when permission is denied and when nothing plays. This
/// uses the private `TCCAccessPreflight` from TCC.framework (as the AudioCap
/// sample does), resolved at runtime so a macOS release without it degrades to
/// `Unknown` instead of failing to launch.
///
/// TCC answers from a per-process cache: on macOS 26 a grant made from this
/// process's own prompt still reads `NotDetermined` here until the app
/// restarts. Anything short of granted is therefore asked again in a fresh,
/// short-lived copy of this binary.
#[cfg(target_os = "macos")]
pub fn system_audio_permission_status() -> SystemAudioPermission {
    let in_process = preflight_code()
        .map(SystemAudioPermission::from_preflight)
        .unwrap_or(SystemAudioPermission::Unknown);
    let status = match in_process {
        SystemAudioPermission::Granted | SystemAudioPermission::Unknown => in_process,
        _ => fresh_process_status().unwrap_or(in_process),
    };
    info!("Audio Capture permission status: {:?} (this process: {:?})", status, in_process);
    status
}

/// `TCCAccessPreflight("kTCCServiceAudioCapture")` in this process, or `None`
/// when the private symbol is unavailable.
#[cfg(target_os = "macos")]
fn preflight_code() -> Option<i32> {
    use std::ffi::{c_char, c_int, c_void};
    use std::sync::OnceLock;

    type Preflight = unsafe extern "C" fn(service: *const c_void, options: *const c_void) -> c_int;
    extern "C" {
        fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }
    const RTLD_LAZY: c_int = 0x1;

    static PREFLIGHT: OnceLock<Option<Preflight>> = OnceLock::new();
    let preflight = PREFLIGHT.get_or_init(|| unsafe {
        let handle = dlopen(
            c"/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC".as_ptr(),
            RTLD_LAZY,
        );
        if handle.is_null() {
            warn!("TCC.framework unavailable; Audio Capture status unknown");
            return None;
        }
        let symbol = dlsym(handle, c"TCCAccessPreflight".as_ptr());
        if symbol.is_null() {
            warn!("TCCAccessPreflight unavailable; Audio Capture status unknown");
            return None;
        }
        Some(std::mem::transmute::<*mut c_void, Preflight>(symbol))
    });
    let preflight = (*preflight)?;
    let service = cidre::cf::String::from_str("kTCCServiceAudioCapture");
    let service_ref = &*service as *const cidre::cf::String as *const c_void;
    Some(unsafe { preflight(service_ref, std::ptr::null()) })
}

/// Entry for `AUDIO_CAPTURE_STATUS_ARG`: prints this fresh process's preflight
/// code and exits. Called from `main` before logging or Tauri start, so no
/// second app instance or window appears.
#[cfg(target_os = "macos")]
pub fn print_audio_capture_status_and_exit() -> ! {
    if let Some(code) = preflight_code() {
        println!("{code}");
    }
    std::process::exit(0);
}

/// The preflight answer from a fresh copy of this binary, which has no stale
/// TCC cache. Its TCC identity is this app's: same code, and this process is
/// responsible for it. `None` if it cannot run or answer within two seconds.
#[cfg(target_os = "macos")]
fn fresh_process_status() -> Option<SystemAudioPermission> {
    if cfg!(test) {
        return None; // The test harness binary is not the app.
    }
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut child = Command::new(std::env::current_exe().ok()?)
        .arg(AUDIO_CAPTURE_STATUS_ARG)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                warn!("Fresh Audio Capture status check did not finish");
                return None;
            }
        }
    }
    let mut output = String::new();
    child.stdout.take()?.read_to_string(&mut output).ok()?;
    output.trim().parse().ok().map(SystemAudioPermission::from_preflight)
}

#[cfg(not(target_os = "macos"))]
pub fn system_audio_permission_status() -> SystemAudioPermission {
    SystemAudioPermission::Granted // No Audio Capture permission on other platforms
}

/// Tauri command: Audio Capture permission without probing or prompting.
#[tauri::command]
pub async fn get_system_audio_permission_status() -> SystemAudioPermission {
    // The fresh-process check spawns and waits; keep it off the async runtime.
    tokio::task::spawn_blocking(system_audio_permission_status)
        .await
        .unwrap_or(SystemAudioPermission::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preflight_codes_map_to_permission_states() {
        assert_eq!(SystemAudioPermission::from_preflight(0), SystemAudioPermission::Granted);
        assert_eq!(SystemAudioPermission::from_preflight(1), SystemAudioPermission::Denied);
        assert_eq!(SystemAudioPermission::from_preflight(2), SystemAudioPermission::NotDetermined);
        assert_eq!(SystemAudioPermission::from_preflight(-1), SystemAudioPermission::Unknown);
        assert_eq!(SystemAudioPermission::from_preflight(3), SystemAudioPermission::Unknown);
    }

    /// Fails if a macOS release drops or changes the private symbol, which
    /// would silently send every user back to the audible probe.
    #[test]
    #[cfg(target_os = "macos")]
    fn tcc_preflight_resolves_on_macos() {
        assert_ne!(system_audio_permission_status(), SystemAudioPermission::Unknown);
    }

    #[test]
    fn test_check_permission() {
        let has_permission = check_screen_recording_permission();
        println!("Has Screen Recording permission: {}", has_permission);
    }
}

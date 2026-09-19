// macOS audio permissions handling.
//
// The `screen_recording` names are legacy IPC/API names. Current macOS capture
// uses Audio Capture permission and a Core Audio process tap, not screen video.
// `check_screen_recording_permission` reports platform support only; the audible
// up-to-five-second probe below is the actual runtime verification.
use anyhow::Result;
use log::{info, warn, error};
use serde::Serialize;

#[cfg(target_os = "macos")]
use std::process::Command;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::Arc;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

/// Why a system-audio probe reached its verdict.
///
/// `detected` alone cannot separate "the tap is denied" from "nothing was
/// audible to capture". Silence is therefore never treated as proof of denial,
/// however strong the circumstantial evidence: only an explicit permission
/// error from Core Audio is conclusive. `reason` lets the UI explain what the
/// most likely cause was without asserting a verdict the probe cannot support.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudioProbe {
    pub detected: bool,
    pub conclusive: bool,
    pub reason: &'static str,
}

impl SystemAudioProbe {
    fn captured() -> Self {
        Self { detected: true, conclusive: true, reason: "captured" }
    }

    fn denied(reason: &'static str) -> Self {
        Self { detected: false, conclusive: true, reason }
    }

    fn inconclusive(reason: &'static str) -> Self {
        Self { detected: false, conclusive: false, reason }
    }
}

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

/// Run `command` and return its stdout, never waiting longer than `timeout`.
/// Used for every helper process here so a hung tool cannot stall the probe.
///
/// stdout is drained on its own thread: a child that fills the pipe buffer
/// blocks until someone reads it, which would otherwise look like a hang and
/// burn the whole timeout.
#[cfg(target_os = "macos")]
fn run_bounded(mut command: Command, timeout: Duration) -> Option<String> {
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut buffer = String::new();
        if let Some(mut stdout) = stdout {
            let _ = stdout.read_to_string(&mut buffer);
        }
        buffer
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };

    let output = reader.join().ok()?;
    status.filter(|status| status.success()).map(|_| output)
}

/// Whether the default output could actually render our test sound.
/// A muted or zero-volume output plays nothing, so silence would say nothing
/// about the capture permission. `None` means the volume could not be read,
/// which is equally unusable as evidence.
#[cfg(target_os = "macos")]
fn output_can_be_heard() -> Option<bool> {
    let mut command = Command::new("/usr/bin/osascript");
    command
        .args(["-e", "get volume settings"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    let settings = run_bounded(command, Duration::from_secs(2))?.to_lowercase();

    if settings.contains("output muted:true") {
        return Some(false);
    }
    settings
        .split("output volume:")
        .nth(1)
        .and_then(|rest| rest.split(',').next())
        .and_then(|value| value.trim().parse::<i32>().ok())
        .map(|volume| volume > 0)
}

/// Combine the readings taken before and after the probe. Anything other than
/// a confirmed audible output on both sides is unusable as denial evidence.
#[cfg(target_os = "macos")]
fn output_was_audible_throughout(before: Option<bool>, after: Option<bool>) -> Option<bool> {
    match (before, after) {
        (Some(true), Some(true)) => Some(true),
        (Some(false), _) | (_, Some(false)) => Some(false),
        _ => None,
    }
}

/// Plays a short sound on repeat for the duration of the probe.
///
/// The child process is owned and bounded: it is killed when the probe ends,
/// when a single playback overruns, and on drop, so no path can leave `afplay`
/// running or block the probe.
#[cfg(target_os = "macos")]
struct SelfTestSound {
    stop: Arc<AtomicBool>,
    played: Arc<AtomicBool>,
    player: Option<std::thread::JoinHandle<()>>,
}

#[cfg(target_os = "macos")]
impl SelfTestSound {
    const MAX_PLAYBACK: Duration = Duration::from_secs(2);

    fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let played = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread_played = played.clone();

        let player = std::thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                let spawned = Command::new("/usr/bin/afplay")
                    .args(["-v", "0.5", "/System/Library/Sounds/Pop.aiff"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn();
                let Ok(mut child) = spawned else {
                    return; // afplay unavailable; ambient audio remains the only signal.
                };

                let deadline = Instant::now() + Self::MAX_PLAYBACK;
                loop {
                    if thread_stop.load(Ordering::Relaxed) || Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return;
                    }
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            if status.success() {
                                thread_played.store(true, Ordering::Relaxed);
                            }
                            break;
                        }
                        Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                        Err(_) => {
                            let _ = child.kill();
                            let _ = child.wait();
                            return;
                        }
                    }
                }
            }
        });

        Self { stop, played, player: Some(player) }
    }

    fn completed_a_playback(&self) -> bool {
        self.played.load(Ordering::Relaxed)
    }
}

#[cfg(target_os = "macos")]
impl Drop for SelfTestSound {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(player) = self.player.take() {
            let _ = player.join();
        }
    }
}

/// Trigger the system-audio permission request and probe functional capture.
///
/// Plays a short sound once the tap is listening, so a granted tap has audio to
/// observe without the user staging playback. A silent tap is always reported
/// as inconclusive, because no amount of local evidence proves the sound was
/// routed to the device being captured.
#[cfg(target_os = "macos")]
pub fn trigger_system_audio_permission() -> Result<SystemAudioProbe> {
    info!("🔐 Triggering Audio Capture permission request...");

    match crate::audio::capture::CoreAudioCapture::new() {
        Ok(capture) => {
            info!("✅ Core Audio tap created; starting native capture probe");

            let output_before = output_can_be_heard();
            let mut sound = None;
            let detected = capture.probe(Duration::from_secs(5), || {
                sound = Some(SelfTestSound::start());
            })?;
            let played = sound.as_ref().is_some_and(SelfTestSound::completed_a_playback);
            drop(sound);

            if detected {
                info!("✅ Native system audio capture verified");
                return Ok(SystemAudioProbe::captured());
            }
            if !played {
                warn!("Audio Capture probe heard nothing and could not play its test sound");
                return Ok(SystemAudioProbe::inconclusive("selfTestUnavailable"));
            }

            match output_was_audible_throughout(output_before, output_can_be_heard()) {
                Some(true) => {
                    // Strong hint, not proof: an audible output does not
                    // guarantee the sound reached the captured device.
                    warn!("Audio Capture probe heard no audio despite playing its own test sound");
                    Ok(SystemAudioProbe::inconclusive("silentWithSelfTest"))
                }
                Some(false) => {
                    warn!("Audio Capture probe heard nothing while output was muted or silent");
                    Ok(SystemAudioProbe::inconclusive("outputMuted"))
                }
                None => {
                    warn!("Audio Capture probe heard nothing and could not confirm output volume");
                    Ok(SystemAudioProbe::inconclusive("outputVolumeUnknown"))
                }
            }
        }
        Err(e) => {
            let error_msg = e.to_string().to_lowercase();
            if error_msg.contains("permission") || error_msg.contains("denied") {
                info!("🔐 Audio Capture permission denied");
                info!("👉 Please grant Audio Capture permission in System Settings");
                return Ok(SystemAudioProbe::denied("tapDenied"));
            }
            warn!("⚠️ Failed to create Core Audio tap: {}", e);
            Ok(SystemAudioProbe::inconclusive("tapUnavailable"))
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn trigger_system_audio_permission() -> Result<SystemAudioProbe> {
    // System audio permissions not required on other platforms
    info!("System audio permissions not required on this platform");
    Ok(SystemAudioProbe { detected: true, conclusive: true, reason: "notRequired" })
}

/// Trigger Audio Capture permission and probe the tap for up to five seconds
/// while playing a short self-test sound. `conclusive` reports whether the
/// verdict can be trusted; only an explicit Core Audio permission error is
/// conclusive, so callers never present silence as a denial.
#[tauri::command]
pub async fn trigger_system_audio_permission_command() -> Result<SystemAudioProbe, String> {
    // Run in blocking task to avoid blocking the async runtime
    tokio::task::spawn_blocking(|| {
        trigger_system_audio_permission()
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_permission() {
        let has_permission = check_screen_recording_permission();
        println!("Has Screen Recording permission: {}", has_permission);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bounded_run_kills_a_process_that_never_exits() {
        let mut command = Command::new("/bin/sleep");
        command.arg("30");

        let started = Instant::now();
        assert!(run_bounded(command, Duration::from_millis(200)).is_none());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bounded_run_reads_output_larger_than_the_pipe_buffer() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "yes abcdefghij | head -c 200000"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());

        let output = run_bounded(command, Duration::from_secs(10)).expect("large output");
        assert_eq!(output.len(), 200_000);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dropping_the_self_test_sound_stops_playback_promptly() {
        let sound = SelfTestSound::start();
        let started = Instant::now();
        drop(sound);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn only_an_explicit_permission_error_is_a_conclusive_denial() {
        assert!(!SystemAudioProbe::inconclusive("silentWithSelfTest").conclusive);
        assert!(!SystemAudioProbe::inconclusive("selfTestUnavailable").conclusive);
        assert!(!SystemAudioProbe::inconclusive("outputMuted").conclusive);
        assert!(!SystemAudioProbe::inconclusive("outputVolumeUnknown").conclusive);
        assert!(SystemAudioProbe::denied("tapDenied").conclusive);
        assert!(SystemAudioProbe::captured().detected);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unreadable_or_muted_output_is_never_treated_as_audible() {
        assert_eq!(output_was_audible_throughout(Some(true), Some(true)), Some(true));
        assert_eq!(output_was_audible_throughout(Some(true), Some(false)), Some(false));
        assert_eq!(output_was_audible_throughout(Some(false), Some(true)), Some(false));
        assert_eq!(output_was_audible_throughout(None, Some(true)), None);
        assert_eq!(output_was_audible_throughout(Some(true), None), None);
        assert_eq!(output_was_audible_throughout(None, None), None);
    }
}

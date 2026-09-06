use anyhow::{anyhow, Result};
use serde::Serialize;
use std::collections::HashSet;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::slice;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use sysinfo::{Pid, System};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio_util::sync::CancellationToken;
use windows::core::Interface;
use windows::Win32::Devices::Properties::DEVPKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use windows::Win32::Media::Audio::{
    eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, StructuredStorage, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Variant::VT_LPWSTR;

#[derive(Clone, Serialize)]
pub struct AudioRouteWarning {
    pub title: String,
    pub message: String,
}

#[derive(Debug, PartialEq, Eq)]
struct ZoomRoute {
    device_name: String,
    process_id: u32,
}

struct MonitorHandle {
    generation: u64,
    token: CancellationToken,
}

#[derive(Default)]
struct MonitorState {
    generation: u64,
    active: Option<MonitorHandle>,
}

fn monitor_state() -> &'static Mutex<MonitorState> {
    static MONITOR: OnceLock<Mutex<MonitorState>> = OnceLock::new();
    MONITOR.get_or_init(|| Mutex::new(MonitorState::default()))
}

pub fn stop_monitoring() {
    if let Ok(mut state) = monitor_state().lock() {
        if let Some(handle) = state.active.take() {
            handle.token.cancel();
        }
    }
}

pub fn start_monitoring<R: Runtime>(app: AppHandle<R>, captured_device: String) {
    let token = CancellationToken::new();
    let generation = {
        let Ok(mut state) = monitor_state().lock() else {
            return;
        };
        if let Some(handle) = state.active.take() {
            handle.token.cancel();
        }
        state.generation = state.generation.wrapping_add(1);
        let generation = state.generation;
        state.active = Some(MonitorHandle {
            generation,
            token: token.clone(),
        });
        generation
    };

    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        let mut warned_devices = HashSet::new();
        let mut pending_device: Option<String> = None;
        loop {
            tokio::select! {
                _ = token.cancelled() => break,
                _ = interval.tick() => {}
            }

            let routes = match tokio::task::spawn_blocking(find_active_zoom_routes).await {
                Ok(Ok(routes)) => routes,
                Ok(Err(error)) => {
                    log::debug!("Unable to inspect Windows audio routes: {error}");
                    continue;
                }
                Err(error) => {
                    log::debug!("Windows audio route task failed: {error}");
                    continue;
                }
            };
            if token.is_cancelled() {
                break;
            }

            if routes
                .iter()
                .any(|route| route.device_name.eq_ignore_ascii_case(&captured_device))
            {
                pending_device = None;
                continue;
            }

            if routes.len() != 1 {
                pending_device = None;
                continue;
            }
            let route = &routes[0];
            let warning_key = route.device_name.to_lowercase();
            if warned_devices.contains(&warning_key) {
                continue;
            }
            if pending_device.as_deref() != Some(&warning_key) {
                pending_device = Some(warning_key.clone());
                continue;
            }
            if !warned_devices.insert(warning_key) {
                continue;
            }

            let warning = AudioRouteWarning {
                title: "Check Zoom's speaker output".to_string(),
                message: format!(
                    "Meetily is capturing \"{}\". Windows reports an active Zoom session and sound on \"{}\". If Zoom is missing from the recording, change Zoom's Speaker to the captured device, or stop recording and select Zoom's output under Settings > Recording > System Audio.",
                    captured_device, route.device_name
                ),
            };
            log::warn!(
                "Possible Zoom audio route mismatch: capturing '{}', Zoom PID {} has an active session on audible endpoint '{}'",
                captured_device,
                route.process_id,
                route.device_name
            );
            let Ok(state) = monitor_state().lock() else {
                break;
            };
            if state.active.as_ref().map(|handle| handle.generation) != Some(generation) {
                break;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("recording-audio-route-warning", warning);
            }
        }

        if let Ok(mut state) = monitor_state().lock() {
            if state.active.as_ref().map(|handle| handle.generation) == Some(generation) {
                state.active = None;
            }
        }
    });
}

fn find_active_zoom_routes() -> Result<Vec<ZoomRoute>> {
    let mut system = System::new_all();
    system.refresh_all();
    let mut routes = unsafe { enumerate_audible_zoom_sessions(&system)? };
    routes.sort_by(|left, right| left.device_name.cmp(&right.device_name));
    routes.dedup_by(|left, right| left.device_name.eq_ignore_ascii_case(&right.device_name));
    Ok(routes)
}

fn process_or_ancestor_is_zoom(system: &System, process_id: u32) -> bool {
    let mut current = Some(Pid::from_u32(process_id));
    for _ in 0..6 {
        let Some(pid) = current else {
            break;
        };
        let Some(process) = system.process(pid) else {
            break;
        };
        let name = process.name().to_string_lossy().to_ascii_lowercase();
        if is_zoom_process_name(&name) {
            return true;
        }
        current = process.parent();
    }
    false
}

fn is_zoom_process_name(name: &str) -> bool {
    name.to_ascii_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|part| part == "zoom")
}

unsafe fn enumerate_audible_zoom_sessions(system: &System) -> Result<Vec<ZoomRoute>> {
    let initialization = CoInitializeEx(None, COINIT_MULTITHREADED);
    initialization
        .ok()
        .map_err(|error| anyhow!("Failed to initialize COM: {error}"))?;
    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    let _guard = ComGuard;

    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
    let mut routes = Vec::new();
    for device_index in 0..devices.GetCount()? {
        let device = devices.Item(device_index)?;
        let Ok(device_name) = device_friendly_name(&device) else {
            continue;
        };
        let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
            continue;
        };
        let Ok(session_enumerator) = manager.GetSessionEnumerator() else {
            continue;
        };
        let mut zoom_processes = Vec::new();
        for session_index in 0..session_enumerator.GetCount()? {
            let Ok(control) = session_enumerator.GetSession(session_index) else {
                continue;
            };
            let Ok(session_state) = control.GetState() else {
                continue;
            };
            if session_state != AudioSessionStateActive {
                continue;
            }
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };
            let Ok(process_id) = control2.GetProcessId() else {
                continue;
            };
            if process_id != 0 && process_or_ancestor_is_zoom(system, process_id) {
                zoom_processes.push(process_id);
            }
        }
        if zoom_processes.is_empty() || !endpoint_is_audible(&device) {
            continue;
        }
        routes.extend(zoom_processes.into_iter().map(|process_id| ZoomRoute {
            device_name: device_name.clone(),
            process_id,
        }));
    }
    Ok(routes)
}

unsafe fn endpoint_is_audible(device: &IMMDevice) -> bool {
    let Ok(meter) = device.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None) else {
        return false;
    };
    let mut peak = 0.0_f32;
    for sample in 0..5 {
        if let Ok(value) = meter.GetPeakValue() {
            peak = peak.max(value);
        }
        if sample < 4 {
            std::thread::sleep(Duration::from_millis(40));
        }
    }
    peak >= 0.001
}

unsafe fn device_friendly_name(device: &IMMDevice) -> Result<String> {
    let property_store = device.OpenPropertyStore(STGM_READ)?;
    let mut property_value =
        property_store.GetValue(&DEVPKEY_Device_FriendlyName as *const _ as *const _)?;
    let value = &property_value.as_raw().Anonymous.Anonymous;
    if value.vt != VT_LPWSTR.0 {
        StructuredStorage::PropVariantClear(&mut property_value)?;
        return Err(anyhow!("Audio endpoint has no friendly name"));
    }

    let pointer = *(&value.Anonymous as *const _ as *const *const u16);
    if pointer.is_null() {
        StructuredStorage::PropVariantClear(&mut property_value)?;
        return Err(anyhow!("Audio endpoint has an empty friendly name"));
    }
    let mut length = 0;
    while *pointer.add(length) != 0 {
        length += 1;
    }
    let name = OsString::from_wide(slice::from_raw_parts(pointer, length))
        .to_string_lossy()
        .into_owned();
    StructuredStorage::PropVariantClear(&mut property_value)?;
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_zoom_process_name_tokens() {
        assert!(is_zoom_process_name("zoom.exe"));
        assert!(is_zoom_process_name("Zoom Meetings.exe"));
        assert!(!is_zoom_process_name("superzoomed.exe"));
        assert!(!is_zoom_process_name("ZoomIt.exe"));
    }

    #[test]
    fn enumerates_windows_audio_sessions() {
        let mut system = System::new_all();
        system.refresh_all();
        let result = unsafe { enumerate_audible_zoom_sessions(&system) };
        assert!(
            result.is_ok(),
            "audio session enumeration failed: {result:?}"
        );
    }
}

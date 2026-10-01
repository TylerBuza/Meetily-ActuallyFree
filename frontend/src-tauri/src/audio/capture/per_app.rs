use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordableApp {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub pid: Option<u32>,
    pub has_audio: bool,
    pub icon: Option<String>,
}

pub fn get_recordable_apps_list() -> Result<Vec<RecordableApp>> {
    let mut apps = Vec::new();

    // Use sysinfo to get running processes
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    // Get active audio session PIDs on Windows
    #[cfg(windows)]
    let audio_pids = get_windows_audio_session_pids();
    #[cfg(not(windows))]
    let audio_pids: std::collections::HashSet<u32> = std::collections::HashSet::new();

    let mut seen_executables = std::collections::HashSet::new();

    for (pid, process) in sys.processes() {
        let pid_u32 = pid.as_u32();
        let exe_name = process.name().to_string_lossy().to_string();
        let exe_lower = exe_name.to_lowercase();

        if is_system_process(&exe_lower) {
            continue;
        }

        let is_audio_active = audio_pids.contains(&pid_u32);
        let friendly_name = get_friendly_name(&exe_name);

        if !seen_executables.contains(&exe_lower) {
            seen_executables.insert(exe_lower.clone());
            apps.push(RecordableApp {
                id: exe_name.clone(),
                name: friendly_name,
                executable: exe_name,
                pid: Some(pid_u32),
                has_audio: is_audio_active,
                icon: None,
            });
        } else if is_audio_active {
            if let Some(existing) = apps.iter_mut().find(|a| a.executable.eq_ignore_ascii_case(&exe_name)) {
                existing.has_audio = true;
                existing.pid = Some(pid_u32);
            }
        }
    }

    // Sort: audio-active apps first, then alphabetical by name
    apps.sort_by(|a, b| {
        match (b.has_audio, a.has_audio) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(apps)
}

fn is_system_process(name: &str) -> bool {
    let lower = name.to_lowercase();
    let sys_names = [
        "system", "smss.exe", "csrss.exe", "wininit.exe", "services.exe",
        "lsass.exe", "svchost.exe", "fontdrvhost.exe", "dwm.exe", "sihost.exe",
        "taskhostw.exe", "searchhost.exe", "runtimebroker.exe", "startmenuexperiencehost.exe",
        "shellexperiencehost.exe", "lockapp.exe", "ctfmon.exe", "conhost.exe",
        "wlanext.exe", "spoolsv.exe", "audiodg.exe", "registry", "memory compression",
        "meetily.exe", "meetily-cuda.exe", "meetily-cpu.exe", "meetily-vulkan.exe",
        "llama-helper-x86_64-pc-windows-msvc.exe", "ffmpeg-x86_64-pc-windows-msvc.exe",
        "searchindexer.exe", "securityhealthservice.exe", "smartscreen.exe",
        // macOS system daemons
        "launchd", "kernel_task", "windowserver", "coreaudiod", "distnoted",
        "loginwindow", "finder", "dock", "systemuiserver", "controlcenter",
        "notificationcenter", "talagent", "tccd", "cfprefsd",
    ];

    sys_names.iter().any(|&s| lower == s || lower.strip_suffix(".exe").unwrap_or(&lower) == s)
}

fn get_friendly_name(exe_name: &str) -> String {
    let lower = exe_name.to_lowercase();
    let base = lower.strip_suffix(".exe").unwrap_or(&lower);

    match base {
        "zoom" | "zoomworkplace" => "Zoom Workplace".to_string(),
        "teams" | "ms-teams" => "Microsoft Teams".to_string(),
        "slack" => "Slack".to_string(),
        "chrome" => "Google Chrome".to_string(),
        "msedge" => "Microsoft Edge".to_string(),
        "firefox" => "Mozilla Firefox".to_string(),
        "spotify" => "Spotify".to_string(),
        "discord" => "Discord".to_string(),
        "skype" => "Skype".to_string(),
        "webex" | "atmgr" => "Cisco Webex".to_string(),
        "telegram" => "Telegram".to_string(),
        "whatsapp" => "WhatsApp".to_string(),
        "vlc" => "VLC Media Player".to_string(),
        "code" => "Visual Studio Code".to_string(),
        "devenv" => "Visual Studio".to_string(),
        "obs64" | "obs32" | "obs" => "OBS Studio".to_string(),
        "safari" => "Safari".to_string(),
        "facetime" => "FaceTime".to_string(),
        _ => {
            let mut chars = base.chars();
            match chars.next() {
                None => exe_name.to_string(),
                Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
            }
        }
    }
}

pub fn find_pid_for_app(target_app: &str) -> Option<u32> {
    let target_clean = std::path::Path::new(target_app)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(target_app)
        .to_lowercase();
    let target_base = target_clean.strip_suffix(".exe").unwrap_or(&target_clean);

    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    #[cfg(windows)]
    let audio_pids = get_windows_audio_session_pids();
    #[cfg(not(windows))]
    let audio_pids: std::collections::HashSet<u32> = std::collections::HashSet::new();

    let mut candidate_pids = Vec::new();
    let mut candidate_parents = std::collections::HashMap::new();

    for (pid, process) in sys.processes() {
        let exe_name = process.name().to_string_lossy().to_string().to_lowercase();
        let path_name = process
            .exe()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_lowercase());

        let name_match = exe_name == target_clean
            || exe_name.strip_suffix(".exe").unwrap_or(&exe_name) == target_base
            || path_name.as_deref() == Some(&target_clean)
            || path_name.as_deref().and_then(|p| p.strip_suffix(".exe")) == Some(target_base);

        // Audio can run in a differently named helper (for example a call
        // host). Keep the complete parent map to associate its session with
        // the selected executable's tree rather than an unrelated app root.
        let p = pid.as_u32();
        if let Some(parent) = process.parent() { candidate_parents.insert(p, parent.as_u32()); }
        if name_match { candidate_pids.push(p); }
    }

    let selected = select_app_root(&candidate_pids, &candidate_parents, &audio_pids);
    log::info!("Selected process-tree root {:?} for target app '{}'", selected, target_app);
    selected
}

fn select_app_root(
    candidates: &[u32],
    parents: &std::collections::HashMap<u32, u32>,
    audio_pids: &std::collections::HashSet<u32>,
) -> Option<u32> {
    let candidates: std::collections::HashSet<u32> = candidates.iter().copied().collect();
    let root_of = |mut pid: u32| {
        // Parent snapshots can contain stale PID cycles; never walk indefinitely.
        let mut visited = std::collections::HashSet::new();
        let mut root = None;
        loop {
            if !visited.insert(pid) {
                return visited.iter().filter(|pid| candidates.contains(pid)).copied().min().or(root);
            }
            if candidates.contains(&pid) { root = Some(pid); }
            match parents.get(&pid) {
                Some(parent) => pid = *parent,
                None => return root,
            }
        }
    };
    // Audio sessions choose the relevant tree, never its disposable audio worker.
    // Include differently named descendants and intervening launcher processes.
    audio_pids.iter().filter_map(|pid| root_of(*pid)).min()
        .or_else(|| candidates.iter().filter_map(|pid| root_of(*pid)).min())

}

#[cfg(test)]
mod process_selection_tests {
    use super::select_app_root;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn audio_worker_and_its_replacement_select_the_same_root() {
        let parents = HashMap::from([(11, 10), (12, 10), (13, 12)]);
        assert_eq!(select_app_root(&[10, 11, 12, 13], &parents, &HashSet::from([11])), Some(10));
        assert_eq!(select_app_root(&[10, 12, 13], &parents, &HashSet::from([13])), Some(10));
    }

    #[test]
    fn active_audio_selects_the_correct_independent_tree() {
        let parents = HashMap::from([(11, 10), (21, 20)]);
        assert_eq!(select_app_root(&[10, 11, 20, 21], &parents, &HashSet::from([21])), Some(20));
    }

    #[test]
    fn differently_named_audio_helpers_select_their_app_tree() {
        let parents = HashMap::from([(11, 10), (21, 20), (22, 21), (30, 29)]);
        assert_eq!(select_app_root(&[10, 20], &parents, &HashSet::from([22, 30])), Some(20));
        assert_eq!(select_app_root(&[20, 22], &parents, &HashSet::from([22])), Some(20));
    }

    #[test]
    fn missing_audio_and_stale_parent_cycles_are_bounded() {
        assert_eq!(select_app_root(&[], &HashMap::new(), &HashSet::new()), None);
        assert_eq!(select_app_root(&[12, 10], &HashMap::new(), &HashSet::new()), Some(10));
        assert_eq!(select_app_root(&[11, 10], &HashMap::from([(10, 11), (11, 10)]), &HashSet::from([11])), Some(10));
    }
}

#[cfg(windows)]
fn get_windows_audio_session_pids() -> std::collections::HashSet<u32> {
    use std::collections::HashSet;
    use windows::core::Interface;
    use windows::Win32::Media::Audio::{
        eMultimedia, eRender, IAudioSessionControl2, IAudioSessionManager2,
        IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    struct ComScope(bool);
    impl Drop for ComScope {
        fn drop(&mut self) { if self.0 { unsafe { CoUninitialize() }; } }
    }
    let mut pids = HashSet::new();

    unsafe {
        // Periodic process checks must balance each successful COM init.
        let _com = ComScope(CoInitializeEx(None, COINIT_MULTITHREADED).is_ok());

        let enumerator: Result<IMMDeviceEnumerator, _> =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL);
        if let Ok(enumerator) = enumerator {
            if let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia) {
                if let Ok(session_manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) {
                    if let Ok(session_enum) = session_manager.GetSessionEnumerator() {
                        if let Ok(count) = session_enum.GetCount() {
                            for i in 0..count {
                                if let Ok(session_control) = session_enum.GetSession(i) {
                                    if let Ok(control2) = session_control.cast::<IAudioSessionControl2>() {
                                        if let Ok(pid) = control2.GetProcessId() {
                                            if pid != 0 {
                                                pids.insert(pid);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    pids
}

#[cfg(windows)]
pub mod windows_loopback {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tokio::sync::mpsc;
    use windows::core::{implement, w, IUnknown, Interface, HRESULT};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::Media::Audio::{
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
        IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX,
    };
    use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

    #[repr(C)]
    #[derive(Clone, Copy)]
    #[allow(non_snake_case)]
    pub struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
        pub TargetProcessId: u32,
        pub ProcessLoopbackMode: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    #[allow(non_snake_case)]
    pub struct AUDIOCLIENT_ACTIVATION_PARAMS {
        pub ActivationType: u32,
        pub ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Blob {
        pub cb_size: u32,
        pub p_blob_data: *mut u8,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct PropVariantBlob {
        pub vt: u16,
        pub w_reserved1: u16,
        pub w_reserved2: u16,
        pub w_reserved3: u16,
        pub blob: Blob,
    }

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct AudioActivationHandler {
        tx: std::sync::mpsc::Sender<Result<IUnknown, HRESULT>>,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for AudioActivationHandler {
        fn ActivateCompleted(
            &self,
            operation: Option<&IActivateAudioInterfaceAsyncOperation>,
        ) -> windows::core::Result<()> {
            if let Some(op) = operation {
                let mut hr = HRESULT(0);
                let mut unk = None;
                unsafe {
                    let _ = op.GetActivateResult(&mut hr, &mut unk);
                }
                if hr.is_ok() {
                    if let Some(u) = unk {
                        let _ = self.tx.send(Ok(u));
                        return Ok(());
                    }
                }
                let _ = self.tx.send(Err(hr));
            }
            Ok(())
        }
    }

    #[cfg(test)]
    static TEST_CLIENT_FAULT: AtomicBool = AtomicBool::new(false);
    #[cfg(test)]
    static TEST_CLIENT_STARTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    pub struct ProcessLoopbackTarget {
        pub name: String,
        pub executable: Option<String>,
        pub pid: u32,
    }

    #[derive(Debug)]
    enum SessionExit { Stopped, Idle, TargetChanged }

    #[derive(Default)]
    struct RecoveryPolicy { failures: u32, idle_restarts: u32 }
    impl RecoveryPolicy {
        fn idle_timeout(&self) -> std::time::Duration {
            std::time::Duration::from_secs(300)
        }
        fn next(&mut self, failed: bool, healthy: bool, idle: bool) -> Option<std::time::Duration> {
            if healthy { self.failures = 0; self.idle_restarts = 0; }
            if failed {
                self.failures += 1;
                if self.failures >= 3 { return None; }
            }
            if idle { self.idle_restarts = (self.idle_restarts + 1).min(3); }
            Some(std::time::Duration::from_millis(200 * (self.failures + 1) as u64))
        }
    }

    struct CaptureEvent(HANDLE);
    impl Drop for CaptureEvent {
        fn drop(&mut self) { let _ = unsafe { CloseHandle(self.0) }; }
    }
    struct ComApartment(bool);
    impl Drop for ComApartment {
        fn drop(&mut self) { if self.0 { unsafe { CoUninitialize() }; } }
    }

    fn supervise_process_loopback<F>(
        mut target: ProcessLoopbackTarget,
        stop: Arc<AtomicBool>,
        ready: std::sync::mpsc::Sender<()>,
        state: Arc<crate::audio::recording_state::RecordingState>,
        mut on_samples: F,
    ) where F: FnMut(&[f32]) + Send + 'static {
        // One worker owns COM and all replacement clients. Reconnection keeps
        // the same processor/pipeline and never tears down microphone capture.
        let _com = ComApartment(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok());
        let mut started = false;
        let mut recovery = RecoveryPolicy::default();
        while !stop.load(Ordering::Relaxed) {
            let began = std::time::Instant::now();
            let mut packets = 0;
            let result = match target.executable.as_deref().map(super::find_pid_for_app) {
                Some(None) => Err(anyhow::anyhow!("Selected app is no longer running")),
                found => {
                    if let Some(Some(pid)) = found { target.pid = pid; }
                    run_single_process_loopback_session(&target, &stop, &ready, &mut started,
                        recovery.idle_timeout(), &mut |data| { packets += 1; on_samples(data); })
                }
            };
            if stop.load(Ordering::Relaxed) || matches!(result, Ok(SessionExit::Stopped)) { break; }
            let failed = result.is_err();
            if let Err(error) = &result { log::warn!("Per-app capture for {} needs recovery: {error:#}", target.name); }
            // Startup still fails atomically through the readiness channel.
            if !started { break; }
            let healthy = packets > 0 && began.elapsed() >= std::time::Duration::from_secs(30);
            let idle = matches!(result, Ok(SessionExit::Idle));
            let Some(delay) = recovery.next(failed, healthy, idle) else {
                log::error!("Per-app capture for {} failed after three recovery attempts", target.name);
                stop.store(true, Ordering::Relaxed);
                state.report_error(crate::audio::recording_state::AudioError::PerAppCaptureFailed);
                break;
            };
            log::info!("Reactivating per-app capture for {} ({result:?})", target.name);
            // Short interruptible backoff bounds both retry rate and stop latency.
            let deadline = std::time::Instant::now() + delay;
            while !stop.load(Ordering::Relaxed) && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
    }

    fn run_single_process_loopback_session<F>(
        target: &ProcessLoopbackTarget,
        stop_flag: &AtomicBool,
        ready: &std::sync::mpsc::Sender<()>,
        started: &mut bool,
        idle_timeout: std::time::Duration,
        on_samples: &mut F,
    ) -> Result<SessionExit> where F: FnMut(&[f32]) {
        let target_pid = target.pid;
        let app_name = &target.name;
        let params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: 1, // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: target_pid,
                ProcessLoopbackMode: 0, // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
            },
        };

        let p_mem = unsafe {
            windows::Win32::System::Com::CoTaskMemAlloc(std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>())
        } as *mut AUDIOCLIENT_ACTIVATION_PARAMS;
        if p_mem.is_null() {
            log::error!("❌ CoTaskMemAlloc failed for process loopback parameters for app '{}' (PID {})", app_name, target_pid);
            anyhow::bail!("Could not initialize per-app loopback for {app_name}");
        }
        unsafe {
            std::ptr::write(p_mem, params);
        }

        let prop_blob = PropVariantBlob {
            vt: 65, // VT_BLOB
            w_reserved1: 0,
            w_reserved2: 0,
            w_reserved3: 0,
            blob: Blob {
                cb_size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                p_blob_data: p_mem as *mut u8,
            },
        };

        let mut prop: windows::core::PROPVARIANT = unsafe { std::mem::transmute(prop_blob) };

        let (tx, rx) = std::sync::mpsc::channel();
        let handler: IActivateAudioInterfaceCompletionHandler =
            AudioActivationHandler { tx }.into();

        log::info!("🎙️ Activating process loopback for '{}' (PID {})", app_name, target_pid);
        let async_op = unsafe {
            ActivateAudioInterfaceAsync(
                w!("VAD\\Process_Loopback"),
                &IAudioClient::IID,
                Some(&prop),
                &handler,
            )
        };

        if let Err(e) = async_op {
            log::error!("❌ ActivateAudioInterfaceAsync failed for '{}' (PID {}): {}", app_name, target_pid, e);
            let _ = unsafe { PropVariantClear(&mut prop) };
            anyhow::bail!("Could not initialize per-app loopback for {app_name}");
        }

        let audio_client_unk = match rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(unk)) => unk,
            Ok(Err(hr)) => {
                log::error!("❌ Process loopback activation failed for '{}' (PID {}) with HRESULT 0x{:08X}", app_name, target_pid, hr.0);
                let _ = unsafe { PropVariantClear(&mut prop) };
                anyhow::bail!("Could not initialize per-app loopback for {app_name}");
            }
            Err(e) => {
                log::error!("❌ Process loopback activation timed out for '{}' (PID {}): {}", app_name, target_pid, e);
                let _ = unsafe { PropVariantClear(&mut prop) };
                anyhow::bail!("Could not initialize per-app loopback for {app_name}");
            }
        };

        let _ = unsafe { PropVariantClear(&mut prop) };

        let audio_client: IAudioClient = match audio_client_unk.cast() {
            Ok(client) => client,
            Err(e) => {
                log::error!("❌ Failed to cast activated interface to IAudioClient for '{}': {}", app_name, e);
                anyhow::bail!("Could not initialize per-app loopback for {app_name}");
            }
        };

        let mut fallback_wfx = WAVEFORMATEX {
            wFormatTag: 1, // WAVE_FORMAT_PCM
            nChannels: 2,
            nSamplesPerSec: 48000,
            nAvgBytesPerSec: 48000 * 4, // 192000 bytes/sec
            nBlockAlign: 4, // 2 channels * 2 bytes/sample
            wBitsPerSample: 16,
            cbSize: 0,
        };

        // Process loopback GetMixFormat may be unsupported, and changing output
        // endpoints must not change the pipeline's 48 kHz stereo contract.
        let p_wfx_to_use = std::ptr::addr_of_mut!(fallback_wfx);
        let (channels, sample_rate, bits_per_sample) = (2u16, 48_000u32, 16u16);
        let auto_convert_flags = 0x80000000u32 | 0x08000000u32;

        log::info!(
            "🔊 Process loopback format configured for '{}': {} Hz, {} channels, {} bits/sample",
            app_name, sample_rate, channels, bits_per_sample
        );

        let event = match unsafe { CreateEventW(None, false, false, None) } {
            Ok(e) => e,
            Err(e) => {
                log::error!("❌ Failed to create event for '{}': {}", app_name, e);
                anyhow::bail!("Could not initialize per-app loopback for {app_name}");
            }
        };

        let _event_owner = CaptureEvent(event);

        let stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK
            | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
            | auto_convert_flags;

        let init_res = unsafe {
            audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                stream_flags,
                10_000_000, // 1 second buffer
                0,
                p_wfx_to_use,
                None,
            )
        };

        if let Err(e) = init_res {
            log::error!("❌ Failed to initialize audio client for '{}': {}", app_name, e);
            anyhow::bail!("Could not initialize per-app loopback for {app_name}");
        }

        if let Err(e) = unsafe { audio_client.SetEventHandle(event) } {
            log::error!("❌ Failed to set event handle for '{}': {}", app_name, e);
            anyhow::bail!("Could not initialize per-app loopback for {app_name}");
        }

        let capture_client: IAudioCaptureClient = match unsafe { audio_client.GetService() } {
            Ok(client) => client,
            Err(e) => {
                log::error!("❌ Failed to get IAudioCaptureClient for '{}': {}", app_name, e);
                anyhow::bail!("Could not initialize per-app loopback for {app_name}");
            }
        };

        if let Err(e) = unsafe { audio_client.Start() } {
            log::error!("❌ Failed to start audio client for '{}': {}", app_name, e);
            anyhow::bail!("Could not initialize per-app loopback for {app_name}");
        }

        log::info!("✅ Process loopback started successfully for '{}' (PID {})", app_name, target_pid);
        if !*started { let _ = ready.send(()); *started = true; }
        #[cfg(test)]
        TEST_CLIENT_STARTS.fetch_add(1, Ordering::Relaxed);
        #[cfg(test)]
        let test_started = std::time::Instant::now();

        let mut f32_buffer = Vec::new();
        let mut last_packet = std::time::Instant::now();
        let mut last_target_check = last_packet;
        let outcome = 'capture: loop {
            if stop_flag.load(Ordering::Relaxed) { break Ok(SessionExit::Stopped); }
            let wait_res = unsafe { WaitForSingleObject(event, 200) };
            if wait_res != WAIT_OBJECT_0 && wait_res != WAIT_TIMEOUT {
                break Err(anyhow::anyhow!("Per-app event wait failed: {wait_res:?}"));
            }
            #[cfg(test)]
            if test_started.elapsed() >= std::time::Duration::from_secs(2) && TEST_CLIENT_FAULT.swap(false, Ordering::Relaxed) {
                break Err(anyhow::anyhow!("Injected client invalidation for recovery qualification"));
            }
            // A missed notification must not strand queued sound. Bound each
            // drain so stop, process checks, and the watchdog retain ownership.
            for _ in 0..128 {
                if stop_flag.load(Ordering::Relaxed) { break 'capture Ok(SessionExit::Stopped); }
                let mut p_data = std::ptr::null_mut();
                let mut num_frames = 0u32;
                let mut flags = 0u32;
                if let Err(error) = unsafe { capture_client.GetBuffer(&mut p_data, &mut num_frames, &mut flags, None, None) } {
                    break 'capture Err(anyhow::anyhow!("Per-app GetBuffer failed: {error}"));
                }
                if num_frames == 0 { break; }
                let is_silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                unsafe { decode_loopback_packet(&mut f32_buffer, p_data, num_frames, channels, bits_per_sample, is_silent); }
                // Copy/decode first, then release ownership before downstream
                // processing. Release failures invalidate this client too.
                if let Err(error) = unsafe { capture_client.ReleaseBuffer(num_frames) } {
                    break 'capture Err(anyhow::anyhow!("Per-app ReleaseBuffer failed: {error}"));
                }
                last_packet = std::time::Instant::now();
                on_samples(&f32_buffer);
            }
            let now = std::time::Instant::now();
            if now.duration_since(last_target_check) >= std::time::Duration::from_secs(2) {
                last_target_check = now;
                if target.executable.as_deref().is_some_and(|exe| super::find_pid_for_app(exe) != Some(target_pid)) {
                    break Ok(SessionExit::TargetChanged);
                }
            }
            if now.duration_since(last_packet) >= idle_timeout {
                // No packets can mean ordinary application silence. Reactivate
                // without declaring it fatal; repeated idle checks back off.
                break Ok(SessionExit::Idle);
            }
        };

        let _ = unsafe { audio_client.Stop() };
        log::info!("🛑 Process loopback stopped for '{}' (PID {})", app_name, target_pid);
        outcome
    }

    fn queue_audio(queue: &mut std::collections::VecDeque<f32>, data: &[f32]) {
        const MAX_SAMPLES: usize = 19_200; // 200 ms of 48 kHz stereo.
        let incoming = &data[data.len().saturating_sub(MAX_SAMPLES)..];
        let excess = queue.len().saturating_add(incoming.len()).saturating_sub(MAX_SAMPLES);
        queue.drain(..excess.min(queue.len()));
        queue.extend(incoming.iter().copied());
    }

    pub fn start_multi_process_loopback(
        device: Arc<crate::audio::devices::AudioDevice>,
        state: Arc<crate::audio::recording_state::RecordingState>,
        recording_sender: Option<mpsc::UnboundedSender<crate::audio::recording_state::AudioChunk>>,
        target_pids: Vec<ProcessLoopbackTarget>,
        stop_flag: Arc<AtomicBool>,
    ) -> Result<Vec<std::thread::JoinHandle<()>>> {
        // Startup is acknowledged only after every selected AudioClient starts.
        // A worker returning early drops its sender; the caller tears down peers.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let target_count = target_pids.len();
        let processor = Arc::new(crate::audio::pipeline::AudioCapture::new(
            device,
            state.clone(),
            48000,
            2,
            crate::audio::recording_state::DeviceType::System,
            recording_sender,
        ));

        if target_pids.len() == 1 {
            let target = target_pids.into_iter().next().unwrap();
            let stop_flag_clone = stop_flag.clone();
            let proc = processor.clone();
            let handle = std::thread::spawn(move || {
                supervise_process_loopback(target, stop_flag_clone, ready_tx, state, move |data| {
                    proc.process_audio_data(data);
                });
            });
            let handles = vec![handle];
            return await_capture_start(ready_rx, 1, stop_flag, handles);
        }

        // Multiple target apps: create queues and mixer thread
        let queues: Arc<Vec<std::sync::Mutex<std::collections::VecDeque<f32>>>> = Arc::new(
            (0..target_pids.len())
                .map(|_| std::sync::Mutex::new(std::collections::VecDeque::with_capacity(9600)))
                .collect(),
        );

        let mut handles = Vec::new();

        for (idx, target) in target_pids.into_iter().enumerate() {
            let ready = ready_tx.clone();
            let stop_flag_worker = stop_flag.clone();
            let queues_clone = queues.clone();
            let worker_state = state.clone();
            let handle = std::thread::spawn(move || {
                supervise_process_loopback(target, stop_flag_worker, ready, worker_state, move |data| {
                    if let Ok(mut q) = queues_clone[idx].lock() {
                        queue_audio(&mut q, data);
                    }
                });
            });
            handles.push(handle);
        }

        // Mixer thread
        let stop_flag_mixer = stop_flag.clone();
        let queues_mixer = queues.clone();
        let proc_mixer = processor.clone();

        let mixer_handle = std::thread::spawn(move || {
            const CHANNELS: usize = 2;
            const CHUNK_DURATION_MS: u64 = 10;
            const FRAMES_PER_CHUNK: usize = 480; // 10ms @ 48kHz
            const SAMPLES_PER_CHUNK: usize = FRAMES_PER_CHUNK * CHANNELS; // 960

            let mut mixed_buffer = vec![0.0f32; SAMPLES_PER_CHUNK];
            let mut next_tick = std::time::Instant::now();

            while !stop_flag_mixer.load(Ordering::Relaxed) {
                next_tick += std::time::Duration::from_millis(CHUNK_DURATION_MS);
                let now = std::time::Instant::now();
                if next_tick > now {
                    std::thread::sleep(next_tick - now);
                } else {
                    next_tick = now;
                }

                mixed_buffer.fill(0.0);

                for queue_mutex in queues_mixer.iter() {
                    if let Ok(mut queue) = queue_mutex.lock() {
                        let count = queue.len().min(SAMPLES_PER_CHUNK);
                        if count > 0 {
                            for j in 0..count {
                                if let Some(s) = queue.pop_front() {
                                    mixed_buffer[j] += s;
                                }
                            }
                        }
                    }
                }

                // Prevent clipping distortion
                for sample in mixed_buffer.iter_mut() {
                    *sample = sample.clamp(-1.0, 1.0);
                }

                proc_mixer.process_audio_data(&mixed_buffer);
            }

            log::info!("🛑 Multi-app audio mixer thread stopped");
        });

        handles.push(mixer_handle);
        drop(ready_tx);
        await_capture_start(ready_rx, target_count, stop_flag, handles)
    }

    fn await_capture_start(
        ready: std::sync::mpsc::Receiver<()>,
        count: usize,
        stop: Arc<AtomicBool>,
        handles: Vec<std::thread::JoinHandle<()>>,
    ) -> Result<Vec<std::thread::JoinHandle<()>>> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        for _ in 0..count {
            if ready.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())).is_err() {
                stop.store(true, Ordering::Relaxed);
                // Do not block the command indefinitely on a stalled native API.
                // The stop flag remains owned by each worker until it exits.
                for handle in handles { if handle.is_finished() { let _ = handle.join(); } }
                anyhow::bail!("Could not start audio capture for every selected app. Check that the apps are running and Windows supports process loopback capture.");
            }
        }
        Ok(handles)
    }

    pub fn start_process_loopback(
        device: Arc<crate::audio::devices::AudioDevice>,
        state: Arc<crate::audio::recording_state::RecordingState>,
        recording_sender: Option<mpsc::UnboundedSender<crate::audio::recording_state::AudioChunk>>,
        target_pid: u32,
        stop_flag: Arc<AtomicBool>,
    ) -> Result<std::thread::JoinHandle<()>> {
        let mut handles = start_multi_process_loopback(
            device,
            state,
            recording_sender,
            vec![ProcessLoopbackTarget { name: "Target".into(), executable: None, pid: target_pid }],
            stop_flag,
        )?;
        Ok(handles.remove(0))
    }

    /// `data` points to `frames * channels` samples owned by WASAPI until release.
    /// A silent packet may use a null pointer; never dereference it.
    unsafe fn decode_loopback_packet(buffer: &mut Vec<f32>, data: *const u8, frames: u32, channels: u16, bits: u16, silent: bool) {
        let count = frames as usize * channels as usize;
        buffer.clear();
        buffer.resize(count, 0.0);
        if silent || data.is_null() { return; }
        if bits == 32 {
            buffer.copy_from_slice(std::slice::from_raw_parts(data as *const f32, count));
        } else if bits == 16 {
            for (target, sample) in buffer.iter_mut().zip(std::slice::from_raw_parts(data as *const i16, count)) {
                *target = *sample as f32 / 32768.0;
            }
        }
    }

    #[cfg(test)]
    mod startup_tests {
        use super::*;

        #[test]
        #[ignore = "Windows live endpoint test: plays a synthetic tone, captures only this test process, and injects one client failure"]
        fn real_process_loopback_resumes_after_client_invalidation() {
            use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_LOOP, SND_NODEFAULT};
            use windows::core::PCWSTR;
            use std::sync::atomic::AtomicUsize;
            let seconds = std::env::var("MEETILY_LOOPBACK_SECONDS").ok().and_then(|value| value.parse::<u64>().ok()).unwrap_or(120).max(10);
            let dir = tempfile::tempdir().unwrap();
            let track = dir.path().join("synthetic-tone.wav");
            let count = 48_000u32;
            let mut wav = Vec::new();
            wav.extend_from_slice(b"RIFF"); wav.extend_from_slice(&(36 + count * 2).to_le_bytes()); wav.extend_from_slice(b"WAVEfmt ");
            wav.extend_from_slice(&16u32.to_le_bytes()); wav.extend_from_slice(&1u16.to_le_bytes()); wav.extend_from_slice(&1u16.to_le_bytes());
            wav.extend_from_slice(&48_000u32.to_le_bytes()); wav.extend_from_slice(&96_000u32.to_le_bytes());
            wav.extend_from_slice(&2u16.to_le_bytes()); wav.extend_from_slice(&16u16.to_le_bytes());
            wav.extend_from_slice(b"data"); wav.extend_from_slice(&(count * 2).to_le_bytes());
            for index in 0..count {
                let sample = ((index as f32 * 2.0 * std::f32::consts::PI * 220.0 / 48_000.0).sin() * 1_000.0) as i16;
                wav.extend_from_slice(&sample.to_le_bytes());
            }
            std::fs::write(&track, wav).unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            struct Cleanup { stop: Arc<AtomicBool>, worker: Option<std::thread::JoinHandle<()>> }
            impl Drop for Cleanup {
                fn drop(&mut self) {
                    self.stop.store(true, Ordering::Relaxed);
                    let _ = unsafe { PlaySoundW(PCWSTR::null(), None, SND_ASYNC) };
                    if let Some(worker) = self.worker.take() { let _ = worker.join(); }
                    TEST_CLIENT_FAULT.store(false, Ordering::Relaxed);
                }
            }
            TEST_CLIENT_STARTS.store(0, Ordering::Relaxed);
            TEST_CLIENT_FAULT.store(true, Ordering::Relaxed);
            let early = Arc::new(AtomicUsize::new(0));
            let resumed = Arc::new(AtomicUsize::new(0));
            let late = Arc::new(AtomicUsize::new(0));
            let (ready, received) = std::sync::mpsc::channel();
            let began = std::time::Instant::now();
            let worker_stop = stop.clone();
            let counts = (early.clone(), resumed.clone(), late.clone());
            let state = crate::audio::recording_state::RecordingState::new();
            let worker_state = state.clone();
            let worker = std::thread::spawn(move || {
                supervise_process_loopback(ProcessLoopbackTarget { name: "Synthetic test".into(), executable: None, pid: std::process::id() },
                    worker_stop, ready, worker_state, move |samples| {
                        if samples.iter().any(|sample| sample.abs() > 0.001) {
                            if TEST_CLIENT_STARTS.load(Ordering::Relaxed) == 1 { counts.0.fetch_add(1, Ordering::Relaxed); }
                            else { counts.1.fetch_add(1, Ordering::Relaxed); }
                            if began.elapsed().as_secs() >= seconds - 5 { counts.2.fetch_add(1, Ordering::Relaxed); }
                        }
                    });
            });
            let _cleanup = Cleanup { stop, worker: Some(worker) };
            received.recv_timeout(std::time::Duration::from_secs(8)).expect("Process capture did not start");
            let wide: Vec<u16> = track.to_string_lossy().encode_utf16().chain(Some(0)).collect();
            assert!(unsafe { PlaySoundW(PCWSTR(wide.as_ptr()), None, SND_ASYNC | SND_FILENAME | SND_LOOP | SND_NODEFAULT) }.as_bool(), "Synthetic playback failed");
            while began.elapsed().as_secs() < seconds { std::thread::sleep(std::time::Duration::from_millis(100)); }
            assert!(early.load(Ordering::Relaxed) > 0, "No initial process audio");
            assert!(resumed.load(Ordering::Relaxed) > 0, "Process audio did not recover");
            assert!(late.load(Ordering::Relaxed) > 0, "Process audio stopped during sustained capture");
            assert!(state.get_last_error().is_none(), "Recovery became fatal");
            println!("Synthetic process capture sustained {seconds}s; client starts {}, signal packets before {}, after {}, late {}", TEST_CLIENT_STARTS.load(Ordering::Relaxed), early.load(Ordering::Relaxed), resumed.load(Ordering::Relaxed), late.load(Ordering::Relaxed));
        }

        #[test]
        fn failed_clients_retry_then_report_failure_with_bounded_backoff() {
            let mut recovery = RecoveryPolicy::default();
            assert_eq!(recovery.next(true, false, false).unwrap().as_millis(), 400);
            assert_eq!(recovery.next(true, false, false).unwrap().as_millis(), 600);
            assert!(recovery.next(true, false, false).is_none());
            assert!(!crate::audio::recording_state::AudioError::PerAppCaptureFailed.is_recoverable());
        }
        #[test]
        fn ordinary_app_silence_keeps_retrying_without_fatal_errors() {
            let mut recovery = RecoveryPolicy::default();
            assert_eq!(recovery.idle_timeout().as_secs(), 5);
            for _ in 0..20 { assert!(recovery.next(false, false, true).is_some()); }
            assert_eq!(recovery.idle_timeout().as_secs(), 30);
            assert_eq!(recovery.failures, 0);
            recovery.next(false, true, false).unwrap();
            assert_eq!(recovery.idle_timeout().as_secs(), 5);
        }
        #[test]
        fn sustained_healthy_capture_resets_a_previous_client_failure() {
            let mut recovery = RecoveryPolicy::default();
            recovery.next(true, false, false).unwrap();
            recovery.next(true, false, false).unwrap();
            assert!(recovery.next(true, true, false).is_some());
            assert_eq!(recovery.failures, 1);
        }
        #[test]
        fn large_packets_cannot_overrun_the_multi_app_queue() {
            let mut queue = std::collections::VecDeque::from(vec![0.0; 19_000]);
            let packet: Vec<f32> = (0..96_000).map(|n| n as f32).collect();
            queue_audio(&mut queue, &packet);
            assert_eq!(queue.len(), 19_200);
            assert_eq!(queue.front(), Some(&76_800.0));
            assert_eq!(queue.back(), Some(&95_999.0));
        }

        #[test]
        fn silent_null_packet_preserves_frames_before_speech_resumes() {
            let mut buffer = vec![1.0; 8];
            unsafe { decode_loopback_packet(&mut buffer, std::ptr::null(), 3, 2, 32, true); }
            assert_eq!(buffer, vec![0.0; 6]);
            let speech = [0.25f32, -0.5, 0.75, -1.0];
            unsafe { decode_loopback_packet(&mut buffer, speech.as_ptr() as *const u8, 2, 2, 32, false); }
            assert_eq!(buffer, speech);
        }

        #[test]
        fn partial_startup_failure_stops_all_selected_apps() {
            let (tx, rx) = std::sync::mpsc::channel();
            tx.send(()).unwrap();
            drop(tx); // Second capture failed before acknowledging Start.
            let stop = Arc::new(AtomicBool::new(false));
            assert!(await_capture_start(rx, 2, stop.clone(), vec![]).is_err());
            assert!(stop.load(Ordering::Relaxed));
        }

        #[test]
        fn all_selected_apps_must_acknowledge_startup() {
            let (tx, rx) = std::sync::mpsc::channel();
            tx.send(()).unwrap();
            tx.send(()).unwrap();
            drop(tx);
            let stop = Arc::new(AtomicBool::new(false));
            assert!(await_capture_start(rx, 2, stop.clone(), vec![]).is_ok());
            assert!(!stop.load(Ordering::Relaxed));
        }
    }
}

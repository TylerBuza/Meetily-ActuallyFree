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

        if name_match {
            let p = pid.as_u32();
            if audio_pids.contains(&p) {
                log::info!("🎯 Found active audio session PID {} for target app '{}'", p, target_app);
                return Some(p);
            }
            candidate_pids.push(p);
            if let Some(parent) = process.parent() {
                candidate_parents.insert(p, parent.as_u32());
            }
        }
    }

    // If an audio session pid wasn't found yet, prefer the root process of the tree
    // (a process whose parent is not also in candidate_pids), because targeting
    // the root with PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE captures
    // the entire process tree.
    for &pid in &candidate_pids {
        if let Some(&parent_pid) = candidate_parents.get(&pid) {
            if !candidate_pids.contains(&parent_pid) {
                log::info!("🎯 Selected root candidate PID {} for target app '{}'", pid, target_app);
                return Some(pid);
            }
        } else {
            log::info!("🎯 Selected candidate PID {} (no parent) for target app '{}'", pid, target_app);
            return Some(pid);
        }
    }

    let fallback = candidate_pids.first().copied();
    log::info!("🎯 Selected first candidate PID {:?} for target app '{}'", fallback, target_app);
    fallback
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
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    let mut pids = HashSet::new();

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

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
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::Media::Audio::{
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
        IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX,
    };
    use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
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

    fn run_single_process_loopback_session<F>(
        target_pid: u32,
        app_name: String,
        stop_flag: Arc<AtomicBool>,
        ready: std::sync::mpsc::Sender<()>,
        mut on_samples: F,
    ) where
        F: FnMut(&[f32]) + Send + 'static,
    {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }

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
            return;
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
            return;
        }

        let audio_client_unk = match rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(unk)) => unk,
            Ok(Err(hr)) => {
                log::error!("❌ Process loopback activation failed for '{}' (PID {}) with HRESULT 0x{:08X}", app_name, target_pid, hr.0);
                let _ = unsafe { PropVariantClear(&mut prop) };
                return;
            }
            Err(e) => {
                log::error!("❌ Process loopback activation timed out for '{}' (PID {}): {}", app_name, target_pid, e);
                let _ = unsafe { PropVariantClear(&mut prop) };
                return;
            }
        };

        let _ = unsafe { PropVariantClear(&mut prop) };

        let audio_client: IAudioClient = match audio_client_unk.cast() {
            Ok(client) => client,
            Err(e) => {
                log::error!("❌ Failed to cast activated interface to IAudioClient for '{}': {}", app_name, e);
                return;
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

        let (p_wfx_to_use, channels, sample_rate, bits_per_sample, auto_convert_flags) = unsafe {
            match audio_client.GetMixFormat() {
                Ok(p) if !p.is_null() => {
                    let w = *p;
                    let sr = w.nSamplesPerSec;
                    let ch = w.nChannels;
                    let bits = w.wBitsPerSample;
                    log::info!(
                        "🔊 Process loopback using native mix format for '{}': {} Hz, {} channels, {} bits/sample",
                        app_name, sr, ch, bits
                    );
                    (p, ch, sr, bits, 0u32)
                }
                res => {
                    log::info!(
                        "ℹ️ audio_client.GetMixFormat() for '{}' returned {:?}. Using 48kHz 16-bit PCM with AUTOCONVERTPCM",
                        app_name, res.err()
                    );
                    (
                        &mut fallback_wfx as *mut WAVEFORMATEX,
                        2u16,
                        48000u32,
                        16u16,
                        0x80000000u32 /* AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM */
                            | 0x08000000u32 /* AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY */,
                    )
                }
            }
        };

        log::info!(
            "🔊 Process loopback format configured for '{}': {} Hz, {} channels, {} bits/sample",
            app_name, sample_rate, channels, bits_per_sample
        );

        let event = match unsafe { CreateEventW(None, false, false, None) } {
            Ok(e) => e,
            Err(e) => {
                log::error!("❌ Failed to create event for '{}': {}", app_name, e);
                return;
            }
        };

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
            let _ = unsafe { CloseHandle(event) };
            return;
        }

        if let Err(e) = unsafe { audio_client.SetEventHandle(event) } {
            log::error!("❌ Failed to set event handle for '{}': {}", app_name, e);
            let _ = unsafe { CloseHandle(event) };
            return;
        }

        let capture_client: IAudioCaptureClient = match unsafe { audio_client.GetService() } {
            Ok(client) => client,
            Err(e) => {
                log::error!("❌ Failed to get IAudioCaptureClient for '{}': {}", app_name, e);
                let _ = unsafe { CloseHandle(event) };
                return;
            }
        };

        if let Err(e) = unsafe { audio_client.Start() } {
            log::error!("❌ Failed to start audio client for '{}': {}", app_name, e);
            let _ = unsafe { CloseHandle(event) };
            return;
        }

        log::info!("✅ Process loopback started successfully for '{}' (PID {})", app_name, target_pid);
        let _ = ready.send(());
        drop(ready);

        let mut f32_buffer = Vec::new();

        while !stop_flag.load(Ordering::Relaxed) {
            let wait_res = unsafe { WaitForSingleObject(event, 200) };
            if wait_res == WAIT_OBJECT_0 {
                loop {
                    let mut p_data = std::ptr::null_mut();
                    let mut num_frames = 0u32;
                    let mut flags = 0u32;

                    let get_res = unsafe {
                        capture_client.GetBuffer(
                            &mut p_data,
                            &mut num_frames,
                            &mut flags,
                            None,
                            None,
                        )
                    };

                    if get_res.is_err() || num_frames == 0 || p_data.is_null() {
                        break;
                    }

                    let is_silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                    let total_samples = (num_frames * channels as u32) as usize;

                    f32_buffer.clear();
                    f32_buffer.resize(total_samples, 0.0);

                    if !is_silent {
                        if bits_per_sample == 32 {
                            let float_slice = unsafe {
                                std::slice::from_raw_parts(p_data as *const f32, total_samples)
                            };
                            f32_buffer.copy_from_slice(float_slice);
                        } else if bits_per_sample == 16 {
                            let i16_slice = unsafe {
                                std::slice::from_raw_parts(p_data as *const i16, total_samples)
                            };
                            for (i, &s) in i16_slice.iter().enumerate() {
                                f32_buffer[i] = s as f32 / 32768.0;
                            }
                        }
                    }

                    on_samples(&f32_buffer);

                    let _ = unsafe { capture_client.ReleaseBuffer(num_frames) };
                }
            } else if wait_res == WAIT_TIMEOUT {
                continue;
            } else {
                break;
            }
        }

        let _ = unsafe { audio_client.Stop() };
        let _ = unsafe { CloseHandle(event) };
        log::info!("🛑 Process loopback stopped for '{}' (PID {})", app_name, target_pid);
    }

    pub fn start_multi_process_loopback(
        device: Arc<crate::audio::devices::AudioDevice>,
        state: Arc<crate::audio::recording_state::RecordingState>,
        recording_sender: Option<mpsc::UnboundedSender<crate::audio::recording_state::AudioChunk>>,
        target_pids: Vec<(String, u32)>,
        stop_flag: Arc<AtomicBool>,
    ) -> Result<Vec<std::thread::JoinHandle<()>>> {
        // Startup is acknowledged only after every selected AudioClient starts.
        // A worker returning early drops its sender; the caller tears down peers.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let target_count = target_pids.len();
        let processor = Arc::new(crate::audio::pipeline::AudioCapture::new(
            device,
            state,
            48000,
            2,
            crate::audio::recording_state::DeviceType::System,
            recording_sender,
        ));

        if target_pids.len() == 1 {
            let (app_name, pid) = target_pids.into_iter().next().unwrap();
            let stop_flag_clone = stop_flag.clone();
            let proc = processor.clone();
            let handle = std::thread::spawn(move || {
                run_single_process_loopback_session(pid, app_name, stop_flag_clone, ready_tx, move |data| {
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

        for (idx, (app_name, pid)) in target_pids.into_iter().enumerate() {
            let ready = ready_tx.clone();
            let stop_flag_worker = stop_flag.clone();
            let queues_clone = queues.clone();
            let handle = std::thread::spawn(move || {
                run_single_process_loopback_session(pid, app_name, stop_flag_worker, ready, move |data| {
                    if let Ok(mut q) = queues_clone[idx].lock() {
                        let q_len = q.len();
                        if q_len + data.len() > 19200 {
                            let drop_count = (q_len + data.len()) - 19200;
                            q.drain(0..drop_count.min(q_len));
                        }
                        q.extend(data.iter().copied());
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
            vec![("Target".to_string(), target_pid)],
            stop_flag,
        )?;
        Ok(handles.remove(0))
    }

    #[cfg(test)]
    mod startup_tests {
        use super::*;

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

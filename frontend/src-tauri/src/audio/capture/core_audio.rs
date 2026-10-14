// Core Audio implementation for macOS system audio capture

#[cfg(target_os = "macos")]
use std::pin::Pin;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use anyhow::Result;
use futures_util::Stream;
use ringbuf::{
    traits::{Consumer, Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use log::{error, info, warn};

#[cfg(target_os = "macos")]
use cidre::{arc, av, cat, cf, core_audio as ca, os};

#[cfg(target_os = "macos")]
extern "C" {
    /// libSystem: the app a helper process acts for (browser renderer → browser,
    /// WebKit WebContent → Safari). Returns the pid itself for ordinary processes.
    fn responsibility_get_pid_responsible_for_pid(pid: i32) -> i32;
    /// libproc: the executable path of a process.
    fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, size: u32) -> i32;
}

/// Executable path of `pid`. `proc_pidpath` also works for Apple's own apps
/// (Safari, QuickTime Player), for which sysinfo returns no executable.
#[cfg(target_os = "macos")]
fn exe_path(pid: i32) -> Option<String> {
    let mut buffer = [0u8; 4096];
    let len = unsafe { proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    (len > 0).then(|| String::from_utf8_lossy(&buffer[..len as usize]).into_owned())
}

/// Core Audio process objects that belong to the chosen apps: the apps' own
/// processes plus helpers they are responsible for, which is where browsers
/// and WebKit actually play audio. Only processes that have used audio exist
/// as Core Audio process objects, so apps not yet playing are missing until
/// they start; a per-app stream re-scans while recording (`follow_process_objects`).
#[cfg(target_os = "macos")]
pub fn audio_process_objects_for_apps(apps: &[String]) -> Vec<u32> {
    let Ok(processes) = ca::Process::list() else { return Vec::new() };
    let candidates: Vec<(u32, [i32; 2])> = processes
        .into_iter()
        .filter_map(|process| {
            let pid = process.pid().ok()?;
            let responsible = unsafe { responsibility_get_pid_responsible_for_pid(pid) };
            Some((process.0 .0, [pid, responsible]))
        })
        .collect();
    let mut objects: Vec<u32> = candidates
        .into_iter()
        .filter(|(_, pids)| {
            pids.iter()
                .filter_map(|&p| exe_path(p))
                .any(|path| apps.iter().any(|app| app_owns_exe_path(app, &path)))
        })
        .map(|(object, _)| object)
        .collect();
    objects.sort_unstable();
    objects.dedup();
    objects
}

/// How often a per-app tap looks for newly started audio processes of the
/// chosen apps (joining a call, a browser restarting its audio service). A
/// scan is one process-object list plus a path lookup per process, so it is
/// cheap; at 1.5 s an app's first sentence was measured going missing.
#[cfg(target_os = "macos")]
const APP_RESCAN_INTERVAL: Duration = std::time::Duration::from_millis(500);

/// Re-scan loop behind a per-app tap. `applied` is the process list the tap
/// currently has; every `interval` the matching processes are scanned again
/// and, only when the set differs, handed to `apply`. A failed apply keeps the
/// old set so the next tick retries. Returns when `stop`'s sender is dropped.
#[cfg(any(target_os = "macos", test))]
fn follow_process_objects(
    mut applied: Vec<u32>,
    stop: &std::sync::mpsc::Receiver<()>,
    interval: std::time::Duration,
    mut scan: impl FnMut() -> Vec<u32>,
    mut apply: impl FnMut(&[u32]) -> Result<()>,
) {
    use std::sync::mpsc::RecvTimeoutError;
    applied.sort_unstable();
    applied.dedup();
    let mut last_failed: Option<Vec<u32>> = None;
    while let Err(RecvTimeoutError::Timeout) = stop.recv_timeout(interval) {
        let mut scanned = scan();
        scanned.sort_unstable();
        scanned.dedup();
        if scanned == applied {
            continue;
        }
        match apply(&scanned) {
            Ok(()) => {
                info!("🎯 CoreAudio: per-app tap now follows process objects {:?} (was {:?})", scanned, applied);
                applied = scanned;
                last_failed = None;
            }
            Err(e) => {
                // Warn once per target set instead of every tick.
                if last_failed.as_ref() != Some(&scanned) {
                    warn!("⚠️ CoreAudio: could not update per-app tap to {:?}: {}", scanned, e);
                }
                last_failed = Some(scanned);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn process_object_array(objects: &[u32]) -> arc::R<cidre::ns::Array<cidre::ns::Number>> {
    let nums: Vec<_> = objects.iter().map(|&id| cidre::ns::Number::with_u32(id)).collect();
    let refs: Vec<&cidre::ns::Number> = nums.iter().map(|n| &**n).collect();
    cidre::ns::Array::from_slice(&refs)
}

/// Replace a live tap's include list in place (`kAudioTapPropertyDescription`
/// is settable). The current description is edited so its UUID, and with it
/// the tap UID the aggregate device refers to, stays the same.
#[cfg(target_os = "macos")]
fn set_tap_processes(tap: &mut ca::TapGuard, objects: &[u32]) -> Result<()> {
    let mut desc = tap.desc().map_err(|e| anyhow::anyhow!("read tap description: {:?}", e))?;
    desc.set_processes(&process_object_array(objects));
    tap.set_desc(desc).map_err(|e| anyhow::anyhow!("set tap description: {:?}", e))
}

/// Background re-scan thread owned by a per-app `CoreAudioStream`. Dropping
/// it stops and joins the thread, so the tap is never touched after the
/// stream releases it.
#[cfg(target_os = "macos")]
struct ProcessFollower {
    stop: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(target_os = "macos")]
impl ProcessFollower {
    fn spawn(tap: Arc<Mutex<ca::TapGuard>>, apps: Vec<String>, initial: Vec<u32>) -> Result<Self> {
        let (stop, stop_rx) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("core-audio-app-rescan".into())
            .spawn(move || {
                follow_process_objects(
                    initial,
                    &stop_rx,
                    APP_RESCAN_INTERVAL,
                    || audio_process_objects_for_apps(&apps),
                    |objects| set_tap_processes(&mut tap.lock().unwrap(), objects),
                )
            })?;
        Ok(Self { stop: Some(stop), thread: Some(thread) })
    }
}

#[cfg(target_os = "macos")]
impl Drop for ProcessFollower {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Whether `exe_path` is the app's executable or lives inside its bundle.
/// `app` is what the record card stores: `Google Chrome.app` or `Google Chrome`.
#[cfg(any(target_os = "macos", test))]
fn app_owns_exe_path(app: &str, exe_path: &str) -> bool {
    let app = app.to_lowercase();
    let name = app.strip_suffix(".app").unwrap_or(&app);
    let path = exe_path.to_lowercase();
    path.contains(&format!("/{name}.app/")) || path.rsplit('/').next() == Some(name)
}

/// Waker state for async polling
struct WakerState {
    waker: Option<Waker>,
    has_data: bool,
}

/// Core Audio speaker input using aggregate device + tap
#[cfg(target_os = "macos")]
pub struct CoreAudioCapture {
    tap: ca::TapGuard,
    agg_desc: arc::Retained<cf::DictionaryOf<cf::String, cf::Type>>,
    /// Per-app capture: the chosen apps and the process objects the tap was
    /// created with, so `stream()` can keep the include list current.
    follow_apps: Option<(Vec<String>, Vec<u32>)>,
}

/// Core Audio stream that produces audio samples
#[cfg(target_os = "macos")]
pub struct CoreAudioStream {
    // Field order is drop order: stop the re-scan thread before the device
    // stops and the tap is destroyed.
    _follower: Option<ProcessFollower>,
    consumer: HeapCons<f32>,
    _device: ca::hardware::StartedDevice<ca::AggregateDevice>,
    _ctx: Box<AudioContext>,
    _tap: Arc<Mutex<ca::TapGuard>>,
    waker_state: Arc<Mutex<WakerState>>,
    current_sample_rate: Arc<AtomicU32>,
    last_drop_log: Instant,
}

/// Audio processing context
#[cfg(target_os = "macos")]
struct AudioContext {
    format: arc::R<av::AudioFormat>,
    producer: HeapProd<f32>,
    waker_state: Arc<Mutex<WakerState>>,
    current_sample_rate: Arc<AtomicU32>,
    dropped_samples: AtomicU32,
    should_terminate: Arc<AtomicBool>,
}

#[cfg(target_os = "macos")]
impl CoreAudioCapture {
    /// Create a new Core Audio capture for system audio
    pub fn new() -> Result<Self> {
        Self::new_with_processes(None)
    }

    /// Create a Core Audio capture of only the chosen apps' audio. Apps that
    /// have no audio process yet (call not joined, nothing played) start out
    /// silent; the stream re-scans and adds their processes once they appear.
    pub fn new_for_apps(apps: Vec<String>) -> Result<Self> {
        anyhow::ensure!(!apps.is_empty(), "No apps chosen for per-app recording");
        let objects = audio_process_objects_for_apps(&apps);
        if objects.is_empty() {
            info!("🎯 CoreAudio: none of {:?} has an audio process yet; starting silent until one plays", apps);
        }
        let mut capture = Self::new_with_processes(Some(objects.clone()))?;
        capture.follow_apps = Some((apps, objects));
        Ok(capture)
    }

    /// Create a Core Audio capture of the given Core Audio process objects
    /// (see `audio_process_objects_for_apps`), or of all audio when `None`.
    /// An empty list is a valid tap that delivers silence.
    fn new_with_processes(process_objects: Option<Vec<u32>>) -> Result<Self> {
        info!("🎙️ CoreAudio: Starting Core Audio capture initialization (process objects: {:?})...", process_objects);

        // Audio Capture permission (NSAudioCaptureUsageDescription) is required.
        // The permission dialog is automatically triggered when creating the Core Audio tap.
        // If permission is denied, the tap will return silence (all zeros).

        // Get default output device
        info!("🎙️ CoreAudio: Getting default output device...");
        let output_device = ca::System::default_output_device()
            .map_err(|e| {
                error!("❌ CoreAudio: Failed to get default output device: {:?}", e);
                anyhow::anyhow!("Failed to get default output device: {:?}", e)
            })?;

        info!("✅ CoreAudio: Got default output device");

        let output_uid = output_device.uid()
            .map_err(|e| {
                error!("❌ CoreAudio: Failed to get device UID: {:?}", e);
                anyhow::anyhow!("Failed to get device UID: {:?}", e)
            })?;

        // Get device name for better debugging
        let device_name = output_device.name().unwrap_or_else(|_| cf::String::from_str("Unknown"));
        info!("✅ CoreAudio: Default output device: '{}' (UID: {:?})", device_name, output_uid);

        // IMPORTANT: We do NOT create a sub_device dictionary here
        // When using a tap, the tap provides all the audio we need
        // Including both the tap AND the device creates duplicate audio (echo issue)

        let tap_desc = if let Some(objects) = &process_objects {
            info!("🎙️ CoreAudio: Creating process tap for process objects {:?}...", objects);
            ca::TapDesc::with_mono_mixdown_of_processes(&process_object_array(objects))
        } else {
            info!("🎙️ CoreAudio: Creating process tap (global mono tap)...");
            ca::TapDesc::with_mono_global_tap_excluding_processes(&cidre::ns::Array::new())
        };

        // No fallback to a global tap: the user chose specific apps, so silently
        // recording every app would be a privacy surprise.
        let tap = tap_desc.create_process_tap()
            .map_err(|e| {
                error!("❌ CoreAudio: Failed to create process tap: {:?}", e);
                anyhow::anyhow!("Failed to create process tap: {:?}", e)
            })?;

        // Get tap information
        let tap_uid = tap.uid().unwrap_or_else(|_| cf::Uuid::new().to_cf_string());
        let tap_asbd = tap.asbd();

        match tap_asbd {
            Ok(asbd) => {
                info!("✅ CoreAudio: Process tap created - UID: {:?}", tap_uid);
                info!("📊 CoreAudio: Tap format - sample_rate: {} Hz, channels: {}",
                      asbd.sample_rate, asbd.channels_per_frame);
            }
            Err(e) => {
                warn!("⚠️ CoreAudio: Tap created but couldn't get format info: {:?}", e);
            }
        }

        // Create sub-tap dictionary
        let sub_tap = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[tap.uid().unwrap().as_type_ref()],
        );

        // Create aggregate device descriptor
        // CRITICAL FIX: Use ONLY the tap, NOT the output device + tap
        // Previous configuration included both sub_device_list (output device) and tap_list (tap of same device)
        // This caused duplicate audio capture, resulting in echo (YouTube audio appeared twice)
        // The tap alone provides all the system audio we need
        let agg_desc = cf::DictionaryOf::with_keys_values(
            &[
                ca::aggregate_device_keys::is_private(),
                ca::aggregate_device_keys::is_stacked(),
                ca::aggregate_device_keys::tap_auto_start(),
                ca::aggregate_device_keys::name(),
                ca::aggregate_device_keys::main_sub_device(),
                ca::aggregate_device_keys::uid(),
                // REMOVED: sub_device_list (was causing duplicate audio)
                ca::aggregate_device_keys::tap_list(),
            ],
            &[
                cf::Boolean::value_true().as_type_ref(),
                cf::Boolean::value_false(),
                cf::Boolean::value_true(),
                cf::str!(c"meetily-audio-tap").as_type_ref(),
                &output_uid,
                &cf::Uuid::new().to_cf_string(),
                // REMOVED: sub_device array (was causing echo)
                &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
            ],
        );

        info!("✅ CoreAudio: Aggregate device descriptor created");
        info!("✅ CoreAudio: Core Audio capture initialized successfully!");

        Ok(Self { tap, agg_desc, follow_apps: None })
    }

    /// Start the audio device and create a stream
    fn start_device(
        &self,
        ctx: &mut Box<AudioContext>,
    ) -> Result<ca::hardware::StartedDevice<ca::AggregateDevice>> {
        extern "C" fn audio_proc(
            device: ca::Device,
            _now: &cat::AudioTimeStamp,
            input_data: &cat::AudioBufList<1>,
            _input_time: &cat::AudioTimeStamp,
            _output_data: &mut cat::AudioBufList<1>,
            _output_time: &cat::AudioTimeStamp,
            ctx: Option<&mut AudioContext>,
        ) -> os::Status {
            let ctx = ctx.unwrap();

            // Check for sample rate changes
            let after = device
                .nominal_sample_rate()
                .unwrap_or(ctx.format.absd().sample_rate) as u32;
            let before = ctx.current_sample_rate.load(Ordering::Acquire);

            if before != after {
                ctx.current_sample_rate.store(after, Ordering::Release);
            }

            // Try to get audio data from the buffer list
            if let Some(view) =
                av::AudioPcmBuf::with_buf_list_no_copy(&ctx.format, input_data, None)
            {
                if let Some(data) = view.data_f32_at(0) {
                    process_audio_data(ctx, data);
                }
            } else if ctx.format.common_format() == av::audio::CommonFormat::PcmF32 {
                // Fallback: manual extraction if AudioPcmBuf fails
                let first_buffer = &input_data.buffers[0];
                let byte_count = first_buffer.data_bytes_size as usize;
                let float_count = byte_count / std::mem::size_of::<f32>();

                if float_count > 0 && first_buffer.data != std::ptr::null_mut() {
                    let data = unsafe {
                        std::slice::from_raw_parts(first_buffer.data as *const f32, float_count)
                    };
                    process_audio_data(ctx, data);
                }
            }

            os::Status::NO_ERR
        }

        // Create aggregate device
        info!("🎙️ CoreAudio: Creating aggregate device...");
        let agg_device = ca::AggregateDevice::with_desc(&self.agg_desc)
            .map_err(|e| {
                error!("❌ CoreAudio: Failed to create aggregate device: {:?}", e);
                anyhow::anyhow!("Failed to create aggregate device: {:?}", e)
            })?;

        info!("✅ CoreAudio: Aggregate device created");

        // Create IO proc ID for audio processing
        info!("🎙️ CoreAudio: Creating IO proc...");
        let proc_id = agg_device.create_io_proc_id(audio_proc, Some(ctx))
            .map_err(|e| {
                error!("❌ CoreAudio: Failed to create IO proc: {:?}", e);
                anyhow::anyhow!("Failed to create IO proc: {:?}", e)
            })?;

        info!("✅ CoreAudio: IO proc created with ID: {:?}", proc_id);

        // Start the device
        info!("🎙️ CoreAudio: Starting audio device...");
        let started_device = ca::device_start(agg_device, Some(proc_id))
            .map_err(|e| {
                error!("❌ CoreAudio: Failed to start device: {:?}", e);
                anyhow::anyhow!("Failed to start device: {:?}", e)
            })?;

        info!("✅ CoreAudio: Audio device started successfully!");

        // Get device sample rate
        let device_ref = started_device.as_ref();
        let sample_rate = device_ref.nominal_sample_rate().unwrap_or(0.0);
        info!("📊 CoreAudio: Aggregate device sample_rate: {} Hz", sample_rate);

        Ok(started_device)
    }

    /// Create a stream from this capture
    pub fn stream(self) -> Result<CoreAudioStream> {
        info!("🎙️ CoreAudio: Creating CoreAudioStream...");

        // Get tap audio format
        let asbd = self.tap.asbd()
            .map_err(|e| {
                error!("❌ CoreAudio: Failed to get tap ASBD: {:?}", e);
                anyhow::anyhow!("Failed to get tap ASBD: {:?}", e)
            })?;

        let format = av::AudioFormat::with_asbd(&asbd)
            .ok_or_else(|| {
                error!("❌ CoreAudio: Failed to create audio format");
                anyhow::anyhow!("Failed to create audio format")
            })?;

        info!("✅ CoreAudio: Tap audio format: {} Hz, {} channels", asbd.sample_rate, asbd.channels_per_frame);

        // Create ring buffer for lock-free audio transfer
        let buffer_size = 1024 * 128; // 128KB buffer
        let rb = HeapRb::<f32>::new(buffer_size);
        let (producer, consumer) = rb.split();

        let waker_state = Arc::new(Mutex::new(WakerState {
            waker: None,
            has_data: false,
        }));

        let current_sample_rate = Arc::new(AtomicU32::new(asbd.sample_rate as u32));
        info!("✅ CoreAudio: Initial sample rate: {} Hz", asbd.sample_rate);

        let mut ctx = Box::new(AudioContext {
            format,
            producer,
            waker_state: waker_state.clone(),
            current_sample_rate: current_sample_rate.clone(),
            dropped_samples: AtomicU32::new(0),
            should_terminate: Arc::new(AtomicBool::new(false)),
        });

        info!("🎙️ CoreAudio: Starting audio device...");
        let device = self.start_device(&mut ctx)?;

        let tap = Arc::new(Mutex::new(self.tap));
        let follower = match self.follow_apps {
            Some((apps, objects)) => match ProcessFollower::spawn(tap.clone(), apps, objects) {
                Ok(follower) => Some(follower),
                Err(e) => {
                    // Without re-scans the include list stays as found, which
                    // may be empty. Stop the device before the tap goes away.
                    drop(device);
                    return Err(anyhow::anyhow!("Failed to start per-app re-scan: {}", e));
                }
            },
            None => None,
        };

        info!("✅ CoreAudio: CoreAudioStream created successfully!");

        Ok(CoreAudioStream {
            _follower: follower,
            consumer,
            _device: device,
            _ctx: ctx,
            _tap: tap,
            waker_state,
            current_sample_rate,
            last_drop_log: Instant::now(),
        })
    }

    /// Start the real tap briefly and report whether audible samples arrive.
    /// A running all-zero stream is indistinguishable from denied permission,
    /// so callers should ask the user to play audio while this probe runs.
    pub fn probe(self, duration: Duration) -> Result<bool> {
        let mut stream = self.stream()?;
        let deadline = Instant::now() + duration;
        let mut sample_count = 0usize;
        let mut peak = 0.0f32;

        while Instant::now() < deadline {
            while let Some(sample) = stream.consumer.try_pop() {
                sample_count += 1;
                peak = peak.max(sample.abs());
            }

            if peak > 0.0001 {
                info!(
                    "Core Audio probe detected system audio (samples={}, peak={:.6})",
                    sample_count, peak
                );
                return Ok(true);
            }

            std::thread::sleep(Duration::from_millis(20));
        }

        warn!(
            "Core Audio probe received no audible system audio (samples={}, peak={:.6})",
            sample_count, peak
        );
        Ok(false)
    }
}

/// Process audio data from the IO proc callback
#[cfg(target_os = "macos")]
fn process_audio_data(ctx: &mut AudioContext, data: &[f32]) {
    // Push raw samples directly to ring buffer
    // Let the pipeline handle all gain adjustments (post-mix 3x gain + mic normalization)
    let buffer_size = data.len();
    let pushed = ctx.producer.push_slice(data);

    if pushed < buffer_size {
        // The tap is system audio, not the mic. Drop on pressure instead of
        // terminating the meeting; report outside the real-time callback.
        ctx.dropped_samples.fetch_add((buffer_size - pushed) as u32, Ordering::Relaxed);
    }

    if pushed > 0 {
        let should_wake = {
            let mut waker_state = ctx.waker_state.lock().unwrap();
            if !waker_state.has_data {
                waker_state.has_data = true;
                waker_state.waker.take()
            } else {
                None
            }
        };

        if let Some(waker) = should_wake {
            waker.wake();
        }
    }
}

#[cfg(target_os = "macos")]
impl CoreAudioStream {
    /// Get current sample rate
    pub fn sample_rate(&self) -> u32 {
        self.current_sample_rate.load(Ordering::Acquire)
    }
}

#[cfg(target_os = "macos")]
impl Stream for CoreAudioStream {
    type Item = f32;

    fn poll_next(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        if self.last_drop_log.elapsed() >= Duration::from_secs(5) {
            let dropped = self._ctx.dropped_samples.swap(0, Ordering::Relaxed);
            if dropped > 0 {
                warn!("CoreAudio system tap dropped {} samples under buffer pressure", dropped);
            }
            self.last_drop_log = Instant::now();
        }
        // Try to pop a sample from the ring buffer
        if let Some(sample) = self.consumer.try_pop() {
            return Poll::Ready(Some(sample));
        }

        // Check if we should terminate
        if self._ctx.should_terminate.load(Ordering::Acquire) {
            warn!("Stream terminating due to buffer pressure");
            return match self.consumer.try_pop() {
                Some(sample) => Poll::Ready(Some(sample)),
                None => Poll::Ready(None),
            };
        }

        // Register before checking again: the callback may have pushed data
        // after our first pop but before it saw a registered waker.
        {
            // Clone the Arc so the guard does not borrow `self` while the
            // consumer needs mutable access for the second pop.
            let waker_state = self.waker_state.clone();
            let mut state = waker_state.lock().unwrap();
            state.has_data = false;
            state.waker = Some(cx.waker().clone());
            if let Some(sample) = self.consumer.try_pop() {
                return Poll::Ready(Some(sample));
            }
        }

        Poll::Pending
    }
}

#[cfg(target_os = "macos")]
impl Drop for CoreAudioStream {
    fn drop(&mut self) {
        info!("CoreAudioStream dropped, signaling termination");
        self._ctx.should_terminate.store(true, Ordering::Release);
    }
}

// Stub implementations for non-macOS platforms
#[cfg(not(target_os = "macos"))]
pub struct CoreAudioCapture;

#[cfg(not(target_os = "macos"))]
pub struct CoreAudioStream;

#[cfg(not(target_os = "macos"))]
impl CoreAudioCapture {
    pub fn new() -> Result<Self> {
        Err(anyhow::anyhow!("Core Audio is only supported on macOS"))
    }

    pub fn stream(self) -> Result<CoreAudioStream> {
        Err(anyhow::anyhow!("Core Audio is only supported on macOS"))
    }
}

#[cfg(not(target_os = "macos"))]
impl CoreAudioStream {
    pub fn sample_rate(&self) -> u32 {
        0
    }
}

#[cfg(not(target_os = "macos"))]
impl Stream for CoreAudioStream {
    type Item = f32;

    fn poll_next(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        Poll::Ready(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[cfg(target_os = "macos")]
    #[ignore] // Only run manually as it requires audio hardware
    async fn test_core_audio_capture() {
        use futures_util::StreamExt;

        let capture = CoreAudioCapture::new().expect("Failed to create capture");
        let mut stream = capture.stream().expect("Failed to create stream");

        info!("Stream sample rate: {} Hz", stream.sample_rate());

        // Collect some samples
        let mut sample_count = 0;
        while sample_count < 48000 { // 1 second at 48kHz
            if let Some(_sample) = stream.next().await {
                sample_count += 1;
            }
        }

        info!("Collected {} samples", sample_count);
        assert!(sample_count >= 48000);
    }
}

#[cfg(test)]
mod app_matching_tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn exe_path_reads_a_process_executable() {
        let own = super::exe_path(std::process::id() as i32).expect("own executable");
        assert_eq!(std::path::Path::new(&own), std::env::current_exe().unwrap().canonicalize().unwrap());
    }

    /// Needs QuickTime Player to have played audio since it opened.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn finds_apple_apps_audio_processes() {
        assert!(!super::audio_process_objects_for_apps(&["QuickTime Player".into()]).is_empty());
    }

    use super::app_owns_exe_path;

    #[test]
    fn app_owns_its_executable_and_bundled_helpers_only() {
        let chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        let renderer = "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)";
        assert!(app_owns_exe_path("Google Chrome.app", chrome));
        assert!(app_owns_exe_path("Google Chrome", chrome));
        assert!(app_owns_exe_path("google chrome.app", renderer));
        assert!(app_owns_exe_path("zoom.us.app", "/Applications/zoom.us.app/Contents/MacOS/zoom.us"));
        assert!(!app_owns_exe_path("Safari.app", chrome));
        assert!(!app_owns_exe_path("Chrome.app", chrome));
        assert!(!app_owns_exe_path("zoom.us.app", "/Applications/zoom.us.app.bak/zoom"));
    }
}

#[cfg(test)]
mod follow_tests {
    use super::follow_process_objects;
    use std::collections::VecDeque;
    use std::time::Duration;

    /// Run the loop over scripted scans; the stop sender is dropped once the
    /// script is used up, so the loop ends after one more (unchanged) scan.
    fn run(initial: Vec<u32>, scans: Vec<Vec<u32>>, fail_first: usize) -> Vec<Vec<u32>> {
        let (stop, stop_rx) = std::sync::mpsc::channel::<()>();
        let mut stop = Some(stop);
        let mut scans: VecDeque<_> = scans.into();
        let mut last = initial.clone();
        let mut applied = Vec::new();
        let mut failures = 0;
        follow_process_objects(
            initial,
            &stop_rx,
            Duration::from_millis(1),
            || match scans.pop_front() {
                Some(scan) => {
                    last = scan.clone();
                    scan
                }
                None => {
                    stop.take();
                    last.clone()
                }
            },
            |objects| {
                applied.push(objects.to_vec());
                if failures < fail_first {
                    failures += 1;
                    anyhow::bail!("tap busy");
                }
                Ok(())
            },
        );
        applied
    }

    #[test]
    fn unchanged_or_reordered_scans_do_not_touch_the_tap() {
        assert!(run(vec![7, 3], vec![vec![3, 7], vec![7, 3, 3]], 0).is_empty());
    }

    #[test]
    fn helpers_appearing_or_leaving_update_the_tap() {
        // Start with nothing (call not joined yet), then a renderer, then
        // Chrome restarts its audio service under a new object.
        let applied = run(vec![], vec![vec![], vec![42], vec![42], vec![51, 42], vec![51]], 0);
        assert_eq!(applied, vec![vec![42], vec![42, 51], vec![51]]);
    }

    #[test]
    fn failed_update_is_retried_on_the_next_scan() {
        let applied = run(vec![1], vec![vec![1, 2], vec![1, 2]], 1);
        assert_eq!(applied, vec![vec![1, 2], vec![1, 2]]);
    }
}

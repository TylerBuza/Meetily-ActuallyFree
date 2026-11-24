use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use anyhow::Result;

use super::devices::AudioDevice;
use super::buffer_pool::AudioBufferPool;

/// Device type for audio chunks
#[derive(Debug, Clone, PartialEq)]
pub enum DeviceType {
    Microphone,
    System,
    /// Pre-mixed mic+system for the playback file (`audio.mp4`).
    Mixed,
}

/// Audio chunk with metadata for processing
#[derive(Debug, Clone)]
pub struct AudioChunk {
    pub data: Vec<f32>,
    pub sample_rate: u32,
    pub timestamp: f64,
    pub chunk_id: u64,
    pub device_type: DeviceType,
}

/// Processed audio chunk (post-VAD) for recording
#[derive(Debug, Clone)]
pub struct ProcessedAudioChunk {
    pub data: Vec<f32>,
    pub sample_rate: u32,
    pub timestamp: f64,
    pub device_type: DeviceType,
}

/// Comprehensive error types for audio system
#[derive(Debug, Clone)]
pub enum AudioError {
    DeviceDisconnected,
    StreamFailed,
    ProcessingFailed,
    TranscriptionFailed,
    ChannelClosed,
    SystemCaptureStalled,
    SystemCaptureEnded,
    LinuxReconnecting,
    InitializationFailed,
    ConfigurationError,
    PermissionDenied,
    BufferOverflow,
    SampleRateUnsupported,
}

impl AudioError {
    /// Check if error is recoverable (can attempt reconnection)
    pub fn is_recoverable(&self) -> bool {
        match self {
            // Capture stream callbacks are terminal. No live reconnection path
            // replaces the failed CPAL stream, so waiting for repeats would
            // leave the UI recording while that source stays silent.
            AudioError::DeviceDisconnected => false,
            AudioError::StreamFailed => false,
            AudioError::ProcessingFailed => true,
            AudioError::TranscriptionFailed => true,
            AudioError::ChannelClosed => false,
            AudioError::SystemCaptureStalled | AudioError::SystemCaptureEnded => false,
            AudioError::InitializationFailed => false,
            AudioError::ConfigurationError => false,
            AudioError::PermissionDenied => false,
            AudioError::BufferOverflow => true,
            AudioError::SampleRateUnsupported => false,
            AudioError::LinuxReconnecting => true,
        }
    }

    /// Get user-friendly error message
    pub fn user_message(&self) -> &'static str {
        match self {
            AudioError::DeviceDisconnected => "Audio device was disconnected",
            AudioError::StreamFailed => "Audio stream encountered an error",
            AudioError::ProcessingFailed => "Audio processing failed",
            AudioError::TranscriptionFailed => "Speech transcription failed",
            AudioError::ChannelClosed => "Audio channel was closed unexpectedly",
            AudioError::SystemCaptureStalled => "Computer audio delivered no samples for 5 seconds. Your microphone is still recording, and computer audio resumes if capture recovers. Check the selected output or app and the recording log.",
            AudioError::SystemCaptureEnded => "Computer audio capture ended unexpectedly; recording stopped. Check the selected output or app and the recording log.",
            AudioError::InitializationFailed => "Failed to initialize audio system",
            AudioError::ConfigurationError => "Audio configuration error",
            AudioError::PermissionDenied => "Microphone permission denied",
            AudioError::BufferOverflow => "Audio buffer overflow",
            AudioError::SampleRateUnsupported => "Audio sample rate not supported",
            AudioError::LinuxReconnecting => "An audio source disconnected. Retrying it for up to 30 seconds while the other source continues. If recovery fails, the meeting will stop and save.",
        }
    }
}

/// Recording statistics
#[derive(Debug, Default)]
pub struct RecordingStats {
    pub chunks_processed: u64,
    pub total_duration: f64,
    pub last_activity: Option<Instant>,
}

#[derive(Default)]
struct RecordingClock {
    start: Option<Instant>,
    stop: Option<Instant>,
    pause_start: Option<Instant>,
    paused: Duration,
}

impl RecordingClock {
    fn end_pause(&mut self, now: Instant) {
        if let Some(start) = self.pause_start.take() {
            self.paused += now.saturating_duration_since(start);
        }
    }

    fn elapsed(&self, now: Instant) -> Option<Duration> {
        self.start.map(|start| self.stop.unwrap_or(now).saturating_duration_since(start))
    }

    fn active(&self, now: Instant) -> Option<Duration> {
        let open_pause = self.pause_start.map(|p| now.saturating_duration_since(p)).unwrap_or_default();
        self.elapsed(now).map(|elapsed| elapsed.saturating_sub(self.paused + open_pause))
    }
}

/// Unified state management for audio recording
pub struct RecordingState {
    // Core recording state
    is_recording: AtomicBool,
    is_paused: AtomicBool,
    microphone_muted: AtomicBool,
    system_audio_muted: AtomicBool,
    is_reconnecting: AtomicBool,  // NEW: Attempting to reconnect to device

    // Audio devices
    microphone_device: Mutex<Option<Arc<AudioDevice>>>,
    system_device: Mutex<Option<Arc<AudioDevice>>>,
    // Track which device is disconnected for reconnection attempts
    disconnected_device: Mutex<Option<(Arc<AudioDevice>, DeviceType)>>,

    // Audio pipeline
    audio_sender: Mutex<Option<mpsc::UnboundedSender<AudioChunk>>>,

    // Memory optimization
    buffer_pool: AudioBufferPool,

    // Error handling
    error_count: AtomicU32,
    recoverable_error_count: AtomicU32,
    last_error: Mutex<Option<AudioError>>,
    #[cfg(target_os = "linux")]
    linux_fatal_claimed: AtomicBool,
    error_callback: Mutex<Option<Box<dyn Fn(&AudioError) + Send + Sync>>>,
    warning_callback: Mutex<Option<Box<dyn Fn(&AudioError) + Send + Sync>>>,

    // Statistics
    stats: Mutex<RecordingStats>,

    // Stop/cleanup precedes metadata and analytics; keep one consistent timing
    // snapshot until the next recording starts, independent of stream lifetime.
    clock: Mutex<RecordingClock>,
    capture_setup_complete: AtomicBool,
    microphone_capture_active: AtomicBool,
    system_capture_active: AtomicBool,
}

impl RecordingState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            is_recording: AtomicBool::new(false),
            is_paused: AtomicBool::new(false),
            microphone_muted: AtomicBool::new(false),
            system_audio_muted: AtomicBool::new(false),
            is_reconnecting: AtomicBool::new(false),
            microphone_device: Mutex::new(None),
            system_device: Mutex::new(None),
            disconnected_device: Mutex::new(None),
            audio_sender: Mutex::new(None),
            buffer_pool: AudioBufferPool::new(16, 48000), // Pool of 16 buffers with 48kHz samples capacity
            error_count: AtomicU32::new(0),
            recoverable_error_count: AtomicU32::new(0),
            last_error: Mutex::new(None),
            #[cfg(target_os = "linux")]
            linux_fatal_claimed: AtomicBool::new(false),
            error_callback: Mutex::new(None),
            warning_callback: Mutex::new(None),
            stats: Mutex::new(RecordingStats::default()),
            clock: Mutex::new(RecordingClock::default()),
            capture_setup_complete: AtomicBool::new(false),
            microphone_capture_active: AtomicBool::new(false),
            system_capture_active: AtomicBool::new(false),
        })
    }

    // Recording control
    pub fn start_recording(&self) -> Result<()> {
        {
            let mut clock = self.clock.lock().unwrap();
            *clock = RecordingClock { start: Some(Instant::now()), ..Default::default() };
            self.is_paused.store(false, Ordering::SeqCst);
            self.is_recording.store(true, Ordering::SeqCst);
        }
        self.microphone_muted.store(false, Ordering::SeqCst);
        self.system_audio_muted.store(false, Ordering::SeqCst);
        self.error_count.store(0, Ordering::SeqCst);
        self.recoverable_error_count.store(0, Ordering::SeqCst);
        *self.last_error.lock().unwrap() = None;
        #[cfg(target_os = "linux")]
        self.linux_fatal_claimed.store(false, Ordering::Release);
        self.capture_setup_complete.store(false, Ordering::SeqCst);
        self.microphone_capture_active.store(false, Ordering::SeqCst);
        self.system_capture_active.store(false, Ordering::SeqCst);
        Ok(())
    }

    pub fn set_capture_active(&self, device_type: DeviceType, active: bool) {
        match device_type {
            DeviceType::Microphone => self.microphone_capture_active.store(active, Ordering::SeqCst),
            DeviceType::System => self.system_capture_active.store(active, Ordering::SeqCst),
            DeviceType::Mixed => {}
        }
    }

    pub fn finish_capture_setup(&self) {
        self.capture_setup_complete.store(true, Ordering::SeqCst);
    }

    pub fn active_capture_sources(&self) -> Option<(bool, bool)> {
        self.capture_setup_complete.load(Ordering::SeqCst).then(|| {
            (
                self.microphone_capture_active.load(Ordering::SeqCst),
                self.system_capture_active.load(Ordering::SeqCst),
            )
        })
    }

    pub fn stop_recording(&self) {
        {
            let mut clock = self.clock.lock().unwrap();
            if clock.start.is_some() && clock.stop.is_none() {
                let now = Instant::now();
                clock.end_pause(now);
                clock.stop = Some(now);
            }
            self.is_recording.store(false, Ordering::SeqCst);
            self.is_paused.store(false, Ordering::SeqCst);
        }
        self.microphone_muted.store(false, Ordering::SeqCst);
        self.system_audio_muted.store(false, Ordering::SeqCst);
        self.capture_setup_complete.store(false, Ordering::SeqCst);
        self.microphone_capture_active.store(false, Ordering::SeqCst);
        self.system_capture_active.store(false, Ordering::SeqCst);
        // CRITICAL: Clear audio sender to close the pipeline channel
        // This ensures the pipeline loop exits properly after processing all chunks
        *self.audio_sender.lock().unwrap() = None;
        // CRITICAL: Clear device references to release microphone/speaker
        // Without this, Arc<AudioDevice> references persist and keep the mic active
        *self.microphone_device.lock().unwrap() = None;
        *self.system_device.lock().unwrap() = None;
        *self.disconnected_device.lock().unwrap() = None;
        log::info!("Recording stopped, device references cleared");
    }

    pub fn pause_recording(&self) -> Result<()> {
        let mut clock = self.clock.lock().unwrap();
        if !self.is_recording() {
            return Err(anyhow::anyhow!("Cannot pause when not recording"));
        }
        if self.is_paused() {
            return Err(anyhow::anyhow!("Recording is already paused"));
        }

        self.is_paused.store(true, Ordering::SeqCst);
        clock.pause_start = Some(Instant::now());
        log::info!("Recording paused");
        Ok(())
    }

    pub fn resume_recording(&self) -> Result<()> {
        let mut clock = self.clock.lock().unwrap();
        if !self.is_recording() {
            return Err(anyhow::anyhow!("Cannot resume when not recording"));
        }
        if !self.is_paused() {
            return Err(anyhow::anyhow!("Recording is not paused"));
        }

        clock.end_pause(Instant::now());
        self.is_paused.store(false, Ordering::SeqCst);
        Ok(())
    }

    pub fn is_recording(&self) -> bool {
        self.is_recording.load(Ordering::SeqCst)
    }

    pub fn is_paused(&self) -> bool {
        self.is_paused.load(Ordering::SeqCst)
    }

    pub fn set_microphone_muted(&self, muted: bool) {
        self.microphone_muted.store(muted, Ordering::SeqCst);
    }

    pub fn is_microphone_muted(&self) -> bool {
        self.microphone_muted.load(Ordering::SeqCst)
    }

    pub fn set_system_audio_muted(&self, muted: bool) {
        self.system_audio_muted.store(muted, Ordering::SeqCst);
    }

    pub fn is_system_audio_muted(&self) -> bool {
        self.system_audio_muted.load(Ordering::SeqCst)
    }

    pub fn is_audio_source_muted(&self, device_type: &DeviceType) -> bool {
        match device_type {
            DeviceType::Microphone => self.is_microphone_muted(),
            DeviceType::System => self.is_system_audio_muted(),
            DeviceType::Mixed => false,
        }
    }

    pub fn is_active(&self) -> bool {
        self.is_recording() && !self.is_paused()
    }

    // Reconnection state management
    pub fn start_reconnecting(&self, device: Arc<AudioDevice>, device_type: DeviceType) {
        self.is_reconnecting.store(true, Ordering::SeqCst);
        *self.disconnected_device.lock().unwrap() = Some((device, device_type));
        log::info!("Started reconnection attempt for device");
    }

    pub fn stop_reconnecting(&self) {
        self.is_reconnecting.store(false, Ordering::SeqCst);
        *self.disconnected_device.lock().unwrap() = None;
        log::info!("Stopped reconnection attempt");
    }

    pub fn is_reconnecting(&self) -> bool {
        self.is_reconnecting.load(Ordering::SeqCst)
    }

    pub fn get_disconnected_device(&self) -> Option<(Arc<AudioDevice>, DeviceType)> {
        self.disconnected_device.lock().unwrap().clone()
    }

    // Device management
    pub fn set_microphone_device(&self, device: Arc<AudioDevice>) {
        *self.microphone_device.lock().unwrap() = Some(device);
    }

    pub fn set_system_device(&self, device: Arc<AudioDevice>) {
        *self.system_device.lock().unwrap() = Some(device);
    }

    pub fn get_microphone_device(&self) -> Option<Arc<AudioDevice>> {
        self.microphone_device.lock().unwrap().clone()
    }

    pub fn get_system_device(&self) -> Option<Arc<AudioDevice>> {
        self.system_device.lock().unwrap().clone()
    }

    // Audio pipeline management
    pub fn set_audio_sender(&self, sender: mpsc::UnboundedSender<AudioChunk>) {
        *self.audio_sender.lock().unwrap() = Some(sender);
    }

    pub fn send_audio_chunk(&self, chunk: AudioChunk) -> Result<()> {
        // Don't send audio chunks when paused
        if self.is_paused() {
            return Ok(()); // Silently discard chunks while paused
        }

        if let Some(sender) = self.audio_sender.lock().unwrap().as_ref() {
            sender.send(chunk).map_err(|_| anyhow::anyhow!("Failed to send audio chunk"))?;

            // Update statistics
            let mut stats = self.stats.lock().unwrap();
            stats.chunks_processed += 1;
            stats.last_activity = Some(Instant::now());
            Ok(())
        } else {
            // Return an error when no sender is available (pipeline not ready)
            Err(anyhow::anyhow!("Audio pipeline not ready - no sender available"))
        }
    }

    // Error handling
    pub fn set_error_callback<F>(&self, callback: F)
    where
        F: Fn(&AudioError) + Send + Sync + 'static,
    {
        *self.error_callback.lock().unwrap() = Some(Box::new(callback));
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn report_linux_fatal(&self, error: AudioError) {
        debug_assert!(!error.is_recoverable());
        // Both streams can fail before either marks the recording stopped.
        // Only the first source owns the fatal event and teardown request.
        if self.is_recording() && !self.linux_fatal_claimed.swap(true, Ordering::AcqRel) {
            self.report_error(error);
        }
    }

    pub fn report_error(&self, error: AudioError) {
        let count = self.error_count.fetch_add(1, Ordering::SeqCst) + 1;
        let mut should_stop = false;

        // Track recoverable vs non-recoverable errors separately
        if error.is_recoverable() {
            let recoverable_count = self.recoverable_error_count.fetch_add(1, Ordering::SeqCst) + 1;
            log::warn!("Recoverable audio error ({}): {:?}", recoverable_count, error);

            // Allow more recoverable errors before stopping
            if recoverable_count >= 10 {
                log::error!("Too many recoverable errors ({}), stopping recording", recoverable_count);
                should_stop = true;
            }
        } else {
            log::error!("Non-recoverable audio error: {:?}", error);
            should_stop = true;
        }

        *self.last_error.lock().unwrap() = Some(error.clone());

        // Fallback: stop recording after too many total errors
        if count >= 15 {
            log::error!("Too many total audio errors ({}), stopping recording", count);
            should_stop = true;
        }

        if should_stop {
            self.stop_recording();
            // The callback owns command-level teardown. Do not notify it for a
            // transient recoverable error that recording can safely survive.
            if let Some(callback) = self.error_callback.lock().unwrap().as_ref() {
                callback(&error);
            }
        }
    }

    pub fn set_warning_callback<F>(&self, callback: F)
    where
        F: Fn(&AudioError) + Send + Sync + 'static,
    {
        *self.warning_callback.lock().unwrap() = Some(Box::new(callback));
    }

    /// Tell the user about a degraded source while recording continues.
    /// Unlike `report_error`, this neither counts toward the stop thresholds
    /// nor stops recording; the caller decides how often to report.
    pub fn report_warning(&self, error: AudioError) {
        log::warn!("Audio warning, recording continues: {:?}", error);
        if let Some(callback) = self.warning_callback.lock().unwrap().as_ref() {
            callback(&error);
        }
    }

    pub fn get_error_count(&self) -> u32 {
        self.error_count.load(Ordering::SeqCst)
    }

    pub fn get_recoverable_error_count(&self) -> u32 {
        self.recoverable_error_count.load(Ordering::SeqCst)
    }

    pub fn get_last_error(&self) -> Option<AudioError> {
        self.last_error.lock().unwrap().clone()
    }

    pub fn has_fatal_error(&self) -> bool {
        if let Some(error) = &*self.last_error.lock().unwrap() {
            !error.is_recoverable() && self.error_count.load(Ordering::SeqCst) > 0
        } else {
            false
        }
    }

    // Statistics
    pub fn get_stats(&self) -> RecordingStats {
        self.stats.lock().unwrap().clone()
    }

    pub fn get_recording_duration(&self) -> Option<f64> {
        self.clock.lock().unwrap().elapsed(Instant::now()).map(|d| d.as_secs_f64())
    }

    pub fn get_active_recording_duration(&self) -> Option<f64> {
        self.clock.lock().unwrap().active(Instant::now()).map(|d| d.as_secs_f64())
    }

    pub fn get_total_pause_duration(&self) -> f64 {
        self.clock.lock().unwrap().paused.as_secs_f64()
    }

    pub fn get_current_pause_duration(&self) -> Option<f64> {
        self.clock.lock().unwrap().pause_start.map(|start| start.elapsed().as_secs_f64())
    }

    // Memory management
    pub fn get_buffer_pool(&self) -> AudioBufferPool {
        self.buffer_pool.clone()
    }

    // Cleanup
    pub fn cleanup(&self) {
        self.stop_recording();
        self.stop_reconnecting();
        *self.microphone_device.lock().unwrap() = None;
        *self.system_device.lock().unwrap() = None;
        *self.disconnected_device.lock().unwrap() = None;
        *self.audio_sender.lock().unwrap() = None;
        *self.last_error.lock().unwrap() = None;
        *self.error_callback.lock().unwrap() = None;
        *self.warning_callback.lock().unwrap() = None;
        *self.stats.lock().unwrap() = RecordingStats::default();
        self.error_count.store(0, Ordering::SeqCst);
        self.recoverable_error_count.store(0, Ordering::SeqCst);

        // Clear buffer pool to free memory
        self.buffer_pool.clear();
    }
}

impl Default for RecordingState {
    fn default() -> Self {
        Self {
            is_recording: AtomicBool::new(false),
            is_paused: AtomicBool::new(false),
            microphone_muted: AtomicBool::new(false),
            system_audio_muted: AtomicBool::new(false),
            is_reconnecting: AtomicBool::new(false),
            microphone_device: Mutex::new(None),
            system_device: Mutex::new(None),
            disconnected_device: Mutex::new(None),
            audio_sender: Mutex::new(None),
            buffer_pool: AudioBufferPool::new(16, 48000), // Pool of 16 buffers with 48kHz samples capacity
            error_count: AtomicU32::new(0),
            recoverable_error_count: AtomicU32::new(0),
            last_error: Mutex::new(None),
            #[cfg(target_os = "linux")]
            linux_fatal_claimed: AtomicBool::new(false),
            error_callback: Mutex::new(None),
            warning_callback: Mutex::new(None),
            stats: Mutex::new(RecordingStats::default()),
            clock: Mutex::new(RecordingClock::default()),
            capture_setup_complete: AtomicBool::new(false),
            microphone_capture_active: AtomicBool::new(false),
            system_capture_active: AtomicBool::new(false),
        }
    }
}

// Thread-safe cloning for RecordingStats
impl Clone for RecordingStats {
    fn clone(&self) -> Self {
        Self {
            chunks_processed: self.chunks_processed,
            total_duration: self.total_duration,
            last_activity: self.last_activity,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[cfg(target_os = "linux")]
    #[test]
    fn simultaneous_linux_failures_request_teardown_once() {
        let state = RecordingState::new();
        let callbacks = Arc::new(AtomicUsize::new(0));
        let count = callbacks.clone();
        state.set_error_callback(move |_| { count.fetch_add(1, Ordering::SeqCst); });
        for expected in 1..=2 {
            state.start_recording().unwrap();
            let barrier = std::sync::Barrier::new(2);
            std::thread::scope(|scope| {
                for error in [AudioError::StreamFailed, AudioError::ChannelClosed] {
                    let state = &state;
                    let barrier = &barrier;
                    scope.spawn(move || {
                        barrier.wait();
                        state.report_linux_fatal(error);
                    });
                }
            });
            assert_eq!(callbacks.load(Ordering::SeqCst), expected);
            assert_eq!(state.get_error_count(), 1);
            assert!(state.has_fatal_error());
            assert!(!state.is_recording());
        }
    }

    #[test]
    fn duration_survives_stop_and_cleanup_then_resets_for_next_session() {
        let state = RecordingState::new();
        assert_eq!(state.get_active_recording_duration(), None);
        state.start_recording().unwrap();
        state.pause_recording().unwrap();
        {
            let mut clock = state.clock.lock().unwrap();
            let now = Instant::now();
            clock.start = Some(now - Duration::from_secs(120));
            clock.paused = Duration::from_secs(12);
            clock.pause_start = Some(now - Duration::from_secs(8));
        }
        state.stop_recording();
        let total = state.get_recording_duration().unwrap();
        assert!(total >= 120.0);
        assert_eq!(state.get_active_recording_duration(), Some(100.0));
        state.cleanup();
        assert_eq!(state.get_recording_duration(), Some(total));
        assert_eq!(state.get_active_recording_duration(), Some(100.0));
        assert_eq!(state.get_current_pause_duration(), None);
        state.start_recording().unwrap();
        assert_eq!(state.get_total_pause_duration(), 0.0);
        assert!(state.clock.lock().unwrap().stop.is_none());
    }

    #[test]
    fn system_capture_stall_warning_keeps_recording() {
        let state = RecordingState::new();
        state.start_recording().unwrap();
        let errors = Arc::new(AtomicUsize::new(0));
        let warnings = Arc::new(AtomicUsize::new(0));
        let errors_seen = errors.clone();
        state.set_error_callback(move |_| {
            errors_seen.fetch_add(1, Ordering::SeqCst);
        });
        let warnings_seen = warnings.clone();
        state.set_warning_callback(move |error| {
            assert!(matches!(error, AudioError::SystemCaptureStalled));
            warnings_seen.fetch_add(1, Ordering::SeqCst);
        });

        // More reports than either stop threshold in report_error.
        for _ in 0..20 {
            state.report_warning(AudioError::SystemCaptureStalled);
        }

        assert!(state.is_recording());
        assert_eq!(state.get_error_count(), 0);
        assert!(!state.has_fatal_error());
        assert_eq!(warnings.load(Ordering::SeqCst), 20);
        assert_eq!(errors.load(Ordering::SeqCst), 0);
    }
}

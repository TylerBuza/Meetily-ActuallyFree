//! Linux capture owns its native loop and recovery independently of the WebView.
//! libpulse stays on one OS thread; only bounded blocks cross to the DSP worker.

use std::cell::Cell;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use anyhow::{anyhow, Result};
use tokio::sync::{mpsc, oneshot};
use super::capture::pulse_linux::{self, DefaultRouteChanged, PulseCapture};
use super::capture_worker::{CaptureWorker, NativeCleanup};
use super::devices::AudioDevice;
use super::pipeline::AudioCapture;
use super::recording_state::{AudioChunk, AudioError, DeviceType, RecordingState};

static CLEANUP: once_cell::sync::Lazy<NativeCleanup> =
    once_cell::sync::Lazy::new(NativeCleanup::default);

struct Frame {
    samples: Vec<f32>,
    end: f64,
    muted: bool,
}

pub struct LinuxStream {
    stop: Arc<AtomicBool>,
    finish: Arc<AtomicBool>,
    thread: Option<JoinHandle<Result<()>>>,
}

impl LinuxStream {
    pub async fn start(
        device: Arc<AudioDevice>,
        state: Arc<RecordingState>,
        role: DeviceType,
        recording_sender: Option<mpsc::UnboundedSender<AudioChunk>>,
    ) -> Result<Self> {
        Self::start_with_worker(move |stop, finish, ready| {
            let started = Cell::new(false);
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run(device, state.clone(), role, recording_sender,
                    stop.clone(), finish.clone(), ready, &started)
            })).unwrap_or_else(|_| Err(anyhow!("Linux capture worker panicked")));
            if outcome.is_err() && started.get()
                && !stop.load(Ordering::Acquire) && !finish.load(Ordering::Acquire)
            {
                state.report_linux_fatal(AudioError::StreamFailed);
            }
            outcome
        }).await
    }

    async fn start_with_worker(
        worker: impl FnOnce(Arc<AtomicBool>, Arc<AtomicBool>, oneshot::Sender<Result<(), String>>)
            -> Result<()> + Send + 'static,
    ) -> Result<Self> {
        anyhow::ensure!(!CLEANUP.is_pending(), "Previous Linux audio cleanup is still running; retry shortly");
        let stop = Arc::new(AtomicBool::new(false));
        let finish = Arc::new(AtomicBool::new(false));
        let (ready, wait) = oneshot::channel();
        let thread_stop = stop.clone();
        let thread_finish = finish.clone();
        let thread = thread::Builder::new().name("linux-capture".into())
            .spawn(move || worker(thread_stop, thread_finish, ready))?;
        // Drop is the cancellation owner even if this async startup future is
        // abandoned. A readiness promise alone cannot own a native stream.
        let owner = Self { stop, finish, thread: Some(thread) };
        match tokio::time::timeout(Duration::from_secs(15), wait).await {
            Ok(Ok(Ok(()))) => Ok(owner),
            Ok(Ok(Err(error))) => Err(anyhow!(error)),
            Ok(Err(_)) => Err(anyhow!("Linux capture worker exited during startup")),
            Err(_) => Err(anyhow!("Linux audio startup timed out")),
        }
    }

    pub fn stop(mut self) -> Result<()> {
        self.finish.store(true, Ordering::Release);
        let result = self.join();
        if result.is_err() {
            self.stop.store(true, Ordering::Release);
        }
        result
    }

    fn join(&mut self) -> Result<()> {
        let Some(thread) = self.thread.take() else { return Ok(()); };
        CLEANUP.run(move || {
            thread.join().map_err(|_| "Linux capture worker panicked".to_string())?
                .map_err(|error| error.to_string())
        }, Duration::from_secs(3)).map_err(anyhow::Error::msg)
    }
}

impl Drop for LinuxStream {
    fn drop(&mut self) {
        if self.thread.is_some() {
            self.stop.store(true, Ordering::Release);
            if let Err(error) = self.join() {
                log::warn!("Linux capture cancellation: {}", error);
            }
        }
    }
}

fn run(
    device: Arc<AudioDevice>, state: Arc<RecordingState>, role: DeviceType,
    recording_sender: Option<mpsc::UnboundedSender<AudioChunk>>,
    stop: Arc<AtomicBool>, finish: Arc<AtomicBool>,
    ready: oneshot::Sender<std::result::Result<(), String>>,
    started: &Cell<bool>,
) -> Result<()> {
    let system = role == DeviceType::System;
    let channels = if system { 2 } else { 1 };
    let capture = AudioCapture::new(device.clone(), state.clone(), 48_000, channels, role.clone(), recording_sender);
    let mut worker = CaptureWorker::spawn(256, move |frame: Frame| {
        capture.process_audio_data_at(&frame.samples, frame.end, frame.muted);
    })?;
    let sender = worker.sender();
    let mut ready = Some(ready);
    let mut retry_since = None;
    let mut overflow_reported = false;
    let mut result = Ok(());
    while !stop.load(Ordering::Acquire) && !finish.load(Ordering::Acquire) {
        let attempt = (|| -> Result<()> {
            let id = if device.follow_default {
                if system { pulse_linux::default_sink_name()? } else { pulse_linux::default_source_name()? }
                    .ok_or_else(|| anyhow!("No default audio device is available"))?
            } else { device.name.clone() };
            let native = if system {
                PulseCapture::new_system(&pulse_linux::find_sink_by_name(&id)?.monitor_source_name)?
            } else {
                PulseCapture::new_microphone(&pulse_linux::find_source_by_name(&id)?.source_name)?
            };
            let mut native = native.with_controls(stop.clone(), finish.clone());
            if device.follow_default {
                native = native.follow_default(system, id.clone());
            }
            let origin = Cell::new(0.0);
            let resumed = Cell::new(false);
            let outcome = native.run_timed_ready(|samples, first_frame| {
                // Receiving frames while paused still proves the route recovered.
                if !samples.is_empty() { resumed.set(true); }
                if state.is_paused() || !state.is_recording() || stop.load(Ordering::Acquire) { return; }
                // Bound by bytes as well as blocks even when the server delivers
                // a large backlog/hole in a single peek.
                for (index, samples) in samples.chunks(960 * channels as usize).enumerate() {
                let first_frame = first_frame + index as u64 * 960;
                let end = sample_end(origin.get(), first_frame, samples.len(), channels, state.get_total_pause_duration());
                match sender.try_send(Frame {
                    samples: samples.to_vec(), end, muted: state.is_audio_source_muted(&role),
                }) {
                    Ok(()) => {}
                    Err(std::sync::mpsc::TrySendError::Full(_)) => {
                        if !overflow_reported {
                            state.report_warning(AudioError::BufferOverflow);
                            overflow_reported = true;
                        }
                    }
                    Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                         state.report_linux_fatal(AudioError::ChannelClosed);
                        stop.store(true, Ordering::Release);
                        break;
                    }
                }
                }
            }, || {
                origin.set(state.get_recording_duration().unwrap_or(0.0));
                started.set(true);
                if let Some(ready) = ready.take() { let _ = ready.send(Ok(())); }
                log::info!("Linux {:?} capture ready: {}", role, id);
            });
            if resumed.get() { retry_since = None; }
            outcome
        })();
        match attempt {
            Ok(()) => break,
            Err(error) if stop.load(Ordering::Acquire) || finish.load(Ordering::Acquire) => {
                result = Err(error);
                break;
            }
            Err(error) if ready.is_some() => {
                let _ = ready.take().unwrap().send(Err(error.to_string()));
                result = Err(error);
                break;
            }
            Err(error) if error.is::<DefaultRouteChanged>() => {
                retry_since = None;
                continue;
            }
            Err(error) => {
                log::warn!("Linux {:?} capture reconnect: {}", role, error);
                let since = retry_since.get_or_insert_with(|| {
                    state.report_warning(AudioError::LinuxReconnecting);
                    Instant::now()
                });
                if since.elapsed() >= Duration::from_secs(30) {
                    // The native fatal callback initiates teardown. Database
                    // completion still follows the fork's existing save path.
                    state.report_linux_fatal(AudioError::StreamFailed);
                    result = Err(error);
                    break;
                }
                for _ in 0..50 {
                    if stop.load(Ordering::Acquire) || finish.load(Ordering::Acquire) { break; }
                    thread::sleep(Duration::from_millis(20));
                }
            }
        }
    }
    // Native capture is gone before accepted DSP blocks are drained. The recording
    // manager still owns a live pipeline until this bounded Stop completes.
    worker.stop(Duration::from_secs(2))
        .map_err(|error| anyhow!("Linux DSP closeout failed: {:?}", error))?;
    result
}

fn sample_end(origin: f64, first_frame: u64, samples: usize, channels: u16, paused: f64) -> f64 {
    origin + (first_frame as f64 + samples as f64 / channels as f64) / 48_000.0 - paused
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::devices::DeviceType as EndpointType;

    fn pactl(args: &[&str]) -> String {
        let output = std::process::Command::new("pactl").args(args).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    struct Module(String);
    impl Drop for Module {
        fn drop(&mut self) {
            let _ = std::process::Command::new("pactl").args(["unload-module", &self.0]).output();
        }
    }
    fn sink(name: &str, frequency: &str) -> (Module, Module) {
        let sink = Module(pactl(&["load-module", "module-null-sink", &format!("sink_name={name}")]));
        let tone = Module(pactl(&["load-module", "module-sine", &format!("sink={name}"), &format!("frequency={frequency}")]));
        (sink, tone)
    }
    async fn receive_tone(rx: &mut mpsc::UnboundedReceiver<AudioChunk>, frequency: f64) -> AudioChunk {
        tokio::time::timeout(Duration::from_secs(12), async {
            loop {
                let chunk = rx.recv().await.expect("capture channel closed");
                if chunk.device_type != DeviceType::System { continue; }
                let crossings = chunk.data.windows(2).filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0).count();
                let measured = crossings as f64 * 48_000.0 / chunk.data.len() as f64;
                if (measured - frequency).abs() < 80.0 {
                    assert_eq!(chunk.sample_rate, 48_000);
                    assert_eq!(chunk.device_type, DeviceType::System);
                    return chunk;
                }
            }
        }).await.expect("expected synthetic tone was not delivered")
    }

    #[tokio::test]
    #[ignore = "Run test-linux-audio.sh: requires an isolated Pulse server"]
    async fn isolated_linux_lifecycle_switch_rollback_and_terminal_loss() {
        use super::super::stream::AudioStreamManager;
        assert_eq!(std::env::var("MEETILY_TEST_PULSE_ISOLATED").as_deref(), Ok("1"));
        let (a, a_tone) = sink("meetily_switch_a", "440");
        let (_b, _b_tone) = sink("meetily_switch_b", "880");
        let _mic = Module(pactl(&["load-module", "module-remap-source",
            "master=meetily_switch_b.monitor", "source_name=meetily_switch_mic"]));
        let state = RecordingState::new();
        state.start_recording().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        state.set_audio_sender(tx);
        let mut manager = AudioStreamManager::new(state.clone());
        manager.start_streams(
            Some(Arc::new(AudioDevice::new("meetily_switch_mic".into(), EndpointType::Input))),
            Some(Arc::new(AudioDevice::new("meetily_switch_b".into(), EndpointType::Output))),
            None,
        ).await.unwrap();
        receive_tone(&mut rx, 880.0).await;
        let missing = Arc::new(AudioDevice::new("meetily_missing".into(), EndpointType::Output));
        assert!(manager.replace_linux_source(missing, DeviceType::System).await.is_err());
        assert!(state.is_recording(), "failed switch should restore the previous source");
        receive_tone(&mut rx, 880.0).await;
        let changed_at = state.get_active_recording_duration().unwrap();
        manager.replace_linux_source(Arc::new(AudioDevice::new("meetily_switch_a".into(), EndpointType::Output)),
            DeviceType::System).await.unwrap();
        receive_tone(&mut rx, 440.0).await;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let chunk = rx.recv().await.unwrap();
                if chunk.device_type == DeviceType::Microphone && chunk.timestamp > changed_at { break; }
            }
        }).await.expect("switching system capture must preserve microphone delivery");
        assert_eq!(state.get_microphone_device().unwrap().name, "meetily_switch_mic");

        // Recovery exhaustion is fatal, even though the other source is healthy.
        // This uses the real 30-second retry deadline, not a mocked clock.
        drop(a_tone);
        drop(a);
        tokio::time::timeout(Duration::from_secs(40), async {
            while state.is_recording() { tokio::time::sleep(Duration::from_millis(50)).await; }
        }).await.expect("lost source must reach a terminal failure");
        assert!(state.has_fatal_error());
        assert!(manager.stop_streams().is_err(), "terminal native failure must reach Stop");
        assert!(!CLEANUP.is_pending());
    }

    #[tokio::test]
    #[ignore = "Run test-linux-audio.sh: requires an isolated Pulse server"]
    async fn isolated_linux_lifecycle() {
        let _ = env_logger::builder().is_test(true).try_init();
        assert_eq!(std::env::var("MEETILY_TEST_PULSE_ISOLATED").as_deref(), Ok("1"));
        let (a, a_tone) = sink("meetily_lifecycle_a", "440");
        let (_b, _b_tone) = sink("meetily_lifecycle_b", "880");
        pactl(&["set-default-sink", "meetily_lifecycle_a"]);
        let state = RecordingState::new();
        state.start_recording().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        state.set_audio_sender(tx);
        let device = AudioDevice::new("meetily_lifecycle_a".into(), EndpointType::Output).following_default();
        let stream = LinuxStream::start(Arc::new(device), state.clone(), DeviceType::System, None).await.unwrap();
        receive_tone(&mut rx, 440.0).await;
        pactl(&["set-default-sink", "meetily_lifecycle_b"]);
        let switched = receive_tone(&mut rx, 880.0).await;
        assert!(switched.timestamp > 0.0);
        state.pause_recording().unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        while rx.try_recv().is_ok() {}
        assert!(tokio::time::timeout(Duration::from_millis(100), rx.recv()).await.is_err());
        state.resume_recording().unwrap();
        receive_tone(&mut rx, 880.0).await;
        let start = Instant::now();
        stream.stop().unwrap();
        assert!(start.elapsed() < Duration::from_secs(3));
        state.stop_recording();

        // Pulse 17 may move playback clients (including module-sine) when the
        // default changes. Recreate the tone on a before testing pinned capture.
        drop(a_tone);
        let a_tone = Module(pactl(&["load-module", "module-sine", "sink=meetily_lifecycle_a", "frequency=440"]));
        // An explicitly selected sink stays pinned when the desktop default changes,
        // and resumes the same ID after unplug/replug instead of substituting b.
        let state = RecordingState::new();
        state.start_recording().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        state.set_audio_sender(tx);
        let stream = LinuxStream::start(Arc::new(AudioDevice::new("meetily_lifecycle_a".into(), EndpointType::Output)),
            state.clone(), DeviceType::System, None).await.unwrap();
        receive_tone(&mut rx, 440.0).await;
        drop(a_tone);
        drop(a);
        tokio::time::sleep(Duration::from_millis(200)).await;
        while rx.try_recv().is_ok() {}
        let (_a, _a_tone) = sink("meetily_lifecycle_a", "440");
        receive_tone(&mut rx, 440.0).await;
        assert!(state.is_recording());
        stream.stop().unwrap();
        state.stop_recording();
        assert!(!CLEANUP.is_pending());
    }

    #[test]
    fn delayed_delivery_preserves_sample_clock_and_pause_offset() {
        assert_eq!(sample_end(10.0, 48_000, 960, 2, 0.0), 11.01);
        assert_eq!(sample_end(10.0, 48_480, 480, 1, 0.0), 11.02);
        assert_eq!(sample_end(10.0, 96_000, 960, 2, 1.0), 11.01);
    }

    #[tokio::test]
    async fn abandoning_linux_start_cancels_and_joins_pending_worker() {
        let (entered, wait) = oneshot::channel();
        let exited = Arc::new(AtomicBool::new(false));
        let worker_exited = exited.clone();
        let task = tokio::spawn(LinuxStream::start_with_worker(move |stop, _, ready| {
            let _ = entered.send(());
            let deadline = Instant::now() + Duration::from_secs(2);
            while !stop.load(Ordering::Acquire) && Instant::now() < deadline {
                thread::park_timeout(Duration::from_millis(5));
            }
            anyhow::ensure!(stop.load(Ordering::Acquire), "abandoned Start did not signal Stop");
            worker_exited.store(true, Ordering::Release);
            drop(ready);
            Ok(())
        }));
        tokio::time::timeout(Duration::from_secs(2), wait).await.unwrap().unwrap();
        task.abort();
        assert!(matches!(task.await, Err(error) if error.is_cancelled()));
        assert!(exited.load(Ordering::Acquire));
        assert!(!CLEANUP.is_pending());
    }
}

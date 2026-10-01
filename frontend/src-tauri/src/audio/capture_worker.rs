//! Bounded capture handoff with explicit shutdown, independent of callback lifetime.
//! Some native backends retain callback closures after their public stream drops.
//! Waiting for sender disconnection would therefore make Stop wait forever.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

const WAKE_INTERVAL: Duration = Duration::from_millis(20);

/// Own an uninterruptible native teardown after a bounded caller wait. Callers
/// reject new capture while pending, so repeated retries cannot leak streams.
#[derive(Default)]
pub struct NativeCleanup {
    active: Arc<AtomicUsize>,
}

impl NativeCleanup {
    pub fn is_pending(&self) -> bool {
        self.active.load(Ordering::Acquire) != 0
    }

    pub fn run(&self, cleanup: impl FnOnce() -> Result<(), String> + Send + 'static, timeout: Duration) -> Result<(), String> {
        let (completed, wait) = mpsc::sync_channel(1);
        let active = self.active.clone();
        active.fetch_add(1, Ordering::AcqRel);
        let thread = thread::Builder::new().name("audio-native-cleanup".into()).spawn(move || {
            struct Guard(Arc<AtomicUsize>);
            impl Drop for Guard {
                fn drop(&mut self) { self.0.fetch_sub(1, Ordering::AcqRel); }
            }
            let guard = Guard(active);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(cleanup))
                .unwrap_or_else(|_| Err("Native audio cleanup panicked".into()));
            drop(guard);
            let _ = completed.send(result);
        });
        if let Err(error) = thread {
            self.active.fetch_sub(1, Ordering::AcqRel);
            return Err(error.to_string());
        }
        wait.recv_timeout(timeout)
            .map_err(|_| "Audio shutdown timed out; native cleanup is still running".to_string())?
    }
}

/// Convert CPAL's first-sample capture age into a recording-relative block end.
/// WASAPI packets can wait in the driver before delivery: using callback time
/// would turn a scheduling stall into a fake gap and then discard the backlog.
pub fn capture_end_seconds(
    callback_seconds: f64,
    samples: usize,
    channels: u16,
    sample_rate: u32,
    capture_age: Option<Duration>,
) -> f64 {
    let Some(age) = capture_age else { return callback_seconds; };
    let duration = samples as f64 / channels.max(1) as f64 / sample_rate.max(1) as f64;
    (callback_seconds - age.as_secs_f64() + duration).clamp(0.0, callback_seconds.max(0.0))
}

#[derive(Debug, PartialEq, Eq)]
pub enum StopError {
    TimedOut,
    Panicked,
}

pub struct CaptureWorker<T> {
    sender: SyncSender<T>,
    closing: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    done: Receiver<bool>,
    thread: Option<JoinHandle<()>>,
}

impl<T: Send + 'static> CaptureWorker<T> {
    pub fn spawn(
        capacity: usize,
        mut process: impl FnMut(T) + Send + 'static,
    ) -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel(capacity);
        let closing = Arc::new(AtomicBool::new(false));
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_closing = closing.clone();
        let worker_cancel = cancel.clone();
        let (done_sender, done) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("capture-audio-processing".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    loop {
                        if worker_cancel.load(Ordering::Acquire) {
                            break;
                        }
                        let frame = if worker_closing.load(Ordering::Acquire) {
                            // Capture is already paused: drain only accepted blocks.
                            // An empty queue means finished, even with a live sender.
                            match receiver.try_recv() {
                                Ok(frame) => frame,
                                Err(_) => break,
                            }
                        } else {
                            match receiver.recv_timeout(WAKE_INTERVAL) {
                                Ok(frame) => frame,
                                Err(RecvTimeoutError::Timeout) => continue,
                                Err(RecvTimeoutError::Disconnected) => break,
                            }
                        };
                        process(frame);
                    }
                }));
                // Release callback/DSP ownership before acknowledging completion.
                drop(receiver);
                drop(process);
                let _ = done_sender.send(result.is_ok());
            })?;
        Ok(Self {
            sender,
            closing,
            cancel,
            done,
            thread: Some(thread),
        })
    }

    pub fn sender(&self) -> SyncSender<T> {
        self.sender.clone()
    }

    /// Call after pausing capture. A stalled DSP operation cannot be interrupted;
    /// bound the caller's wait and abandon queued work if it exceeds the deadline.
    /// The recording manager then closes pipeline input and reports the failure.
    pub fn stop(&mut self, timeout: Duration) -> Result<(), StopError> {
        self.closing.store(true, Ordering::Release);
        let result = match self.done.recv_timeout(timeout) {
            Ok(true) => Ok(()),
            Ok(false) | Err(RecvTimeoutError::Disconnected) => Err(StopError::Panicked),
            Err(RecvTimeoutError::Timeout) => {
                self.cancel.store(true, Ordering::Release);
                Err(StopError::TimedOut)
            }
        };
        if let Some(thread) = self.thread.take() {
            // Never turn a bounded completion wait back into an unbounded join.
            if thread.is_finished() {
                let _ = thread.join();
            }
        }
        result
    }
}

impl<T> Drop for CaptureWorker<T> {
    fn drop(&mut self) {
        // Covers device-build/play failure and other early exits too. The worker
        // sees this on its next receive, even if the native callback is retained.
        self.closing.store(true, Ordering::Release);
        self.cancel.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Barrier, Mutex};
    use std::time::Instant;

    #[test]
    fn native_cleanup_timeout_retains_ownership_and_blocks_restart_until_done() {
        let cleanup = NativeCleanup::default();
        let (release, wait) = mpsc::channel();
        let started = Instant::now();
        let result = cleanup.run(move || { wait.recv().unwrap(); Ok(()) }, Duration::from_millis(20));
        assert!(result.unwrap_err().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(cleanup.is_pending());
        release.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while cleanup.is_pending() && Instant::now() < deadline { thread::yield_now(); }
        assert!(!cleanup.is_pending());
        assert_eq!(cleanup.run(|| Ok(()), Duration::from_secs(1)), Ok(()));
    }

    #[test]
    fn native_cleanup_failure_and_panic_release_restart_guard() {
        let cleanup = NativeCleanup::default();
        assert_eq!(cleanup.run(|| Err("driver failure".into()), Duration::from_secs(1)), Err("driver failure".into()));
        assert!(!cleanup.is_pending());
        assert!(cleanup.run(|| panic!("native teardown failure"), Duration::from_secs(1)).unwrap_err().contains("panicked"));
        assert!(!cleanup.is_pending());
    }

    #[test]
    fn driver_backlog_keeps_capture_time_instead_of_delivery_time() {
        // Two consecutive stereo 10 ms blocks arrive almost together after
        // an 80 ms scheduling stall. Their actual sample ends remain 10 ms apart.
        let first = capture_end_seconds(12.590, 960, 2, 48_000, Some(Duration::from_millis(90)));
        let second = capture_end_seconds(12.591, 960, 2, 48_000, Some(Duration::from_millis(81)));
        assert!((first - 12.510).abs() < 1e-9);
        assert!((second - 12.520).abs() < 1e-9);
        assert_eq!(capture_end_seconds(0.005, 480, 1, 48_000, Some(Duration::from_millis(80))), 0.0);
        assert_eq!(capture_end_seconds(1.0, 480, 1, 48_000, None), 1.0);
    }

    #[test]
    fn stop_drains_audio_and_timestamps_with_callback_sender_still_alive() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let collected = output.clone();
        let mut worker = CaptureWorker::spawn(8, move |frame: (Vec<f32>, f64)| {
            collected.lock().unwrap().push(frame);
        })
        .unwrap();
        let retained_callback_sender = worker.sender();
        let frames = vec![(vec![0.25; 480], 0.01), (vec![-0.25; 480], 0.02)];
        for frame in &frames {
            retained_callback_sender.try_send(frame.clone()).unwrap();
        }
        assert_eq!(worker.stop(Duration::from_secs(1)), Ok(()));
        assert_eq!(*output.lock().unwrap(), frames);
        assert!(retained_callback_sender
            .try_send((vec![1.0], 0.03))
            .is_err());
    }

    #[test]
    fn stalled_processing_has_bounded_stop_and_discards_pending_work() {
        let entered = Arc::new(Barrier::new(2));
        let gate = entered.clone();
        let (release, wait) = mpsc::channel();
        let (processed, results) = mpsc::channel();
        let mut worker = CaptureWorker::spawn(2, move |frame: u32| {
            gate.wait();
            wait.recv().unwrap();
            processed.send(frame).unwrap();
        })
        .unwrap();
        let sender = worker.sender();
        sender.try_send(1).unwrap();
        entered.wait();
        sender.try_send(2).unwrap();
        let started = Instant::now();
        assert_eq!(
            worker.stop(Duration::from_millis(25)),
            Err(StopError::TimedOut)
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        release.send(()).unwrap();
        assert_eq!(results.recv_timeout(Duration::from_secs(1)).unwrap(), 1);
        assert_eq!(
            results.recv_timeout(Duration::from_secs(1)),
            Err(RecvTimeoutError::Disconnected)
        );
    }

    #[test]
    fn full_queue_never_waits_for_processing() {
        let (release, wait) = mpsc::channel();
        let (entered, entry) = mpsc::channel();
        let mut worker = CaptureWorker::spawn(1, move |_: u32| {
            entered.send(()).unwrap();
            wait.recv().unwrap();
        })
        .unwrap();
        let sender = worker.sender();
        sender.try_send(1).unwrap();
        entry.recv_timeout(Duration::from_secs(1)).unwrap();
        sender.try_send(2).unwrap();
        assert!(matches!(
            sender.try_send(3),
            Err(mpsc::TrySendError::Full(3))
        ));
        release.send(()).unwrap();
        release.send(()).unwrap();
        assert_eq!(worker.stop(Duration::from_secs(1)), Ok(()));
    }

    #[test]
    fn processing_panic_is_reported_instead_of_hanging_stop() {
        let mut worker = CaptureWorker::spawn(1, |_: u32| panic!("synthetic DSP failure")).unwrap();
        worker.sender().try_send(1).unwrap();
        assert_eq!(
            worker.stop(Duration::from_secs(1)),
            Err(StopError::Panicked)
        );
    }

    #[test]
    fn early_owner_drop_releases_worker_despite_retained_callback() {
        let (released, release_notice) = mpsc::channel();
        struct OnDrop(mpsc::Sender<()>);
        impl Drop for OnDrop {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }
        let guard = OnDrop(released);
        let worker = CaptureWorker::spawn(1, move |_: u32| {
            let _ = &guard;
        })
        .unwrap();
        let sender = worker.sender();
        drop(worker);
        release_notice.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(sender.try_send(1).is_err());
    }
}

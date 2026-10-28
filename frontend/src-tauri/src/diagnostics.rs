//! Content-free lifecycle evidence. Producers never do file I/O or wait for queue
//! capacity; one worker owns a bounded journal for each native app session.
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const LIMIT: usize = 128;
const ACTIVE_LIMIT: usize = 32;
const SLOW_MS: u64 = 15_000;
static RECORDER: OnceLock<Mutex<Option<Recorder>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

// No free-form labels, model paths, device names, or error strings can enter this
// channel. Add stages here deliberately rather than routing application logs in.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    ParakeetInit,
    ParakeetLoad,
    WhisperInit,
    WhisperLoad,
    SttMemoryPreparation,
    RecordingStart,
    LifecycleLock,
    RuntimeCheck,
    ModelValidation,
    DeviceResolution,
    LiveDiarization,
    CaptureStart,
    RecordingStop,
    CaptureStop,
    TranscriptionDrain,
    RecordingSave,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Started,
    Completed,
    Failed,
    Interrupted,
    Slow,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    operation_id: u64,
    stage: Stage,
    outcome: Outcome,
    at_ms: u64,
    elapsed_ms: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    events: VecDeque<Event>,
    active: Vec<Event>,
    elapsed_ms: u64,
    dropped_events: u64,
    evicted_events: u64,
}

impl Snapshot {
    fn push(&mut self, event: Event) {
        if self.events.len() == LIMIT {
            self.events.pop_front();
            self.evicted_events += 1;
        }
        self.events.push_back(event);
    }

    fn accept(&mut self, event: Event) {
        if event.outcome == Outcome::Started {
            if self.active.len() < ACTIVE_LIMIT {
                self.active.push(event.clone());
            } else {
                self.dropped_events += 1;
            }
        } else {
            self.active
                .retain(|active| active.operation_id != event.operation_id);
        }
        self.push(event);
    }

    fn tick(&mut self, now_ms: u64) {
        self.elapsed_ms = now_ms;
        let mut slow = Vec::new();
        for active in &mut self.active {
            active.elapsed_ms = now_ms.saturating_sub(active.at_ms);
            if active.outcome == Outcome::Started && active.elapsed_ms >= SLOW_MS {
                active.outcome = Outcome::Slow;
                let mut event = active.clone();
                event.at_ms = now_ms;
                slow.push(event);
            }
        }
        for event in slow {
            self.push(event);
        }
    }
}

#[derive(Clone)]
struct Recorder {
    sender: mpsc::SyncSender<Event>,
    started: Instant,
    dropped: Arc<AtomicU64>,
    shutdown: Arc<AtomicBool>,
}

impl Recorder {
    fn send(&self, event: Event) {
        if self.sender.try_send(event).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub struct Span {
    recorder: Option<Recorder>,
    stage: Stage,
    id: u64,
    started: Instant,
    outcome: Outcome,
}

impl Span {
    pub fn start(stage: Stage) -> Self {
        let recorder = RECORDER
            .get()
            .and_then(|holder| holder.lock().ok()?.clone());
        let span = Self {
            recorder,
            stage,
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            started: Instant::now(),
            outcome: Outcome::Interrupted,
        };
        span.emit(Outcome::Started);
        span
    }

    fn emit(&self, outcome: Outcome) {
        if let Some(recorder) = &self.recorder {
            recorder.send(Event {
                operation_id: self.id,
                stage: self.stage,
                outcome,
                at_ms: millis(recorder.started.elapsed()),
                elapsed_ms: millis(self.started.elapsed()),
            });
        }
    }

    pub fn complete(mut self) {
        self.outcome = Outcome::Completed;
    }

    pub fn result<T, E>(mut self, result: &Result<T, E>) {
        self.outcome = if result.is_ok() {
            Outcome::Completed
        } else {
            Outcome::Failed
        };
    }
}

impl Drop for Span {
    fn drop(&mut self) {
        self.emit(self.outcome);
    }
}

pub async fn track<T, E>(stage: Stage, future: impl Future<Output = Result<T, E>>) -> Result<T, E> {
    let span = Span::start(stage);
    let result = future.await;
    span.result(&result);
    result
}

pub async fn wait<T>(stage: Stage, future: impl Future<Output = T>) -> T {
    let span = Span::start(stage);
    let result = future.await;
    span.complete();
    result
}

fn millis(duration: Duration) -> u64 {
    duration.as_millis().min(u64::MAX as u128) as u64
}

fn path(root: &Path, session_id: &str) -> PathBuf {
    use sha2::{Digest, Sha256};
    // Only a fixed-format filename, even when importing a malformed session file.
    root.join(format!(
        "diagnostics-{:x}.json",
        Sha256::digest(session_id.as_bytes())
    ))
}

pub(crate) fn start(root: &Path, session_id: &str) {
    match new_recorder(root, session_id) {
        Ok(recorder) => {
            if let Ok(mut holder) = RECORDER.get_or_init(|| Mutex::new(None)).lock() {
                *holder = Some(recorder);
            }
        }
        Err(_) => log::warn!("Could not start content-free diagnostic journal"),
    }
}

fn new_recorder(root: &Path, session_id: &str) -> std::io::Result<Recorder> {
    let (sender, receiver) = mpsc::sync_channel(LIMIT);
    let recorder = Recorder {
        sender,
        started: Instant::now(),
        dropped: Arc::new(AtomicU64::new(0)),
        shutdown: Arc::new(AtomicBool::new(false)),
    };
    let started = recorder.started;
    let dropped = recorder.dropped.clone();
    let shutdown = recorder.shutdown.clone();
    let destination = path(root, session_id);
    std::thread::Builder::new()
        .name("diagnostic-journal".into())
        .spawn(move || {
            let mut snapshot = Snapshot::default();
            loop {
                let message = receiver.recv_timeout(Duration::from_secs(1));
                if shutdown.load(Ordering::Acquire) {
                    let _ = std::fs::remove_file(&destination);
                    break;
                }
                match message {
                    Ok(event) => snapshot.accept(event),
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) if snapshot.active.is_empty() => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                snapshot.dropped_events += dropped.swap(0, Ordering::Relaxed);
                snapshot.tick(millis(started.elapsed()));
                // Failed writes never affect recording. Retry on the next event/tick.
                let _ = crate::crash_report::write_json_atomic(&destination, &snapshot);
            }
        })?;
    Ok(recorder)
}

pub(crate) fn finish() {
    if let Some(holder) = RECORDER.get() {
        if let Ok(mut holder) = holder.lock() {
            if let Some(recorder) = holder.take() {
                // Old spans retain their old sender, never a later session's. The
                // worker exits on its next receive check, without waiting on ASR.
                recorder.shutdown.store(true, Ordering::Release);
            }
        }
    }
}

pub(crate) fn recover(root: &Path, session_id: &str) -> Option<Snapshot> {
    let path = path(root, session_id);
    if std::fs::metadata(&path).ok()?.len() > 128 * 1024 {
        return None;
    }
    let snapshot: Snapshot = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    (snapshot.events.len() <= LIMIT && snapshot.active.len() <= ACTIVE_LIMIT).then_some(snapshot)
}

pub(crate) fn remove(root: &Path, session_id: &str) {
    let _ = std::fs::remove_file(path(root, session_id));
}

pub(crate) fn prune(root: &Path) {
    // A normal process exit can precede the worker's clean-stop cleanup. At the
    // next launch, after recovery, retain no older diagnostic session journals.
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name
                .strip_prefix("diagnostics-")
                .and_then(|s| s.strip_suffix(".json"))
                .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: u64, outcome: Outcome, at_ms: u64) -> Event {
        Event {
            operation_id: id,
            stage: Stage::ParakeetLoad,
            outcome,
            at_ms,
            elapsed_ms: 0,
        }
    }

    #[test]
    fn slow_active_operation_survives_ring_eviction_and_completes_by_id() {
        let mut journal = Snapshot::default();
        journal.accept(event(1, Outcome::Started, 10));
        for id in 2..200 {
            journal.accept(event(id, Outcome::Completed, 100));
        }
        journal.tick(20_010);
        assert_eq!(journal.events.len(), LIMIT);
        assert_eq!(journal.active[0].elapsed_ms, 20_000);
        assert_eq!(journal.events.back().unwrap().outcome, Outcome::Slow);
        let evicted = journal.evicted_events;
        journal.tick(30_010);
        assert_eq!(journal.evicted_events, evicted); // Only one slow warning.
        journal.accept(event(1, Outcome::Failed, 30_011));
        assert!(journal.active.is_empty());
    }

    #[test]
    fn persisted_evidence_is_session_scoped_bounded_and_allowlisted() {
        let root = tempfile::tempdir().unwrap();
        let mut journal = Snapshot::default();
        journal.accept(event(1, Outcome::Started, 1));
        crate::crash_report::write_json_atomic(&path(root.path(), "old"), &journal).unwrap();
        assert!(recover(root.path(), "new").is_none());
        assert_eq!(recover(root.path(), "old").unwrap().active.len(), 1);
        let bad = serde_json::to_string(&journal)
            .unwrap()
            .replace("parakeet_load", "private device name");
        std::fs::write(path(root.path(), "old"), bad).unwrap();
        assert!(recover(root.path(), "old").is_none());
        std::fs::write(path(root.path(), "old"), vec![b' '; 128 * 1024 + 1]).unwrap();
        assert!(recover(root.path(), "old").is_none());
    }

    #[test]
    fn full_queue_does_not_block_and_counts_loss() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let recorder = Recorder {
            sender,
            started: Instant::now(),
            dropped: Arc::new(AtomicU64::new(0)),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        recorder.send(event(1, Outcome::Started, 0));
        recorder.send(event(1, Outcome::Completed, 1));
        assert_eq!(recorder.dropped.load(Ordering::Relaxed), 1);
    }

    fn until(mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(
                Instant::now() < deadline,
                "diagnostic worker did not persist its state"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn worker_persists_unfinished_work_and_clean_stop_removes_only_its_session() {
        let root = tempfile::tempdir().unwrap();
        let old = new_recorder(root.path(), "old").unwrap();
        old.send(event(1, Outcome::Started, 0));
        until(|| recover(root.path(), "old").is_some_and(|s| s.active.len() == 1));
        let current = new_recorder(root.path(), "current").unwrap();
        current.send(event(2, Outcome::Started, 0));
        old.shutdown.store(true, Ordering::Release);
        old.send(event(1, Outcome::Completed, 20));
        until(|| !path(root.path(), "old").exists());
        until(|| recover(root.path(), "current").is_some_and(|s| s.active[0].operation_id == 2));
        current.shutdown.store(true, Ordering::Release);
        current.send(event(2, Outcome::Completed, 20));
        until(|| !path(root.path(), "current").exists());
    }

    #[test]
    fn span_outcomes_do_not_capture_result_payloads() {
        let (sender, receiver) = mpsc::sync_channel(8);
        let recorder = Recorder {
            sender,
            started: Instant::now(),
            dropped: Arc::new(AtomicU64::new(0)),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        for id in 1..=3 {
            let span = Span {
                recorder: Some(recorder.clone()),
                stage: Stage::WhisperLoad,
                id,
                started: Instant::now(),
                outcome: Outcome::Interrupted,
            };
            match id {
                1 => span.complete(),
                2 => span.result(&Err::<(), _>("private model path and error")),
                _ => drop(span),
            }
        }
        let events: Vec<_> = receiver.try_iter().collect();
        assert_eq!(
            events.iter().map(|e| e.outcome).collect::<Vec<_>>(),
            vec![Outcome::Completed, Outcome::Failed, Outcome::Interrupted]
        );
        assert!(!serde_json::to_string(&events).unwrap().contains("private"));
    }
}

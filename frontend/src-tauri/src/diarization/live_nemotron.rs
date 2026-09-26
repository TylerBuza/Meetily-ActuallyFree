//! Continuous remote-audio diarization. Inference never runs on the capture thread.
//! Microphone provenance remains authoritative for "You"; remote channels are
//! meeting-local identities, not voiceprints or names carried between recordings.
use anyhow::{anyhow, Result};
use std::{collections::VecDeque, sync::{mpsc, Arc, Condvar, Mutex}, thread, time::Duration};
use tauri::Emitter;
use super::nemotron::{NemotronDiarizationModel, StreamingSpeakerSegment};

const RATE: u64 = 16_000;
const STRIDE: u64 = 9 * 1280;
const LOOKAHEAD: u64 = 4 * 1280;
const HISTORY: u64 = 10 * 60 * RATE;

#[derive(Default)]
struct Timeline {
    segments: VecDeque<StreamingSpeakerSegment>,
    ready_until: u64,
    finished: bool,
    failed: bool,
}
impl Timeline {
    fn append(&mut self, segments: Vec<StreamingSpeakerSegment>, ready_until: u64) {
        self.segments.extend(segments);
        self.ready_until = ready_until;
        let oldest = ready_until.saturating_sub(HISTORY);
        self.segments.retain(|s| s.end >= oldest);
    }

    fn label(&self, start: u64, end: u64) -> Option<String> {
        if self.failed || end <= start || start < self.ready_until.saturating_sub(HISTORY) { return None; }
        let mut coverage = [0u64; 8];
        for s in &self.segments {
            if s.speaker_id < coverage.len() {
                coverage[s.speaker_id] += s.end.min(end).saturating_sub(s.start.max(start));
            }
        }
        let best = *coverage.iter().max()?;
        if best == 0 { return None; }
        // A transcript turn may include multiple speakers. Do not fabricate word
        // alignment or concatenate identities into a new pseudo-speaker label.
        let speaker = coverage.iter().position(|&value| value == best)?;
        Some(format!("Speaker {}", speaker + 1))
    }
}

struct Audio { start: u64, samples: Vec<f32> }
struct Session {
    sender: Option<mpsc::SyncSender<Audio>>,
    shared: Arc<(Mutex<Timeline>, Condvar)>,
    worker: Option<thread::JoinHandle<()>>,
    notify: Arc<dyn Fn(String) + Send + Sync>,
}
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn report_failure(notify: &Arc<dyn Fn(String) + Send + Sync>, shared: &Arc<(Mutex<Timeline>, Condvar)>, message: String) {
    log::error!("Live Nemotron: {message}");
    if let Ok(mut state) = shared.0.lock() { state.failed = true; }
    shared.1.notify_all();
    notify(format!("Nemotron live speaker labeling stopped: {message}. Transcription continues with source labels."));
}

pub fn start<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<()> {
    stop();
    let cfg = super::get_diarization_config();
    let mut model = NemotronDiarizationModel::new(
        super::diarization_user_model_dir().join(super::nemotron::NEMOTRON_MODEL_FILENAME),
        8, cfg.nemotron_threshold,
    )?;
    model.enable_live_streaming()?;
    let notify: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |message| { let _ = app.emit("live-diarization-error", message); });
    let session = spawn_session(model, notify)?;
    *SESSION.lock().map_err(|_| anyhow!("Live Nemotron lock poisoned"))? = Some(session);
    log::info!("Live Nemotron started: 1.04 s buffering, continuous system audio, 8 speaker channels");
    Ok(())
}

fn spawn_session(mut model: NemotronDiarizationModel, notify: Arc<dyn Fn(String) + Send + Sync>) -> Result<Session> {
    // 30 s of 50 ms capture windows. An overloaded queue disables labeling
    // explicitly instead of blocking capture or silently dropping timeline audio.
    let (sender, receiver) = mpsc::sync_channel::<Audio>(600);
    let shared = Arc::new((Mutex::new(Timeline::default()), Condvar::new()));
    let state = shared.clone();
    let worker_notify = notify.clone();
    let worker = thread::Builder::new().name("nemotron-live".into()).spawn(move || {
        let result = (|| -> Result<()> {
            let mut cursor = 0u64;
            for audio in receiver {
                if state.0.lock().map_err(|_| anyhow!("Timeline lock poisoned"))?.failed { return Ok(()); }
                // Device gaps and pause/resume use recording-relative VAD time.
                // Feed silence in bounded pieces, preserving the model's cache.
                while cursor < audio.start {
                    if state.0.lock().map_err(|_| anyhow!("Timeline lock poisoned"))?.failed { return Ok(()); }
                    let count = (audio.start - cursor).min(RATE) as usize;
                    let segments = model.feed(&vec![0.0; count])?;
                    cursor += count as u64;
                    publish(&state, segments, cursor, false)?;
                }
                let skip = cursor.saturating_sub(audio.start).min(audio.samples.len() as u64) as usize;
                let samples = &audio.samples[skip..];
                let segments = model.feed(samples)?;
                cursor += samples.len() as u64;
                publish(&state, segments, cursor, false)?;
            }
            let segments = model.flush()?;
            publish(&state, segments, cursor, true)
        })();
        if let Err(error) = result { report_failure(&worker_notify, &state, error.to_string()); }
    })?;
    Ok(Session {
        sender: Some(sender), shared, worker: Some(worker), notify,
    })
}

fn publish(shared: &Arc<(Mutex<Timeline>, Condvar)>, segments: Vec<StreamingSpeakerSegment>, cursor: u64, finished: bool) -> Result<()> {
    let ready = if finished { cursor } else { cursor.saturating_sub(LOOKAHEAD) / STRIDE * STRIDE };
    let mut state = shared.0.lock().map_err(|_| anyhow!("Timeline lock poisoned"))?;
    state.append(segments, ready);
    state.finished = finished;
    shared.1.notify_all();
    Ok(())
}

pub fn active() -> bool { SESSION.lock().map(|s| s.is_some()).unwrap_or(false) }

pub fn feed(start: u64, samples: &[f32]) {
    let Ok(mut guard) = SESSION.lock() else { return; };
    let Some(session) = guard.as_mut() else { return; };
    let Some(sender) = &session.sender else { return; };
    if sender.try_send(Audio { start, samples: samples.to_vec() }).is_err() {
        session.sender.take();
        report_failure(&session.notify, &session.shared, "Inference queue unavailable or overloaded".into());
    }
}

/// Closing input drains queued audio and flushes the final lookahead. Keep the
/// timeline alive until the transcription worker has consumed the final turns.
pub fn finish() {
    if let Ok(mut guard) = SESSION.lock() {
        if let Some(session) = guard.as_mut() { session.sender.take(); }
    }
}

pub fn label(start_seconds: f64, duration: f64) -> Option<String> {
    if !start_seconds.is_finite() || !duration.is_finite() || duration <= 0.0 { return None; }
    let shared = SESSION.lock().ok()?.as_ref()?.shared.clone();
    let start = (start_seconds.max(0.0) * RATE as f64).round() as u64;
    let end = start.saturating_add((duration * RATE as f64).round() as u64);
    let state = shared.0.lock().ok()?;
    let (state, _) = shared.1.wait_timeout_while(state, Duration::from_millis(1500), |s| {
        !s.failed && !s.finished && s.ready_until < end
    }).ok()?;
    state.label(start, end)
}

pub fn stop() {
    let session = SESSION.lock().ok().and_then(|mut s| s.take());
    if let Some(mut session) = session {
        session.sender.take();
        if let Some(worker) = session.worker.take() { let _ = worker.join(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires pinned model and multispeaker fixture"]
    fn live_nemotron_worker_drains_and_keeps_final_turns_available() {
        let path = std::env::var("MEETILY_NEMOTRON_MODEL").unwrap();
        let wav = std::env::var("MEETILY_NEMOTRON_WAV").unwrap();
        let (audio, rate) = super::super::dsp::read_wav(std::path::Path::new(&wav)).unwrap();
        assert_eq!(rate, 16000);
        let mut model = NemotronDiarizationModel::new(path, 8, 0.5).unwrap();
        model.enable_live_streaming().unwrap();
        let errors = Arc::new(Mutex::new(Vec::new()));
        let reported = errors.clone();
        let mut session = spawn_session(model, Arc::new(move |message| reported.lock().unwrap().push(message))).unwrap();
        for (i, samples) in audio.chunks(800).enumerate() {
            session.sender.as_ref().unwrap().send(Audio { start: (i * 800) as u64, samples: samples.to_vec() }).unwrap();
        }
        session.sender.take();
        session.worker.take().unwrap().join().unwrap();
        assert!(errors.lock().unwrap().is_empty());
        let state = session.shared.0.lock().unwrap();
        assert!(state.finished);
        assert_eq!(state.ready_until, audio.len() as u64);
        assert!(state.label(0, 10 * RATE).is_some());
        assert!(state.label(audio.len() as u64 - 10 * RATE, audio.len() as u64).is_some());
    }
    fn segment(start: u64, end: u64, speaker_id: usize) -> StreamingSpeakerSegment {
        StreamingSpeakerSegment { start, end, speaker_id }
    }
    #[test]
    fn labels_follow_overlap_not_the_last_detected_speaker() {
        let mut timeline = Timeline::default();
        timeline.append(vec![segment(0, RATE * 2, 2), segment(RATE * 2, RATE * 3, 0)], RATE * 3);
        assert_eq!(timeline.label(0, RATE), Some("Speaker 3".into()));
        assert_eq!(timeline.label(RATE * 2, RATE * 3), Some("Speaker 1".into()));
        assert_eq!(timeline.label(RATE * 4, RATE * 5), None);
        timeline.failed = true;
        assert_eq!(timeline.label(0, RATE), None);
    }
    #[test]
    fn history_is_bounded_and_old_turns_are_not_assigned_new_identities() {
        let mut timeline = Timeline::default();
        timeline.append(vec![segment(0, RATE, 0), segment(HISTORY, HISTORY + RATE, 1)], HISTORY + RATE * 2);
        assert_eq!(timeline.segments.len(), 1);
        assert_eq!(timeline.label(0, RATE), None);
        assert_eq!(timeline.label(HISTORY, HISTORY + RATE), Some("Speaker 2".into()));
    }
    #[test]
    fn flush_publishes_the_buffered_tail() {
        let shared = Arc::new((Mutex::new(Timeline::default()), Condvar::new()));
        publish(&shared, vec![], STRIDE + LOOKAHEAD - 1, false).unwrap();
        assert_eq!(shared.0.lock().unwrap().ready_until, 0);
        publish(&shared, vec![], STRIDE + LOOKAHEAD, false).unwrap();
        assert_eq!(shared.0.lock().unwrap().ready_until, STRIDE);
        publish(&shared, vec![segment(STRIDE, STRIDE + LOOKAHEAD, 1)], STRIDE + LOOKAHEAD, true).unwrap();
        let state = shared.0.lock().unwrap();
        assert!(state.finished);
        assert_eq!(state.ready_until, STRIDE + LOOKAHEAD);
    }
}

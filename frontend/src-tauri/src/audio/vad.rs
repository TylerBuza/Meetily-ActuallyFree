use anyhow::{anyhow, Result};
use silero_rs::{VadConfig, VadSession, VadTransition};
use log::{debug, info, warn, error};
use std::collections::VecDeque;
use std::time::Duration;

/// Represents a complete speech segment detected by VAD
#[derive(Debug, Clone)]
pub struct SpeechSegment {
    pub samples: Vec<f32>,
    pub start_timestamp_ms: f64,
    pub end_timestamp_ms: f64,
    pub confidence: f32,
}

/// Searches the trailing `search_samples` of `samples` for the window of length
/// `sub_window_samples` with the minimum RMS energy. Returns the sample index
/// at the center of the quietest window to provide a natural split point.
fn find_split_point(samples: &[f32], search_samples: usize, sub_window_samples: usize) -> usize {
    if samples.len() <= sub_window_samples {
        return samples.len();
    }
    let search_start = samples.len().saturating_sub(search_samples);
    let search_slice = &samples[search_start..];
    if search_slice.len() <= sub_window_samples {
        return samples.len();
    }

    let step = 160; // 10ms steps at 16kHz
    let mut min_energy = f32::MAX;
    let mut best_cut = samples.len();

    let mut offset = 0;
    while offset + sub_window_samples <= search_slice.len() {
        let window = &search_slice[offset..offset + sub_window_samples];
        let energy: f32 = window.iter().map(|&x| x * x).sum();
        if energy < min_energy {
            min_energy = energy;
            best_cut = search_start + offset + (sub_window_samples / 2);
        }
        offset += step;
    }

    best_cut
}

/// Processes audio in 30ms chunks but returns complete speech segments
pub struct ContinuousVadProcessor {
    session: VadSession,
    config: VadConfig,
    chunk_size: usize,
    sample_rate: u32,
    buffer: Vec<f32>,
    speech_segments: VecDeque<SpeechSegment>,
    current_speech: Vec<f32>,
    in_speech: bool,
    processed_samples: usize,
    session_start_sample: usize,
    speech_start_sample: usize,
    // State tracking for smart logging
    last_logged_state: bool,
    // Maximum samples of continuous speech before force-splitting at a quiet dip (0 = disabled)
    max_speech_samples: usize,
}

impl ContinuousVadProcessor {
    /// Set maximum speech segment duration in milliseconds before force-splitting.
    /// In real-time streaming mode, this is typically 3500ms (~3.5s).
    /// In standard mode, this is typically 6000ms (~6.0s) to prevent memory buildup.
    /// Pass 0 to disable capping.
    pub fn set_max_speech_duration_ms(&mut self, duration_ms: u32) {
        if duration_ms == 0 {
            self.max_speech_samples = 0;
        } else {
            self.max_speech_samples = (duration_ms as usize * 16000) / 1000;
        }
    }

    /// Whether speech has started but has not yet crossed the redemption-time
    /// silence boundary. Live capture uses this to advance only an unfinished
    /// utterance when an audio backend suppresses exact-zero callbacks.
    pub fn has_active_speech(&self) -> bool {
        self.in_speech
    }

    /// Close the current live utterance at the last audio timestamp without
    /// synthesizing samples. Used when a capture backend suppresses callbacks
    /// throughout silence, so wall time can trigger finalization without moving
    /// the recording-relative audio clock or duplicating later gap padding.
    pub fn finalize_active_speech(&mut self) -> Option<SpeechSegment> {
        if !self.in_speech || self.current_speech.is_empty() {
            return None;
        }
        let start_ms = (self.speech_start_sample as f64 / 16000.0) * 1000.0;
        let end_ms = (self.processed_samples as f64 / 16000.0) * 1000.0;
        self.in_speech = false;
        self.last_logged_state = false;
        // Silero's reset intentionally retains session_audio. Recreate the
        // session so repeated callback-silence finalizations stay O(utterance)
        // in memory, then offset its future relative timestamps onto the
        // continuous meeting timeline.
        match VadSession::new(self.config) {
            Ok(session) => {
                self.session = session;
                self.session_start_sample = self.processed_samples;
            }
            Err(error) => {
                warn!("Failed to recreate VAD session after forced finalization: {error:?}");
                self.session.reset();
            }
        }
        let samples = std::mem::take(&mut self.current_speech);
        let sum_sq: f32 = samples.iter().map(|&x| x * x).sum();
        let rms = (sum_sq / samples.len() as f32).sqrt();
        let peak = samples.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
        if rms < 0.005 && peak < 0.01 {
            return None;
        }
        Some(SpeechSegment {
            samples,
            start_timestamp_ms: start_ms,
            end_timestamp_ms: end_ms,
            confidence: 0.8,
        })
    }

    /// Move an inactive processor to an absolute recording-relative position.
    /// The mixer calls this after dropping a callback-free gap instead of
    /// allocating seconds or minutes of synthetic silence.
    pub fn advance_inactive_timeline_to(&mut self, timestamp_seconds: f64) {
        if self.in_speech {
            return;
        }
        let target_sample = (timestamp_seconds.max(0.0) * 16000.0).round() as usize;
        if target_sample <= self.processed_samples {
            return;
        }
        match VadSession::new(self.config) {
            Ok(session) => self.session = session,
            Err(error) => {
                warn!("Failed to recreate VAD session after timeline discontinuity: {error:?}");
                self.session.reset();
            }
        }
        self.buffer.clear();
        self.current_speech.clear();
        self.processed_samples = target_sample;
        self.session_start_sample = target_sample;
    }

    pub fn new(input_sample_rate: u32, redemption_time_ms: u32) -> Result<Self> {
        Self::new_with_thresholds(input_sample_rate, redemption_time_ms, 0.50, 0.35)
    }

    pub fn new_with_thresholds(
        input_sample_rate: u32,
        redemption_time_ms: u32,
        positive_speech_threshold: f32,
        negative_speech_threshold: f32,
    ) -> Result<Self> {
        // Silero VAD MUST use 16kHz - this is hardcoded requirement
        const VAD_SAMPLE_RATE: u32 = 16000;

        // Use STRICT settings to prevent silence from reaching Whisper
        let mut config = VadConfig::default();
        config.sample_rate = VAD_SAMPLE_RATE as usize;

        // CONTINUOUS SPEECH FIX: Tuned for capturing complete 5+ second utterances
        // Previous: 0.55/0.40 with 400ms redemption was fragmenting speech into 40ms segments
        // New: More lenient thresholds + longer redemption for continuous speech
        config.positive_speech_threshold = positive_speech_threshold;
        config.negative_speech_threshold = negative_speech_threshold;

        // CRITICAL FIX: Removed redemption_time capping to support long continuous speech
        // Previous: capped at 400ms, causing VAD to fragment 5-second speech into 40ms segments
        // New: Use full redemption_time from pipeline (2000ms) to bridge natural pauses
        config.redemption_time = Duration::from_millis(redemption_time_ms as u64);
        let pre_pad_ms = (redemption_time_ms as u64 / 2).max(100).min(300);
        config.pre_speech_pad = Duration::from_millis(pre_pad_ms);

        // CRITICAL SILERO PANIC PREVENTION:
        // In silero-rs, speech_end_with_pad_ms is computed as:
        //   speech_end_ms + post_speech_pad
        // Since speech_end_ms = (processed_samples - silent_samples), and speech end is
        // triggered when silent_samples >= redemption_time, if post_speech_pad > redemption_time,
        // speech_end_with_pad points beyond total processed audio into the future!
        // silero-rs slices &session_audio[speech_start_idx..speech_end_idx] without bounds checking,
        // causing a panic: "range end index ... out of range for slice of length ...".
        // To strictly prevent this, post_speech_pad MUST be less than redemption_time.
        let post_pad_ms = (redemption_time_ms as u64 / 2)
            .max(50)
            .min(250)
            .min(redemption_time_ms.saturating_sub(60) as u64);
        config.post_speech_pad = Duration::from_millis(post_pad_ms);

        // CRITICAL FIX: Increased min_speech_time to prevent tiny 40ms fragments
        // Previous: 100ms allowed too-short segments that Whisper rejects
        // New: 250ms ensures segments are substantial enough for Whisper (>100ms requirement)
        config.min_speech_time = Duration::from_millis(250);  // Prevent tiny fragments

        debug!("Creating VAD session with: sample_rate={}Hz, redemption={}ms, thresholds={:.2}/{:.2}, min_speech={}ms, input_rate={}Hz",
               VAD_SAMPLE_RATE, redemption_time_ms, positive_speech_threshold,
               negative_speech_threshold, 250, input_sample_rate);

        crate::onnx_runtime::ensure_available()?;
        let session = VadSession::new(config)
            .map_err(|e| anyhow!("Failed to create VAD session: {:?}", e))?;

        // VAD uses 30ms chunks at 16kHz (480 samples)
        let vad_chunk_size = (VAD_SAMPLE_RATE as f32 * 0.03) as usize; // 480 samples

        // Cap continuous speech to prevent unbounded buffers, memory bloat, and speaker merging:
        // <= 400ms redemption (real-time streaming): cap at 3.5s (56,000 samples at 16kHz)
        // > 400ms redemption (standard mode): cap at 6.0s (96,000 samples at 16kHz)
        let max_speech_samples = if redemption_time_ms <= 400 {
            56_000
        } else {
            96_000
        };

        info!("VAD processor created: input={}Hz, vad={}Hz, chunk_size={} samples, max_speech={:.1}s",
              input_sample_rate, VAD_SAMPLE_RATE, vad_chunk_size, max_speech_samples as f32 / 16000.0);

        Ok(Self {
            session,
            config,
            chunk_size: vad_chunk_size,
            sample_rate: input_sample_rate, // Store input rate for resampling ratio in resample_to_16k()
            buffer: Vec::with_capacity(vad_chunk_size * 2),
            speech_segments: VecDeque::new(),
            current_speech: Vec::new(),
            in_speech: false,
            processed_samples: 0,
            session_start_sample: 0,
            speech_start_sample: 0,
            // Initialize state tracking
            last_logged_state: false,
            max_speech_samples,
        })
    }

    /// Process incoming audio samples and return any complete speech segments
    /// Handles resampling from input sample rate to 16kHz for VAD processing
    pub fn process_audio(&mut self, samples: &[f32]) -> Result<Vec<SpeechSegment>> {
        // Resample to 16kHz if needed
        let resampled_audio = if self.sample_rate == 16000 {
            samples.to_vec()
        } else {
            self.resample_to_16k(samples)?
        };

        self.buffer.extend_from_slice(&resampled_audio);
        let mut completed_segments = Vec::new();

        // Process complete 30ms chunks (480 samples at 16kHz)
        while self.buffer.len() >= self.chunk_size {
            let chunk: Vec<f32> = self.buffer.drain(..self.chunk_size).collect();
            self.process_chunk(&chunk)?;

            // Extract any completed speech segments
            while let Some(segment) = self.speech_segments.pop_front() {
                completed_segments.push(segment);
            }
        }

        Ok(completed_segments)
    }

    /// Improved resampling from input sample rate to 16kHz with anti-aliasing
    /// Uses linear interpolation and basic low-pass filtering for better quality
    fn resample_to_16k(&self, samples: &[f32]) -> Result<Vec<f32>> {
        if self.sample_rate == 16000 {
            return Ok(samples.to_vec());
        }

        // Calculate downsampling ratio
        let ratio = self.sample_rate as f64 / 16000.0;
        let output_len = (samples.len() as f64 / ratio) as usize;
        let mut resampled = Vec::with_capacity(output_len);

        // Apply simple low-pass filter before downsampling to reduce aliasing
        let cutoff_freq = 0.4; // Normalized frequency (0.4 * Nyquist)
        let mut filtered_samples = Vec::with_capacity(samples.len());
        
        // Simple moving average filter (basic low-pass)
        let filter_size = (self.sample_rate as f64 / (cutoff_freq * self.sample_rate as f64)) as usize;
        let filter_size = std::cmp::max(1, std::cmp::min(filter_size, 5)); // Limit filter size
        
        for i in 0..samples.len() {
            let start = if i >= filter_size { i - filter_size } else { 0 };
            let end = std::cmp::min(i + filter_size + 1, samples.len());
            let sum: f32 = samples[start..end].iter().sum();
            filtered_samples.push(sum / (end - start) as f32);
        }

        // Linear interpolation downsampling
        for i in 0..output_len {
            let source_pos = i as f64 * ratio;
            let source_index = source_pos as usize;
            let fraction = source_pos - source_index as f64;
            
            if source_index + 1 < filtered_samples.len() {
                // Linear interpolation
                let sample1 = filtered_samples[source_index];
                let sample2 = filtered_samples[source_index + 1];
                let interpolated = sample1 + (sample2 - sample1) * fraction as f32;
                resampled.push(interpolated);
            } else if source_index < filtered_samples.len() {
                resampled.push(filtered_samples[source_index]);
            }
        }

        debug!("Resampled from {} samples ({}Hz) to {} samples (16kHz) with anti-aliasing",
               samples.len(), self.sample_rate, resampled.len());

        Ok(resampled)
    }

    /// Flush any remaining audio and return final speech segments
    pub fn flush(&mut self) -> Result<Vec<SpeechSegment>> {
        debug!("VAD flush: in_speech={}, current_speech_len={}, buffer_len={}, speech_segments_queued={}",
              self.in_speech, self.current_speech.len(), self.buffer.len(), self.speech_segments.len());

        let mut completed_segments = Vec::new();

        // Process any remaining buffered audio
        if !self.buffer.is_empty() {
            let remaining = self.buffer.clone();
            self.buffer.clear();

            // Pad to chunk size if needed
            let mut padded_chunk = remaining;
            if padded_chunk.len() < self.chunk_size {
                padded_chunk.resize(self.chunk_size, 0.0);
            }

            self.process_chunk(&padded_chunk)?;
        }

        // Force end any ongoing speech
        if self.in_speech && !self.current_speech.is_empty() {
            let sum_sq: f32 = self.current_speech.iter().map(|&x| x * x).sum();
            let rms = (sum_sq / self.current_speech.len() as f32).sqrt();
            let peak = self.current_speech.iter().fold(0.0f32, |m, &x| m.max(x.abs()));

            if rms >= 0.005 || peak >= 0.01 {
                let start_ms = (self.speech_start_sample as f64 / 16000.0) * 1000.0;
                let end_ms = (self.processed_samples as f64 / 16000.0) * 1000.0;

                debug!("VAD flush: Force-ending speech - start={}ms, end={}ms, duration={}ms, samples={} (rms={:.5}, peak={:.5})",
                      start_ms, end_ms, end_ms - start_ms, self.current_speech.len(), rms, peak);

                let segment = SpeechSegment {
                    samples: self.current_speech.clone(),
                    start_timestamp_ms: start_ms,
                    end_timestamp_ms: end_ms,
                    confidence: 0.8, // Estimated confidence for forced end
                };

                self.speech_segments.push_back(segment);
            } else {
                debug!("VAD flush: Dropping silent ongoing speech (rms={:.5}, peak={:.5})", rms, peak);
            }
            self.current_speech.clear();
            self.in_speech = false;
        }

        // Extract all remaining segments
        while let Some(segment) = self.speech_segments.pop_front() {
            completed_segments.push(segment);
        }

        Ok(completed_segments)
    }

    fn process_chunk(&mut self, chunk: &[f32]) -> Result<()> {
        let transitions_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.session.process(chunk)
        }));

        let transitions = match transitions_result {
            Ok(Ok(t)) => t,
            Ok(Err(e)) => return Err(anyhow!("VAD processing failed: {}", e)),
            Err(panic_err) => {
                let panic_msg = if let Some(s) = panic_err.downcast_ref::<&str>() {
                    s.to_string()
                } else if let Some(s) = panic_err.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "unknown panic".to_string()
                };
                error!("VAD: Silero session panicked: {}. Recreating session safely to prevent pipeline crash.", panic_msg);
                if let Ok(new_session) = VadSession::new(self.config) {
                    self.session = new_session;
                    self.session_start_sample = self.processed_samples;
                } else {
                    self.session.reset();
                }
                Vec::new()
            }
        };

        // Log transitions for debugging
        if !transitions.is_empty() {
            debug!("VAD transitions at sample {}: {} transitions", self.processed_samples, transitions.len());
        }

        // Handle VAD transitions
        for transition in transitions {
            match transition {
                VadTransition::SpeechStart { timestamp_ms } => {
                    // Only initialize start if not already in continuous speech (avoids wiping buffer after a split)
                    if !self.in_speech {
                        if !self.last_logged_state {
                            debug!("VAD: Speech started at {}ms", timestamp_ms);
                            self.last_logged_state = true;
                        }
                        self.in_speech = true;
                        // Use 16000 (VAD processing rate) since processed_samples counts 16kHz samples
                        self.speech_start_sample =
                            self.session_start_sample + (timestamp_ms * 16000 / 1000);
                        self.current_speech.clear();
                    }
                }
                VadTransition::SpeechEnd { start_timestamp_ms: _, end_timestamp_ms: _, samples } => {
                    self.in_speech = false;
                    if self.last_logged_state {
                        debug!("VAD: Speech ended at sample {}", self.processed_samples);
                        self.last_logged_state = false;
                    }

                    // Use accumulated speech samples if present, otherwise fallback to transition samples
                    let speech_samples = if !self.current_speech.is_empty() {
                        std::mem::take(&mut self.current_speech)
                    } else {
                        samples
                    };

                    if !speech_samples.is_empty() {
                        let sum_sq: f32 = speech_samples.iter().map(|&x| x * x).sum();
                        let rms = (sum_sq / speech_samples.len() as f32).sqrt();
                        let peak = speech_samples.iter().fold(0.0f32, |m, &x| m.max(x.abs()));

                        if rms >= 0.005 || peak >= 0.01 {
                            let start_ms = (self.speech_start_sample as f64 / 16000.0) * 1000.0;
                            let duration_ms = (speech_samples.len() as f64 / 16000.0) * 1000.0;
                            let end_ms = start_ms + duration_ms;

                            info!("VAD: Completed speech segment: {:.1}ms duration, {} samples (rms={:.5}, peak={:.5})",
                                  duration_ms, speech_samples.len(), rms, peak);

                            self.speech_segments.push_back(SpeechSegment {
                                samples: speech_samples,
                                start_timestamp_ms: start_ms,
                                end_timestamp_ms: end_ms,
                                confidence: 0.9, // VAD confidence
                            });
                        } else {
                            debug!("VAD: Dropping silent segment at SpeechEnd (rms={:.5}, peak={:.5})", rms, peak);
                        }
                    }

                    self.current_speech.clear();

                    // Recreate session so internal session_audio memory does not grow unbounded
                    match VadSession::new(self.config) {
                        Ok(session) => {
                            self.session = session;
                            self.session_start_sample = self.processed_samples;
                        }
                        Err(_e) => {
                            self.session.reset();
                        }
                    }
                }
            }
        }

        // Accumulate speech if we're currently in a speech state
        if self.in_speech {
            self.current_speech.extend_from_slice(chunk);

            // Cap continuous speech to max_speech_samples (e.g. 3.5s in real-time mode, 6.0s in standard mode)
            // Splitting at the quietest 50ms window avoids mid-phoneme cuts, prevents memory issues,
            // and lets online diarization cleanly separate rapid consecutive speakers.
            if self.max_speech_samples > 0 && self.current_speech.len() >= self.max_speech_samples {
                let cut_point = find_split_point(&self.current_speech, 16000, 800)
                    .max(800)
                    .min(self.current_speech.len());

                if cut_point > 0 {
                    let segment_samples: Vec<f32> = self.current_speech.drain(..cut_point).collect();
                    let sum_sq: f32 = segment_samples.iter().map(|&x| x * x).sum();
                    let rms = (sum_sq / segment_samples.len() as f32).sqrt();
                    let peak = segment_samples.iter().fold(0.0f32, |m, &x| m.max(x.abs()));

                    if rms < 0.005 && peak < 0.01 {
                        debug!("VAD: Dropping silent continuous segment (rms: {:.6}, peak: {:.6}), resetting in_speech", rms, peak);
                        self.current_speech.clear();
                        self.in_speech = false;
                        self.last_logged_state = false;
                        if let Ok(new_session) = VadSession::new(self.config) {
                            self.session = new_session;
                            self.session_start_sample = self.processed_samples;
                        }
                    } else {
                        let start_ms = (self.speech_start_sample as f64 / 16000.0) * 1000.0;
                        let duration_ms = (segment_samples.len() as f64 / 16000.0) * 1000.0;
                        let end_ms = start_ms + duration_ms;

                        info!("VAD: Continuous speech reached max duration ({:.1}s) - streaming segment: {:.1}ms duration, {} samples (rms={:.5}, peak={:.5})",
                              duration_ms / 1000.0, duration_ms, segment_samples.len(), rms, peak);

                        self.speech_segments.push_back(SpeechSegment {
                            samples: segment_samples,
                            start_timestamp_ms: start_ms,
                            end_timestamp_ms: end_ms,
                            confidence: 0.9,
                        });

                        self.speech_start_sample += cut_point;
                    }
                }
            }
        }

        self.processed_samples += chunk.len();
        Ok(())
    }
}

/// Legacy function for backward compatibility - now uses the optimized approach
pub fn extract_speech_16k(samples_mono_16k: &[f32]) -> Result<Vec<f32>> {
    let mut processor = ContinuousVadProcessor::new(16000, 400)?;

    // Process all audio
    let mut all_segments = processor.process_audio(samples_mono_16k)?;
    let final_segments = processor.flush()?;
    all_segments.extend(final_segments);

    // Concatenate all speech segments
    let mut result = Vec::new();
    let num_segments = all_segments.len();
    for segment in &all_segments {
        result.extend_from_slice(&segment.samples);
    }

    // Apply balanced energy filtering for very short segments
    if result.len() < 1600 { // Less than 100ms at 16kHz
        let input_energy: f32 = samples_mono_16k.iter().map(|&x| x * x).sum::<f32>() / samples_mono_16k.len() as f32;
        let rms = input_energy.sqrt();
        let peak = samples_mono_16k.iter().map(|&x| x.abs()).fold(0.0f32, f32::max);

        // BALANCED FIX: Lowered thresholds to preserve quiet speech while still filtering silence
        // Previous aggressive values (0.08/0.15) were discarding valid quiet speech
        // New values (0.03/0.08) are more balanced - catch quiet speech, reject pure silence
        if rms < 0.2 || peak < 0.20 {
            info!("-----VAD detected silence/noise (RMS: {:.6}, Peak: {:.6}), skipping to prevent hallucinations-----", rms, peak);
            return Ok(Vec::new());
        } else {
            info!("VAD detected speech with sufficient energy (RMS: {:.6}, Peak: {:.6})", rms, peak);
            return Ok(samples_mono_16k.to_vec());
        }
    }

    debug!("VAD: Processed {} samples, extracted {} speech samples from {} segments",
           samples_mono_16k.len(), result.len(), num_segments);

    Ok(result)
}

/// Simple convenience function to get speech chunks from audio
/// Uses the optimized ContinuousVadProcessor with configurable redemption time
pub fn get_speech_chunks(samples_mono_16k: &[f32], redemption_time_ms: u32) -> Result<Vec<SpeechSegment>> {
    get_speech_chunks_with_progress(samples_mono_16k, redemption_time_ms, |_, _| true)
}

/// Get speech chunks with progress callback and cancellation support
/// The callback receives (progress_percent, segments_found) and returns false to cancel
pub fn get_speech_chunks_with_progress<F>(
    samples_mono_16k: &[f32],
    redemption_time_ms: u32,
    progress_callback: F,
) -> Result<Vec<SpeechSegment>>
where
    F: FnMut(u32, usize) -> bool,
{
    get_speech_chunks_with_thresholds_and_progress(
        samples_mono_16k,
        redemption_time_ms,
        0.50,
        0.35,
        progress_callback,
    )
}

pub fn get_speech_chunks_with_thresholds_and_progress<F>(
    samples_mono_16k: &[f32],
    redemption_time_ms: u32,
    positive_speech_threshold: f32,
    negative_speech_threshold: f32,
    mut progress_callback: F,
) -> Result<Vec<SpeechSegment>>
where
    F: FnMut(u32, usize) -> bool,
{
    let mut processor = ContinuousVadProcessor::new_with_thresholds(
        16000,
        redemption_time_ms,
        positive_speech_threshold,
        negative_speech_threshold,
    )?;

    let total_samples = samples_mono_16k.len();

    // For large files (>1 minute at 16kHz = 960,000 samples), process in chunks with progress logging
    const LARGE_FILE_THRESHOLD: usize = 960_000;
    const CHUNK_SIZE: usize = 160_000; // 10 seconds at 16kHz

    let mut all_segments = Vec::new();

    if total_samples > LARGE_FILE_THRESHOLD {
        info!("VAD: Processing large file ({} samples = {:.1}s), will log progress...",
              total_samples, total_samples as f64 / 16000.0);

        let mut processed = 0;
        let mut last_progress = 0u32;
        let mut chunk_count = 0;
        let total_chunks = (total_samples + CHUNK_SIZE - 1) / CHUNK_SIZE;

        for chunk in samples_mono_16k.chunks(CHUNK_SIZE) {
            chunk_count += 1;

            let start_time = std::time::Instant::now();
            let segments = processor.process_audio(chunk)?;
            let elapsed = start_time.elapsed();

            // Debug log for chunk processing details
            debug!("VAD: Chunk {}/{} processed in {:?}, found {} segments",
                  chunk_count, total_chunks, elapsed, segments.len());

            // Warn if chunk processing took too long (>1 second)
            if elapsed.as_secs() > 1 {
                warn!("VAD: Chunk {} took {:?} - possible performance issue", chunk_count, elapsed);
            }

            all_segments.extend(segments);

            processed += chunk.len();
            let progress = ((processed * 100) / total_samples) as u32;

            // Call progress callback every 5%
            if progress >= last_progress + 5 {
                debug!("VAD: Progress {}% ({} segments found so far)", progress, all_segments.len());

                // Check for cancellation
                if !progress_callback(progress, all_segments.len()) {
                    info!("VAD: Cancelled by callback at {}%", progress);
                    return Err(anyhow!("VAD processing cancelled"));
                }

                last_progress = progress;
            }
        }

        let final_segments = processor.flush()?;
        all_segments.extend(final_segments);

        info!("VAD: Complete! Found {} speech segments", all_segments.len());
    } else {
        // Small file - process all at once
        all_segments = processor.process_audio(samples_mono_16k)?;
        let final_segments = processor.flush()?;
        all_segments.extend(final_segments);
        if !progress_callback(100, all_segments.len()) {
            return Err(anyhow!("VAD processing cancelled"));
        }
    }

    Ok(all_segments)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Generate synthetic speech-like audio with alternating speech/silence
    fn generate_test_audio_with_speech(duration_seconds: f32, sample_rate: u32) -> Vec<f32> {
        let total_samples = (duration_seconds * sample_rate as f32) as usize;
        let mut samples = vec![0.0f32; total_samples];

        // Create speech-like patterns: bursts of sine waves with varying amplitude
        // Speech every 10 seconds for 5 seconds
        let speech_interval = 10.0; // seconds between speech starts
        let speech_duration = 5.0;  // seconds of speech

        for i in 0..total_samples {
            let time = i as f32 / sample_rate as f32;
            let cycle_time = time % speech_interval;

            // Speech occurs in the first `speech_duration` seconds of each cycle
            if cycle_time < speech_duration {
                // Generate speech-like signal: multiple frequencies with amplitude modulation
                let freq1 = 200.0 + (time * 50.0).sin() * 100.0; // Varying fundamental
                let freq2 = freq1 * 2.0; // Harmonic
                let freq3 = freq1 * 3.0; // Another harmonic

                let amplitude = 0.3 + 0.1 * (time * 5.0).sin(); // Amplitude modulation
                samples[i] = amplitude * (
                    0.5 * (2.0 * std::f32::consts::PI * freq1 * time).sin() +
                    0.3 * (2.0 * std::f32::consts::PI * freq2 * time).sin() +
                    0.2 * (2.0 * std::f32::consts::PI * freq3 * time).sin()
                );
            }
            // else: silence (already 0.0)
        }

        samples
    }

    #[test]
    fn test_vad_chunked_vs_single_processing() {
        // Generate 60 seconds of audio with speech patterns at 16kHz
        let audio = generate_test_audio_with_speech(60.0, 16000);
        println!("Generated {} samples ({:.1}s)", audio.len(), audio.len() as f32 / 16000.0);

        // Process all at once (like small files)
        let segments_single = get_speech_chunks(&audio, 2000).expect("Single processing failed");
        println!("Single processing found {} segments", segments_single.len());

        // Process in chunks (like large files)
        let segments_chunked = get_speech_chunks_with_progress(&audio, 2000, |progress, segments| {
            println!("Chunked progress: {}%, {} segments", progress, segments);
            true // Don't cancel
        }).expect("Chunked processing failed");
        println!("Chunked processing found {} segments", segments_chunked.len());

        // Both should find the same number of segments (approximately)
        // Allow some variance due to chunk boundary effects
        let diff = (segments_single.len() as i32 - segments_chunked.len() as i32).abs();
        assert!(diff <= 1,
            "Chunked and single processing found different segment counts: {} vs {} (diff: {})",
            segments_single.len(), segments_chunked.len(), diff);
    }

    #[test]
    fn test_vad_large_file_progress() {
        // Generate 120 seconds (2 minutes) of audio - triggers large file threshold
        let audio = generate_test_audio_with_speech(120.0, 16000);
        let total_samples = audio.len();
        println!("Generated {} samples ({:.1}s)", total_samples, total_samples as f32 / 16000.0);

        // This should trigger the large file path (>960,000 samples)
        assert!(total_samples > 960_000, "Audio should be large enough to trigger chunked processing");

        let mut progress_updates = Vec::new();
        let segments = get_speech_chunks_with_progress(&audio, 2000, |progress, segments| {
            progress_updates.push((progress, segments));
            true // Don't cancel
        }).expect("Processing failed");

        println!("Found {} segments with {} progress updates", segments.len(), progress_updates.len());

        // The synthetic signal is not real speech, so Silero may merge it into
        // one long segment. This test is specifically for the large-file path:
        // it must still emit speech and report monotonic progress through 100%.
        assert!(!segments.is_empty(), "Expected at least one speech segment");
        assert!(
            segments.iter().all(|segment| !segment.samples.is_empty()
                && segment.end_timestamp_ms > segment.start_timestamp_ms),
            "Expected all speech segments to contain audio with positive duration"
        );

        // Should have received progress updates
        assert!(!progress_updates.is_empty(), "Expected progress updates for large file");
        assert_eq!(
            progress_updates.last().map(|(progress, _)| *progress),
            Some(100),
            "Expected progress to reach 100%"
        );
        assert!(
            progress_updates
                .windows(2)
                .all(|pair| pair[0].0 < pair[1].0),
            "Expected progress updates to increase monotonically: {:?}",
            progress_updates
        );
    }

    #[test]
    fn test_vad_cancellation() {
        let audio = generate_test_audio_with_speech(120.0, 16000);

        // Cancel at 50%
        let result = get_speech_chunks_with_progress(&audio, 2000, |progress, _| {
            progress < 50 // Cancel when reaching 50%
        });

        // Should return error due to cancellation
        assert!(result.is_err(), "Expected cancellation error");
        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.contains("cancelled"), "Error should mention cancellation: {}", err_msg);
    }

    #[test]
    fn test_vad_continuous_processor_state_across_chunks() {
        // Test that VAD state is correctly maintained across chunk boundaries
        let mut processor = ContinuousVadProcessor::new(16000, 2000).expect("Failed to create processor");

        // Generate audio with a speech segment that spans a chunk boundary
        let chunk_size = 160_000; // 10 seconds
        let audio = generate_test_audio_with_speech(30.0, 16000); // 30 seconds

        // Process in 10-second chunks
        let mut all_segments = Vec::new();
        for (i, chunk) in audio.chunks(chunk_size).enumerate() {
            let segments = processor.process_audio(chunk).expect("Processing failed");
            println!("Chunk {}: processed {} samples, found {} segments", i, chunk.len(), segments.len());
            all_segments.extend(segments);
        }

        // Flush remaining
        let final_segments = processor.flush().expect("Flush failed");
        all_segments.extend(final_segments);

        println!("Total segments found: {}", all_segments.len());

        // Should find speech segments
        assert!(all_segments.len() >= 1, "Expected at least 1 speech segment");
    }

    #[test]
    fn test_vad_silence_ticks_finalize_without_followup_speech() {
        let mut processor = ContinuousVadProcessor::new_with_thresholds(
            16000,
            800,
            0.20,
            0.10,
        )
        .expect("Failed to create processor");
        let speech = generate_test_audio_with_speech(2.0, 16000);
        let mut segments = processor.process_audio(&speech).expect("Speech processing failed");

        // Some capture backends stop calling us for exact-zero silence. Feeding
        // real-time silence ticks must close the utterance without waiting for
        // another speaker to produce the next callback.
        for _ in 0..30 {
            segments.extend(
                processor
                    .process_audio(&vec![0.0; 800])
                    .expect("Silence tick failed"),
            );
            if !segments.is_empty() {
                break;
            }
        }

        assert!(!segments.is_empty(), "Expected silence ticks to finalize speech");
        assert!(!processor.has_active_speech());
    }

    #[test]
    fn test_force_finalize_does_not_advance_audio_timeline() {
        let mut processor = ContinuousVadProcessor::new_with_thresholds(
            16000,
            800,
            0.20,
            0.10,
        )
        .expect("Failed to create processor");
        let speech = generate_test_audio_with_speech(2.0, 16000);
        processor.process_audio(&speech).expect("Speech processing failed");
        let segment = processor
            .finalize_active_speech()
            .expect("Expected active utterance");

        assert!(segment.end_timestamp_ms <= 2100.0);
        assert!(segment.end_timestamp_ms > segment.start_timestamp_ms);
        assert!(!processor.has_active_speech());
        assert_eq!(processor.session.session_audio_samples(), 0);
        assert!(
            processor
                .process_audio(&vec![0.0; 16000])
                .expect("post-finalize silence")
                .is_empty(),
            "Reset Silero state must not emit the force-finalized utterance again"
        );
    }

    #[test]
    fn test_inactive_timeline_advance_preserves_callback_gap() {
        let mut processor = ContinuousVadProcessor::new_with_thresholds(
            16000,
            800,
            0.20,
            0.10,
        )
        .expect("Failed to create processor");
        processor
            .process_audio(&vec![0.0; 16000])
            .expect("initial silence");
        processor.advance_inactive_timeline_to(10.0);
        let speech = generate_test_audio_with_speech(2.0, 16000);
        processor.process_audio(&speech).expect("later speech");
        let segment = processor
            .finalize_active_speech()
            .expect("Expected later utterance");

        assert!(segment.start_timestamp_ms >= 10_000.0);
        assert!(segment.end_timestamp_ms > segment.start_timestamp_ms);
    }

    #[test]
    fn test_vad_400ms_vs_2000ms_segmentation() {
        // Demonstrates why 2000ms redemption is needed for batch processing:
        // 400ms creates excessive fragmentation, 2000ms bridges natural pauses.
        //
        // Audio pattern: 60s with 5s speech / 5s silence cycles
        // Natural pauses within speech (sentence gaps) are 500ms-1.5s
        let audio = generate_test_audio_with_speech(60.0, 16000);

        let segments_400 = get_speech_chunks(&audio, 400).expect("400ms processing failed");
        let segments_2000 = get_speech_chunks(&audio, 2000).expect("2000ms processing failed");

        println!(
            "400ms redemption: {} segments, 2000ms redemption: {} segments",
            segments_400.len(),
            segments_2000.len()
        );

        // 2000ms should produce fewer or equal segments (bridges more pauses)
        assert!(
            segments_2000.len() <= segments_400.len(),
            "2000ms redemption ({} segments) should not produce more segments than 400ms ({} segments)",
            segments_2000.len(),
            segments_400.len()
        );

        // Verify segments have reasonable durations with 2000ms
        for (i, seg) in segments_2000.iter().enumerate() {
            let duration_ms = seg.end_timestamp_ms - seg.start_timestamp_ms;
            println!("2000ms segment {}: {:.0}ms duration", i, duration_ms);
            // Each segment should be at least 250ms (min_speech_time)
            assert!(duration_ms >= 200.0, "Segment {} too short: {:.0}ms", i, duration_ms);
        }
    }

    #[test]
    fn test_continuous_speech_max_capping_and_splitting() {
        // Generate 10 seconds of unbroken speech with no pauses
        let speech = generate_test_audio_with_speech(10.0, 16000);
        let mut processor = ContinuousVadProcessor::new_with_thresholds(16000, 350, 0.20, 0.10)
            .expect("Failed to create processor");
        processor.set_max_speech_duration_ms(3500);

        // Feed speech in 1-second chunks (16000 samples)
        let mut all_segments = Vec::new();
        for chunk in speech.chunks(16000) {
            let segments = processor.process_audio(chunk).expect("process_audio failed");
            all_segments.extend(segments);
        }
        let final_segments = processor.flush().expect("flush failed");
        all_segments.extend(final_segments);

        // With 10s of continuous speech capped at 3.5s:
        // Must emit multiple segments (at least 2, typically 3: ~3.5s, ~3.5s, ~3.0s)
        // instead of buffering all 10s into a single massive chunk!
        assert!(
            all_segments.len() >= 2,
            "Expected continuous 10s speech to be split into >= 2 segments, got {}",
            all_segments.len()
        );

        // Verify each segment does not exceed the cap (with small tolerance for windowing)
        for (i, seg) in all_segments.iter().enumerate() {
            let duration_ms = seg.end_timestamp_ms - seg.start_timestamp_ms;
            println!("Segment {}: {:.1}ms duration, {} samples", i, duration_ms, seg.samples.len());
            assert!(
                duration_ms <= 4000.0,
                "Segment {} duration {:.1}ms exceeded max limit of 4000ms",
                i,
                duration_ms
            );
            assert!(
                seg.end_timestamp_ms > seg.start_timestamp_ms,
                "Segment {} timestamps invalid: start={}, end={}",
                i,
                seg.start_timestamp_ms,
                seg.end_timestamp_ms
            );
        }
    }

    #[test]
    fn test_speech_followed_by_pause_realtime_vad() {
        // Test speech followed by a pause under 350ms real-time redemption:
        // Must transition cleanly from speech to pause without out-of-bounds slicing in silero-rs!
        let speech = generate_test_audio_with_speech(2.0, 16000);
        let silence = vec![0.0f32; 16000]; // 1 second of silence
        let mut audio = speech;
        audio.extend(silence);

        let mut processor = ContinuousVadProcessor::new_with_thresholds(16000, 350, 0.20, 0.10)
            .expect("Failed to create processor");

        let mut all_segments = Vec::new();
        for chunk in audio.chunks(1600) {
            let segments = processor.process_audio(chunk).expect("process_audio failed");
            all_segments.extend(segments);
        }
        let final_segments = processor.flush().expect("flush failed");
        all_segments.extend(final_segments);

        assert!(!all_segments.is_empty(), "Expected at least 1 speech segment from speech + pause");
    }
}


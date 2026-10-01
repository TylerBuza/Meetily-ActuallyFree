//! Explicitly opted-in hardware soak. Keeps only counts/digests, never audio files.
use super::*;
use crate::audio::capture::AudioCaptureBackend;
use crate::audio::device_detection::InputDeviceKind;
use crate::audio::devices::DeviceType as EndpointType;
use crate::audio::stream::AudioStream;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::time::{Duration, Instant};

#[derive(Debug)]
struct Samples {
    count: u64,
    nonzero: u64,
    digest: u64,
    peak: f32,
}

impl Default for Samples {
    fn default() -> Self {
        Self { count: 0, nonzero: 0, digest: 0xcbf29ce484222325, peak: 0.0 }
    }
}

impl Samples {
    fn add(&mut self, samples: &[f32]) {
        self.count += samples.len() as u64;
        for sample in samples {
            self.peak = self.peak.max(sample.abs());
            // Alignment may legitimately pad source starts/tails with zeros.
            // Hash every nonzero sample in order to expose loss or duplication.
            if *sample != 0.0 {
                self.nonzero += 1;
                self.digest ^= sample.to_bits() as u64;
                self.digest = self.digest.wrapping_mul(0x100000001b3);
            }
        }
    }
}

fn source_index(source: &DeviceType) -> Option<usize> {
    match source {
        DeviceType::Microphone => Some(0),
        DeviceType::System => Some(1),
        DeviceType::Mixed => None,
    }
}

/// Exercises real CPAL streams, mic worker/DSP, the production dual-VAD mixer,
/// retained-track output, and native stream/pipeline shutdown. ASR is not run.
/// Set exact endpoint names and duration explicitly; a quiet tone is played on
/// the selected output to keep Windows loopback active. No preferences are saved.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "Requires real Windows audio endpoints and explicit MEETILY_HW_* opt-in"]
async fn physical_windows_capture_continuity() -> Result<()> {
    let mic_name = std::env::var("MEETILY_HW_MIC")?;
    let output_name = std::env::var("MEETILY_HW_OUTPUT")?;
    let seconds: u64 = std::env::var("MEETILY_HW_SECONDS")?.parse()?;
    anyhow::ensure!((3..=900).contains(&seconds), "Duration must be 3–900 seconds");
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).try_init();

    let host = cpal::default_host();
    let output = host.output_devices()?.find(|device| device.name().ok().as_deref() == Some(&output_name))
        .ok_or_else(|| anyhow::anyhow!("Requested output endpoint not found"))?;
    let config = output.default_output_config()?;
    anyhow::ensure!(config.sample_format() == cpal::SampleFormat::F32,
        "Hardware test currently needs an f32 output endpoint");
    let sample_rate = config.sample_rate().0 as f64;
    let channels = config.channels() as usize;
    let mut position = 0_u64;
    let tone_errors = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let errors = tone_errors.clone();
    let tone = output.build_output_stream(
        &config.into(),
        move |buffer: &mut [f32], _: &cpal::OutputCallbackInfo| {
            for frame in buffer.chunks_mut(channels) {
                let t = position as f64 / sample_rate;
                // Quiet, deterministic signal; this is not a speech fixture.
                let sample = (0.005 * (std::f64::consts::TAU * 437.0 * t).sin()) as f32;
                frame.fill(sample);
                position += 1;
            }
        },
        move |_| { errors.fetch_add(1, std::sync::atomic::Ordering::Relaxed); },
        None,
    )?;

    let state = RecordingState::new();
    let capture_errors = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let errors = capture_errors.clone();
    state.set_error_callback(move |_| { errors.fetch_add(1, std::sync::atomic::Ordering::Relaxed); });
    let (capture_tx, mut capture_rx) = mpsc::unbounded_channel::<AudioChunk>();
    let (pipeline_tx, pipeline_rx) = mpsc::unbounded_channel();
    let (transcription_tx, mut transcription_rx) = mpsc::unbounded_channel::<AudioChunk>();
    let (tracks_tx, mut tracks_rx) = mpsc::unbounded_channel::<AudioChunk>();
    let mut pipeline = AudioPipeline::new(
        pipeline_rx, transcription_tx, state.clone(), 1000, 48_000,
        mic_name.clone(), InputDeviceKind::Unknown,
        output_name.clone(), InputDeviceKind::Unknown,
    )?;
    pipeline.recording_sender_for_mixed = Some(tracks_tx);
    state.set_audio_sender(capture_tx);
    state.start_recording()?;
    let mic = AudioStream::create_with_backend(
        Arc::new(AudioDevice::new(mic_name.clone(), EndpointType::Input)),
        state.clone(), DeviceType::Microphone, None, AudioCaptureBackend::ScreenCaptureKit,
    ).await?;
    let system = AudioStream::create_with_backend(
        Arc::new(AudioDevice::new(output_name.clone(), EndpointType::Output)),
        state.clone(), DeviceType::System, None, AudioCaptureBackend::ScreenCaptureKit,
    ).await?;
    state.set_capture_active(DeviceType::Microphone, true);
    state.set_capture_active(DeviceType::System, true);
    state.finish_capture_setup();

    let tapped = tokio::spawn(async move {
        let mut samples = [Samples::default(), Samples::default()];
        let mut last_end = [None::<f64>; 2];
        let mut max_capture_gap = [0.0_f64; 2];
        while let Some(chunk) = capture_rx.recv().await {
            if let Some(index) = source_index(&chunk.device_type) {
                let start = chunk.timestamp - chunk.data.len() as f64 / chunk.sample_rate as f64;
                if let Some(last) = last_end[index] {
                    max_capture_gap[index] = max_capture_gap[index].max(start - last);
                }
                last_end[index] = Some(chunk.timestamp);
                let mut expected = chunk.data.clone();
                if index == 1 { apply_system_gain(&mut expected, recording_preferences::system_gain()); }
                samples[index].add(&expected);
            }
            if pipeline_tx.send(chunk).is_err() { break; }
        }
        (samples, max_capture_gap)
    });
    let recorded = tokio::spawn(async move {
        let mut samples = [Samples::default(), Samples::default()];
        while let Some(chunk) = tracks_rx.recv().await {
            if let Some(index) = source_index(&chunk.device_type) { samples[index].add(&chunk.data); }
        }
        samples
    });
    let speech = tokio::spawn(async move {
        let mut segments = [0_u64; 2];
        while let Some(chunk) = transcription_rx.recv().await {
            if let Some(index) = source_index(&chunk.device_type) { segments[index] += 1; }
        }
        segments
    });
    let processing = tokio::spawn(pipeline.run());
    tone.play()?;
    println!("HARDWARE TEST START: mic={mic_name:?}, output={output_name:?}, seconds={seconds}; VAD enabled, ASR disabled, no saved audio");
    tokio::time::sleep(Duration::from_secs(seconds)).await;

    let stop_start = Instant::now();
    // Same stream-drain-before-state-stop ordering as RecordingManager.
    let mic_stop = mic.stop();
    let mic_stop_time = stop_start.elapsed();
    println!("HARDWARE STOP: mic_ms={}", mic_stop_time.as_millis());
    let system_stop = system.stop();
    let native_stop = stop_start.elapsed();
    println!("HARDWARE STOP: system_ms={}", (native_stop - mic_stop_time).as_millis());
    drop(tone);
    println!("HARDWARE STOP: test_tone_ms={}", (stop_start.elapsed() - native_stop).as_millis());
    state.stop_recording();
    let (input, gaps) = tokio::time::timeout(Duration::from_secs(15), tapped).await??;
    tokio::time::timeout(Duration::from_secs(15), processing).await???;
    let output = tokio::time::timeout(Duration::from_secs(15), recorded).await??;
    let segments = tokio::time::timeout(Duration::from_secs(15), speech).await??;
    println!("HARDWARE TEST RESULT: input={input:?}; retained={output:?}; max_capture_gap_seconds={gaps:?}; VAD_segments={segments:?}; native_stop_ms={}; total_stop_ms={}",
        native_stop.as_millis(), stop_start.elapsed().as_millis());
    mic_stop?;
    system_stop?;
    anyhow::ensure!(capture_errors.load(std::sync::atomic::Ordering::Relaxed) == 0, "Capture reported an error");
    anyhow::ensure!(tone_errors.load(std::sync::atomic::Ordering::Relaxed) == 0, "Output reported an error");
    for index in 0..2 {
        anyhow::ensure!(input[index].count >= seconds * 48_000 * 95 / 100, "Source {index} delivered too few samples");
        anyhow::ensure!(input[index].nonzero == output[index].nonzero && input[index].digest == output[index].digest,
            "Source {index} lost, duplicated or changed nonzero samples in the pipeline");
    }
    anyhow::ensure!(input[1].peak > 0.0001, "Generated loopback signal was not captured");
    anyhow::ensure!(output[0].count == output[1].count, "Retained source lengths differ");
    anyhow::ensure!(native_stop < Duration::from_secs(3), "Native stream Stop exceeded its bound");
    Ok(())
}

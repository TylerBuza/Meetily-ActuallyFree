//! Optional Nemotron-3 engine using the shared ONNX Runtime.
//! Speaker identities are meeting-local; only capture provenance identifies You.
use anyhow::{ensure, Result};
use std::path::Path;
use super::{DiarizationResult, DiarizationSegment};
#[path = "sortformer/mod.rs"]
#[allow(dead_code)] // Keep the attributed reference implementation's API intact.
mod sortformer;
pub(crate) use sortformer::SpeakerSegment as StreamingSpeakerSegment;

pub const NEMOTRON_MODEL_FILENAME: &str = "nemotron3_diar_v3.onnx";
pub const NEMOTRON_EXPECTED_BYTES: u64 = 400_506_656;
pub const NEMOTRON_SHA256: &str = "915e4fa23b0192ed9fadeb1cdd26847df986d50c92012d177be28d0343bbe03a";
pub const DEFAULT_NEMOTRON_THRESHOLD: f32 = 0.50;
pub const DEFAULT_MAX_SPEAKERS: usize = 8;

pub struct NemotronDiarizationModel {
    model: sortformer::Sortformer,
}

impl NemotronDiarizationModel {
    pub fn new<P: AsRef<Path>>(path: P, max_speakers: usize, threshold: f32) -> Result<Self> {
        ensure!((1..=8).contains(&max_speakers), "Nemotron supports 1–8 speaker channels");
        ensure!(threshold.is_finite() && (0.1..=0.9).contains(&threshold), "Invalid speech threshold");
        // Also verify manually copied files before passing them to native code.
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut file = std::fs::File::open(path.as_ref())?;
        ensure!(file.metadata()?.len() == NEMOTRON_EXPECTED_BYTES, "Incomplete Nemotron model; download it again");
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 { break; }
            hasher.update(&buffer[..count]);
        }
        ensure!(format!("{:x}", hasher.finalize()) == NEMOTRON_SHA256, "Nemotron model checksum mismatch; download it again");
        let config = sortformer::DiarizationConfig {
            onset: threshold, offset: threshold, ..Default::default()
        };
        // Do not truncate output channels to pretend an exact speaker count.
        // Arrival-ordered channels are model identities, not a clustering limit.
        let model = sortformer::Sortformer::with_config(path, None, config)?;
        Ok(Self { model })
    }

    pub fn reset_streaming_state(&mut self) { self.model.reset_state(); }

    pub fn enable_live_streaming(&mut self) -> Result<()> {
        self.model.set_profile(sortformer::StreamingProfile::low_latency())?;
        Ok(())
    }

    pub fn feed(&mut self, samples: &[f32]) -> Result<Vec<StreamingSpeakerSegment>> {
        ensure!(samples.iter().all(|v| v.is_finite()), "Invalid streaming audio samples");
        Ok(self.model.feed(samples)?)
    }

    pub fn flush(&mut self) -> Result<Vec<StreamingSpeakerSegment>> {
        Ok(self.model.flush()?)
    }

    pub fn diarize(&mut self, samples: &[f32], sample_rate: u32) -> Result<DiarizationResult> {
        ensure!(sample_rate > 0, "Invalid sample rate");
        ensure!(samples.iter().all(|v| v.is_finite()), "Invalid audio samples");
        let audio = if sample_rate == 16000 { samples.to_vec() } else {
            crate::audio::audio_processing::resample_audio(samples, sample_rate, 16000)
        };
        let duration = audio.len() as f32 / 16000.0;
        if audio.is_empty() {
            return Ok(DiarizationResult { segments: vec![], num_speakers: 0, duration, user_speaker: None });
        }
        let predicted = self.model.diarize(audio, 16000, 1)?;
        let mut segments: Vec<_> = predicted.into_iter().map(|s| DiarizationSegment {
            start: s.start as f32 / 16000.0,
            end: s.end as f32 / 16000.0,
            speaker: s.speaker_id,
            overlapped: false,
        }).collect();
        let snapshot = segments.clone();
        for segment in &mut segments {
            segment.overlapped = snapshot.iter().any(|other| other.speaker != segment.speaker
                && other.start < segment.end && other.end > segment.start);
        }
        let num_speakers = segments.iter().map(|s| s.speaker).collect::<std::collections::HashSet<_>>().len();
        Ok(DiarizationResult { segments, num_speakers, duration, user_speaker: None })
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Requires pinned model and speech fixture"]
    fn live_nemotron_streams_continuously_and_resets_between_meetings() {
        let path = std::env::var("MEETILY_NEMOTRON_MODEL").unwrap();
        let wav = std::env::var("MEETILY_NEMOTRON_WAV").unwrap();
        let (audio, rate) = super::super::dsp::read_wav(Path::new(&wav)).unwrap();
        assert_eq!(rate, 16000);
        let mut model = NemotronDiarizationModel::new(path, 8, 0.5).unwrap();
        model.enable_live_streaming().unwrap();
        let started = std::time::Instant::now();
        let mut segments = Vec::new();
        for chunk in audio.chunks(800) { segments.extend(model.feed(chunk).unwrap()); }
        segments.extend(model.flush().unwrap());
        assert!(!segments.is_empty());
        assert!(segments.iter().all(|s| s.start < s.end && s.end <= audio.len() as u64 && s.speaker_id < 8));
        let speakers = segments.iter().map(|s| s.speaker_id).collect::<std::collections::HashSet<_>>();
        assert!(speakers.len() >= 2, "Multispeaker fixture collapsed: {speakers:?}");
        if let Ok(expected) = std::env::var("MEETILY_NEMOTRON_EXPECTED") {
            let turns: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(expected).unwrap()).unwrap();
            let mut voices = std::collections::HashMap::new();
            for turn in turns {
                let name = turn["voice"].as_str().unwrap();
                if name == "overlap" { continue; }
                let start = (turn["start"].as_f64().unwrap() * 16000.0) as u64;
                let end = (turn["end"].as_f64().unwrap() * 16000.0) as u64;
                let mut coverage = [0u64; 8];
                for segment in &segments {
                    coverage[segment.speaker_id] += segment.end.min(end).saturating_sub(segment.start.max(start));
                }
                let (speaker, &duration) = coverage.iter().enumerate().max_by_key(|(_, n)| *n).unwrap();
                assert!(duration > (end - start) / 2, "Insufficient live coverage for {name}");
                if let Some(previous) = voices.insert(name.to_string(), speaker) {
                    assert_eq!(previous, speaker, "Live identity changed for returning speaker {name}");
                }
            }
            assert_eq!(voices.values().collect::<std::collections::HashSet<_>>().len(), voices.len());
        }
        println!("LIVE_NEMOTRON duration={} inference={:?} speakers={}", audio.len() as f64 / 16000.0, started.elapsed(), speakers.len());
        model.reset_streaming_state();
        assert!(model.feed(&vec![0.0; 16000 * 2]).unwrap().is_empty());
        assert!(model.flush().unwrap().is_empty());
    }

    #[test]
    #[ignore = "Requires MEETILY_NEMOTRON_MODEL pointing to the pinned model"]
    fn real_model_silence_and_optional_speech() {
        let path = std::env::var("MEETILY_NEMOTRON_MODEL").expect("Set MEETILY_NEMOTRON_MODEL");
        let mut model = NemotronDiarizationModel::new(path, 8, 0.5).unwrap();
        let silence = model.diarize(&vec![0.0; 16000 * 65], 16000).unwrap();
        assert_eq!(silence.duration, 65.0);
        assert!(silence.segments.is_empty(), "Silence invented speakers: {:?}", silence.segments);
        assert_eq!(silence.num_speakers, 0);
        assert_eq!(silence.user_speaker, None);
        if let Ok(wav) = std::env::var("MEETILY_NEMOTRON_WAV") {
            let (audio, rate) = super::super::dsp::read_wav(Path::new(&wav)).unwrap();
            let started = std::time::Instant::now();
            let result = model.diarize(&audio, rate).unwrap();
            assert!(!result.segments.is_empty(), "Speech produced no speakers");
            assert_eq!(result.user_speaker, None);
            assert!(result.segments.iter().all(|s| s.start >= 0.0 && s.end > s.start && s.end <= result.duration + 0.01));
            if let Ok(expected) = std::env::var("MEETILY_NEMOTRON_EXPECTED") {
                let turns: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(expected).unwrap()).unwrap();
                let mut voices = std::collections::HashMap::new();
                for turn in turns {
                    let name = turn["voice"].as_str().unwrap();
                    let start = turn["start"].as_f64().unwrap() as f32;
                    let end = turn["end"].as_f64().unwrap() as f32;
                    let mut coverage = [0.0f32; 8];
                    for seg in &result.segments {
                        coverage[seg.speaker] += (seg.end.min(end) - seg.start.max(start)).max(0.0);
                    }
                    if name == "overlap" {
                        assert_eq!(coverage.iter().filter(|&&seconds| seconds > (end-start)*0.5).count(),2, "Both overlapping voices must survive");
                    } else {
                        let (speaker, duration) = coverage.iter().enumerate().max_by(|a,b| a.1.total_cmp(b.1)).unwrap();
                        assert!(*duration > (end-start)*0.5, "Missing speech for {name}");
                        if let Some(previous) = voices.insert(name.to_string(),speaker) { assert_eq!(previous,speaker,"Returning speaker changed identity"); }
                    }
                }
                assert_eq!(voices.values().collect::<std::collections::HashSet<_>>().len(),voices.len(),"Distinct voices merged");
                assert_eq!(result.num_speakers, voices.len());
            }
            println!("NEMOTRON_SPEECH_RESULT {:?}; elapsed {:?}", result, started.elapsed());
        }
    }
}

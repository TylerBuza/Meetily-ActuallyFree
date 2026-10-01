//! Bounded waveform peak extraction for the Labs recorded-audio player.
//! FFmpeg streams 8 kHz mono samples into one peak per second; the full audio
//! file is never decoded into application or WebView memory.
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};

const SAMPLE_RATE: usize = 8_000;
const MAX_SECONDS: usize = 24 * 60 * 60;

fn append_peak(samples: &[u8], sample_index: &mut usize, peaks: &mut Vec<f32>) -> Result<(), String> {
    for frame in samples.chunks_exact(4) {
        let value = f32::from_le_bytes(frame.try_into().unwrap());
        let second = *sample_index / SAMPLE_RATE;
        if second >= MAX_SECONDS { return Err("Recording exceeds waveform duration limit".into()); }
        if peaks.len() <= second { peaks.push(0.0); }
        if value.is_finite() { peaks[second] = peaks[second].max(value.abs().min(1.0)); }
        *sample_index += 1;
    }
    Ok(())
}

fn extract_peaks(file: &Path) -> Result<Vec<f32>, String> {
    let ffmpeg = super::ffmpeg::find_ffmpeg_path().ok_or("FFmpeg is unavailable")?;
    let mut command = Command::new(ffmpeg);
    command
        .arg("-v").arg("error")
        .arg("-i").arg(file)
        .args(["-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"])
        .stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
    // A GUI parent otherwise gives FFmpeg its own briefly visible Windows console.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child.stdout.take().ok_or("FFmpeg has no audio output")?;
    let mut reader = BufReader::new(stdout);
    let mut buffer = [0u8; 32_768];
    let mut pending = Vec::with_capacity(buffer.len() + 4);
    let mut peaks = Vec::new();
    let mut sample_index = 0usize;
    let result = (|| -> Result<(), String> {
        loop {
            let count = reader.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 { break; }
            pending.extend_from_slice(&buffer[..count]);
            let aligned = pending.len() & !3;
            append_peak(&pending[..aligned], &mut sample_index, &mut peaks)?;
            pending.drain(..aligned);
        }
        Ok(())
    })();
    if result.is_err() { let _ = child.kill(); }
    let status = child.wait().map_err(|error| error.to_string())?;
    result?;
    if !status.success() { return Err("FFmpeg could not decode meeting audio".into()); }
    Ok(peaks)
}

#[tauri::command]
pub async fn get_waveform_peaks(file_path: String) -> Result<Vec<f32>, String> {
    let file = std::path::PathBuf::from(file_path);
    if !file.is_file() { return Err("Meeting audio is unavailable".into()); }
    static JOBS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let limiter = JOBS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1))).clone();
    let permit = limiter.try_acquire_owned().map_err(|_| "Waveform extraction is already running")?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        extract_peaks(&file)
    })
        .await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn peak_bins_follow_seconds_and_bound_amplitude() {
        let mut index = 0;
        let mut peaks = Vec::new();
        let samples: Vec<u8> = (0..SAMPLE_RATE * 2).flat_map(|sample| {
            let value: f32 = if sample < SAMPLE_RATE { 0.25 } else { -1.5 };
            value.to_le_bytes()
        }).collect();
        append_peak(&samples, &mut index, &mut peaks).unwrap();
        assert_eq!(peaks, vec![0.25, 1.0]);
    }
}

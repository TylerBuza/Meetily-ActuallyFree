//! One-click download of local speaker-diarization models.
//!
//! Supports both:
//! - Pyannote pipeline (segmentation-3.0 + WeSpeaker + VBx) from GitHub release assets
//! - NVIDIA Nemotron-3 model and license, pinned by revision, length and SHA-256.
//!
//! Each file is streamed to a `.part` temporary, verified, then atomically renamed
//! into place — a partial or corrupt download can never be mistaken for a valid model.
//!
//! Progress is reported to the UI via `diarization-download-progress` events.

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri::{AppHandle, Emitter, Runtime};

/// Release that hosts the Pyannote model assets.
const PYANNOTE_RELEASE_BASE: &str =
    "https://github.com/TylerBuza/Meetily-ActuallyFree/releases/download/diarization-models-v1";

/// (filename, expected size in bytes, expected sha256)
const PYANNOTE_ASSETS: [(&str, u64, &str); 3] = [
    (
        "segmentation-3.0-fp16.onnx",
        2_977_738,
        "b0acba8e4cc30e8ec2bd33075ce95f282d66acab86fb155860d8deddbfacd30c",
    ),
    (
        "wespeaker-resnet34-LM.onnx",
        26_544_003,
        "992a5632618f11644608dbfbd28d401cd8480713207dc2db9af1c4cfc2c8652e",
    ),
    (
        "xvec_transform.npz",
        134_376,
        "325f1ce8e48f7e55e9c8aa47e05d2766b7c48c4b25b8de8dd751e7a4cc5fbe8f",
    ),
];

const NEMOTRON_DOWNLOAD_URL: &str =
    "https://huggingface.co/altunenes/parakeet-rs/resolve/4d2a8bc71f5c896ec40faa59732e6716295edaf2/nemotron-3-diarization/nemotron3_diar_v3.onnx";
const NEMOTRON_LICENSE_URL: &str =
    "https://huggingface.co/altunenes/parakeet-rs/resolve/4d2a8bc71f5c896ec40faa59732e6716295edaf2/nemotron-3-diarization/LICENSE";

const NEMOTRON_ASSETS: [(&str, u64, &str, &str); 2] = [
    (
        "Nemotron-LICENSE.txt",
        2660,
        NEMOTRON_LICENSE_URL,
        "14cf93aed5ee7c72516170ecb65fb6d7e54ef19217d328c8b00b78eaf61c8b36",
    ),
    (
        "nemotron3_diar_v3.onnx",
        400_506_656,
        NEMOTRON_DOWNLOAD_URL,
        "915e4fa23b0192ed9fadeb1cdd26847df986d50c92012d177be28d0343bbe03a",
    ),
];

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    /// File currently being handled.
    pub file: String,
    /// 1-based index of that file.
    pub file_index: usize,
    pub file_count: usize,
    /// Bytes fetched for the current file.
    pub downloaded: u64,
    /// Expected size of the current file.
    pub total: u64,
    /// Overall progress across all files, 0–100.
    pub percent: f32,
    /// "downloading" | "verifying" | "skipped" | "done" | "error"
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn emit<R: Runtime>(app: &AppHandle<R>, p: DownloadProgress) {
    let _ = app.emit("diarization-download-progress", p);
}

/// SHA-256 of a file on disk, lowercase hex.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_ipc_future_stays_within_windows_stack_budget() {
        fn future_size<F: std::future::Future>(
            _: impl FnOnce(tauri::AppHandle<tauri::Wry>, Option<String>) -> F,
        ) -> usize {
            std::mem::size_of::<F>()
        }
        // Inspect the actual command future without constructing/running a GUI.
        let size = future_size(super::super::download_diarization_models::<tauri::Wry>);
        assert!(size < 32 * 1024, "Download IPC future is {size} bytes; nested Tauri dispatch can overflow the Windows stack");
        println!("Download IPC future: {size} bytes");
    }

    #[tokio::test]
    async fn checksum_future_is_small_and_hashes_multiple_buffers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.onnx");
        let bytes: Vec<u8> = (0..200_003).map(|i| (i % 251) as u8).collect();
        tokio::fs::write(&path, &bytes).await.unwrap();
        let future = file_sha256(&path);
        // Windows IPC can copy/nest this future several times before spawning it.
        // Prevent the 64 KiB inline buffer that caused _alloca_probe stack overflow.
        assert!(std::mem::size_of_val(&future) < 4096, "Checksum buffer leaked onto async stack");
        assert_eq!(future.await.unwrap(), format!("{:x}", Sha256::digest(&bytes)));
    }
}

async fn file_sha256(path: &Path) -> Result<String> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    // This buffer lives across await points. Inline arrays inflate every parent
    // future and can overflow the Windows IPC thread before the task is spawned.
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).await?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Download Pyannote models.
pub async fn download_pyannote_models<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let dir = super::diarization_user_model_dir();
    tokio::fs::create_dir_all(&dir).await?;

    let total_bytes: u64 = PYANNOTE_ASSETS.iter().map(|(_, sz, _)| *sz).sum();
    let mut completed_bytes: u64 = 0;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()?;

    for (index, (name, expected_size, expected_hash)) in PYANNOTE_ASSETS.iter().enumerate() {
        let dest = dir.join(name);
        let file_index = index + 1;

        if dest.exists() {
            if let Ok(hash) = file_sha256(&dest).await {
                if hash == *expected_hash {
                    completed_bytes += expected_size;
                    log::info!("✅ {} already present and verified", name);
                    emit(
                        app,
                        DownloadProgress {
                            file: name.to_string(),
                            file_index,
                            file_count: PYANNOTE_ASSETS.len(),
                            downloaded: *expected_size,
                            total: *expected_size,
                            percent: (completed_bytes as f32 / total_bytes as f32) * 100.0,
                            status: "skipped".into(),
                            message: Some("Already installed".into()),
                        },
                    );
                    continue;
                }
            }
            log::warn!("{} present but failed verification — re-downloading", name);
            let _ = tokio::fs::remove_file(&dest).await;
        }

        let url = format!("{}/{}", PYANNOTE_RELEASE_BASE, name);
        log::info!("⬇️ Downloading {} …", name);

        download_single_file(app, &client, &url, &dest, name, file_index, PYANNOTE_ASSETS.len(), *expected_size, Some(expected_hash), completed_bytes, total_bytes).await?;
        completed_bytes += expected_size;
    }

    emit(
        app,
        DownloadProgress {
            file: String::new(),
            file_index: PYANNOTE_ASSETS.len(),
            file_count: PYANNOTE_ASSETS.len(),
            downloaded: total_bytes,
            total: total_bytes,
            percent: 100.0,
            status: "done".into(),
            message: Some("All pyannote diarization models installed".into()),
        },
    );

    Ok(())
}

/// Download the pinned NVIDIA Nemotron-3 ONNX export and its model license.
pub async fn download_nemotron_models<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let dir = super::diarization_user_model_dir();
    tokio::fs::create_dir_all(&dir).await?;

    let total_bytes: u64 = NEMOTRON_ASSETS.iter().map(|(_, sz, _, _)| *sz).sum();
    let mut completed_bytes: u64 = 0;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .build()?;

    for (index, (name, expected_size, url, expected_hash)) in NEMOTRON_ASSETS.iter().enumerate() {
        let dest = dir.join(name);
        let file_index = index + 1;

        // Only an exact length and checksum can identify a completed artifact.
        if dest.exists() {
            if let Ok(meta) = tokio::fs::metadata(&dest).await {
                if meta.len() == *expected_size && file_sha256(&dest).await? == *expected_hash {
                    completed_bytes += expected_size;
                    log::info!("✅ {} already present and verified by SHA-256", name);
                    emit(
                        app,
                        DownloadProgress {
                            file: name.to_string(),
                            file_index,
                            file_count: NEMOTRON_ASSETS.len(),
                            downloaded: meta.len(),
                            total: *expected_size,
                            percent: (completed_bytes as f32 / total_bytes as f32) * 100.0,
                            status: "skipped".into(),
                            message: Some("Already installed".into()),
                        },
                    );
                    continue;
                }
            }
            let _ = tokio::fs::remove_file(&dest).await;
        }

        log::info!("⬇️ Downloading {} from {} …", name, url);
        download_single_file(app, &client, url, &dest, name, file_index, NEMOTRON_ASSETS.len(), *expected_size, Some(expected_hash), completed_bytes, total_bytes).await?;
        completed_bytes += expected_size;
    }

    emit(
        app,
        DownloadProgress {
            file: String::new(),
            file_index: NEMOTRON_ASSETS.len(),
            file_count: NEMOTRON_ASSETS.len(),
            downloaded: total_bytes,
            total: total_bytes,
            percent: 100.0,
            status: "done".into(),
            message: Some("Nemotron-3 Diarization model installed successfully".into()),
        },
    );

    Ok(())
}

async fn download_single_file<R: Runtime>(
    app: &AppHandle<R>,
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    name: &str,
    file_index: usize,
    file_count: usize,
    expected_size: u64,
    expected_hash: Option<&str>,
    completed_bytes: u64,
    total_bytes: u64,
) -> Result<()> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| anyhow!("Failed to start download for {}: {}", name, e))?;

    if !response.status().is_success() {
        return Err(anyhow!(
            "Download of {} failed with status {}",
            name,
            response.status()
        ));
    }
    let content_len = response.content_length().unwrap_or(expected_size);

    let part = dest.with_file_name(format!("{name}.part"));
    let mut file = tokio::fs::File::create(&part).await?;
    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| anyhow!("Download of {} interrupted: {}", name, e))?;
        if chunk.len() as u64 > expected_size.saturating_sub(written) {
            return Err(anyhow!("{name} exceeds its published size"));
        }
        if expected_hash.is_some() {
            hasher.update(&chunk);
        }
        {
            use tokio::io::AsyncWriteExt;
            file.write_all(&chunk).await?;
        }
        written += chunk.len() as u64;

        if last_emit.elapsed().as_millis() >= 100 {
            last_emit = std::time::Instant::now();
            let overall = ((completed_bytes + written) as f32 / total_bytes as f32) * 100.0;
            emit(
                app,
                DownloadProgress {
                    file: name.to_string(),
                    file_index,
                    file_count,
                    downloaded: written,
                    total: content_len,
                    percent: overall.min(100.0),
                    status: "downloading".into(),
                    message: None,
                },
            );
        }
    }

    {
        use tokio::io::AsyncWriteExt;
        file.flush().await?;
    }
    drop(file);

    if written != expected_size {
        return Err(anyhow!("{name}: received {written} bytes, expected {expected_size}"));
    }

    if let Some(hash) = expected_hash {
        emit(
            app,
            DownloadProgress {
                file: name.to_string(),
                file_index,
                file_count,
                downloaded: written,
                total: content_len,
                percent: ((completed_bytes + written) as f32 / total_bytes as f32) * 100.0,
                status: "verifying".into(),
                message: None,
            },
        );

        let actual = format!("{:x}", hasher.finalize());
        if actual != hash {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(anyhow!(
                "{} failed integrity check (expected {}, got {})",
                name,
                hash,
                actual
            ));
        }
    }

    tokio::fs::rename(&part, dest).await?;
    log::info!("✅ {} downloaded and verified", name);
    Ok(())
}

/// Download diarization models (delegates according to engine or active).
pub async fn download_models<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let engine = super::get_active_engine();
    if engine.eq_ignore_ascii_case("nemotron") {
        download_nemotron_models(app).await
    } else {
        download_pyannote_models(app).await
    }
}

pub async fn download_models_for_engine<R: Runtime>(app: &AppHandle<R>, engine: &str) -> Result<()> {
    if engine.eq_ignore_ascii_case("nemotron") {
        download_nemotron_models(app).await
    } else {
        download_pyannote_models(app).await
    }
}

/// Total download size in bytes for Pyannote models.
pub fn total_download_bytes() -> u64 {
    PYANNOTE_ASSETS.iter().map(|(_, sz, _)| *sz).sum()
}

/// Total download size in bytes for Nemotron models.
pub fn nemotron_download_bytes() -> u64 {
    NEMOTRON_ASSETS.iter().map(|(_, sz, _, _)| *sz).sum()
}

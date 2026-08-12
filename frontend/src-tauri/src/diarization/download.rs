//! One-click download of the local speaker-diarization models.
//!
//! Models are hosted as release assets on this fork's own GitHub repository,
//! so setup needs no third-party bandwidth and no account/token. Each file is
//! streamed to a `.part` temporary, SHA-256 verified, then atomically renamed
//! into place — a partial or corrupt download can never be mistaken for a
//! valid model.
//!
//! Progress is reported to the UI via `diarization-download-progress` events.

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri::{AppHandle, Emitter, Runtime};

/// Release that hosts the model assets.
const RELEASE_BASE: &str =
    "https://github.com/TylerBuza/Meetily-ActuallyFree/releases/download/diarization-models-v1";

/// (filename, expected size in bytes, expected sha256)
const ASSETS: [(&str, u64, &str); 3] = [
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

#[derive(Clone, Serialize)]
struct DownloadProgress {
    /// File currently being handled.
    file: String,
    /// 1-based index of that file.
    file_index: usize,
    file_count: usize,
    /// Bytes fetched for the current file.
    downloaded: u64,
    /// Expected size of the current file.
    total: u64,
    /// Overall progress across all files, 0–100.
    percent: f32,
    /// "downloading" | "verifying" | "skipped" | "done" | "error"
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

fn emit<R: Runtime>(app: &AppHandle<R>, p: DownloadProgress) {
    let _ = app.emit("diarization-download-progress", p);
}

/// SHA-256 of a file on disk, lowercase hex.
async fn file_sha256(path: &Path) -> Result<String> {
    let bytes = tokio::fs::read(path).await?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

/// Download all missing/invalid diarization model assets.
pub async fn download_models<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    // Always download into the writable user directory (never the read-only
    // bundled resource folder).
    let dir = super::diarization_user_model_dir();
    tokio::fs::create_dir_all(&dir).await?;

    let total_bytes: u64 = ASSETS.iter().map(|(_, sz, _)| *sz).sum();
    let mut completed_bytes: u64 = 0;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()?;

    for (index, (name, expected_size, expected_hash)) in ASSETS.iter().enumerate() {
        let dest = dir.join(name);
        let file_index = index + 1;

        // Already present and valid? Skip.
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
                            file_count: ASSETS.len(),
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

        let url = format!("{}/{}", RELEASE_BASE, name);
        log::info!("⬇️ Downloading {} …", name);

        let response = client
            .get(&url)
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
        let content_len = response.content_length().unwrap_or(*expected_size);

        // Stream to a .part temporary so a crash can't leave a half-written model.
        let part = dir.join(format!("{}.part", name));
        let mut file = tokio::fs::File::create(&part).await?;
        let mut hasher = Sha256::new();
        let mut written: u64 = 0;
        let mut last_emit = std::time::Instant::now();

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| anyhow!("Download of {} interrupted: {}", name, e))?;
            hasher.update(&chunk);
            {
                use tokio::io::AsyncWriteExt;
                file.write_all(&chunk).await?;
            }
            written += chunk.len() as u64;

            // Throttle UI updates to ~10/sec.
            if last_emit.elapsed().as_millis() >= 100 {
                last_emit = std::time::Instant::now();
                let overall = ((completed_bytes + written) as f32 / total_bytes as f32) * 100.0;
                emit(
                    app,
                    DownloadProgress {
                        file: name.to_string(),
                        file_index,
                        file_count: ASSETS.len(),
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

        // Verify before it's allowed to become a real model file.
        emit(
            app,
            DownloadProgress {
                file: name.to_string(),
                file_index,
                file_count: ASSETS.len(),
                downloaded: written,
                total: content_len,
                percent: ((completed_bytes + written) as f32 / total_bytes as f32) * 100.0,
                status: "verifying".into(),
                message: None,
            },
        );

        let actual = format!("{:x}", hasher.finalize());
        if actual != *expected_hash {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(anyhow!(
                "{} failed integrity check (expected {}, got {})",
                name,
                expected_hash,
                actual
            ));
        }

        tokio::fs::rename(&part, &dest).await?;
        completed_bytes += written;
        log::info!("✅ {} downloaded and verified", name);
    }

    emit(
        app,
        DownloadProgress {
            file: String::new(),
            file_index: ASSETS.len(),
            file_count: ASSETS.len(),
            downloaded: total_bytes,
            total: total_bytes,
            percent: 100.0,
            status: "done".into(),
            message: Some("All diarization models installed".into()),
        },
    );

    Ok(())
}

/// Total download size in bytes (for the UI to show before starting).
pub fn total_download_bytes() -> u64 {
    ASSETS.iter().map(|(_, sz, _)| *sz).sum()
}

use anyhow::Result;
use log::info;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{command, AppHandle, Emitter, Runtime};
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;

lazy_static::lazy_static! {
    static ref ACTIVE_DOWNLOADS: Arc<RwLock<HashSet<String>>> = Arc::new(RwLock::new(HashSet::new()));
    static ref CANCEL_FLAGS: Arc<RwLock<std::collections::HashMap<String, Arc<AtomicBool>>>> = Arc::new(RwLock::new(std::collections::HashMap::new()));
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QwenModelInfo {
    pub name: String,
    pub display_name: String,
    pub path: String,
    pub size_mb: u64,
    pub accuracy: String,
    pub speed: String,
    pub status: String,
    pub description: String,
    pub recommended_for: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct QwenDownloadProgress {
    #[serde(rename = "modelName")]
    pub model_name: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub downloaded_mb: f64,
    pub total_mb: f64,
    pub percent: u8,
    pub speed_mbps: f64,
    pub status: String,
}

pub fn qwen_models_dir() -> PathBuf {
    crate::paths::install_data_root().join("models").join("qwen")
}

fn model_file_name(model_name: &str) -> &'static str {
    match model_name {
        "Qwen3-ASR-1.7B" | "qwen3-asr-1.7b" => "qwen3-asr-1.7b.onnx",
        _ => "qwen3-asr-0.6b.onnx",
    }
}

fn model_download_url(model_name: &str) -> &'static str {
    match model_name {
        "Qwen3-ASR-1.7B" | "qwen3-asr-1.7b" => {
            "https://huggingface.co/andrewleech/qwen3-asr-1.7b-onnx/resolve/main/encoder.onnx"
        }
        _ => "https://huggingface.co/andrewleech/qwen3-asr-0.6b-onnx/resolve/main/encoder.onnx",
    }
}

fn model_expected_size(model_name: &str) -> u64 {
    match model_name {
        "Qwen3-ASR-1.7B" | "qwen3-asr-1.7b" => 1270 * 1024 * 1024,
        _ => 745 * 1024 * 1024,
    }
}

#[command]
pub async fn qwen_get_available_models() -> Result<Vec<QwenModelInfo>, String> {
    let dir = qwen_models_dir();
    let active = ACTIVE_DOWNLOADS.read().await;

    let models_def = [
        (
            "Qwen3-ASR-0.6B",
            "Qwen3-ASR 0.6B",
            745u64,
            "High (0.6B params)",
            "Ultra Fast (2000x RT)",
            "Optimized for real-time live recording & low latency. Up to 2000x real-time throughput across 52 languages.",
            "live",
        ),
        (
            "Qwen3-ASR-1.7B",
            "Qwen3-ASR 1.7B",
            1270u64,
            "State-of-the-Art (1.7B params)",
            "Fast (600x RT)",
            "State-of-the-art multilingual accuracy for noisy speech, strong accents, multi-speaker dialogue, and 22 dialects.",
            "post-call",
        ),
    ];

    let mut result = Vec::new();

    for (name, display, size, acc, spd, desc, rec) in models_def {
        let file = dir.join(model_file_name(name));
        let is_downloading = active.contains(name);

        let status = if is_downloading {
            "Downloading".to_string()
        } else if file.exists() {
            "Available".to_string()
        } else {
            "Missing".to_string()
        };

        result.push(QwenModelInfo {
            name: name.to_string(),
            display_name: display.to_string(),
            path: file.to_string_lossy().to_string(),
            size_mb: size,
            accuracy: acc.to_string(),
            speed: spd.to_string(),
            status,
            description: desc.to_string(),
            recommended_for: rec.to_string(),
        });
    }

    Ok(result)
}

#[command]
pub async fn qwen_download_model<R: Runtime>(
    app_handle: AppHandle<R>,
    model_name: String,
) -> Result<(), String> {
    info!("⬇️ Starting download for Qwen3-ASR model: {}", model_name);

    {
        let mut active = ACTIVE_DOWNLOADS.write().await;
        if active.contains(&model_name) {
            return Err(format!("Download already in progress for {}", model_name));
        }
        active.insert(model_name.clone());
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut cancels = CANCEL_FLAGS.write().await;
        cancels.insert(model_name.clone(), cancel_flag.clone());
    }

    let dir = qwen_models_dir();
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        ACTIVE_DOWNLOADS.write().await.remove(&model_name);
        return Err(format!("Failed to create Qwen models directory: {}", e));
    }

    let target_file = dir.join(model_file_name(&model_name));
    let temp_file = dir.join(format!("{}.download", model_file_name(&model_name)));
    let url = model_download_url(&model_name);
    let expected_size = model_expected_size(&model_name);

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            ACTIVE_DOWNLOADS.write().await.remove(&model_name);
            return Err(format!("Failed to build HTTP client: {}", e));
        }
    };

    let response = match client.get(url).send().await {
        Ok(r) => r,
        Err(e) => {
            ACTIVE_DOWNLOADS.write().await.remove(&model_name);
            return Err(format!("Failed to connect to model server: {}", e));
        }
    };

    if !response.status().is_success() {
        ACTIVE_DOWNLOADS.write().await.remove(&model_name);
        return Err(format!("Server returned HTTP {}", response.status()));
    }

    let total_bytes = response.content_length().unwrap_or(expected_size);

    let mut file = match tokio::fs::File::create(&temp_file).await {
        Ok(f) => f,
        Err(e) => {
            ACTIVE_DOWNLOADS.write().await.remove(&model_name);
            return Err(format!("Failed to create destination file: {}", e));
        }
    };

    let mut stream = response.bytes_stream();
    let mut downloaded_bytes = 0u64;
    let start_time = std::time::Instant::now();
    let mut last_emit = std::time::Instant::now();

    use futures_util::StreamExt;

    while let Some(chunk_res) = stream.next().await {
        if cancel_flag.load(Ordering::Relaxed) {
            let _ = tokio::fs::remove_file(&temp_file).await;
            ACTIVE_DOWNLOADS.write().await.remove(&model_name);
            let _ = app_handle.emit(
                "qwen-model-download-progress",
                QwenDownloadProgress {
                    model_name: model_name.clone(),
                    downloaded_bytes,
                    total_bytes,
                    downloaded_mb: downloaded_bytes as f64 / (1024.0 * 1024.0),
                    total_mb: total_bytes as f64 / (1024.0 * 1024.0),
                    percent: ((downloaded_bytes as f64 / total_bytes as f64) * 100.0) as u8,
                    speed_mbps: 0.0,
                    status: "cancelled".to_string(),
                },
            );
            return Ok(());
        }

        let chunk = match chunk_res {
            Ok(c) => c,
            Err(e) => {
                let _ = tokio::fs::remove_file(&temp_file).await;
                ACTIVE_DOWNLOADS.write().await.remove(&model_name);
                return Err(format!("Network error while streaming model: {}", e));
            }
        };

        if let Err(e) = file.write_all(&chunk).await {
            let _ = tokio::fs::remove_file(&temp_file).await;
            ACTIVE_DOWNLOADS.write().await.remove(&model_name);
            return Err(format!("Disk write error: {}", e));
        }

        downloaded_bytes += chunk.len() as u64;

        if last_emit.elapsed() >= std::time::Duration::from_millis(200) || downloaded_bytes == total_bytes {
            let elapsed_secs = start_time.elapsed().as_secs_f64().max(0.001);
            let speed_mbps = (downloaded_bytes as f64 / (1024.0 * 1024.0)) / elapsed_secs;
            let percent = (((downloaded_bytes as f64 / total_bytes as f64) * 100.0).min(100.0)) as u8;

            let _ = app_handle.emit(
                "qwen-model-download-progress",
                QwenDownloadProgress {
                    model_name: model_name.clone(),
                    downloaded_bytes,
                    total_bytes,
                    downloaded_mb: downloaded_bytes as f64 / (1024.0 * 1024.0),
                    total_mb: total_bytes as f64 / (1024.0 * 1024.0),
                    percent,
                    speed_mbps,
                    status: if downloaded_bytes == total_bytes { "completed" } else { "downloading" }.to_string(),
                },
            );
            last_emit = std::time::Instant::now();
        }
    }

    if let Err(e) = file.flush().await {
        let _ = tokio::fs::remove_file(&temp_file).await;
        ACTIVE_DOWNLOADS.write().await.remove(&model_name);
        return Err(format!("Flush error: {}", e));
    }
    drop(file);

    if let Err(e) = tokio::fs::rename(&temp_file, &target_file).await {
        ACTIVE_DOWNLOADS.write().await.remove(&model_name);
        return Err(format!("Failed to finalize model file: {}", e));
    }

    ACTIVE_DOWNLOADS.write().await.remove(&model_name);
    info!("✅ Successfully downloaded Qwen3-ASR model: {}", model_name);

    let _ = app_handle.emit(
        "qwen-model-download-complete",
        serde_json::json!({
            "modelName": model_name
        }),
    );

    Ok(())
}

#[command]
pub async fn qwen_cancel_download(model_name: String) -> Result<bool, String> {
    let cancels = CANCEL_FLAGS.read().await;
    if let Some(flag) = cancels.get(&model_name) {
        flag.store(true, Ordering::Relaxed);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[command]
pub async fn qwen_delete_model(model_name: String) -> Result<bool, String> {
    let dir = qwen_models_dir();
    let file = dir.join(model_file_name(&model_name));
    if file.exists() {
        tokio::fs::remove_file(&file)
            .await
            .map_err(|e| format!("Failed to delete model file: {}", e))?;
        info!("🗑️ Deleted Qwen3-ASR model: {}", model_name);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[command]
pub async fn open_qwen_models_folder() -> Result<(), String> {
    let dir = qwen_models_dir();
    if !dir.exists() {
        let _ = tokio::fs::create_dir_all(&dir).await;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    Ok(())
}

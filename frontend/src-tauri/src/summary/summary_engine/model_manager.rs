// Model manager for built-in AI models - handles downloads and lifecycle
// Follows the same pattern as whisper_engine/whisper_engine.rs for consistency

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::fs::{self, OpenOptions};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::{Notify, RwLock};
use tokio::time::timeout;

use super::models::{get_available_models, get_model_by_name};

// ============================================================================
// Model Status Types
// ============================================================================

/// Detailed download progress info (MB-based with speed)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    /// Bytes downloaded so far
    pub downloaded_bytes: u64,
    /// Total file size in bytes
    pub total_bytes: u64,
    /// Downloaded in MB (for display)
    pub downloaded_mb: f64,
    /// Total size in MB (for display)
    pub total_mb: f64,
    /// Download speed in MB/s
    pub speed_mbps: f64,
    /// Percentage complete (0-100)
    pub percent: u8,
}

impl DownloadProgress {
    pub fn new(downloaded: u64, total: u64, speed_mbps: f64) -> Self {
        let percent = if total > 0 {
            ((downloaded as f64 / total as f64) * 100.0) as u8
        } else {
            0
        };
        Self {
            downloaded_bytes: downloaded,
            total_bytes: total,
            downloaded_mb: downloaded as f64 / (1024.0 * 1024.0),
            total_mb: total as f64 / (1024.0 * 1024.0),
            speed_mbps,
            percent,
        }
    }
}

/// Model status in the system
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ModelStatus {
    /// Model is not yet downloaded
    NotDownloaded,

    /// Model is currently being downloaded (progress 0-100)
    Downloading { progress: u8 },

    /// Model is downloaded and ready to use
    Available,

    /// A resumable partial download exists on disk.
    Incomplete { file_size: u64, expected_size: u64 },

    /// Model file is corrupted and needs redownload
    Corrupted { file_size: u64, expected_min_size: u64 },

    /// Error occurred with the model
    Error(String),
}

/// Model information for UI display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    /// Model name (e.g., "gemma3:1b")
    pub name: String,

    /// Display name for UI
    pub display_name: String,

    /// Current status
    pub status: ModelStatus,

    /// File path (if available)
    pub path: PathBuf,

    /// Size in MB
    pub size_mb: u64,

    /// Context window size in tokens
    pub context_size: u32,

    /// Description
    pub description: String,

    /// GGUF filename on disk
    pub gguf_file: String,
}

// ============================================================================
// Model Manager
// ============================================================================

struct DownloadControl {
    cancelled: AtomicBool,
    notify: Notify,
}

pub struct ModelManager {
    /// Directory where models are stored
    models_dir: PathBuf,

    /// Currently available models with their status
    available_models: Arc<RwLock<HashMap<String, ModelInfo>>>,

    /// One owner and cancellation signal per active model download.
    download_controls: Arc<RwLock<HashMap<String, Arc<DownloadControl>>>>,
}

impl ModelManager {
    /// Create a new model manager with default models directory
    pub fn new() -> Result<Self> {
        Self::new_with_models_dir(None)
    }

    /// Create a new model manager with custom models directory
    pub fn new_with_models_dir(models_dir: Option<PathBuf>) -> Result<Self> {
        let models_dir = if let Some(dir) = models_dir {
            dir
        } else {
            // Fallback: Use current directory in development
            let current_dir = std::env::current_dir()
                .map_err(|e| anyhow!("Failed to get current directory: {}", e))?;

            if cfg!(debug_assertions) {
                // Development mode
                current_dir.join("models").join("summary")
            } else {
                // Production mode fallback (caller should provide path).
                // Portable: models live next to the executable.
                log::warn!("ModelManager: No models directory provided, using install-local fallback");
                crate::paths::models_dir().join("summary")
            }
        };

        log::info!(
            "Built-in AI ModelManager using directory: {}",
            models_dir.display()
        );

        Ok(Self {
            models_dir,
            available_models: Arc::new(RwLock::new(HashMap::new())),
            download_controls: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    /// Initialize and scan for existing models
    pub async fn init(&self) -> Result<()> {
        // Create models directory if it doesn't exist
        if !self.models_dir.exists() {
            fs::create_dir_all(&self.models_dir).await?;
            log::info!("Created models directory: {}", self.models_dir.display());
        }

        // Scan for existing models
        self.scan_models().await?;

        Ok(())
    }

    /// Scan models directory and update status
    pub async fn scan_models(&self) -> Result<()> {
        let start = std::time::Instant::now();

        log::info!(
            "Starting model scan in directory: {}",
            self.models_dir.display()
        );

        let model_defs = get_available_models();
        let mut models_map = HashMap::new();

        for model_def in model_defs {
            let model_path = self.models_dir.join(&model_def.gguf_file);
            log::debug!(
                "Checking model '{}' at path: {}",
                model_def.name,
                model_path.display()
            );

            let is_actively_downloading = {
                self.download_controls.read().await.contains_key(&model_def.name)
            };

            // If actively downloading, preserve existing status from memory
            if is_actively_downloading {
                let existing_info = {
                    let models = self.available_models.read().await;
                    models.get(&model_def.name).cloned()
                };

                if let Some(info) = existing_info {
                    // Preserve existing status (should be Downloading)
                    models_map.insert(model_def.name.clone(), info);
                    log::debug!(
                        "Model '{}': Preserving Downloading status during scan",
                        model_def.name
                    );
                    continue;
                }
            }

            let status = if model_path.exists() {
                // Check if file size matches expected size (basic validation)
                match fs::metadata(&model_path).await {
                    Ok(metadata) => {
                        let file_size_bytes = metadata.len();
                        let file_size_mb = file_size_bytes / (1024 * 1024);

                        let expected_min = (model_def.size_mb as f64 * 0.9) as u64;

                        log::info!(
                            "Model '{}': found {} bytes (expected exactly {} bytes)",
                            model_def.name,
                            file_size_bytes,
                            model_def.size_bytes
                        );

                        if file_size_bytes == model_def.size_bytes {
                            match self.validate_gguf_file(&model_path).await {
                                Ok(()) => {
                                    log::info!("Model '{}': AVAILABLE", model_def.name);
                                    ModelStatus::Available
                                }
                                Err(error) => {
                                    log::warn!("Model '{}': CORRUPTED ({})", model_def.name, error);
                                    ModelStatus::Corrupted {
                                        file_size: file_size_mb,
                                        expected_min_size: model_def.size_mb,
                                    }
                                }
                            }
                        } else if file_size_bytes < model_def.size_bytes {
                            log::info!(
                                "Model '{}': INCOMPLETE ({} MB of approximately {} MB); download can resume",
                                model_def.name,
                                file_size_mb,
                                model_def.size_mb
                            );
                            ModelStatus::Incomplete {
                                file_size: file_size_mb,
                                expected_size: model_def.size_mb,
                            }
                        } else {
                            log::warn!(
                                "Model '{}': CORRUPTED (size mismatch: {} MB, expected {} MB)",
                                model_def.name,
                                file_size_mb,
                                model_def.size_mb
                            );
                            ModelStatus::Corrupted {
                                file_size: file_size_mb,
                                expected_min_size: expected_min,
                            }
                        }
                    }
                    Err(e) => {
                        log::error!(
                            "Model '{}': Failed to read metadata: {}",
                            model_def.name,
                            e
                        );
                        ModelStatus::Error(format!("Failed to read metadata: {}", e))
                    }
                }
            } else {
                log::debug!("Model '{}': NOT FOUND", model_def.name);
                ModelStatus::NotDownloaded
            };

            let model_info = ModelInfo {
                name: model_def.name.clone(),
                display_name: model_def.display_name.clone(),
                status,
                path: model_path,
                size_mb: model_def.size_mb,
                context_size: model_def.context_size,
                description: model_def.description.clone(),
                gguf_file: model_def.gguf_file.clone(),
            };

            models_map.insert(model_def.name.clone(), model_info);
        }

        let model_count = models_map.len();

        let mut models = self.available_models.write().await;
        *models = models_map;

        let elapsed = start.elapsed();
        log::info!(
            "Model scan complete: {} models checked in {:?}",
            model_count,
            elapsed
        );
        Ok(())
    }

    /// Get list of all models with their status
    pub async fn list_models(&self) -> Vec<ModelInfo> {
        self.available_models
            .read()
            .await
            .values()
            .cloned()
            .collect()
    }

    /// Get info for a specific model
    pub async fn get_model_info(&self, model_name: &str) -> Option<ModelInfo> {
        self.available_models
            .read()
            .await
            .get(model_name)
            .cloned()
    }

    /// Check if a model is ready to use
    /// If refresh=true, scans filesystem before checking (slower but accurate)
    pub async fn is_model_ready(&self, model_name: &str, refresh: bool) -> bool {
        if refresh {
            if let Err(e) = self.scan_models().await {
                log::error!("Failed to scan models: {}", e);
                return false;
            }
        }

        if let Some(info) = self.get_model_info(model_name).await {
            info.status == ModelStatus::Available
        } else {
            false
        }
    }

    /// Download a model with simple percentage callback (backward compatible)
    pub async fn download_model(
        &self,
        model_name: &str,
        progress_callback: Option<Box<dyn Fn(u8) + Send>>,
    ) -> Result<()> {
        // Wrap the simple callback to use detailed progress internally
        let detailed_callback: Option<Box<dyn Fn(DownloadProgress) + Send>> =
            progress_callback.map(|cb| {
                Box::new(move |p: DownloadProgress| cb(p.percent)) as Box<dyn Fn(DownloadProgress) + Send>
            });
        self.download_model_detailed(model_name, detailed_callback).await
    }

    /// Download a model with detailed progress (MB, speed, etc.)
    pub async fn download_model_detailed(
        &self,
        model_name: &str,
        progress_callback: Option<Box<dyn Fn(DownloadProgress) + Send>>,
    ) -> Result<()> {
        log::info!("Starting download for model: {}", model_name);

        // Reserve atomically. A read-then-write check lets two simultaneous UI
        // invokes both pass before either inserts its reservation.
        let control = Arc::new(DownloadControl {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        });
        {
            let mut controls = self.download_controls.write().await;
            if controls.contains_key(model_name) {
                log::warn!("Download already in progress for model: {}", model_name);
                return Err(anyhow!("Download already in progress"));
            }
            controls.insert(model_name.to_string(), control.clone());
        }

        // Get model definition
        let model_def = match get_model_by_name(model_name) {
            Some(model) => model,
            None => {
                self.release_download(model_name, &control).await;
                return Err(anyhow!("Unknown model: {}", model_name));
            }
        };

        // Update status to downloading
        {
            let mut models = self.available_models.write().await;
            if let Some(model_info) = models.get_mut(model_name) {
                model_info.status = ModelStatus::Downloading { progress: 0 };
            }
        }

        let file_path = self.models_dir.join(&model_def.gguf_file);

        // Check if model already exists and is valid (skip re-download)
        if file_path.exists() {
            if let Ok(metadata) = fs::metadata(&file_path).await {
                let file_size_mb = metadata.len() / (1024 * 1024);

                if metadata.len() == model_def.size_bytes
                    && self.validate_gguf_file(&file_path).await.is_ok()
                {
                    log::info!(
                        "Model '{}' already exists and is valid ({} MB), skipping download",
                        model_name,
                        file_size_mb
                    );

                    let mut controls = self.download_controls.write().await;
                    if control.cancelled.load(Ordering::Acquire) {
                        drop(controls);
                        self.finish_cancelled_download(
                            model_name,
                            &control,
                            &file_path,
                            model_def.size_mb,
                        )
                        .await;
                        return Err(anyhow!("CANCELLED: Download cancelled by user"));
                    }
                    let mut models = self.available_models.write().await;
                    if let Some(model_info) = models.get_mut(model_name) {
                        model_info.status = ModelStatus::Available;
                    }
                    controls.remove(model_name);

                    // Report 100% progress
                    if let Some(ref callback) = progress_callback {
                        let total = metadata.len();
                        callback(DownloadProgress::new(total, total, 0.0));
                    }

                    return Ok(());
                } else if metadata.len() >= model_def.size_bytes {
                    // File is LARGER than expected - possibly corrupted or wrong file
                    // Delete and re-download in this case
                    log::warn!(
                        "Model '{}' exists but is too large ({} MB, expected exactly {} bytes), deleting and re-downloading",
                        model_name,
                        file_size_mb,
                        model_def.size_bytes
                    );
                    if let Err(e) = fs::remove_file(&file_path).await {
                        log::warn!("Failed to delete oversized model file: {}", e);
                    }
                } else {
                    // File is SMALLER than expected - likely partial download
                    // DON'T DELETE - let resume logic handle it
                    log::info!(
                        "Model '{}' exists but is incomplete ({} MB of approximately {} MB), will resume download",
                        model_name,
                        file_size_mb,
                        model_def.size_mb
                    );
                    // Continue to download/resume logic below
                }
            }
        }

        log::info!("Downloading from: {}", model_def.download_url);
        log::info!("Saving to: {}", file_path.display());

        // Create models directory if needed
        if !self.models_dir.exists() {
            if let Err(error) = fs::create_dir_all(&self.models_dir).await {
                self.fail_download(model_name, &control, format!("Failed to create models directory: {}", error)).await;
                return Err(error.into());
            }
        }

        // Check for existing partial download to resume
        let existing_size: u64 = if file_path.exists() {
            fs::metadata(&file_path)
                .await
                .map(|m| m.len())
                .unwrap_or(0)
        } else {
            0
        };

        // Download the file with optimized client settings
        let client = match Client::builder()
            .tcp_nodelay(true) // Disable Nagle's algorithm for faster streaming
            .pool_max_idle_per_host(1) // Keep connection alive
            .timeout(Duration::from_secs(3600)) // 1 hour timeout for large files
            .connect_timeout(Duration::from_secs(30))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                self.fail_download(model_name, &control, format!("Failed to create HTTP client: {}", error)).await;
                return Err(anyhow!("Failed to create HTTP client: {}", error));
            }
        };

        // Build request with Range header if resuming
        let mut request = client.get(&model_def.download_url);
        if existing_size > 0 {
            log::info!(
                "Resuming download from byte {} ({:.1} MB)",
                existing_size,
                existing_size as f64 / (1024.0 * 1024.0)
            );
            request = request.header("Range", format!("bytes={}-", existing_size));
        }

        let response_result = tokio::select! {
            _ = control.notify.notified() => {
                self.finish_cancelled_download(model_name, &control, &file_path, model_def.size_mb).await;
                return Err(anyhow!("CANCELLED: Download cancelled by user"));
            }
            response = request.send() => response,
        };
        let response = match response_result {
            Ok(response) => response,
            Err(error) => {
                self.fail_download(model_name, &control, format!("Failed to start download: {}", error)).await;
                return Err(anyhow!("Failed to start download: {}", error));
            }
        };

        // Check response status - 200 OK (full download) or 206 Partial Content (resume)
        let (total_size, resuming) = if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            let content_range = response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            let expected_prefix = format!("bytes {}-", existing_size);
            let expected_total = format!("/{}", model_def.size_bytes);
            if !content_range.starts_with(&expected_prefix) || !content_range.ends_with(&expected_total) {
                self.fail_download(
                    model_name,
                    &control,
                    format!("Server returned unexpected resume range: {}", content_range),
                )
                .await;
                return Err(anyhow!("Server returned unexpected resume range: {}", content_range));
            }
            // Server supports resume - total size = existing + remaining
            let remaining = response.content_length().unwrap_or(0);
            log::info!("Server supports resume, {} MB remaining", remaining / (1024 * 1024));
            (existing_size + remaining, true)
        } else if response.status().is_success() {
            // Server doesn't support resume or fresh download
            if existing_size > 0 {
                log::warn!("Server doesn't support resume, starting fresh download");
            }
            (response.content_length().unwrap_or(0), false)
        } else {
            self.fail_download(model_name, &control, format!("Download failed with status: {}", response.status())).await;
            return Err(anyhow!("Download failed with status: {}", response.status()));
        };

        log::info!("Total size: {} MB", total_size / (1024 * 1024));

        // Open file for append if resuming, or create new
        let file_result = if resuming {
            OpenOptions::new()
                .write(true)
                .append(true)
                .open(&file_path)
                .await
        } else {
            fs::File::create(&file_path).await
        };
        let file = match file_result {
            Ok(file) => file,
            Err(error) => {
                self.fail_download(model_name, &control, format!("Failed to open model file: {}", error)).await;
                return Err(anyhow!("Failed to open model file: {}", error));
            }
        };

        // Use 8MB buffer to reduce disk I/O syscalls (major performance improvement)
        let mut writer = BufWriter::with_capacity(8 * 1024 * 1024, file);

        let mut downloaded: u64 = if resuming { existing_size } else { 0 };

        // Emit initial progress (showing resumed position if applicable)
        if let Some(ref callback) = progress_callback {
            callback(DownloadProgress::new(downloaded, total_size, 0.0));
        }
        log::info!(
            "Starting at {:.1} MB / {:.1} MB",
            downloaded as f64 / (1024.0 * 1024.0),
            total_size as f64 / (1024.0 * 1024.0)
        );

        let mut last_progress_percent = if total_size > 0 {
            ((downloaded as f64 / total_size as f64) * 100.0) as u8
        } else {
            0
        };
        let mut last_report_time = std::time::Instant::now();
        let mut bytes_since_last_report: u64 = 0;
        let download_start_time = std::time::Instant::now();
        let start_downloaded = downloaded;

        use futures_util::StreamExt;
        let mut stream = response.bytes_stream();

        loop {
            // Check for cancellation
            {
                if control.cancelled.load(Ordering::Acquire) {
                    log::info!("Download cancelled for model: {}", model_name);

                    // Flush and keep partial file for resume on next attempt
                    let _ = writer.flush().await;
                    drop(writer);

                    self.finish_cancelled_download(model_name, &control, &file_path, model_def.size_mb).await;

                    // Use special marker prefix to distinguish cancellation from other errors
                    return Err(anyhow!("CANCELLED: Download cancelled by user"));
                }
            }

            // Add per-chunk timeout (30 seconds) to detect stalled connections
            let next_result = tokio::select! {
                _ = control.notify.notified() => continue,
                result = timeout(Duration::from_secs(30), stream.next()) => result,
            };

            let chunk = match next_result {
                // Timeout - no data received for 30 seconds
                Err(_) => {
                    log::warn!("Download timeout for {}: no data received for 30 seconds", model_name);
                    let _ = writer.flush().await;

                    self.fail_download(model_name, &control, "Download timeout - No data received for 30 seconds".to_string()).await;

                    return Err(anyhow!("Download timeout - No data received for 30 seconds"));
                },
                // Stream ended
                Ok(None) => break,
                // Got chunk result
                Ok(Some(chunk_result)) => {
                    match chunk_result {
                        Ok(c) => c,
                        // Detect error type for better user feedback
                        Err(e) => {
                            log::error!("Download error for {}: {:?}", model_name, e);
                            let _ = writer.flush().await;

                            // Categorize error for user-friendly message
                            let error_msg = if e.is_timeout() {
                                "Connection timeout - Check your internet"
                            } else if e.is_connect() {
                                "Connection failed - Check your internet"
                            } else if e.is_body() {
                                "Stream interrupted - Network unstable"
                            } else {
                                "Download error"
                            };

                            self.fail_download(model_name, &control, error_msg.to_string()).await;

                            return Err(anyhow!("{}: {}", error_msg, e));
                        }
                    }
                }
            };
            let chunk_len = chunk.len() as u64;
            if let Err(error) = writer.write_all(&chunk).await {
                self.fail_download(model_name, &control, format!("Error writing model file: {}", error)).await;
                return Err(anyhow!("Error writing to file: {}", error));
            }

            downloaded += chunk_len;
            bytes_since_last_report += chunk_len;

            // Calculate progress
            let progress_percent = if total_size > 0 {
                let exact_percent = (downloaded as f64 / total_size as f64) * 100.0;
                exact_percent.min(100.0) as u8
            } else {
                0
            };

            let elapsed_since_report = last_report_time.elapsed();
            let is_download_complete = downloaded >= total_size;
            let should_report = progress_percent > last_progress_percent
                || is_download_complete  // Force report on completion
                || elapsed_since_report.as_millis() >= 500;

            if should_report {
                // Calculate speed based on bytes downloaded since last report
                let speed_mbps = if elapsed_since_report.as_secs_f64() > 0.0 {
                    (bytes_since_last_report as f64 / (1024.0 * 1024.0)) / elapsed_since_report.as_secs_f64()
                } else {
                    // Fallback to overall average speed
                    let total_elapsed = download_start_time.elapsed().as_secs_f64();
                    if total_elapsed > 0.0 {
                        ((downloaded - start_downloaded) as f64 / (1024.0 * 1024.0)) / total_elapsed
                    } else {
                        0.0
                    }
                };

                log::info!(
                    "Download: {:.1} MB / {:.1} MB ({:.1} MB/s)",
                    downloaded as f64 / (1024.0 * 1024.0),
                    total_size as f64 / (1024.0 * 1024.0),
                    speed_mbps
                );

                // Update status
                {
                    let mut models = self.available_models.write().await;
                    if let Some(model_info) = models.get_mut(model_name) {
                        model_info.status = ModelStatus::Downloading {
                            progress: if is_download_complete { 100 } else { progress_percent }
                        };
                    }
                }

                // Call progress callback with detailed info
                if let Some(ref callback) = progress_callback {
                    callback(DownloadProgress::new(downloaded, total_size, speed_mbps));
                }

                last_progress_percent = progress_percent;
                last_report_time = std::time::Instant::now();
                bytes_since_last_report = 0;
            }
        }

        if let Err(error) = writer.flush().await {
            self.fail_download(model_name, &control, format!("Failed to flush model file: {}", error)).await;
            return Err(error.into());
        }
        drop(writer);

        let final_size = match fs::metadata(&file_path).await {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                self.fail_download(model_name, &control, format!("Failed to inspect downloaded model: {}", error)).await;
                return Err(error.into());
            }
        };
        if final_size != model_def.size_bytes || (total_size > 0 && final_size != total_size) {
            let final_size_mb = final_size / (1024 * 1024);
            log::warn!(
                "Download ended before model '{}' was complete: {} MB of approximately {} MB",
                model_name,
                final_size_mb,
                model_def.size_mb
            );
            {
                let mut models = self.available_models.write().await;
                if let Some(model_info) = models.get_mut(model_name) {
                    model_info.status = ModelStatus::Incomplete {
                        file_size: final_size_mb,
                        expected_size: model_def.size_mb,
                    };
                }
            }
            self.release_download(model_name, &control).await;
            return Err(anyhow!(
                "Download incomplete: received {} MB of approximately {} MB; retry to resume",
                final_size_mb,
                model_def.size_mb
            ));
        }

        log::info!("Download completed for model: {}", model_name);

        {
            let mut models = self.available_models.write().await;
            if let Some(model_info) = models.get_mut(model_name) {
                model_info.status = ModelStatus::Downloading { progress: 100 };
            }
        }

        if let Some(ref callback) = progress_callback {
            callback(DownloadProgress::new(total_size, total_size, 0.0));
        }

        if control.cancelled.load(Ordering::Acquire) {
            self.finish_cancelled_download(model_name, &control, &file_path, model_def.size_mb).await;
            return Err(anyhow!("CANCELLED: Download cancelled by user"));
        }

        if let Err(e) = self.validate_gguf_file(&file_path).await {
            log::error!("Downloaded file failed validation: {}", e);

            // Clean up invalid file
            let _ = fs::remove_file(&file_path).await;

            // Update status
            {
                let mut models = self.available_models.write().await;
                if let Some(model_info) = models.get_mut(model_name) {
                    model_info.status = ModelStatus::Error(format!("Validation failed: {}", e));
                }
            }

            self.release_download(model_name, &control).await;

            return Err(anyhow!("File validation failed: {}", e));
        }

        // Commit completion while ownership is still held. Cancellation is
        // either observed here or rejected after the control is removed.
        let mut controls = self.download_controls.write().await;
        if control.cancelled.load(Ordering::Acquire) {
            drop(controls);
            self.finish_cancelled_download(model_name, &control, &file_path, model_def.size_mb).await;
            return Err(anyhow!("CANCELLED: Download cancelled by user"));
        }
        let mut models = self.available_models.write().await;
        if let Some(model_info) = models.get_mut(model_name) {
            model_info.status = ModelStatus::Available;
            model_info.path = file_path.clone();
        }
        controls.remove(model_name);

        Ok(())
    }

    /// Validate that a file is a valid GGUF model
    async fn validate_gguf_file(&self, path: &PathBuf) -> Result<()> {
        let mut file = fs::File::open(path).await?;

        // Read first 4 bytes to check for GGUF magic number
        use tokio::io::AsyncReadExt;
        let mut magic = [0u8; 4];
        file.read_exact(&mut magic).await?;

        // GGUF magic number is "GGUF" (0x47475546)
        if &magic == b"GGUF" {
            Ok(())
        } else if &magic == b"ggjt" || &magic == b"ggla" || &magic == b"ggml" {
            // Older formats (GGML, GGJT)
            Ok(())
        } else {
            Err(anyhow!(
                "Invalid model file: magic number {:?} doesn't match GGUF/GGML",
                magic
            ))
        }
    }

    async fn release_download(&self, model_name: &str, control: &Arc<DownloadControl>) {
        let mut controls = self.download_controls.write().await;
        if controls
            .get(model_name)
            .is_some_and(|current| Arc::ptr_eq(current, control))
        {
            controls.remove(model_name);
        }
    }

    async fn fail_download(
        &self,
        model_name: &str,
        control: &Arc<DownloadControl>,
        message: String,
    ) {
        let mut models = self.available_models.write().await;
        if let Some(model_info) = models.get_mut(model_name) {
            model_info.status = ModelStatus::Error(message);
        }
        drop(models);
        self.release_download(model_name, control).await;
    }

    async fn finish_cancelled_download(
        &self,
        model_name: &str,
        control: &Arc<DownloadControl>,
        file_path: &PathBuf,
        expected_size: u64,
    ) {
        let partial_size = fs::metadata(file_path).await.map(|m| m.len()).unwrap_or(0);
        let mut models = self.available_models.write().await;
        if let Some(model_info) = models.get_mut(model_name) {
            model_info.status = if partial_size > 0 {
                ModelStatus::Incomplete {
                    file_size: partial_size / (1024 * 1024),
                    expected_size,
                }
            } else {
                ModelStatus::NotDownloaded
            };
        }
        drop(models);
        self.release_download(model_name, control).await;
    }

    /// Cancel an ongoing download
    pub async fn cancel_download(&self, model_name: &str) -> Result<()> {
        log::info!("Cancelling download for model: {}", model_name);

        let control = self
            .download_controls
            .read()
            .await
            .get(model_name)
            .cloned()
            .ok_or_else(|| anyhow!("No download in progress for model: {}", model_name))?;
        control.cancelled.store(true, Ordering::Release);
        control.notify.notify_one();

        timeout(Duration::from_secs(5), async {
            while self
                .download_controls
                .read()
                .await
                .get(model_name)
                .is_some_and(|current| Arc::ptr_eq(current, &control))
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| anyhow!("Timed out cancelling model download"))?;

        Ok(())
    }

    /// Delete a corrupted or available model file
    pub async fn delete_model(&self, model_name: &str) -> Result<()> {
        log::info!("Deleting model: {}", model_name);

        let model_def = get_model_by_name(model_name)
            .ok_or_else(|| anyhow!("Unknown model: {}", model_name))?;

        let file_path = self.models_dir.join(&model_def.gguf_file);

        if file_path.exists() {
            fs::remove_file(&file_path).await?;
            log::info!("Deleted model file: {}", file_path.display());
        }

        // Update status
        {
            let mut models = self.available_models.write().await;
            if let Some(model_info) = models.get_mut(model_name) {
                model_info.status = ModelStatus::NotDownloaded;
            }
        }

        Ok(())
    }

    /// Get models directory path
    pub fn get_models_directory(&self) -> PathBuf {
        self.models_dir.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scan_marks_partial_model_incomplete_and_exact_model_available() {
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = ModelManager::new_with_models_dir(Some(temp.path().to_path_buf()))
            .expect("manager");
        let model = get_model_by_name("qwen3.5:2b").expect("model");
        let path = temp.path().join(&model.gguf_file);

        let partial = fs::File::create(&path).await.expect("partial file");
        partial.set_len(123_456).await.expect("partial size");
        manager.init().await.expect("partial scan");
        assert!(matches!(
            manager.get_model_info(&model.name).await.unwrap().status,
            ModelStatus::Incomplete { .. }
        ));

        let mut exact = fs::OpenOptions::new().write(true).open(&path).await.expect("exact file");
        exact.set_len(model.size_bytes).await.expect("exact invalid size");
        manager.scan_models().await.expect("invalid exact scan");
        assert!(matches!(
            manager.get_model_info(&model.name).await.unwrap().status,
            ModelStatus::Corrupted { .. }
        ));

        exact.write_all(b"GGUF").await.expect("GGUF magic");
        exact.set_len(model.size_bytes).await.expect("exact size");
        manager.scan_models().await.expect("exact scan");
        assert_eq!(
            manager.get_model_info(&model.name).await.unwrap().status,
            ModelStatus::Available
        );
    }
}

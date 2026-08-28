use crate::parakeet_engine::model::ParakeetModel;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::fs;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::RwLock;
use tokio::time::timeout;

pub(crate) const DOWNLOAD_CANCELLED_MESSAGE: &str = "Download cancelled by user";

/// Quantization type for Parakeet models
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum QuantizationType {
    FP32, // Full precision
    Int8, // 8-bit integer quantization (faster)
}

impl Default for QuantizationType {
    fn default() -> Self {
        QuantizationType::Int8 // Default to int8 for best performance
    }
}

/// Model status for Parakeet models
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ModelStatus {
    Available,
    Missing,
    Downloading {
        progress: u8,
    },
    Error(String),
    Corrupted {
        file_size: u64,
        expected_min_size: u64,
    },
}

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
            ((downloaded as f64 / total as f64) * 100.0).min(100.0) as u8
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

/// Information about a Parakeet model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub name: String,
    pub path: PathBuf,
    pub size_mb: u32,
    pub quantization: QuantizationType,
    pub speed: String, // Performance description
    pub status: ModelStatus,
    pub description: String,
}

#[derive(Debug)]
pub enum ParakeetEngineError {
    ModelNotLoaded,
    ModelNotFound(String),
    TranscriptionFailed(String),
    DownloadFailed(String),
    IoError(std::io::Error),
    Other(String),
}

impl std::fmt::Display for ParakeetEngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParakeetEngineError::ModelNotLoaded => write!(f, "No Parakeet model loaded"),
            ParakeetEngineError::ModelNotFound(name) => write!(f, "Model '{}' not found", name),
            ParakeetEngineError::TranscriptionFailed(err) => {
                write!(f, "Transcription failed: {}", err)
            }
            ParakeetEngineError::DownloadFailed(err) => write!(f, "Download failed: {}", err),
            ParakeetEngineError::IoError(err) => write!(f, "IO error: {}", err),
            ParakeetEngineError::Other(err) => write!(f, "Error: {}", err),
        }
    }
}

impl std::error::Error for ParakeetEngineError {}

impl From<std::io::Error> for ParakeetEngineError {
    fn from(err: std::io::Error) -> Self {
        ParakeetEngineError::IoError(err)
    }
}

pub struct ParakeetEngine {
    models_dir: PathBuf,
    current_model: Arc<RwLock<Option<ParakeetModel>>>,
    current_model_name: Arc<RwLock<Option<String>>>,
    pub(crate) available_models: Arc<RwLock<HashMap<String, ModelInfo>>>,
    cancel_downloads: Arc<RwLock<HashSet<String>>>,
    completed_cancellations: Arc<RwLock<HashSet<String>>>,
    // Active downloads tracking to prevent concurrent downloads
    pub(crate) active_downloads: Arc<RwLock<HashSet<String>>>, // Set of models currently being downloaded
}

impl ParakeetEngine {
    fn download_base_urls(model_name: &str) -> Vec<&'static str> {
        if model_name.contains("-v2-") {
            vec!["https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/main"]
        } else {
            vec![
                "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main",
                "https://github.com/TylerBuza/Meetily-ActuallyFree/releases/download/parakeet-tdt-0.6b-v3-onnx",
            ]
        }
    }

    fn download_file_sizes(
        model_name: &str,
        quantization: &QuantizationType,
    ) -> HashMap<&'static str, u64> {
        match quantization {
            QuantizationType::Int8 if model_name.contains("-v2-") => [
                ("encoder-model.int8.onnx", 652_184_014),
                ("decoder_joint-model.int8.onnx", 8_998_286),
                ("nemo128.onnx", 139_764),
                ("vocab.txt", 9_384),
            ]
            .into_iter()
            .collect(),
            QuantizationType::Int8 => [
                ("encoder-model.int8.onnx", 652_183_999),
                ("decoder_joint-model.int8.onnx", 18_202_004),
                ("nemo128.onnx", 139_764),
                ("vocab.txt", 93_939),
            ]
            .into_iter()
            .collect(),
            QuantizationType::FP32 => [
                ("encoder-model.onnx", 41_800_000 + 2_440_000_000),
                ("decoder_joint-model.onnx", 72_500_000),
                ("nemo128.onnx", 140_000),
                ("vocab.txt", 93_900),
            ]
            .into_iter()
            .collect(),
        }
    }

    /// Create a new Parakeet engine with optional custom models directory
    pub fn new_with_models_dir(models_dir: Option<PathBuf>) -> Result<Self> {
        let models_dir = if let Some(dir) = models_dir {
            dir.join("parakeet") // Parakeet models in subdirectory
        } else {
            // Fallback to default location
            let current_dir = std::env::current_dir()
                .map_err(|e| anyhow!("Failed to get current directory: {}", e))?;

            if cfg!(debug_assertions) {
                // Development mode
                current_dir.join("models").join("parakeet")
            } else {
                // Production mode — portable: models live next to the executable.
                crate::paths::models_dir().join("parakeet")
            }
        };

        log::info!(
            "ParakeetEngine using models directory: {}",
            models_dir.display()
        );

        // Create directory if it doesn't exist
        if !models_dir.exists() {
            std::fs::create_dir_all(&models_dir)?;
        }

        Ok(Self {
            models_dir,
            current_model: Arc::new(RwLock::new(None)),
            current_model_name: Arc::new(RwLock::new(None)),
            available_models: Arc::new(RwLock::new(HashMap::new())),
            cancel_downloads: Arc::new(RwLock::new(HashSet::new())),
            completed_cancellations: Arc::new(RwLock::new(HashSet::new())),
            // Initialize active downloads tracking
            active_downloads: Arc::new(RwLock::new(HashSet::new())),
        })
    }

    /// Discover available Parakeet models
    pub async fn discover_models(&self) -> Result<Vec<ModelInfo>> {
        let models_dir = &self.models_dir;
        let mut models = Vec::new();

        // Parakeet model configurations
        // Model name format: parakeet-tdt-0.6b-v{version}-{quantization}
        // Sizes match actual download sizes (encoder + decoder + preprocessor + vocab)
        let model_configs = [
            (
                "parakeet-tdt-0.6b-v3-int8",
                670,
                QuantizationType::Int8,
                "Ultra Fast (v3)",
                "Real time on M4 Max, latest version with int8 quantization",
            ),
            (
                "parakeet-tdt-0.6b-v2-int8",
                661,
                QuantizationType::Int8,
                "Fast (v2)",
                "Previous version with int8 quantization, good balance of speed and accuracy",
            ),
        ];

        // Get active downloads to override status
        let active_downloads = self.active_downloads.read().await;

        for (name, size_mb, quantization, speed, description) in model_configs {
            let model_path = models_dir.join(name);

            // Check if model is currently downloading
            let status = if active_downloads.contains(name) {
                // If downloading, preserve that status regardless of file system
                // We don't know the exact progress here without more state, but 0 is safe fallback
                // The progress events will update the UI
                ModelStatus::Downloading { progress: 0 }
            } else if model_path.exists() {
                // Check for required ONNX files
                let required_files = match quantization {
                    QuantizationType::Int8 => vec![
                        "encoder-model.int8.onnx",
                        "decoder_joint-model.int8.onnx",
                        "nemo128.onnx",
                        "vocab.txt",
                    ],
                    QuantizationType::FP32 => vec![
                        "encoder-model.onnx",
                        "decoder_joint-model.onnx",
                        "nemo128.onnx",
                        "vocab.txt",
                    ],
                };

                let all_files_exist = required_files
                    .iter()
                    .all(|file| model_path.join(file).exists());

                if all_files_exist {
                    // Validate model by checking file sizes
                    match self.validate_model_directory(&model_path).await {
                        Ok(_) => ModelStatus::Available,
                        Err(_) => {
                            log::warn!("Model directory {} appears corrupted", name);
                            // Calculate total size of existing files
                            let mut total_size = 0u64;
                            for file in required_files {
                                if let Ok(metadata) = std::fs::metadata(model_path.join(file)) {
                                    total_size += metadata.len();
                                }
                            }
                            ModelStatus::Corrupted {
                                file_size: total_size,
                                expected_min_size: (size_mb as u64) * 1024 * 1024,
                            }
                        }
                    }
                } else {
                    ModelStatus::Missing
                }
            } else {
                ModelStatus::Missing
            };

            let model_info = ModelInfo {
                name: name.to_string(),
                path: model_path,
                size_mb: size_mb as u32,
                quantization: quantization.clone(),
                speed: speed.to_string(),
                status,
                description: description.to_string(),
            };

            models.push(model_info);
        }

        // Update internal cache
        let mut available_models = self.available_models.write().await;
        available_models.clear();
        for model in &models {
            available_models.insert(model.name.clone(), model.clone());
        }

        Ok(models)
    }

    /// Validate model directory by checking if all required files exist AND have valid sizes
    async fn validate_model_directory(&self, model_dir: &PathBuf) -> Result<()> {
        // Check if vocab.txt exists and is readable
        let vocab_path = model_dir.join("vocab.txt");
        if !vocab_path.exists() {
            return Err(anyhow!("vocab.txt not found"));
        }

        // Determine which files to check based on what exists
        let is_int8 = model_dir.join("encoder-model.int8.onnx").exists();
        let is_fp32 = model_dir.join("encoder-model.onnx").exists();

        if !is_int8 && !is_fp32 {
            return Err(anyhow!("No ONNX model files found"));
        }

        // Check preprocessor
        if !model_dir.join("nemo128.onnx").exists() {
            return Err(anyhow!("Preprocessor (nemo128.onnx) not found"));
        }

        // Published model sizes prevent truncated files from being treated as
        // loadable models. Keep minimum checks only for legacy FP32 exports.
        let model_name = model_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        let exact_sizes = if is_int8 {
            Some(Self::download_file_sizes(
                model_name,
                &QuantizationType::Int8,
            ))
        } else {
            None
        };
        let expected_sizes: Vec<(&str, u64)> = if let Some(ref sizes) = exact_sizes {
            sizes.iter().map(|(name, size)| (*name, *size)).collect()
        } else {
            vec![
                ("encoder-model.onnx", 2_200_000_000), // ~2.44 GB, min 2.2 GB
                ("decoder_joint-model.onnx", 65_000_000), // ~72 MB, min 65 MB
                ("nemo128.onnx", 100_000),             // ~140 KB, min 100 KB
                ("vocab.txt", 5_000),                  // ~94 KB, min 5 KB
            ]
        };

        for (filename, expected_size) in expected_sizes {
            let file_path = model_dir.join(filename);
            if !file_path.exists() {
                return Err(anyhow!("{} not found", filename));
            }

            match std::fs::metadata(&file_path) {
                Ok(metadata) => {
                    let actual_size = metadata.len();
                    let valid_size = exact_sizes.is_some() && actual_size == expected_size
                        || exact_sizes.is_none() && actual_size >= expected_size;
                    if !valid_size {
                        return Err(anyhow!(
                            "{} has {} bytes (expected {})",
                            filename,
                            actual_size,
                            expected_size
                        ));
                    }
                }
                Err(e) => {
                    return Err(anyhow!("Failed to read {} metadata: {}", filename, e));
                }
            }
        }

        Ok(())
    }

    /// Load a Parakeet model
    pub async fn load_model(&self, model_name: &str) -> Result<()> {
        let models = self.available_models.read().await;
        let model_info = models
            .get(model_name)
            .ok_or_else(|| anyhow!("Model {} not found", model_name))?;

        match model_info.status {
            ModelStatus::Available => {
                // Check if this model is already loaded
                if let Some(current_model) = self.current_model_name.read().await.as_ref() {
                    if current_model == model_name {
                        log::info!(
                            "Parakeet model {} is already loaded, skipping reload",
                            model_name
                        );
                        return Ok(());
                    }

                    // Unload current model before loading new one
                    log::info!(
                        "Unloading current Parakeet model '{}' before loading '{}'",
                        current_model,
                        model_name
                    );
                    self.unload_model().await;
                }

                log::info!("Loading Parakeet model: {}", model_name);

                // Load model based on quantization type
                let quantized = model_info.quantization == QuantizationType::Int8;
                let model = ParakeetModel::new(&model_info.path, quantized)
                    .map_err(|e| anyhow!("Failed to load Parakeet model {}: {}", model_name, e))?;

                // Update current model and model name
                *self.current_model.write().await = Some(model);
                *self.current_model_name.write().await = Some(model_name.to_string());

                log::info!(
                    "Successfully loaded Parakeet model: {} ({})",
                    model_name,
                    if quantized { "Int8 quantized" } else { "FP32" }
                );
                Ok(())
            }
            ModelStatus::Missing => Err(anyhow!("Parakeet model {} is not downloaded", model_name)),
            ModelStatus::Downloading { .. } => Err(anyhow!(
                "Parakeet model {} is currently downloading",
                model_name
            )),
            ModelStatus::Error(ref err) => {
                Err(anyhow!("Parakeet model {} has error: {}", model_name, err))
            }
            ModelStatus::Corrupted { .. } => Err(anyhow!(
                "Parakeet model {} is corrupted and cannot be loaded",
                model_name
            )),
        }
    }

    /// Unload the current model
    pub async fn unload_model(&self) -> bool {
        let mut model_guard = self.current_model.write().await;
        let unloaded = model_guard.take().is_some();
        if unloaded {
            log::info!("Parakeet model unloaded");
        }

        let mut model_name_guard = self.current_model_name.write().await;
        model_name_guard.take();

        unloaded
    }

    /// Get the currently loaded model name
    pub async fn get_current_model(&self) -> Option<String> {
        self.current_model_name.read().await.clone()
    }

    /// Check if a model is loaded
    pub async fn is_model_loaded(&self) -> bool {
        self.current_model.read().await.is_some()
    }

    /// Transcribe audio samples using the loaded Parakeet model and optional
    /// comma- or newline-separated vocabulary phrases.
    pub async fn transcribe_audio(
        &self,
        audio_data: Vec<f32>,
        vocabulary: Option<&str>,
    ) -> Result<String> {
        let mut model_guard = self.current_model.write().await;
        let model = model_guard
            .as_mut()
            .ok_or_else(|| anyhow!("No Parakeet model loaded. Please load a model first."))?;

        let duration_seconds = audio_data.len() as f64 / 16000.0; // Assuming 16kHz
        log::debug!(
            "Parakeet transcribing {} samples ({:.1}s duration)",
            audio_data.len(),
            duration_seconds
        );

        // Transcribe using Parakeet model
        let result = model
            .transcribe_samples(audio_data, vocabulary)
            .map_err(|e| anyhow!("Parakeet transcription failed: {}", e))?;

        log::debug!("Parakeet transcription result: '{}'", result.text);

        Ok(result.text)
    }

    /// Get the models directory path
    pub async fn get_models_directory(&self) -> PathBuf {
        self.models_dir.clone()
    }

    /// Delete a corrupted model
    pub async fn delete_model(&self, model_name: &str) -> Result<String> {
        log::info!("Attempting to delete Parakeet model: {}", model_name);

        // Get model info to find the directory path
        let model_info = {
            let models = self.available_models.read().await;
            models.get(model_name).cloned()
        };

        let model_info =
            model_info.ok_or_else(|| anyhow!("Parakeet model '{}' not found", model_name))?;

        log::info!(
            "Parakeet model '{}' has status: {:?}",
            model_name,
            model_info.status
        );

        // Allow deletion of corrupted or available models
        match &model_info.status {
            ModelStatus::Corrupted { .. } | ModelStatus::Available => {
                // Delete the entire model directory
                if model_info.path.exists() {
                    fs::remove_dir_all(&model_info.path).await
                        .map_err(|e| anyhow!("Failed to delete directory '{}': {}", model_info.path.display(), e))?;
                    log::info!("Successfully deleted Parakeet model directory: {}", model_info.path.display());
                } else {
                    log::warn!("Directory '{}' does not exist, nothing to delete", model_info.path.display());
                }

                // Update model status to Missing
                {
                    let mut models = self.available_models.write().await;
                    if let Some(model) = models.get_mut(model_name) {
                        model.status = ModelStatus::Missing;
                    }
                }

                Ok(format!("Successfully deleted Parakeet model '{}'", model_name))
            }
            _ => {
                Err(anyhow!(
                    "Can only delete corrupted or available Parakeet models. Model '{}' has status: {:?}",
                    model_name,
                    model_info.status
                ))
            }
        }
    }

    /// Download a Parakeet model from HuggingFace (backward-compatible wrapper)
    pub async fn download_model(
        &self,
        model_name: &str,
        progress_callback: Option<Box<dyn Fn(u8) + Send>>,
    ) -> Result<()> {
        // Wrap simple callback to use detailed version
        let detailed_callback: Option<Box<dyn Fn(DownloadProgress) + Send>> = progress_callback
            .map(|cb| {
                Box::new(move |p: DownloadProgress| cb(p.percent))
                    as Box<dyn Fn(DownloadProgress) + Send>
            });
        self.download_model_detailed(model_name, detailed_callback)
            .await
    }

    /// Download a Parakeet model with detailed progress (MB/speed/resume support)
    pub async fn download_model_detailed(
        &self,
        model_name: &str,
        progress_callback: Option<Box<dyn Fn(DownloadProgress) + Send>>,
    ) -> Result<()> {
        log::info!("Starting download for Parakeet model: {}", model_name);

        {
            let mut active = self.active_downloads.write().await;
            if !active.insert(model_name.to_string()) {
                log::warn!(
                    "Download already in progress for Parakeet model: {}",
                    model_name
                );
                return Err(anyhow!(
                    "Download already in progress for model: {}",
                    model_name
                ));
            }
        }
        self.cancel_downloads.write().await.remove(model_name);
        self.completed_cancellations.write().await.remove(model_name);

        let result = self
            .download_model_detailed_reserved(model_name, progress_callback)
            .await;
        if let Err(error) = &result {
            let mut models = self.available_models.write().await;
            if let Some(model) = models.get_mut(model_name) {
                model.status = if error.to_string() == DOWNLOAD_CANCELLED_MESSAGE {
                    ModelStatus::Missing
                } else {
                    ModelStatus::Error(error.to_string())
                };
            }
        }
        if result.as_ref().is_err_and(|error| error.to_string() == DOWNLOAD_CANCELLED_MESSAGE) {
            self.completed_cancellations
                .write()
                .await
                .insert(model_name.to_string());
        } else {
            self.active_downloads.write().await.remove(model_name);
            self.cancel_downloads.write().await.remove(model_name);
        }
        result
    }

    async fn download_model_detailed_reserved(
        &self,
        model_name: &str,
        progress_callback: Option<Box<dyn Fn(DownloadProgress) + Send>>,
    ) -> Result<()> {
        // Get model info
        let model_info = {
            let models = self.available_models.read().await;
            match models.get(model_name).cloned() {
                Some(info) => info,
                None => {
                    return Err(anyhow!("Model {} not found", model_name));
                }
            }
        };

        // Update model status to downloading
        {
            let mut models = self.available_models.write().await;
            if let Some(model) = models.get_mut(model_name) {
                model.status = ModelStatus::Downloading { progress: 0 };
            }
        }

        // Both v3 sources contain the same compatible ONNX export. Prefer the
        // established Hugging Face repository and fail over to this fork's
        // release assets when one CDN is temporarily unavailable.
        let base_urls = Self::download_base_urls(model_name);

        // Determine which files to download based on quantization
        let files_to_download = match model_info.quantization {
            QuantizationType::Int8 => vec![
                "encoder-model.int8.onnx",
                "decoder_joint-model.int8.onnx",
                "nemo128.onnx",
                "vocab.txt",
            ],
            QuantizationType::FP32 => vec![
                "encoder-model.onnx",
                "decoder_joint-model.onnx",
                "nemo128.onnx",
                "vocab.txt",
            ],
        };

        // Create model directory
        let model_dir = &model_info.path;
        if !model_dir.exists() {
            if let Err(e) = fs::create_dir_all(model_dir).await {
                return Err(anyhow!("Failed to create model directory: {}", e));
            }
        }

        // Optimized HTTP client for large file downloads
        let client = reqwest::Client::builder()
            .tcp_nodelay(true) // Disable Nagle's algorithm for better streaming
            .pool_max_idle_per_host(1) // Keep connection alive
            .timeout(Duration::from_secs(3600)) // 1 hour timeout for large files
            .connect_timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| anyhow!("Failed to create HTTP client: {}", e))?;

        let total_files = files_to_download.len();

        let file_sizes = Self::download_file_sizes(model_name, &model_info.quantization);

        // Calculate total expected download size
        let total_size_bytes: u64 = files_to_download
            .iter()
            .filter_map(|f| file_sizes.get(*f))
            .copied()
            .sum();

        // Check for existing downloads (complete or partial) to calculate resume offset
        let mut already_downloaded: u64 = 0;
        for filename in &files_to_download {
            let file_path = model_dir.join(filename);
            if file_path.exists() {
                if let Ok(metadata) = fs::metadata(&file_path).await {
                    let file_size = metadata.len();
                    let expected_size = file_sizes.get(*filename).copied().unwrap_or(0);
                    // Count all existing bytes (complete files capped at expected size, partial as-is)
                    // This ensures progress starts from where we left off
                    if file_size <= expected_size {
                        already_downloaded += file_size;
                    }
                }
            }
        }

        let mut total_downloaded: u64 = already_downloaded;

        // Timing for speed calculation
        let download_start_time = Instant::now();
        let mut last_report_time = Instant::now();
        let mut bytes_since_last_report: u64 = 0;
        let mut last_reported_progress: u8 = 0;

        log::info!(
            "Starting weighted download for {} files, total size: {:.2} MB (already downloaded: {:.2} MB)",
            total_files,
            total_size_bytes as f64 / 1_048_576.0,
            already_downloaded as f64 / 1_048_576.0
        );

        for (index, filename) in files_to_download.iter().enumerate() {
            let file_path = model_dir.join(filename);

            // Check for existing partial file to resume
            let existing_size: u64 = if file_path.exists() {
                fs::metadata(&file_path).await.map(|m| m.len()).unwrap_or(0)
            } else {
                0
            };

            let expected_size = file_sizes.get(*filename).copied().unwrap_or(0);

            if existing_size == expected_size && expected_size > 0 {
                log::info!(
                    "Skipping complete file: {} ({:.2} MB, expected: {:.2} MB)",
                    filename,
                    existing_size as f64 / 1_048_576.0,
                    expected_size as f64 / 1_048_576.0
                );
                continue;
            }

            if existing_size > expected_size {
                fs::remove_file(&file_path)
                    .await
                    .map_err(|e| anyhow!("Failed to remove oversized {}: {}", filename, e))?;
            }
            log::info!(
                "Downloading file {}/{}: {} (resuming from {} bytes)",
                index + 1,
                total_files,
                filename,
                existing_size.min(expected_size)
            );

            let mut source_errors = Vec::new();
            let mut completed = false;
            for base_url in &base_urls {
                if self.cancel_downloads.read().await.contains(model_name) {
                    return Err(anyhow!(DOWNLOAD_CANCELLED_MESSAGE));
                }
                let resume_size = fs::metadata(&file_path)
                    .await
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                if resume_size == expected_size {
                    completed = true;
                    break;
                }

                let file_url = format!("{}/{}", base_url, filename);
                let mut request = client.get(&file_url);
                if resume_size > 0 {
                    request = request.header("Range", format!("bytes={}-", resume_size));
                }
                let response = match timeout(Duration::from_secs(30), request.send()).await {
                    Ok(Ok(candidate)) if candidate.status().is_success() => candidate,
                    Ok(Ok(candidate)) => {
                        source_errors.push(format!("{} returned {}", base_url, candidate.status()));
                        continue;
                    }
                    Ok(Err(error)) => {
                        source_errors.push(format!("{}: {}", base_url, error));
                        continue;
                    }
                    Err(_) => {
                        source_errors.push(format!("{} timed out waiting for response headers", base_url));
                        continue;
                    }
                };

                let (file_total_size, resuming) =
                    if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
                        let content_range = response
                            .headers()
                            .get(reqwest::header::CONTENT_RANGE)
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default();
                        let expected_prefix = format!("bytes {}-", resume_size);
                        let expected_suffix = format!("/{}", expected_size);
                        let remaining = response.content_length().unwrap_or(0);
                        if !content_range.starts_with(&expected_prefix)
                            || !content_range.ends_with(&expected_suffix)
                            || resume_size + remaining != expected_size
                        {
                            source_errors.push(format!(
                                "{} returned unexpected resume range {}",
                                base_url, content_range
                            ));
                            continue;
                        }
                        (resume_size + remaining, resume_size > 0)
                    } else {
                        let reported_size = response.content_length().unwrap_or(0);
                        if reported_size != expected_size {
                            source_errors.push(format!(
                                "{} reports {} bytes, expected {}",
                                base_url, reported_size, expected_size
                            ));
                            continue;
                        }
                        (reported_size, false)
                    };

                log::info!("Downloading {} from {}", filename, base_url);
                let file = if resuming {
                    fs::OpenOptions::new()
                        .append(true)
                        .open(&file_path)
                        .await
                        .map_err(|e| {
                            anyhow!("Failed to open file for resume {}: {}", filename, e)
                        })?
                } else {
                    total_downloaded = total_downloaded.saturating_sub(resume_size);
                    fs::File::create(&file_path)
                        .await
                        .map_err(|e| anyhow!("Failed to create file {}: {}", filename, e))?
                };
                let mut writer = BufWriter::with_capacity(8 * 1024 * 1024, file);
                use futures_util::StreamExt;
                let mut stream = response.bytes_stream();
                let mut file_downloaded = if resuming { resume_size } else { 0 };
                let mut transfer_error = None;

                loop {
                    if self.cancel_downloads.read().await.contains(model_name) {
                        let _ = writer.flush().await;
                        return Err(anyhow!(DOWNLOAD_CANCELLED_MESSAGE));
                    }

                    let chunk = match timeout(Duration::from_secs(30), stream.next()).await {
                        Err(_) => {
                            transfer_error = Some("no data received for 30 seconds".to_string());
                            break;
                        }
                        Ok(None) => break,
                        Ok(Some(Err(error))) => {
                            transfer_error = Some(error.to_string());
                            break;
                        }
                        Ok(Some(Ok(chunk))) => chunk,
                    };

                    writer
                        .write_all(&chunk)
                        .await
                        .map_err(|e| anyhow!("Failed to write chunk to file: {}", e))?;
                    let chunk_len = chunk.len() as u64;
                    file_downloaded += chunk_len;
                    total_downloaded += chunk_len;
                    bytes_since_last_report += chunk_len;

                    let overall_progress = if total_size_bytes > 0 {
                        ((total_downloaded as f64 / total_size_bytes as f64) * 100.0).min(99.0)
                            as u8
                    } else {
                        ((index as f64 + (file_downloaded as f64 / file_total_size.max(1) as f64))
                            / total_files as f64
                            * 100.0) as u8
                    };
                    let elapsed_since_report = last_report_time.elapsed();
                    if overall_progress > last_reported_progress
                        || elapsed_since_report >= Duration::from_millis(500)
                        || file_downloaded >= file_total_size
                    {
                        let speed_mbps = if elapsed_since_report.as_secs_f64() >= 0.1 {
                            (bytes_since_last_report as f64 / (1024.0 * 1024.0))
                                / elapsed_since_report.as_secs_f64()
                        } else {
                            0.0
                        };
                        last_reported_progress = overall_progress;
                        last_report_time = Instant::now();
                        bytes_since_last_report = 0;
                        if let Some(ref callback) = progress_callback {
                            callback(DownloadProgress::new(
                                total_downloaded,
                                total_size_bytes,
                                speed_mbps,
                            ));
                        }
                        if let Some(model) = self.available_models.write().await.get_mut(model_name)
                        {
                            model.status = ModelStatus::Downloading {
                                progress: overall_progress,
                            };
                        }
                    }
                }

                writer
                    .flush()
                    .await
                    .map_err(|e| anyhow!("Failed to flush file {}: {}", filename, e))?;
                let final_size = fs::metadata(&file_path)
                    .await
                    .map_err(|e| anyhow!("Failed to inspect {}: {}", filename, e))?
                    .len();
                if final_size == expected_size {
                    completed = true;
                    break;
                }
                source_errors.push(format!(
                    "{} stopped at {} of {} bytes{}",
                    base_url,
                    final_size,
                    expected_size,
                    transfer_error
                        .map(|error| format!(": {}", error))
                        .unwrap_or_default()
                ));
            }

            if self.cancel_downloads.read().await.contains(model_name) {
                return Err(anyhow!(DOWNLOAD_CANCELLED_MESSAGE));
            }
            if !completed {
                return Err(anyhow!(
                    "Could not download {} from any available source. Check your connection, VPN, firewall, or proxy, then retry. Details: {}",
                    filename,
                    source_errors.join("; ")
                ));
            }

            log::info!(
                "Completed download: {} ({:.2} MB, overall progress: {:.1}%)",
                filename,
                expected_size as f64 / 1_048_576.0,
                (total_downloaded as f64 / total_size_bytes as f64) * 100.0
            );
        }

        if self.cancel_downloads.read().await.contains(model_name) {
            return Err(anyhow!(DOWNLOAD_CANCELLED_MESSAGE));
        }
        self.validate_model_directory(model_dir)
            .await
            .map_err(|error| anyhow!("Downloaded Parakeet model failed validation: {}", error))?;

        // Report 100% only after every file passes exact validation.
        let total_elapsed = download_start_time.elapsed().as_secs_f64();
        let final_speed = if total_elapsed > 0.0 {
            ((total_downloaded - already_downloaded) as f64 / (1024.0 * 1024.0)) / total_elapsed
        } else {
            0.0
        };
        let final_progress = DownloadProgress::new(total_size_bytes, total_size_bytes, final_speed);
        if let Some(ref callback) = progress_callback {
            callback(final_progress);
        }

        // Update model status to available
        {
            let mut models = self.available_models.write().await;
            if let Some(model) = models.get_mut(model_name) {
                model.status = ModelStatus::Available;
                model.path = model_dir.clone();
            }
        }

        log::info!("Download completed for Parakeet model: {}", model_name);
        Ok(())
    }

    /// Cancel an ongoing model download
    pub async fn cancel_download(&self, model_name: &str) -> Result<()> {
        log::info!("Cancelling download for Parakeet model: {}", model_name);

        if !self.active_downloads.read().await.contains(model_name) {
            return Err(anyhow!("No download in progress for model: {}", model_name));
        }
        self.cancel_downloads
            .write()
            .await
            .insert(model_name.to_string());

        // The worker flushes and retains partial files so a later attempt can
        // resume instead of redownloading hundreds of megabytes.

        Ok(())
    }

    pub(crate) async fn cancellation_completed(&self, model_name: &str) -> bool {
        self.completed_cancellations.read().await.contains(model_name)
    }

    pub(crate) async fn release_cancelled_download(&self, model_name: &str) {
        self.completed_cancellations.write().await.remove(model_name);
        self.cancel_downloads.write().await.remove(model_name);
        self.active_downloads.write().await.remove(model_name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v3_download_prefers_hugging_face_with_github_fallback() {
        assert_eq!(
            ParakeetEngine::download_base_urls("parakeet-tdt-0.6b-v3-int8"),
            vec![
                "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main",
                "https://github.com/TylerBuza/Meetily-ActuallyFree/releases/download/parakeet-tdt-0.6b-v3-onnx",
            ]
        );
    }

    #[test]
    fn published_int8_sizes_are_exact() {
        assert_eq!(
            ParakeetEngine::download_file_sizes(
                "parakeet-tdt-0.6b-v2-int8",
                &QuantizationType::Int8,
            )["encoder-model.int8.onnx"],
            652_184_014,
        );
        assert_eq!(
            ParakeetEngine::download_file_sizes(
                "parakeet-tdt-0.6b-v3-int8",
                &QuantizationType::Int8,
            )["decoder_joint-model.int8.onnx"],
            18_202_004,
        );
    }

    #[tokio::test]
    async fn v3_validation_requires_exact_published_sizes() {
        let temp = tempfile::tempdir().expect("tempdir");
        let model_dir = temp.path().join("parakeet-tdt-0.6b-v3-int8");
        fs::create_dir_all(&model_dir)
            .await
            .expect("model directory");
        for (name, size) in [
            ("encoder-model.int8.onnx", 652_183_999),
            ("decoder_joint-model.int8.onnx", 18_202_004),
            ("nemo128.onnx", 139_764),
            ("vocab.txt", 93_939),
        ] {
            let file = fs::File::create(model_dir.join(name))
                .await
                .expect("model file");
            file.set_len(size).await.expect("model size");
        }

        let engine =
            ParakeetEngine::new_with_models_dir(Some(temp.path().to_path_buf())).expect("engine");
        engine
            .validate_model_directory(&model_dir)
            .await
            .expect("exact model");

        let encoder = fs::OpenOptions::new()
            .write(true)
            .open(model_dir.join("encoder-model.int8.onnx"))
            .await
            .expect("encoder");
        encoder
            .set_len(652_183_998)
            .await
            .expect("truncate encoder");
        assert!(engine.validate_model_directory(&model_dir).await.is_err());
    }

    #[tokio::test]
    async fn download_published_v3_model() {
        if std::env::var_os("PARAKEET_DOWNLOAD_TEST").is_none() {
            return;
        }
        let temp = tempfile::tempdir().expect("tempdir");
        let engine = ParakeetEngine::new_with_models_dir(Some(temp.path().to_path_buf()))
            .expect("engine");
        engine.discover_models().await.expect("discover models");
        engine
            .download_model_detailed("parakeet-tdt-0.6b-v3-int8", None)
            .await
            .expect("download model");
        let model_dir = temp
            .path()
            .join("parakeet")
            .join("parakeet-tdt-0.6b-v3-int8");
        engine
            .validate_model_directory(&model_dir)
            .await
            .expect("validate model");
    }
}

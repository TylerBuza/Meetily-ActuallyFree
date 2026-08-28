use crate::config::WHISPER_MODEL_CATALOG;
use crate::whisper_engine::{ModelInfo, WhisperEngine};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{command, AppHandle, Emitter, Manager, Runtime};

const MIN_CUDA_DRIVER: (u32, u32) = (580, 0);
const MIN_CUDA_COMPUTE_CAPABILITY: (u32, u32) = (7, 5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
enum CudaDriverState {
    NotApplicable,
    MissingDriver,
    OutdatedDriver,
    UnsupportedGpu,
    QueryFailed,
    Ready,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CudaReconfigurationStatus {
    compiled_backend: String,
    nvidia_gpu_detected: bool,
    driver_state: CudaDriverState,
    driver_update_required: bool,
    reconfiguration_required: bool,
    setup_download_url: Option<String>,
}

fn parse_version_pair(value: &str) -> Option<(u32, u32)> {
    let mut parts = value.lines().next()?.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor))
}

fn classify_cuda_driver(
    nvidia_hardware: bool,
    nvidia_smi_available: bool,
    driver_version: Option<&str>,
    compute_capability: Option<&str>,
) -> CudaDriverState {
    if !nvidia_hardware && !nvidia_smi_available {
        return CudaDriverState::NotApplicable;
    }
    if !nvidia_smi_available {
        return CudaDriverState::MissingDriver;
    }
    let Some(driver_version) = driver_version.and_then(parse_version_pair) else {
        return CudaDriverState::QueryFailed;
    };
    if driver_version < MIN_CUDA_DRIVER {
        return CudaDriverState::OutdatedDriver;
    }
    let Some(compute_capability) = compute_capability.and_then(parse_version_pair) else {
        return CudaDriverState::QueryFailed;
    };
    if compute_capability < MIN_CUDA_COMPUTE_CAPABILITY {
        CudaDriverState::UnsupportedGpu
    } else {
        CudaDriverState::Ready
    }
}

#[cfg(target_os = "windows")]
fn has_nvidia_display_adapter() -> bool {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let Ok(pci) = hklm.open_subkey_with_flags(
        "SYSTEM\\CurrentControlSet\\Enum\\PCI",
        KEY_READ | KEY_WOW64_64KEY,
    ) else {
        return false;
    };
    pci.enum_keys().flatten().any(|device_name| {
        if !device_name
            .get(..8)
            .is_some_and(|vendor| vendor.eq_ignore_ascii_case("VEN_10DE"))
        {
            return false;
        }
        let Ok(device) = pci.open_subkey_with_flags(&device_name, KEY_READ | KEY_WOW64_64KEY)
        else {
            return false;
        };
        device.enum_keys().flatten().any(|instance_name| {
            let Ok(instance) =
                device.open_subkey_with_flags(instance_name, KEY_READ | KEY_WOW64_64KEY)
            else {
                return false;
            };
            instance
                .get_value::<String, _>("ClassGUID")
                .is_ok_and(|class_guid| {
                    class_guid.eq_ignore_ascii_case("{4d36e968-e325-11ce-bfc1-08002be10318}")
                })
        })
    })
}

#[cfg(target_os = "windows")]
fn nvidia_smi_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(windows) = std::env::var_os("WINDIR") {
        candidates.push(
            PathBuf::from(windows)
                .join("System32")
                .join("nvidia-smi.exe"),
        );
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("NVIDIA Corporation")
                .join("NVSMI")
                .join("nvidia-smi.exe"),
        );
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(target_os = "windows")]
fn run_nvidia_smi(path: &std::path::Path, query: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut command = Command::new(path);
    command
        .args(["--id=0", query, "--format=csv,noheader,nounits"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().ok()?;
                return status
                    .success()
                    .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string());
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => {
                if child.kill().is_ok() {
                    let _ = child.wait();
                }
                return None;
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_cuda_reconfiguration_status() -> CudaReconfigurationStatus {
    let compiled_backend = super::acceleration::WhisperCompiledBackend::current()
        .as_str()
        .to_string();
    let nvidia_hardware = has_nvidia_display_adapter();
    let nvidia_smi = nvidia_smi_path();
    let driver_version = nvidia_smi
        .as_deref()
        .and_then(|path| run_nvidia_smi(path, "--query-gpu=driver_version"));
    let compute_capability = driver_version
        .as_deref()
        .and_then(parse_version_pair)
        .filter(|version| *version >= MIN_CUDA_DRIVER)
        .and_then(|_| nvidia_smi.as_deref())
        .and_then(|path| run_nvidia_smi(path, "--query-gpu=compute_cap"));
    let driver_state = classify_cuda_driver(
        nvidia_hardware,
        nvidia_smi.is_some(),
        driver_version.as_deref(),
        compute_capability.as_deref(),
    );
    let cuda_compiled = compiled_backend.eq_ignore_ascii_case("cuda");

    CudaReconfigurationStatus {
        compiled_backend,
        nvidia_gpu_detected: nvidia_hardware || nvidia_smi.is_some(),
        driver_state,
        driver_update_required: matches!(
            driver_state,
            CudaDriverState::MissingDriver
                | CudaDriverState::OutdatedDriver
                | CudaDriverState::QueryFailed
        ),
        reconfiguration_required: driver_state == CudaDriverState::Ready && !cuda_compiled,
        setup_download_url: Some(format!(
            "https://github.com/TylerBuza/Meetily-ActuallyFree/releases/download/v{version}/Meetily-ActuallyFree-{version}-x64-universal-setup.exe",
            version = env!("CARGO_PKG_VERSION"),
        )),
    }
}

// Global whisper engine
pub static WHISPER_ENGINE: Mutex<Option<Arc<WhisperEngine>>> = Mutex::new(None);

// Global models directory path (set during app initialization)
static MODELS_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Initialize the models directory path using app_data_dir
/// This should be called during app setup before whisper_init
pub fn set_models_directory<R: Runtime>(app: &AppHandle<R>) {
    let _ = app; // portable build resolves models relative to the executable
    let models_dir = crate::paths::models_dir();

    // Create directory if it doesn't exist
    if !models_dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&models_dir) {
            log::error!("Failed to create models directory: {}", e);
            return;
        }
    }

    log::info!("Models directory set to: {}", models_dir.display());

    let mut guard = MODELS_DIR.lock().unwrap();
    *guard = Some(models_dir);
}

/// Get the configured models directory
fn get_models_directory() -> Option<PathBuf> {
    MODELS_DIR.lock().unwrap().clone()
}

#[command]
pub async fn whisper_init() -> Result<(), String> {
    let mut guard = WHISPER_ENGINE.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }

    let models_dir = get_models_directory();
    let engine = WhisperEngine::new_with_models_dir(models_dir)
        .map_err(|e| format!("Failed to initialize whisper engine: {}", e))?;
    *guard = Some(Arc::new(engine));
    Ok(())
}

#[command]
pub async fn whisper_get_available_models() -> Result<Vec<ModelInfo>, String> {
    let engine = {
        let guard = WHISPER_ENGINE.lock().unwrap();
        guard.as_ref().cloned()
    };

    if let Some(engine) = engine {
        engine
            .discover_models()
            .await
            .map_err(|e| format!("Failed to discover models: {}", e))
    } else {
        // Fallback: scan models directory directly without initialized engine
        log::info!("Whisper engine not initialized, scanning models directory directly");
        discover_models_standalone()
    }
}

/// Discover Whisper models by scanning the models directory directly
/// Used when the Whisper engine isn't initialized (e.g., when using Parakeet for live transcription)
fn discover_models_standalone() -> Result<Vec<ModelInfo>, String> {
    use crate::whisper_engine::ModelStatus;

    let models_dir =
        get_models_directory().ok_or_else(|| "Models directory not initialized".to_string())?;

    // Whisper models are stored directly in the models directory (not in a whisper subdirectory)
    let whisper_dir = models_dir.clone();

    log::info!("Scanning for Whisper models in: {}", whisper_dir.display());

    // Use centralized model catalog from config.rs
    let model_configs = WHISPER_MODEL_CATALOG;

    let mut models = Vec::new();

    for &(name, filename, size_mb, accuracy, speed, description) in model_configs {
        let model_path = whisper_dir.join(filename);
        let status = if model_path.exists() {
            match std::fs::metadata(&model_path) {
                Ok(metadata) => {
                    let file_size_mb = metadata.len() / (1024 * 1024);
                    if file_size_mb >= 1 {
                        ModelStatus::Available
                    } else {
                        ModelStatus::Missing
                    }
                }
                Err(_) => ModelStatus::Missing,
            }
        } else {
            ModelStatus::Missing
        };

        models.push(ModelInfo {
            name: name.to_string(),
            path: model_path,
            size_mb,
            status,
            accuracy: accuracy.to_string(),
            speed: speed.to_string(),
            description: description.to_string(),
        });
    }

    let downloaded_count = models
        .iter()
        .filter(|m| matches!(m.status, ModelStatus::Available))
        .count();
    log::info!("Found {} downloaded Whisper models", downloaded_count);

    Ok(models)
}

#[command]
pub async fn whisper_load_model(
    app_handle: tauri::AppHandle,
    model_name: String,
) -> Result<(), String> {
    let engine = {
        let guard = WHISPER_ENGINE.lock().unwrap();
        guard.as_ref().cloned()
    };

    if let Some(engine) = engine {
        // Free builtin LLM before loading STT so they never share VRAM.
        crate::audio::common::prepare_for_stt().await;

        // FIX 6: Emit model loading started event
        if let Err(e) = app_handle.emit(
            "model-loading-started",
            serde_json::json!({
                "modelName": model_name
            }),
        ) {
            log::error!("Failed to emit model-loading-started event: {}", e);
        }

        let result = engine
            .load_model(&model_name)
            .await
            .map_err(|e| format!("Failed to load model: {}", e));

        // FIX 6: Emit model loading completed/failed event
        if result.is_ok() {
            crate::audio::common::mark_stt_activity();
            if let Err(e) = app_handle.emit(
                "model-loading-completed",
                serde_json::json!({
                    "modelName": model_name
                }),
            ) {
                log::error!("Failed to emit model-loading-completed event: {}", e);
            }
        } else if let Err(ref error) = result {
            if let Err(e) = app_handle.emit(
                "model-loading-failed",
                serde_json::json!({
                    "modelName": model_name,
                    "error": error
                }),
            ) {
                log::error!("Failed to emit model-loading-failed event: {}", e);
            }
        }

        result
    } else {
        Err("Whisper engine not initialized".to_string())
    }
}

#[command]
pub async fn whisper_get_current_model() -> Result<Option<String>, String> {
    let engine = {
        let guard = WHISPER_ENGINE.lock().unwrap();
        guard.as_ref().cloned()
    };

    if let Some(engine) = engine {
        Ok(engine.get_current_model().await)
    } else {
        Err("Whisper engine not initialized".to_string())
    }
}

#[command]
pub async fn whisper_is_model_loaded() -> Result<bool, String> {
    let engine = {
        let guard = WHISPER_ENGINE.lock().unwrap();
        guard.as_ref().cloned()
    };

    if let Some(engine) = engine {
        Ok(engine.is_model_loaded().await)
    } else {
        Err("Whisper engine not initialized".to_string())
    }
}

#[command]
pub async fn whisper_unload_model() -> Result<bool, String> {
    crate::audio::common::force_unload_stt().await.map(|_| true)
}

/// Force-unload Whisper + Parakeet (settings / local stack panel).
#[command]
pub async fn force_unload_stt_models() -> Result<(), String> {
    crate::audio::common::force_unload_stt().await
}

/// Free STT + builtin LLM (settings “Free all memory”).
#[command]
pub async fn force_unload_all_models() -> Result<(), String> {
    crate::audio::common::force_unload_all().await
}

/// Snapshot of what is loaded locally for the Local Stack settings page.
#[command]
pub async fn get_local_stack_status() -> Result<serde_json::Value, String> {
    let whisper_loaded = {
        let engine = {
            let guard = WHISPER_ENGINE.lock().unwrap();
            guard.as_ref().cloned()
        };
        match engine {
            Some(e) => e.is_model_loaded().await,
            None => false,
        }
    };
    let whisper_model = {
        let engine = {
            let guard = WHISPER_ENGINE.lock().unwrap();
            guard.as_ref().cloned()
        };
        match engine {
            Some(e) => e.get_current_model().await,
            None => None,
        }
    };

    let (parakeet_loaded, parakeet_model) = {
        use crate::parakeet_engine::commands::PARAKEET_ENGINE;
        let engine = {
            let guard = PARAKEET_ENGINE.lock().unwrap_or_else(|e| e.into_inner());
            guard.as_ref().cloned()
        };
        match engine {
            Some(e) => (e.is_model_loaded().await, e.get_current_model().await),
            None => (false, None),
        }
    };

    let recording = crate::audio::recording_commands::is_recording().await;
    let models_dir = crate::paths::models_dir();
    let models_bytes = crate::audio::common::dir_size_bytes(&models_dir);
    let data_bytes = crate::audio::common::dir_size_bytes(&crate::paths::install_data_root());

    // Cloud BYOK keys present → network may be used for summaries.
    let cloud_keys = {
        // Best-effort: if any non-empty API key is stored, flag it.
        // Actual traffic still only happens when the user picks a cloud provider.
        false // filled below if we can open DB; keep simple for now
    };
    let _ = cloud_keys;

    // Rough VRAM hint from what's loaded (not a GPU query — portable estimate).
    let vram_hint_mb = {
        let mut m = 0u32;
        if whisper_loaded {
            m += 1500; // typical medium/large whisper
        }
        if parakeet_loaded {
            m += 600;
        }
        // Builtin LLM size unknown without probing sidecar; add if STT free path
        m
    };

    Ok(serde_json::json!({
        "recording": recording,
        "whisper": {
            "loaded": whisper_loaded,
            "model": whisper_model,
        },
        "parakeet": {
            "loaded": parakeet_loaded,
            "model": parakeet_model,
        },
        "sttIdleUnloadSecs": crate::audio::common::STT_IDLE_UNLOAD_SECS,
        "llmIdleUnloadSecs": crate::summary::summary_engine::DEFAULT_IDLE_TIMEOUT_SECS,
        "sttLastUnloadSecs": crate::audio::common::stt_last_unload_secs(),
        "llmLastUnloadSecs": crate::audio::common::llm_last_unload_secs(),
        "modelsDirBytes": models_bytes,
        "dataDirBytes": data_bytes,
        "modelsDir": models_dir.to_string_lossy(),
        "vramHintMb": vram_hint_mb,
        "cuda": cfg!(feature = "cuda"),
        "vulkan": cfg!(feature = "vulkan"),
        "sttBackend": super::acceleration::WhisperCompiledBackend::current().as_str(),
        "networkPolicy": "local-first",
        "networkNote": "No telemetry. Cloud LLM only if you add an API key and select that provider.",
    }))
}

/// Recheck whether a Windows NVIDIA driver now supports the CUDA build selected
/// by setup. CUDA and Vulkan are separate executables, so a newly ready CUDA
/// driver requires rerunning setup rather than changing the active process.
#[command]
pub async fn get_cuda_reconfiguration_status() -> Result<CudaReconfigurationStatus, String> {
    #[cfg(target_os = "windows")]
    {
        return tauri::async_runtime::spawn_blocking(windows_cuda_reconfiguration_status)
            .await
            .map_err(|error| format!("Failed to recheck CUDA availability: {error}"));
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(CudaReconfigurationStatus {
            compiled_backend: super::acceleration::WhisperCompiledBackend::current()
                .as_str()
                .to_string(),
            nvidia_gpu_detected: false,
            driver_state: CudaDriverState::NotApplicable,
            driver_update_required: false,
            reconfiguration_required: false,
            setup_download_url: None,
        })
    }
}

#[command]
pub async fn whisper_has_available_models() -> Result<bool, String> {
    let engine = {
        let guard = WHISPER_ENGINE.lock().unwrap();
        guard.as_ref().cloned()
    };

    if let Some(engine) = engine {
        let models = engine
            .discover_models()
            .await
            .map_err(|e| format!("Failed to discover models: {}", e))?;

        // Check if at least one model is available
        let available_models: Vec<_> = models
            .iter()
            .filter(|model| matches!(model.status, crate::whisper_engine::ModelStatus::Available))
            .collect();

        Ok(!available_models.is_empty())
    } else {
        Ok(false)
    }
}

#[command]
pub async fn whisper_validate_model_ready() -> Result<String, String> {
    let engine = {
        let guard = WHISPER_ENGINE.lock().unwrap();
        guard.as_ref().cloned()
    };

    if let Some(engine) = engine {
        // Check if a model is currently loaded
        if engine.is_model_loaded().await {
            if let Some(current_model) = engine.get_current_model().await {
                return Ok(current_model);
            }
        }

        // No model loaded, check if any models are available to load
        let models = engine
            .discover_models()
            .await
            .map_err(|e| format!("Failed to discover models: {}", e))?;

        let available_models: Vec<_> = models
            .iter()
            .filter(|model| matches!(model.status, crate::whisper_engine::ModelStatus::Available))
            .collect();

        if available_models.is_empty() {
            return Err(
                "No Whisper models are available. Please download a model to enable transcription."
                    .to_string(),
            );
        }

        // Try to load the first available model
        let first_model = &available_models[0];
        engine
            .load_model(&first_model.name)
            .await
            .map_err(|e| format!("Failed to load model {}: {}", first_model.name, e))?;

        Ok(first_model.name.clone())
    } else {
        Err("Whisper engine not initialized".to_string())
    }
}

/// Internal version of whisper_validate_model_ready that respects user's transcript config
pub async fn whisper_validate_model_ready_with_config<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<String, String> {
    let engine = {
        let guard = WHISPER_ENGINE.lock().unwrap();
        guard.as_ref().cloned()
    };

    if let Some(engine) = engine {
        // Check if a model is currently loaded
        if engine.is_model_loaded().await {
            if let Some(current_model) = engine.get_current_model().await {
                log::info!("Model already loaded: {}", current_model);
                return Ok(current_model);
            }
        }

        // No model loaded - try to load user's configured model from transcript config
        let model_to_load = match crate::api::api::api_get_transcript_config(
            app.clone(),
            app.state(),
            None,
        )
        .await
        {
            Ok(Some(config)) => {
                log::info!(
                    "Got transcript config from API - provider: {}, model: {}",
                    config.provider,
                    config.model
                );
                if config.provider == "localWhisper" && !config.model.is_empty() {
                    log::info!("Using user's configured model: {}", config.model);
                    Some(config.model)
                } else {
                    log::info!(
                        "API config uses non-local provider ({}) or empty model, will auto-select",
                        config.provider
                    );
                    None
                }
            }
            Ok(None) => {
                log::info!("No transcript config found in API, will auto-select model");
                None
            }
            Err(e) => {
                log::warn!(
                    "Failed to get transcript config from API: {}, will auto-select model",
                    e
                );
                None
            }
        };

        // Check available models
        let models = engine
            .discover_models()
            .await
            .map_err(|e| format!("Failed to discover models: {}", e))?;

        let available_models: Vec<_> = models
            .iter()
            .filter(|model| matches!(model.status, crate::whisper_engine::ModelStatus::Available))
            .collect();

        if available_models.is_empty() {
            return Err(
                "No Whisper models are available. Please download a model to enable transcription."
                    .to_string(),
            );
        }

        // Try to load user's configured model if specified
        let model_name = if let Some(configured_model) = model_to_load {
            // Check if configured model is available
            if available_models.iter().any(|m| m.name == configured_model) {
                log::info!("Loading user's configured model: {}", configured_model);
                configured_model
            } else {
                log::warn!(
                    "Configured model '{}' not found, falling back to first available: {}",
                    configured_model,
                    available_models[0].name
                );
                available_models[0].name.clone()
            }
        } else {
            // No configured model, use first available
            log::info!(
                "No configured model, loading first available: {}",
                available_models[0].name
            );
            available_models[0].name.clone()
        };

        engine
            .load_model(&model_name)
            .await
            .map_err(|e| format!("Failed to load model {}: {}", model_name, e))?;

        Ok(model_name)
    } else {
        Err("Whisper engine not initialized".to_string())
    }
}

#[command]
pub async fn whisper_transcribe_audio<R: Runtime>(
    app: AppHandle<R>,
    audio_data: Vec<f32>,
) -> Result<String, String> {
    let engine = {
        let guard = WHISPER_ENGINE.lock().unwrap();
        guard.as_ref().cloned()
    };

    if let Some(engine) = engine {
        // Get language preference
        let language = crate::get_language_preference_internal();
        let initial_prompt = match app.try_state::<crate::state::AppState>() {
            Some(state) => {
                crate::database::repositories::vocabulary::VocabularyRepository::get_effective(
                state.db_manager.pool(),
                None,
            )
            .await
                .map_err(|error| error.to_string())?
            }
            None => None,
        };
        engine
            .transcribe_audio(audio_data, language, initial_prompt.as_deref())
            .await
            .map_err(|e| format!("Transcription failed: {}", e))
    } else {
        Err("Whisper engine not initialized".to_string())
    }
}

#[command]
pub async fn whisper_get_models_directory() -> Result<String, String> {
    let engine = {
        let guard = WHISPER_ENGINE.lock().unwrap();
        guard.as_ref().cloned()
    };

    if let Some(engine) = engine {
        let path = engine.get_models_directory().await;
        Ok(path.to_string_lossy().to_string())
    } else {
        Err("Whisper engine not initialized".to_string())
    }
}

#[command]
pub async fn whisper_download_model(
    app_handle: tauri::AppHandle,
    model_name: String,
) -> Result<(), String> {
    let engine = {
        let guard = WHISPER_ENGINE.lock().unwrap();
        guard.as_ref().cloned()
    };

    if let Some(engine) = engine {
        // Create progress callback that emits events
        let app_handle_clone = app_handle.clone();
        let model_name_clone = model_name.clone();

        let progress_callback = Box::new(move |progress: u8| {
            log::info!("Download progress for {}: {}%", model_name_clone, progress);

            // Emit download progress event
            if let Err(e) = app_handle_clone.emit(
                "model-download-progress",
                serde_json::json!({
                    "modelName": model_name_clone,
                    "progress": progress
                }),
            ) {
                log::error!("Failed to emit download progress event: {}", e);
            }
        });

        let result = engine
            .download_model(&model_name, Some(progress_callback))
            .await;

        match result {
            Ok(()) => {
                // Emit completion event
                if let Err(e) = app_handle.emit(
                    "model-download-complete",
                    serde_json::json!({
                        "modelName": model_name
                    }),
                ) {
                    log::error!("Failed to emit download complete event: {}", e);
                }
                Ok(())
            }
            Err(e) => {
                // Emit error event
                if let Err(emit_e) = app_handle.emit(
                    "model-download-error",
                    serde_json::json!({
                        "modelName": model_name,
                        "error": e.to_string()
                    }),
                ) {
                    log::error!("Failed to emit download error event: {}", emit_e);
                }
                Err(format!("Failed to download model: {}", e))
            }
        }
    } else {
        Err("Whisper engine not initialized".to_string())
    }
}

#[command]
pub async fn whisper_cancel_download(model_name: String) -> Result<(), String> {
    let engine = {
        let guard = WHISPER_ENGINE.lock().unwrap();
        guard.as_ref().cloned()
    };

    if let Some(engine) = engine {
        engine
            .cancel_download(&model_name)
            .await
            .map_err(|e| format!("Failed to cancel download: {}", e))
    } else {
        Err("Whisper engine not initialized".to_string())
    }
}

#[command]
pub async fn whisper_delete_corrupted_model(model_name: String) -> Result<String, String> {
    let engine = {
        let guard = WHISPER_ENGINE.lock().unwrap();
        guard.as_ref().cloned()
    };

    if let Some(engine) = engine {
        engine
            .delete_model(&model_name)
            .await
            .map_err(|e| format!("Failed to delete model: {}", e))
    } else {
        Err("Whisper engine not initialized".to_string())
    }
}

/// Open the models folder in the system file explorer
#[command]
pub async fn open_models_folder() -> Result<(), String> {
    let models_dir =
        get_models_directory().ok_or_else(|| "Models directory not initialized".to_string())?;

    // Ensure directory exists before trying to open it
    if !models_dir.exists() {
        std::fs::create_dir_all(&models_dir)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    let folder_path = models_dir.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&folder_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&folder_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&folder_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    log::info!("Opened models folder: {}", folder_path);
    Ok(())
}

#[cfg(test)]
mod cuda_reconfiguration_tests {
    use super::*;

    #[test]
    fn version_parser_handles_driver_and_compute_values() {
        assert_eq!(parse_version_pair("610.74\r\n"), Some((610, 74)));
        assert_eq!(parse_version_pair("12.0"), Some((12, 0)));
        assert_eq!(parse_version_pair("invalid"), None);
    }

    #[test]
    fn fresh_nvidia_install_requires_a_driver() {
        assert_eq!(
            classify_cuda_driver(true, false, None, None),
            CudaDriverState::MissingDriver
        );
    }

    #[test]
    fn current_driver_and_supported_gpu_are_ready() {
        assert_eq!(
            classify_cuda_driver(true, true, Some("610.74"), Some("12.0")),
            CudaDriverState::Ready
        );
    }

    #[test]
    fn old_driver_and_old_gpu_have_distinct_results() {
        assert_eq!(
            classify_cuda_driver(true, true, Some("579.99"), Some("12.0")),
            CudaDriverState::OutdatedDriver
        );
        assert_eq!(
            classify_cuda_driver(true, true, Some("610.74"), Some("7.0")),
            CudaDriverState::UnsupportedGpu
        );
    }

    #[test]
    fn status_serializes_for_the_frontend_contract() {
        let status = CudaReconfigurationStatus {
            compiled_backend: "Vulkan".to_string(),
            nvidia_gpu_detected: true,
            driver_state: CudaDriverState::Ready,
            driver_update_required: false,
            reconfiguration_required: true,
            setup_download_url: Some("https://example.test/setup.exe".to_string()),
        };
        let value = serde_json::to_value(status).unwrap();

        assert_eq!(value["compiledBackend"], "Vulkan");
        assert_eq!(value["driverState"], "ready");
        assert_eq!(value["reconfigurationRequired"], true);
        assert_eq!(value["setupDownloadUrl"], "https://example.test/setup.exe");
    }
}

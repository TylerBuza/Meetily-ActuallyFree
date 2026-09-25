//! One packaged Windows runtime for CPU speech models and DirectML diarization.
//! Do not search PATH or accept an environment-selected DLL for the desktop app.

pub const START_ERROR_CODE: &str = "TRANSCRIPTION_RUNTIME_INITIALIZATION_FAILED";

#[derive(Debug, thiserror::Error)]
#[error("Speech recognition could not initialize: {0}")]
pub struct InitializationError(#[source] pub anyhow::Error);

#[cfg(windows)]
static RUNTIME_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
#[cfg(windows)]
static INITIALIZED: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
#[cfg(windows)]
static DIRECTML: std::sync::OnceLock<libloading::Library> = std::sync::OnceLock::new();

#[cfg(windows)]
pub fn initialize<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    if let Ok(path) = app.path().resolve("binaries/onnxruntime/onnxruntime.dll", tauri::path::BaseDirectory::Resource) {
        let _ = RUNTIME_PATH.set(path);
    }
    if let Err(error) = ensure_available() {
        log::error!("Bundled ONNX Runtime unavailable: {error}");
    }
}

pub fn ensure_available() -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        let initialized = INITIALIZED.get_or_init(|| {
            let path = RUNTIME_PATH.get_or_init(|| {
                #[cfg(test)]
                { std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/onnxruntime/onnxruntime.dll") }
                #[cfg(not(test))]
                { std::env::current_exe().unwrap_or_default().with_file_name("binaries").join("onnxruntime/onnxruntime.dll") }
            });
            initialize_library(path)
        });
        initialized.as_ref().map_err(|error| anyhow::anyhow!("{error}"))?;
    }
    Ok(())
}

#[cfg(windows)]
fn initialize_library(path: &std::path::Path) -> Result<(), String> {
    if !path.is_absolute() || !path.is_file() {
        return Err("The bundled ONNX Runtime is missing. Repair or reinstall Meetily, then restart it.".into());
    }
    // Preflight OS loading and the expected export as a Result, so a missing
    // dependency does not trigger ort's panic-based dynamic-loader failure.
    // SAFETY: the build/package validator pins this app-owned native library;
    // no function or pointer is used after the handle is dropped. ort retains
    // its own handle when init_from succeeds.
    // Keep the app-owned DirectML dependency loaded by absolute path for the
    // lifetime of ORT. Never resolve a different DirectML.dll from PATH.
    let directml_path = path.with_file_name("DirectML.dll");
    if directml_path.is_file() && DIRECTML.get().is_none() {
        match unsafe { libloading::Library::new(&directml_path) } {
            Ok(library) => { let _ = DIRECTML.set(library); }
            Err(error) => log::warn!("DirectML unavailable; speech models can use CPU: {error}"),
        }
    }
    let library = unsafe { libloading::Library::new(path) }
        .map_err(|error| format!("Cannot load bundled ONNX Runtime: {error}. Repair/reinstall and restart Meetily."))?;
    unsafe { library.get::<unsafe extern "system" fn() -> *const std::ffi::c_void>(b"OrtGetApiBase\0") }
        .map_err(|error| format!("Invalid bundled ONNX Runtime: {error}"))?;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ort::init_from(path.to_string_lossy().into_owned()).with_telemetry(false).commit()
    })).map_err(|_| "ONNX Runtime initialization failed. Repair/reinstall and restart Meetily.".to_string())?
        .map_err(|error| error.to_string())?;
    if !result {
        return Err("An ONNX environment was initialized before the bundled runtime. Restart Meetily.".into());
    }
    log::info!("Initialized verified bundled Windows ONNX Runtime");
    Ok(())
}

#[tauri::command]
pub async fn check_transcription_runtime() -> Result<(), String> {
    ensure_available().map_err(|error| format!("{START_ERROR_CODE}: {error}"))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Requires MEETILY_PARAKEET_TEST_MODEL and MEETILY_NEMOTRON_WAV"]
    fn directml_runtime_preserves_cpu_vad_and_parakeet() {
        ensure_available().unwrap();
        let path = std::env::var("MEETILY_PARAKEET_TEST_MODEL").expect("Set Parakeet model directory");
        let wav = std::env::var("MEETILY_NEMOTRON_WAV").expect("Set speech WAV");
        let (mut audio, rate) = crate::diarization::dsp::read_wav(std::path::Path::new(&wav)).unwrap();
        assert_eq!(rate, 16000);
        audio.truncate(16000 * 16);
        let mut vad = crate::audio::vad::ContinuousVadProcessor::new(16000, 800).unwrap();
        let mut segments = vad.process_audio(&audio).unwrap();
        segments.extend(vad.flush().unwrap());
        assert!(!segments.is_empty(), "VAD lost speech under DirectML-enabled runtime");
        let mut model = crate::parakeet_engine::model::ParakeetModel::new(path, true).unwrap();
        let result = model.transcribe_samples(audio).unwrap();
        assert!(result.text.to_lowercase().contains("meeting"), "Unexpected Parakeet output: {}", result.text);
        println!("CPU VAD and Parakeet passed: {}", result.text);
    }
    #[test]
    fn missing_runtime_is_a_recoverable_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(initialize_library(&dir.path().join("onnxruntime.dll")).unwrap_err().contains("missing"));
    }
    #[test]
    fn bundled_runtime_initialization_is_shared_and_idempotent() {
        ensure_available().unwrap();
        ensure_available().unwrap();
        assert!(ort::session::Session::builder().is_ok());
    }

    #[test]
    fn bundled_diarization_models_run_with_shared_runtime() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/diarization");
        let mut models = crate::diarization::models::DiarizationModels::load(&path).unwrap();
        let waveform: Vec<f32> = (0..160_000).map(|sample| (sample as f32 * 0.07).sin() * 0.01).collect();
        assert!(!models.segment_window(&waveform).unwrap().is_empty());
        let embedding = models.embed(&waveform[..48_000]).unwrap();
        assert_eq!(embedding.len(), 128);
        assert!(embedding.iter().all(|value| value.is_finite()));
    }

    #[tokio::test]
    async fn failed_runtime_does_not_create_recording_storage() {
        const SCENARIO: &str = "MEETILY_TEST_MISSING_ONNX";
        if std::env::var_os(SCENARIO).is_none() {
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "onnx_runtime::tests::failed_runtime_does_not_create_recording_storage", "--nocapture"])
                .env(SCENARIO, "1").status().unwrap();
            assert!(result.success());
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        RUNTIME_PATH.set(dir.path().join("missing/onnxruntime.dll")).unwrap();
        let recordings = dir.path().join("recordings");
        let mut manager = crate::audio::recording_manager::RecordingManager::new();
        manager.set_recordings_folder(recordings.clone());
        manager.set_meeting_name(Some("Startup failure test".into()));
        let result = manager.start_recording(None, None, true, None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().downcast_ref::<InitializationError>().is_some());
        assert!(!recordings.exists());
        assert!(!manager.get_state().is_recording());
    }
}

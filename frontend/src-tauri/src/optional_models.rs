//! Native ownership of optional-model removal and preference cleanup.
use sqlx::SqlitePool;
use std::path::Path;
use tauri::{Emitter, Manager};

pub const WHISPER_MODEL: &str = "large-v3-turbo-q5_0";
static WHISPER_OPERATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static WHISPER_ACTIVATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static NEMOTRON_OPERATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Held through download activation or uninstall, including across WebView reloads.
pub fn operation(model: &str) -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    let lock = match model {
        "whisper" => &WHISPER_OPERATION,
        "nemotron" => &NEMOTRON_OPERATION,
        _ => return Err("Unknown optional model".into()),
    };
    lock.try_lock().map_err(|_| "This model is busy downloading, enabling, or uninstalling".into())
}

/// One optional activation may wait for an already-running manual download.
/// The native request, not a WebView promise, owns that completion requirement.
pub async fn whisper_activation() -> Result<(tokio::sync::MutexGuard<'static, ()>, tokio::sync::MutexGuard<'static, ()>), String> {
    let request = WHISPER_ACTIVATION.try_lock().map_err(|_| "Whisper activation is already pending")?;
    let model = tokio::time::timeout(std::time::Duration::from_secs(3600), WHISPER_OPERATION.lock())
        .await.map_err(|_| "Timed out waiting for the current Whisper model operation")?;
    Ok((request, model))
}

async fn disable_whisper(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut transaction = pool.begin().await?;
    sqlx::query("UPDATE transcript_settings SET postCallProvider = 'live', postCallModel = '' WHERE postCallProvider = 'whisper' AND postCallModel = ?")
        .bind(WHISPER_MODEL).execute(&mut *transaction).await?;
    sqlx::query("UPDATE transcript_settings SET provider = 'parakeet', model = ? WHERE provider IN ('localWhisper', 'whisper') AND model = ?")
        .bind(crate::config::DEFAULT_PARAKEET_MODEL).bind(WHISPER_MODEL)
        .execute(&mut *transaction).await?;
    transaction.commit().await
}

async fn remove_nemotron_files(directory: &Path) -> Result<(), String> {
    // Never remove the shared diarization directory or bundled Pyannote files.
    for name in ["nemotron3_diar_v3.onnx", "Nemotron-LICENSE.txt", "nemotron3_diar_v3.onnx.part", "Nemotron-LICENSE.txt.part"] {
        match tokio::fs::remove_file(directory.join(name)).await {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(format!("Could not remove {name}: {error}")),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn uninstall_optional_model(app: tauri::AppHandle, model: String) -> Result<(), String> {
    let _model = operation(&model)?;
    let _diarization = crate::diarization::try_operation_guard()?;
    let _engines = crate::audio::common::acquire_engine_lifecycle_lock().await;
    if crate::audio::recording_commands::is_recording().await
        || crate::audio::retranscription::is_retranscription_in_progress_command(None).await
    {
        return Err("Finish recording or post-call processing before uninstalling a model".into());
    }
    if model == "nemotron" {
        // This is an explicit uninstall, not fallback after an inference failure.
        if crate::diarization::get_active_engine() == "nemotron" {
            crate::diarization::set_diarization_engine("pyannote".into()).await?;
            let _ = app.emit("diarization-engine-changed", "pyannote");
        }
        remove_nemotron_files(&crate::diarization::diarization_user_model_dir()).await?;
    } else {
        crate::whisper_engine::commands::whisper_init().await?;
        let engine = crate::whisper_engine::commands::WHISPER_ENGINE.lock()
            .map_err(|_| "Whisper engine lock failed")?.as_ref().cloned()
            .ok_or("Whisper engine not initialized")?;
        let state = app.state::<crate::state::AppState>();
        // Disable references before deleting; a failed removal leaves an installed
        // but disabled model rather than a preference pointing at a missing file.
        disable_whisper(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
        let _ = app.emit("transcript-config-changed", ());
        let _ = app.emit("post-call-transcript-config-changed", ());
        if engine.get_current_model().await.as_deref() == Some(WHISPER_MODEL) {
            engine.unload_model().await;
        }
        let models = engine.discover_models().await.map_err(|e| e.to_string())?;
        if models.iter().any(|entry| entry.name == WHISPER_MODEL && !matches!(entry.status, crate::whisper_engine::ModelStatus::Missing)) {
            engine.delete_model(WHISPER_MODEL).await.map_err(|e| e.to_string())?;
        }
    }
    let _ = app.emit("optional-model-removed", &model);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn optional_uninstall_preserves_other_files_and_is_repeatable() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["nemotron3_diar_v3.onnx", "Nemotron-LICENSE.txt", "nemotron3_diar_v3.onnx.part", "segmentation-3.0-fp16.onnx", "recording.mp4"] {
            tokio::fs::write(directory.path().join(name), b"fixture").await.unwrap();
        }
        remove_nemotron_files(directory.path()).await.unwrap();
        remove_nemotron_files(directory.path()).await.unwrap();
        assert!(!directory.path().join("nemotron3_diar_v3.onnx").exists());
        assert!(!directory.path().join("Nemotron-LICENSE.txt").exists());
        assert!(!directory.path().join("nemotron3_diar_v3.onnx.part").exists());
        assert!(directory.path().join("segmentation-3.0-fp16.onnx").exists());
        assert!(directory.path().join("recording.mp4").exists());
    }

    #[tokio::test]
    async fn optional_uninstall_only_resets_preferences_referencing_its_model() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE transcript_settings (provider TEXT, model TEXT, postCallProvider TEXT, postCallModel TEXT)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO transcript_settings VALUES ('parakeet', 'keep-live', 'whisper', ?)").bind(WHISPER_MODEL).execute(&pool).await.unwrap();
        disable_whisper(&pool).await.unwrap();
        let row: (String, String, String, String) = sqlx::query_as("SELECT * FROM transcript_settings").fetch_one(&pool).await.unwrap();
        assert_eq!(row, ("parakeet".into(), "keep-live".into(), "live".into(), "".into()));
        sqlx::query("UPDATE transcript_settings SET provider = 'localWhisper', model = ?, postCallProvider = 'whisper', postCallModel = 'other-whisper'").bind(WHISPER_MODEL).execute(&pool).await.unwrap();
        disable_whisper(&pool).await.unwrap();
        let row: (String, String, String, String) = sqlx::query_as("SELECT * FROM transcript_settings").fetch_one(&pool).await.unwrap();
        assert_eq!(row, ("parakeet".into(), crate::config::DEFAULT_PARAKEET_MODEL.into(), "whisper".into(), "other-whisper".into()));
    }

    #[test]
    fn optional_model_operations_reject_duplicates_and_unknown_names() {
        let _guard = operation("nemotron").unwrap();
        assert!(operation("nemotron").is_err());
        assert!(operation("../models").is_err());
    }

    #[tokio::test]
    async fn optional_whisper_activation_waits_natively_and_bounds_pending_requests() {
        let download = operation("whisper").unwrap();
        let activation = tokio::spawn(whisper_activation());
        tokio::task::yield_now().await;
        assert!(!activation.is_finished());
        assert!(whisper_activation().await.is_err());
        drop(download);
        let ownership = activation.await.unwrap().unwrap();
        assert!(operation("whisper").is_err());
        drop(ownership);
        assert!(operation("whisper").is_ok());
    }
}

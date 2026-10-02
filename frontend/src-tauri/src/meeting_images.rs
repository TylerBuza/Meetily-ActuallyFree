//! Explicitly captured or pasted meeting images, indexed on the audio clock.
//! The recording folder exists before its meeting row, so the folder path is
//! the durable join key between live capture and the saved meeting.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingImage {
    id: String,
    path: String,
    audio_time: f64,
    created_at: String,
}

fn image_extension(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("Image must be between 1 byte and 8 MB".into());
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok("png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Ok("jpg")
    } else {
        Err("Only PNG and JPEG images are supported".into())
    }
}

async fn meeting_folder(pool: &sqlx::SqlitePool, meeting_id: &str) -> Result<PathBuf, String> {
    let folder: Option<String> = sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
        .map_err(|error| error.to_string())?
        .flatten();
    folder.map(PathBuf::from).ok_or_else(|| "This meeting has no recording folder".into())
}

fn image_path(folder: &Path, file_name: &str) -> PathBuf {
    folder.join("images").join(file_name)
}

/// `live` uses the native recording manager; saved meetings are resolved by ID.
/// No arbitrary path supplied by the WebView is accepted.
#[tauri::command]
pub async fn save_meeting_image<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: Option<String>,
    live: bool,
    audio_time: f64,
    bytes: Vec<u8>,
) -> Result<MeetingImage, String> {
    if !audio_time.is_finite() || audio_time < 0.0 || audio_time > 24.0 * 3600.0 {
        return Err("Invalid recording timestamp".into());
    }
    let extension = image_extension(&bytes)?;
    let folder = if live {
        crate::audio::recording_commands::active_meeting_folder()
            .ok_or_else(|| "No recording is active".to_string())?
    } else {
        meeting_folder(state.db_manager.pool(), meeting_id.as_deref().unwrap_or("")).await?
    };
    if !folder.is_dir() {
        return Err("Recording folder is unavailable".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let file_name = format!("{id}.{extension}");
    let file = image_path(&folder, &file_name);
    let parent = file.parent().ok_or("Invalid image folder")?;
    tokio::fs::create_dir_all(parent).await.map_err(|error| error.to_string())?;
    tokio::fs::write(&file, bytes).await.map_err(|error| error.to_string())?;

    let stored = sqlx::query(
        "INSERT INTO meeting_images (id, folder_path, file_name, audio_time, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .bind(&id)
    .bind(folder.to_string_lossy().as_ref())
    .bind(&file_name)
    .bind(audio_time)
    .execute(state.db_manager.pool())
    .await;
    if let Err(error) = stored {
        let _ = tokio::fs::remove_file(&file).await;
        return Err(error.to_string());
    }
    app.asset_protocol_scope().allow_file(&file).map_err(|error| error.to_string())?;
    Ok(MeetingImage {
        id,
        path: file.to_string_lossy().into_owned(),
        audio_time,
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

#[tauri::command]
pub async fn list_meeting_images<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: Option<String>,
    live: bool,
) -> Result<Vec<MeetingImage>, String> {
    let folder = if live {
        crate::audio::recording_commands::active_meeting_folder()
            .ok_or_else(|| "No recording is active".to_string())?
    } else {
        meeting_folder(state.db_manager.pool(), meeting_id.as_deref().unwrap_or("")).await?
    };
    let rows = sqlx::query_as::<_, (String, String, f64, String)>(
        "SELECT id, file_name, audio_time, created_at FROM meeting_images WHERE folder_path = ? ORDER BY audio_time, created_at",
    )
    .bind(folder.to_string_lossy().as_ref())
    .fetch_all(state.db_manager.pool())
    .await
    .map_err(|error| error.to_string())?;
    let mut images = Vec::with_capacity(rows.len());
    for (id, file_name, audio_time, created_at) in rows {
        // Only files named by this command are ever served by the asset protocol.
        if file_name != format!("{id}.png") && file_name != format!("{id}.jpg") {
            continue;
        }
        let file = image_path(&folder, &file_name);
        if file.is_file() {
            app.asset_protocol_scope().allow_file(&file).map_err(|error| error.to_string())?;
            images.push(MeetingImage { id, path: file.to_string_lossy().into_owned(), audio_time, created_at });
        }
    }
    Ok(images)
}

#[tauri::command]
pub async fn delete_meeting_image(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: Option<String>,
    live: bool,
    image_id: String,
) -> Result<(), String> {
    let folder = if live {
        crate::audio::recording_commands::active_meeting_folder()
            .ok_or_else(|| "No recording is active".to_string())?
    } else {
        meeting_folder(state.db_manager.pool(), meeting_id.as_deref().unwrap_or("")).await?
    };
    let file_name: Option<String> = sqlx::query_scalar(
        "SELECT file_name FROM meeting_images WHERE id = ? AND folder_path = ?",
    )
    .bind(&image_id)
    .bind(folder.to_string_lossy().as_ref())
    .fetch_optional(state.db_manager.pool())
    .await
    .map_err(|error| error.to_string())?;
    let Some(file_name) = file_name else { return Err("Image was not found".into()); };
    if file_name != format!("{image_id}.png") && file_name != format!("{image_id}.jpg") {
        return Err("Invalid stored image name".into());
    }
    let file = image_path(&folder, &file_name);
    if file.exists() {
        tokio::fs::remove_file(&file).await.map_err(|error| error.to_string())?;
    }
    sqlx::query("DELETE FROM meeting_images WHERE id = ? AND folder_path = ?")
        .bind(&image_id)
        .bind(folder.to_string_lossy().as_ref())
        .execute(state.db_manager.pool())
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::image_extension;

    #[test]
    fn validates_image_bytes() {
        assert_eq!(image_extension(b"\x89PNG\r\n\x1a\nrest").unwrap(), "png");
        assert_eq!(image_extension(b"\xff\xd8\xffrest").unwrap(), "jpg");
        assert!(image_extension(b"not an image").is_err());
    }
}

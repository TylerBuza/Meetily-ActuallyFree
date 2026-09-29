//! The user's own notes for a meeting, written during or after the call. They
//! sit above the AI summary in the meeting document and are never touched by
//! summary generation.

use serde::Serialize;
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingNotes {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    /// BlockNote document, kept so formatting round-trips exactly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json: Option<serde_json::Value>,
    pub updated_at: String,
}

pub struct MeetingNotesRepository;

impl MeetingNotesRepository {
    pub async fn get(pool: &SqlitePool, meeting_id: &str) -> Result<Option<MeetingNotes>, sqlx::Error> {
        let row = sqlx::query_as::<_, (Option<String>, Option<String>, String)>(
            "SELECT notes_markdown, notes_json, updated_at FROM meeting_notes WHERE meeting_id = ?",
        )
        .bind(meeting_id)
        .fetch_optional(pool)
        .await?;
        Ok(row.map(|(markdown, json, updated_at)| MeetingNotes {
            markdown,
            json: json.and_then(|raw| serde_json::from_str(&raw).ok()),
            updated_at,
        }))
    }

    pub async fn save(
        pool: &SqlitePool,
        meeting_id: &str,
        markdown: Option<String>,
        json: Option<serde_json::Value>,
    ) -> Result<(), sqlx::Error> {
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_optional(pool)
            .await?;
        if exists.is_none() {
            return Err(sqlx::Error::RowNotFound);
        }
        let markdown = markdown.filter(|text| !text.trim().is_empty());
        let json = json.filter(|value| !value.is_null()).map(|value| value.to_string());
        sqlx::query(
            "INSERT INTO meeting_notes (meeting_id, notes_markdown, notes_json, created_at, updated_at) \
             VALUES (?, ?, ?, datetime('now'), datetime('now')) \
             ON CONFLICT(meeting_id) DO UPDATE SET notes_markdown = excluded.notes_markdown, \
                 notes_json = excluded.notes_json, updated_at = excluded.updated_at",
        )
        .bind(meeting_id)
        .bind(markdown)
        .bind(json)
        .execute(pool)
        .await?;
        Ok(())
    }
}

#[tauri::command]
pub async fn api_get_meeting_notes(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
) -> Result<Option<MeetingNotes>, String> {
    MeetingNotesRepository::get(state.db_manager.pool(), &meeting_id)
        .await
        .map_err(|error| format!("Failed to load notes: {}", error))
}

#[tauri::command]
pub async fn api_save_meeting_notes(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    markdown: Option<String>,
    json: Option<serde_json::Value>,
) -> Result<(), String> {
    MeetingNotesRepository::save(state.db_manager.pool(), &meeting_id, markdown, json)
        .await
        .map_err(|error| match error {
            sqlx::Error::RowNotFound => "Meeting not found".to_string(),
            other => format!("Failed to save notes: {}", other),
        })
}

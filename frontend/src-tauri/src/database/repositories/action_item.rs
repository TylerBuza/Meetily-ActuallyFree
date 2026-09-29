//! Action items. Every item belongs to the meeting it came from: the meeting
//! is the ground truth, and the person, group, and home views only read these
//! rows back with a link to their source. AI-extracted items are replaced when a
//! summary is regenerated unless the user has touched them (edited or checked).

use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use super::person::{is_person_name, normalize_person_name};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionItemView {
    pub id: String,
    pub meeting_id: String,
    pub meeting_title: String,
    pub meeting_created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub person_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub person_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_text: Option<String>,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_at: Option<String>,
    pub source: String,
    pub edited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_id: Option<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// An item as proposed by summary extraction (or typed by the user).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionItemDraft {
    pub text: String,
    #[serde(default)]
    pub owner_label: Option<String>,
    #[serde(default)]
    pub due_text: Option<String>,
    #[serde(default)]
    pub audio_time: Option<f64>,
    #[serde(default)]
    pub transcript_id: Option<String>,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionItemFilter {
    #[serde(default)]
    pub meeting_id: Option<String>,
    #[serde(default)]
    pub person_id: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub open_only: bool,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct ActionRow {
    id: String,
    meeting_id: String,
    meeting_title: String,
    meeting_created_at: String,
    group_id: Option<String>,
    text: String,
    owner_label: Option<String>,
    person_id: Option<String>,
    person_name: Option<String>,
    due_text: Option<String>,
    done: bool,
    done_at: Option<String>,
    source: String,
    edited: bool,
    audio_time: Option<f64>,
    transcript_id: Option<String>,
    position: i64,
    created_at: String,
    updated_at: String,
}

const ACTION_SELECT: &str = "SELECT a.id AS id, a.meeting_id AS meeting_id, m.title AS meeting_title,         m.created_at AS meeting_created_at, m.group_id AS group_id, a.text AS text,         a.owner_label AS owner_label, a.person_id AS person_id, p.display_name AS person_name,         a.due_text AS due_text, a.done AS done, a.done_at AS done_at, a.source AS source,         a.edited AS edited, a.audio_time AS audio_time, a.transcript_id AS transcript_id,         a.position AS position, a.created_at AS created_at, a.updated_at AS updated_at      FROM action_items a      JOIN meetings m ON m.id = a.meeting_id      LEFT JOIN people p ON p.id = a.person_id";

fn view_from_row(row: ActionRow) -> ActionItemView {
    ActionItemView {
        // A dangling id (legacy databases without FK enforcement) is not a link.
        person_id: row.person_name.as_ref().and(row.person_id),
        id: row.id,
        meeting_id: row.meeting_id,
        meeting_title: row.meeting_title,
        meeting_created_at: row.meeting_created_at,
        group_id: row.group_id,
        text: row.text,
        owner_label: row.owner_label,
        person_name: row.person_name,
        due_text: row.due_text,
        done: row.done,
        done_at: row.done_at,
        source: row.source,
        edited: row.edited,
        audio_time: row.audio_time,
        transcript_id: row.transcript_id,
        position: row.position,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn clean(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

/// Links an owner name to a contact: first someone who spoke in this meeting
/// under that name, then any contact with exactly that name.
async fn resolve_owner(
    tx: &mut Transaction<'_, Sqlite>,
    meeting_id: &str,
    owner: Option<&str>,
) -> Result<Option<String>, sqlx::Error> {
    let Some(owner) = owner.map(str::trim).filter(|value| is_person_name(value)) else {
        return Ok(None);
    };
    let normalized = normalize_person_name(owner);
    let in_meeting: Option<String> = sqlx::query_scalar(
        "SELECT ps.person_id FROM person_speakers ps \
         WHERE ps.meeting_id = ? AND lower(trim(ps.speaker_label)) = ? LIMIT 1",
    )
    .bind(meeting_id)
    .bind(&normalized)
    .fetch_optional(&mut **tx)
    .await?;
    if in_meeting.is_some() {
        return Ok(in_meeting);
    }
    sqlx::query_scalar("SELECT id FROM people WHERE normalized_name = ? LIMIT 1")
        .bind(&normalized)
        .fetch_optional(&mut **tx)
        .await
}

pub struct ActionItemsRepository;

impl ActionItemsRepository {
    pub async fn list(
        pool: &SqlitePool,
        filter: &ActionItemFilter,
    ) -> Result<Vec<ActionItemView>, sqlx::Error> {
        let mut clauses: Vec<&str> = Vec::new();
        if filter.meeting_id.is_some() {
            clauses.push("a.meeting_id = ?");
        }
        if filter.person_id.is_some() {
            clauses.push("a.person_id = ?");
        }
        if filter.group_id.is_some() {
            clauses.push("m.group_id = ?");
        }
        if filter.open_only {
            clauses.push("a.done = 0");
        }
        let mut sql = ACTION_SELECT.to_string();
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        if filter.meeting_id.is_some() {
            sql.push_str(" ORDER BY a.position, a.created_at");
        } else {
            sql.push_str(" ORDER BY a.done, m.created_at DESC, a.position");
        }
        if filter.limit.is_some() {
            sql.push_str(" LIMIT ?");
        }

        let mut query = sqlx::query_as::<_, ActionRow>(&sql);
        if let Some(meeting_id) = &filter.meeting_id {
            query = query.bind(meeting_id);
        }
        if let Some(person_id) = &filter.person_id {
            query = query.bind(person_id);
        }
        if let Some(group_id) = &filter.group_id {
            query = query.bind(group_id);
        }
        if let Some(limit) = filter.limit {
            query = query.bind(limit.clamp(1, 500));
        }
        Ok(query.fetch_all(pool).await?.into_iter().map(view_from_row).collect())
    }

    pub async fn get(pool: &SqlitePool, id: &str) -> Result<ActionItemView, sqlx::Error> {
        sqlx::query_as::<_, ActionRow>(&format!("{} WHERE a.id = ?", ACTION_SELECT))
            .bind(id)
            .fetch_optional(pool)
            .await?
            .map(view_from_row)
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn create(
        pool: &SqlitePool,
        meeting_id: &str,
        draft: ActionItemDraft,
        person_id: Option<String>,
    ) -> Result<ActionItemView, sqlx::Error> {
        let text = draft.text.trim().to_string();
        if text.is_empty() {
            return Err(sqlx::Error::Protocol("Action item text is required".into()));
        }
        let mut tx = pool.begin().await?;
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_optional(&mut *tx)
            .await?;
        if exists.is_none() {
            return Err(sqlx::Error::RowNotFound);
        }
        let owner = clean(draft.owner_label);
        let person_id = match clean(person_id) {
            Some(id) => Some(id),
            None => resolve_owner(&mut tx, meeting_id, owner.as_deref()).await?,
        };
        let position: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM action_items WHERE meeting_id = ?",
        )
        .bind(meeting_id)
        .fetch_one(&mut *tx)
        .await?;
        let id = format!("action-{}", Uuid::new_v4());
        sqlx::query(
            "INSERT INTO action_items (id, meeting_id, text, owner_label, person_id, due_text, done, \
             source, edited, audio_time, transcript_id, position, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, 0, 'user', 1, ?, ?, ?, datetime('now'), datetime('now'))",
        )
        .bind(&id)
        .bind(meeting_id)
        .bind(&text)
        .bind(&owner)
        .bind(&person_id)
        .bind(clean(draft.due_text))
        .bind(draft.audio_time)
        .bind(clean(draft.transcript_id))
        .bind(position)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Self::get(pool, &id).await
    }

    /// Full-state update. Changing the wording, owner, or due date marks the
    /// item as the user's; checking it off also protects it from regeneration.
    #[allow(clippy::too_many_arguments)]
    pub async fn update(
        pool: &SqlitePool,
        id: &str,
        text: &str,
        owner_label: Option<String>,
        person_id: Option<String>,
        due_text: Option<String>,
        done: bool,
    ) -> Result<ActionItemView, sqlx::Error> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err(sqlx::Error::Protocol("Action item text is required".into()));
        }
        let current = Self::get(pool, id).await?;
        let owner_label = clean(owner_label);
        let due_text = clean(due_text);
        let changed_wording = current.text != text
            || current.owner_label != owner_label
            || current.due_text != due_text;
        let mut tx = pool.begin().await?;
        let person_id = match clean(person_id) {
            Some(id) => Some(id),
            None if current.owner_label == owner_label => current.person_id.clone(),
            None => resolve_owner(&mut tx, &current.meeting_id, owner_label.as_deref()).await?,
        };
        sqlx::query(
            "UPDATE action_items SET text = ?, owner_label = ?, person_id = ?, due_text = ?, done = ?, \
             done_at = CASE WHEN ? THEN COALESCE(done_at, datetime('now')) ELSE NULL END, \
             edited = CASE WHEN ? OR ? THEN 1 ELSE edited END, updated_at = datetime('now') \
             WHERE id = ?",
        )
        .bind(&text)
        .bind(&owner_label)
        .bind(&person_id)
        .bind(&due_text)
        .bind(done)
        .bind(done)
        .bind(changed_wording)
        .bind(done)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Self::get(pool, id).await
    }

    pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
        let result = sqlx::query("DELETE FROM action_items WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(sqlx::Error::RowNotFound);
        }
        Ok(())
    }

    /// Replaces the meeting's untouched AI items with a fresh extraction.
    /// Items the user created, edited, or checked off are kept, and a draft
    /// that repeats one of them is skipped.
    pub async fn sync_ai(
        pool: &SqlitePool,
        meeting_id: &str,
        drafts: Vec<ActionItemDraft>,
        source_fingerprint: &str,
    ) -> Result<Vec<ActionItemView>, sqlx::Error> {
        let mut tx = pool.begin().await?;
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_optional(&mut *tx)
            .await?;
        if exists.is_none() {
            return Err(sqlx::Error::RowNotFound);
        }
        sqlx::query(
            "DELETE FROM action_items WHERE meeting_id = ? AND source = 'ai' AND edited = 0 AND done = 0",
        )
        .bind(meeting_id)
        .execute(&mut *tx)
        .await?;

        let kept: Vec<String> =
            sqlx::query_scalar("SELECT text FROM action_items WHERE meeting_id = ?")
                .bind(meeting_id)
                .fetch_all(&mut *tx)
                .await?;
        let mut seen: Vec<String> = kept.iter().map(|text| normalize_person_name(text)).collect();
        let mut position: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM action_items WHERE meeting_id = ?",
        )
        .bind(meeting_id)
        .fetch_one(&mut *tx)
        .await?;

        for draft in drafts {
            let text = draft.text.trim().to_string();
            let key = normalize_person_name(&text);
            if text.is_empty() || seen.contains(&key) {
                continue;
            }
            seen.push(key);
            let owner = clean(draft.owner_label);
            let person_id = resolve_owner(&mut tx, meeting_id, owner.as_deref()).await?;
            sqlx::query(
                "INSERT INTO action_items (id, meeting_id, text, owner_label, person_id, due_text, done, \
                 source, edited, audio_time, transcript_id, position, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, 0, 'ai', 0, ?, ?, ?, datetime('now'), datetime('now'))",
            )
            .bind(format!("action-{}", Uuid::new_v4()))
            .bind(meeting_id)
            .bind(&text)
            .bind(&owner)
            .bind(&person_id)
            .bind(clean(draft.due_text))
            .bind(draft.audio_time)
            .bind(clean(draft.transcript_id))
            .bind(position)
            .execute(&mut *tx)
            .await?;
            position += 1;
        }

        sqlx::query("UPDATE meetings SET action_items_source = ? WHERE id = ?")
            .bind(source_fingerprint)
            .bind(meeting_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        Self::list(
            pool,
            &ActionItemFilter {
                meeting_id: Some(meeting_id.to_string()),
                ..Default::default()
            },
        )
        .await
    }

    /// Meetings that have a finished summary but were never read for action
    /// items (everything recorded before this feature, for example).
    pub async fn unsynced_meetings(pool: &SqlitePool) -> Result<Vec<String>, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT m.id FROM meetings m \
             JOIN summary_processes s ON s.meeting_id = m.id \
             WHERE m.action_items_source IS NULL AND s.result IS NOT NULL \
               AND lower(s.status) = 'completed' \
             ORDER BY m.created_at DESC",
        )
        .fetch_all(pool)
        .await
    }
}

fn action_error(action: &str, error: sqlx::Error) -> String {
    match error {
        sqlx::Error::RowNotFound => "Action item or meeting not found".to_string(),
        sqlx::Error::Protocol(message) => message,
        other => format!("Failed to {}: {}", action, other),
    }
}

#[tauri::command]
pub async fn api_list_action_items(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: Option<String>,
    person_id: Option<String>,
    group_id: Option<String>,
    open_only: Option<bool>,
    limit: Option<i64>,
) -> Result<Vec<ActionItemView>, String> {
    ActionItemsRepository::list(
        state.db_manager.pool(),
        &ActionItemFilter {
            meeting_id,
            person_id,
            group_id,
            open_only: open_only.unwrap_or(false),
            limit,
        },
    )
    .await
    .map_err(|error| action_error("list action items", error))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn api_create_action_item(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    text: String,
    owner_label: Option<String>,
    person_id: Option<String>,
    due_text: Option<String>,
    audio_time: Option<f64>,
    transcript_id: Option<String>,
) -> Result<ActionItemView, String> {
    ActionItemsRepository::create(
        state.db_manager.pool(),
        &meeting_id,
        ActionItemDraft {
            text,
            owner_label,
            due_text,
            audio_time,
            transcript_id,
        },
        person_id,
    )
    .await
    .map_err(|error| action_error("create action item", error))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn api_update_action_item(
    state: tauri::State<'_, crate::state::AppState>,
    id: String,
    text: String,
    owner_label: Option<String>,
    person_id: Option<String>,
    due_text: Option<String>,
    done: bool,
) -> Result<ActionItemView, String> {
    ActionItemsRepository::update(
        state.db_manager.pool(),
        &id,
        &text,
        owner_label,
        person_id,
        due_text,
        done,
    )
    .await
    .map_err(|error| action_error("update action item", error))
}

#[tauri::command]
pub async fn api_delete_action_item(
    state: tauri::State<'_, crate::state::AppState>,
    id: String,
) -> Result<(), String> {
    ActionItemsRepository::delete(state.db_manager.pool(), &id)
        .await
        .map_err(|error| action_error("delete action item", error))
}

#[tauri::command]
pub async fn api_sync_ai_action_items(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    items: Vec<ActionItemDraft>,
    source_fingerprint: String,
) -> Result<Vec<ActionItemView>, String> {
    ActionItemsRepository::sync_ai(state.db_manager.pool(), &meeting_id, items, &source_fingerprint)
        .await
        .map_err(|error| action_error("save action items", error))
}

#[tauri::command]
pub async fn api_list_unsynced_action_meetings(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Vec<String>, String> {
    ActionItemsRepository::unsynced_meetings(state.db_manager.pool())
        .await
        .map_err(|error| action_error("list meetings", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, \
                 group_id TEXT, action_items_source TEXT); \
             CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, normalized_name TEXT NOT NULL); \
             CREATE TABLE person_speakers (person_id TEXT NOT NULL, meeting_id TEXT NOT NULL, speaker_label TEXT NOT NULL); \
             CREATE TABLE action_items (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, text TEXT NOT NULL, \
                 owner_label TEXT, person_id TEXT, due_text TEXT, done INTEGER NOT NULL DEFAULT 0, done_at TEXT, \
                 source TEXT NOT NULL DEFAULT 'user', edited INTEGER NOT NULL DEFAULT 0, audio_time REAL, \
                 transcript_id TEXT, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, \
                 updated_at TEXT NOT NULL); \
             INSERT INTO meetings (id, title, created_at) VALUES ('m1', 'Kickoff', '2026-09-01'); \
             INSERT INTO people VALUES ('person-priya', 'Priya Shah', 'priya shah'); \
             INSERT INTO person_speakers VALUES ('person-priya', 'm1', 'Priya Shah');",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    fn draft(text: &str, owner: Option<&str>) -> ActionItemDraft {
        ActionItemDraft {
            text: text.to_string(),
            owner_label: owner.map(str::to_string),
            due_text: None,
            audio_time: None,
            transcript_id: None,
        }
    }

    #[tokio::test]
    async fn sync_links_owners_and_keeps_touched_items() {
        let pool = test_pool().await;
        let first = ActionItemsRepository::sync_ai(
            &pool,
            "m1",
            vec![draft("Send terms", Some("Priya Shah")), draft("Book room", Some("You"))],
            "v1",
        )
        .await
        .unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].person_id.as_deref(), Some("person-priya"));
        assert_eq!(first[1].person_id, None);

        // Checking an item off protects it; the other is replaced.
        ActionItemsRepository::update(&pool, &first[0].id, "Send terms", Some("Priya Shah".into()), None, None, true)
            .await
            .unwrap();
        let second = ActionItemsRepository::sync_ai(
            &pool,
            "m1",
            vec![draft("Send terms", Some("Priya Shah")), draft("Draft rollout doc", None)],
            "v2",
        )
        .await
        .unwrap();
        let texts: Vec<&str> = second.iter().map(|item| item.text.as_str()).collect();
        assert_eq!(texts, vec!["Send terms", "Draft rollout doc"]);
        assert!(second[0].done);

    }
}

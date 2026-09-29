//! Groups. A meeting belongs to at most one group, and using groups at all is
//! optional. A group can model a recurring meeting (standups, 1:1s), a customer
//! engagement, a team, or anything else; `kind` only changes wording and
//! defaults in the UI. Membership is whoever was linked as a contact in the
//! group's meetings.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;
use uuid::Uuid;

use super::person::normalize_person_name;

const GROUP_KINDS: [&str; 5] = ["recurring", "customer", "team", "project", "other"];
const GROUP_COLORS: [&str; 10] = [
    "blue", "sky", "teal", "green", "amber", "orange", "red", "pink", "violet", "slate",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupListItem {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<serde_json::Value>,
    pub meeting_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_meeting_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_meeting_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_meeting_title: Option<String>,
    pub created_at: String,
}

/// Everything the user can set on a group. Updates send the full state.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInput {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub schedule: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMember {
    pub person_id: String,
    pub display_name: String,
    pub meeting_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMeetingRow {
    pub meeting_id: String,
    pub title: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    pub present: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupDetail {
    #[serde(flatten)]
    pub group: GroupListItem,
    pub frequent: Vec<GroupMember>,
    pub rare: Vec<GroupMember>,
    pub meetings: Vec<GroupMeetingRow>,
}

type GroupRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
);

const GROUP_SELECT: &str = "SELECT g.id, g.name, g.color, g.kind, g.description, g.schedule, g.created_at, \
        (SELECT COUNT(*) FROM meetings m WHERE m.group_id = g.id), \
        (SELECT m.created_at FROM meetings m WHERE m.group_id = g.id ORDER BY m.created_at DESC LIMIT 1), \
        (SELECT m.id FROM meetings m WHERE m.group_id = g.id ORDER BY m.created_at DESC LIMIT 1), \
        (SELECT m.title FROM meetings m WHERE m.group_id = g.id ORDER BY m.created_at DESC LIMIT 1) \
     FROM groups g";

fn group_from_row(row: GroupRow) -> GroupListItem {
    let (
        id,
        name,
        color,
        kind,
        description,
        schedule,
        created_at,
        meeting_count,
        last_meeting_at,
        last_meeting_id,
        last_meeting_title,
    ) = row;
    GroupListItem {
        id,
        name,
        color,
        kind,
        description,
        schedule: schedule.and_then(|raw| serde_json::from_str(&raw).ok()),
        meeting_count,
        last_meeting_at,
        last_meeting_id,
        last_meeting_title,
        created_at,
    }
}

fn clean_text(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

struct CleanGroupInput {
    name: String,
    normalized: String,
    color: String,
    kind: String,
    description: Option<String>,
    schedule: Option<String>,
}

fn validate_input(input: GroupInput) -> Result<CleanGroupInput, sqlx::Error> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(sqlx::Error::Protocol("Group name is required".into()));
    }
    let color = input
        .color
        .filter(|color| GROUP_COLORS.contains(&color.as_str()))
        .unwrap_or_else(|| "blue".to_string());
    let kind = input
        .kind
        .filter(|kind| GROUP_KINDS.contains(&kind.as_str()))
        .unwrap_or_else(|| "other".to_string());
    let schedule = match input.schedule {
        Some(serde_json::Value::Null) | None => None,
        Some(value) => Some(value.to_string()),
    };
    Ok(CleanGroupInput {
        normalized: normalize_person_name(&name),
        name,
        color,
        kind,
        description: clean_text(input.description),
        schedule,
    })
}

pub struct GroupsRepository;

impl GroupsRepository {
    pub async fn list(pool: &SqlitePool) -> Result<Vec<GroupListItem>, sqlx::Error> {
        let rows = sqlx::query_as::<_, GroupRow>(&format!(
            "{} ORDER BY COALESCE( \
                (SELECT m.created_at FROM meetings m WHERE m.group_id = g.id ORDER BY m.created_at DESC LIMIT 1), \
                g.created_at) DESC",
            GROUP_SELECT
        ))
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(group_from_row).collect())
    }

    pub async fn get(pool: &SqlitePool, group_id: &str) -> Result<GroupListItem, sqlx::Error> {
        sqlx::query_as::<_, GroupRow>(&format!("{} WHERE g.id = ?", GROUP_SELECT))
            .bind(group_id)
            .fetch_optional(pool)
            .await?
            .map(group_from_row)
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// Creating a name that already exists returns that group instead of a duplicate.
    pub async fn create(pool: &SqlitePool, input: GroupInput) -> Result<GroupListItem, sqlx::Error> {
        let input = validate_input(input)?;
        if let Some(id) = sqlx::query_scalar::<_, String>("SELECT id FROM groups WHERE normalized_name = ?")
            .bind(&input.normalized)
            .fetch_optional(pool)
            .await?
        {
            return Self::get(pool, &id).await;
        }
        let id = format!("group-{}", Uuid::new_v4());
        sqlx::query(
            "INSERT INTO groups (id, name, normalized_name, color, kind, description, schedule, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
        )
        .bind(&id)
        .bind(&input.name)
        .bind(&input.normalized)
        .bind(&input.color)
        .bind(&input.kind)
        .bind(&input.description)
        .bind(&input.schedule)
        .execute(pool)
        .await?;
        Self::get(pool, &id).await
    }

    pub async fn update(
        pool: &SqlitePool,
        group_id: &str,
        input: GroupInput,
    ) -> Result<GroupListItem, sqlx::Error> {
        let input = validate_input(input)?;
        let clash: Option<String> = sqlx::query_scalar(
            "SELECT id FROM groups WHERE normalized_name = ? AND id <> ?",
        )
        .bind(&input.normalized)
        .bind(group_id)
        .fetch_optional(pool)
        .await?;
        if clash.is_some() {
            return Err(sqlx::Error::Protocol(format!(
                "Another group is already named \"{}\"",
                input.name
            )));
        }
        let result = sqlx::query(
            "UPDATE groups SET name = ?, normalized_name = ?, color = ?, kind = ?, description = ?, \
             schedule = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(&input.name)
        .bind(&input.normalized)
        .bind(&input.color)
        .bind(&input.kind)
        .bind(&input.description)
        .bind(&input.schedule)
        .bind(group_id)
        .execute(pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(sqlx::Error::RowNotFound);
        }
        Self::get(pool, group_id).await
    }

    /// Deleting a group keeps its meetings; they simply become ungrouped.
    pub async fn delete(pool: &SqlitePool, group_id: &str) -> Result<(), sqlx::Error> {
        let mut tx = pool.begin().await?;
        sqlx::query("UPDATE meetings SET group_id = NULL WHERE group_id = ?")
            .bind(group_id)
            .execute(&mut *tx)
            .await?;
        let result = sqlx::query("DELETE FROM groups WHERE id = ?")
            .bind(group_id)
            .execute(&mut *tx)
            .await?;
        if result.rows_affected() == 0 {
            return Err(sqlx::Error::RowNotFound);
        }
        tx.commit().await?;
        Ok(())
    }

    async fn ensure_group(pool: &SqlitePool, group_id: Option<&str>) -> Result<(), sqlx::Error> {
        if let Some(group_id) = group_id {
            let group: Option<String> = sqlx::query_scalar("SELECT id FROM groups WHERE id = ?")
                .bind(group_id)
                .fetch_optional(pool)
                .await?;
            if group.is_none() {
                return Err(sqlx::Error::RowNotFound);
            }
        }
        Ok(())
    }

    pub async fn set_meeting_group(
        pool: &SqlitePool,
        meeting_id: &str,
        group_id: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_optional(pool)
            .await?;
        if exists.is_none() {
            return Err(sqlx::Error::RowNotFound);
        }
        Self::ensure_group(pool, group_id).await?;
        sqlx::query("UPDATE meetings SET group_id = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(group_id)
            .bind(meeting_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Bulk move, used to sort a large back catalog into groups.
    pub async fn set_meetings_group(
        pool: &SqlitePool,
        meeting_ids: &[String],
        group_id: Option<&str>,
    ) -> Result<u64, sqlx::Error> {
        Self::ensure_group(pool, group_id).await?;
        let mut tx = pool.begin().await?;
        let mut updated = 0;
        for meeting_id in meeting_ids {
            updated += sqlx::query(
                "UPDATE meetings SET group_id = ?, updated_at = datetime('now') WHERE id = ?",
            )
            .bind(group_id)
            .bind(meeting_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        }
        tx.commit().await?;
        Ok(updated)
    }

    pub async fn meeting_group(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<GroupListItem>, sqlx::Error> {
        let group_id: Option<String> = sqlx::query_scalar(
            "SELECT g.id FROM groups g JOIN meetings m ON m.group_id = g.id WHERE m.id = ?",
        )
        .bind(meeting_id)
        .fetch_optional(pool)
        .await?;
        match group_id {
            Some(id) => Ok(Some(Self::get(pool, &id).await?)),
            None => Ok(None),
        }
    }

    pub async fn detail(
        pool: &SqlitePool,
        group_id: &str,
        query: Option<&str>,
    ) -> Result<GroupDetail, sqlx::Error> {
        let group = Self::get(pool, group_id).await?;

        let rows = sqlx::query_as::<_, (String, String, String, Option<f64>, Option<String>, Option<String>)>(
            "SELECT m.id, m.title, m.created_at, \
                    (SELECT MAX(COALESCE(t.audio_end_time, t.audio_start_time + COALESCE(t.duration, 0))) \
                     FROM transcripts t WHERE t.meeting_id = m.id), \
                    p.id, p.display_name \
             FROM meetings m \
             LEFT JOIN person_speakers ps ON ps.meeting_id = m.id \
             LEFT JOIN people p ON p.id = ps.person_id \
             WHERE m.group_id = ? \
             ORDER BY m.created_at DESC, p.display_name",
        )
        .bind(group_id)
        .fetch_all(pool)
        .await?;

        let mut meetings: Vec<GroupMeetingRow> = Vec::new();
        let mut attendance: HashMap<String, (String, i64)> = HashMap::new();
        for (meeting_id, title, created_at, duration_seconds, person_id, person_name) in rows {
            if meetings.last().map(|m| m.meeting_id.as_str()) != Some(meeting_id.as_str()) {
                meetings.push(GroupMeetingRow {
                    meeting_id: meeting_id.clone(),
                    title,
                    created_at,
                    duration_seconds,
                    present: Vec::new(),
                });
            }
            if let (Some(person_id), Some(person_name)) = (person_id, person_name) {
                if let Some(meeting) = meetings.last_mut() {
                    if !meeting.present.iter().any(|name| name == &person_name) {
                        meeting.present.push(person_name.clone());
                        attendance.entry(person_id).or_insert((person_name, 0)).1 += 1;
                    }
                }
            }
        }

        let meeting_total = meetings.len() as i64;
        let mut members: Vec<GroupMember> = attendance
            .into_iter()
            .map(|(person_id, (display_name, meeting_count))| GroupMember {
                person_id,
                display_name,
                meeting_count,
            })
            .collect();
        members.sort_by(|a, b| {
            b.meeting_count
                .cmp(&a.meeting_count)
                .then_with(|| a.display_name.cmp(&b.display_name))
        });
        let (rare, frequent): (Vec<GroupMember>, Vec<GroupMember>) =
            members.into_iter().partition(|member| {
                if meeting_total <= 3 {
                    member.meeting_count * 2 < meeting_total.max(1)
                } else {
                    member.meeting_count <= 2
                }
            });

        let needle = query.unwrap_or("").trim().to_lowercase();
        if !needle.is_empty() {
            let like = format!(
                "%{}%",
                needle.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
            );
            let transcript_hits: Vec<String> = sqlx::query_scalar(
                "SELECT DISTINCT t.meeting_id FROM transcripts t \
                 JOIN meetings m ON m.id = t.meeting_id \
                 WHERE m.group_id = ? AND lower(t.transcript) LIKE ? ESCAPE '\\'",
            )
            .bind(group_id)
            .bind(&like)
            .fetch_all(pool)
            .await?;
            meetings.retain(|meeting| {
                meeting.title.to_lowercase().contains(&needle)
                    || meeting
                        .present
                        .iter()
                        .any(|name| name.to_lowercase().contains(&needle))
                    || transcript_hits.iter().any(|id| id == &meeting.meeting_id)
            });
        }

        Ok(GroupDetail {
            group,
            frequent,
            rare,
            meetings,
        })
    }
}

fn group_error(action: &str, error: sqlx::Error) -> String {
    match error {
        sqlx::Error::RowNotFound => "Group not found".to_string(),
        sqlx::Error::Protocol(message) => message,
        other => format!("Failed to {}: {}", action, other),
    }
}

#[tauri::command]
pub async fn api_list_groups(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<Vec<GroupListItem>, String> {
    GroupsRepository::list(state.db_manager.pool())
        .await
        .map_err(|error| group_error("list groups", error))
}

#[tauri::command]
pub async fn api_create_group(
    state: tauri::State<'_, crate::state::AppState>,
    name: String,
    color: Option<String>,
    kind: Option<String>,
    description: Option<String>,
    schedule: Option<serde_json::Value>,
) -> Result<GroupListItem, String> {
    GroupsRepository::create(
        state.db_manager.pool(),
        GroupInput {
            name,
            color,
            kind,
            description,
            schedule,
        },
    )
    .await
    .map_err(|error| group_error("create group", error))
}

#[tauri::command]
pub async fn api_update_group(
    state: tauri::State<'_, crate::state::AppState>,
    group_id: String,
    name: String,
    color: Option<String>,
    kind: Option<String>,
    description: Option<String>,
    schedule: Option<serde_json::Value>,
) -> Result<GroupListItem, String> {
    GroupsRepository::update(
        state.db_manager.pool(),
        &group_id,
        GroupInput {
            name,
            color,
            kind,
            description,
            schedule,
        },
    )
    .await
    .map_err(|error| group_error("update group", error))
}

#[tauri::command]
pub async fn api_delete_group(
    state: tauri::State<'_, crate::state::AppState>,
    group_id: String,
) -> Result<(), String> {
    GroupsRepository::delete(state.db_manager.pool(), &group_id)
        .await
        .map_err(|error| group_error("delete group", error))
}

#[tauri::command]
pub async fn api_get_group(
    state: tauri::State<'_, crate::state::AppState>,
    group_id: String,
    query: Option<String>,
) -> Result<GroupDetail, String> {
    GroupsRepository::detail(state.db_manager.pool(), &group_id, query.as_deref())
        .await
        .map_err(|error| group_error("load group", error))
}

#[tauri::command]
pub async fn api_set_meeting_group(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    group_id: Option<String>,
) -> Result<(), String> {
    GroupsRepository::set_meeting_group(
        state.db_manager.pool(),
        &meeting_id,
        group_id.as_deref().filter(|id| !id.trim().is_empty()),
    )
    .await
    .map_err(|error| match error {
        sqlx::Error::RowNotFound => "Meeting or group not found".to_string(),
        _ => format!("Failed to update meeting group: {}", error),
    })
}

#[tauri::command]
pub async fn api_set_meetings_group(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_ids: Vec<String>,
    group_id: Option<String>,
) -> Result<u64, String> {
    GroupsRepository::set_meetings_group(
        state.db_manager.pool(),
        &meeting_ids,
        group_id.as_deref().filter(|id| !id.trim().is_empty()),
    )
    .await
    .map_err(|error| group_error("move meetings", error))
}

#[tauri::command]
pub async fn api_get_meeting_group(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
) -> Result<Option<GroupListItem>, String> {
    GroupsRepository::meeting_group(state.db_manager.pool(), &meeting_id)
        .await
        .map_err(|error| group_error("load meeting group", error))
}

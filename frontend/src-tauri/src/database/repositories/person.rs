//! Durable cross-meeting people, global search, and person-AI context.
//!
//! A transcript's `speaker` remains the meeting-local display snapshot used by
//! existing renderers and diarization. `person_speakers` is the authoritative
//! identity link: generated/capture labels never become people, while equal
//! normalized custom names intentionally auto-link across meetings. All profile
//! and AI queries join through that mapping instead of guessing from label text.

use serde::Serialize;
use sqlx::{Sqlite, SqlitePool, Transaction};
use std::cmp::Ordering;
use std::collections::HashMap;
use uuid::Uuid;

use crate::state::AppState;

const DEFAULT_SEARCH_LIMIT: i64 = 40;
const MAX_SEARCH_LIMIT: i64 = 100;
// Roughly 3k tokens at four characters per token, leaving room for the bounded
// question, grounding prompt, and answer on a 4k-token model.
const PERSON_CONTEXT_CHARS: usize = 12_000;
const MEETING_MESSAGE_CHARS: usize = 8_000;
const MEETING_SUMMARY_CHARS: usize = 4_000;
const MESSAGE_TEXT_CHARS: usize = 1_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchResult {
    pub kind: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub person_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_id: Option<String>,
    pub title: String,
    pub snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_start_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonMeeting {
    pub meeting_id: String,
    pub title: String,
    pub created_at: String,
    pub message_count: i64,
    pub speaking_seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonProfile {
    pub id: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub meeting_count: i64,
    pub message_count: i64,
    pub total_speaking_seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_seen_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    pub meetings: Vec<PersonMeeting>,
}

#[derive(Debug)]
pub(crate) struct PersonContextMeeting {
    pub meeting_id: String,
    pub title: String,
    pub created_at: String,
    pub summary: Option<String>,
    pub messages: Vec<PersonContextMessage>,
}

#[derive(Debug)]
pub(crate) struct PersonContextMessage {
    pub text: String,
    pub timestamp: String,
    pub audio_start_time: Option<f64>,
}

#[derive(Debug)]
struct RankedResult {
    score: i32,
    sort_time: String,
    result: GlobalSearchResult,
}

pub struct PeopleRepository;

pub(crate) struct SpeakerRenameOutcome {
    pub count: u64,
    pub speaker: String,
    pub removed_name: bool,
}

impl PeopleRepository {
    pub async fn global_search(
        pool: &SqlitePool,
        query: &str,
        limit: Option<i64>,
    ) -> Result<Vec<GlobalSearchResult>, sqlx::Error> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }

        let limit = limit
            .unwrap_or(DEFAULT_SEARCH_LIMIT)
            .clamp(1, MAX_SEARCH_LIMIT);
        let normalized_query = normalize_person_name(query);
        let like_query = format!("%{}%", escape_like(&normalized_query));
        let mut ranked = Vec::new();

        let people = sqlx::query_as::<_, (String, String, Option<String>, i64)>(
            "SELECT p.id, p.display_name, p.notes, COUNT(DISTINCT ps.meeting_id) \
             FROM people p \
             LEFT JOIN person_speakers ps ON ps.person_id = p.id \
             WHERE p.normalized_name LIKE ? ESCAPE '\\' \
             GROUP BY p.id, p.display_name, p.notes, p.updated_at \
             ORDER BY p.updated_at DESC LIMIT ?",
        )
        .bind(&like_query)
        .bind(limit)
        .fetch_all(pool)
        .await?;

        for (id, display_name, notes, meeting_count) in people {
            let score = match_quality(&normalize_person_name(&display_name), &normalized_query);
            ranked.push(RankedResult {
                score,
                sort_time: String::new(),
                result: GlobalSearchResult {
                    kind: "person".to_string(),
                    id: id.clone(),
                    meeting_id: None,
                    person_id: Some(id),
                    transcript_id: None,
                    title: display_name,
                    snippet: notes.unwrap_or_else(|| format!("{} mapped meetings", meeting_count)),
                    timestamp: None,
                    speaker: None,
                    audio_start_time: None,
                    meeting_count: Some(meeting_count),
                },
            });
        }

        let meetings = sqlx::query_as::<_, (String, String, String)>(
            "SELECT id, title, created_at FROM meetings \
             WHERE lower(title) LIKE ? ESCAPE '\\' \
             ORDER BY created_at DESC LIMIT ?",
        )
        .bind(&like_query)
        .bind(limit)
        .fetch_all(pool)
        .await?;

        for (id, title, created_at) in meetings {
            ranked.push(RankedResult {
                score: match_quality(&title.to_lowercase(), &normalized_query),
                sort_time: created_at.clone(),
                result: GlobalSearchResult {
                    kind: "meeting".to_string(),
                    id: id.clone(),
                    meeting_id: Some(id),
                    person_id: None,
                    transcript_id: None,
                    title: title.clone(),
                    snippet: title,
                    timestamp: Some(created_at),
                    speaker: None,
                    audio_start_time: None,
                    meeting_count: None,
                },
            });
        }

        let transcripts = sqlx::query_as::<
            _,
            (
                String,
                String,
                String,
                String,
                String,
                Option<String>,
                Option<f64>,
            ),
        >(
            "SELECT t.id, m.id, m.title, t.transcript, t.timestamp, t.speaker, t.audio_start_time \
             FROM transcripts t JOIN meetings m ON m.id = t.meeting_id \
             WHERE lower(t.transcript) LIKE ? ESCAPE '\\' \
                OR lower(COALESCE(t.speaker, '')) LIKE ? ESCAPE '\\' \
             ORDER BY m.created_at DESC, t.audio_start_time ASC LIMIT ?",
        )
        .bind(&like_query)
        .bind(&like_query)
        .bind(limit)
        .fetch_all(pool)
        .await?;

        for (id, meeting_id, title, text, timestamp, speaker, audio_start_time) in transcripts {
            let speaker_match = speaker
                .as_deref()
                .map(|value| value.to_lowercase().contains(&normalized_query))
                .unwrap_or(false);
            ranked.push(RankedResult {
                score: if speaker_match { 5 } else { 20 },
                sort_time: timestamp.clone(),
                result: GlobalSearchResult {
                    kind: "transcript".to_string(),
                    id: id.clone(),
                    meeting_id: Some(meeting_id),
                    person_id: None,
                    transcript_id: Some(id),
                    title,
                    snippet: snippet_around(&text, query, 180),
                    timestamp: Some(timestamp),
                    speaker,
                    audio_start_time,
                    meeting_count: None,
                },
            });
        }

        // Summary JSON contains caches and editor structure, so only parsed,
        // user-visible text is searched. Never use a LIKE against the raw blob.
        let summaries = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT m.id, m.title, m.created_at, s.result \
             FROM summary_processes s JOIN meetings m ON m.id = s.meeting_id \
             WHERE s.result IS NOT NULL ORDER BY m.created_at DESC",
        )
        .fetch_all(pool)
        .await?;

        for (meeting_id, title, created_at, raw) in summaries {
            let Some(visible) = visible_summary_text(&raw) else {
                continue;
            };
            if !visible.to_lowercase().contains(&normalized_query) {
                continue;
            }
            ranked.push(RankedResult {
                score: 25,
                sort_time: created_at.clone(),
                result: GlobalSearchResult {
                    kind: "summary".to_string(),
                    id: format!("summary-{}", meeting_id),
                    meeting_id: Some(meeting_id),
                    person_id: None,
                    transcript_id: None,
                    title,
                    snippet: snippet_around(&visible, query, 220),
                    timestamp: Some(created_at),
                    speaker: None,
                    audio_start_time: None,
                    meeting_count: None,
                },
            });
        }

        ranked.sort_by(|a, b| {
            a.score
                .cmp(&b.score)
                .then_with(|| b.sort_time.cmp(&a.sort_time))
                .then_with(|| a.result.id.cmp(&b.result.id))
        });
        ranked.truncate(limit as usize);
        Ok(ranked.into_iter().map(|item| item.result).collect())
    }

    pub async fn get_profile(
        pool: &SqlitePool,
        person_id: &str,
    ) -> Result<PersonProfile, sqlx::Error> {
        let person = sqlx::query_as::<_, (String, String, Option<String>)>(
            "SELECT id, display_name, notes FROM people WHERE id = ?",
        )
        .bind(person_id)
        .fetch_optional(pool)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;

        let rows = sqlx::query_as::<_, (String, String, String, i64, f64, Option<String>)>(
            "SELECT m.id, m.title, m.created_at, COUNT(t.id), \
                    COALESCE(SUM(CASE \
                        WHEN t.duration IS NOT NULL AND t.duration > 0 THEN t.duration \
                        WHEN t.audio_end_time IS NOT NULL AND t.audio_start_time IS NOT NULL \
                             AND t.audio_end_time > t.audio_start_time \
                            THEN t.audio_end_time - t.audio_start_time \
                        ELSE 0 END), 0.0), \
                    (SELECT tx.transcript FROM transcripts tx \
                     JOIN person_speakers px ON px.meeting_id = tx.meeting_id \
                                             AND px.speaker_label = tx.speaker \
                     WHERE px.person_id = ? AND tx.meeting_id = m.id \
                     ORDER BY COALESCE(tx.audio_start_time, 1e30), tx.timestamp LIMIT 1) \
             FROM meetings m \
             JOIN person_speakers ps ON ps.meeting_id = m.id AND ps.person_id = ? \
             LEFT JOIN transcripts t ON t.meeting_id = ps.meeting_id \
                                     AND t.speaker = ps.speaker_label \
             GROUP BY m.id, m.title, m.created_at \
             ORDER BY m.created_at DESC",
        )
        .bind(person_id)
        .bind(person_id)
        .fetch_all(pool)
        .await?;

        let meetings: Vec<PersonMeeting> = rows
            .into_iter()
            .map(
                |(meeting_id, title, created_at, message_count, speaking_seconds, excerpt)| {
                    PersonMeeting {
                        meeting_id,
                        title,
                        created_at,
                        message_count,
                        speaking_seconds,
                        excerpt: excerpt.map(|text| truncate_chars(&text, 240)),
                    }
                },
            )
            .collect();
        let message_count = meetings.iter().map(|meeting| meeting.message_count).sum();
        let total_speaking_seconds = meetings
            .iter()
            .map(|meeting| meeting.speaking_seconds)
            .sum();

        Ok(PersonProfile {
            id: person.0,
            display_name: person.1,
            notes: person.2,
            meeting_count: meetings.len() as i64,
            message_count,
            total_speaking_seconds,
            first_seen_at: meetings.last().map(|meeting| meeting.created_at.clone()),
            last_seen_at: meetings.first().map(|meeting| meeting.created_at.clone()),
            meetings,
        })
    }

    pub async fn update_notes(
        pool: &SqlitePool,
        person_id: &str,
        notes: Option<String>,
    ) -> Result<(), sqlx::Error> {
        let notes = notes.and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        });
        let result =
            sqlx::query("UPDATE people SET notes = ?, updated_at = datetime('now') WHERE id = ?")
                .bind(notes)
                .bind(person_id)
                .execute(pool)
                .await?;
        if result.rows_affected() == 0 {
            return Err(sqlx::Error::RowNotFound);
        }
        Ok(())
    }

    /// Relabeling changes transcript attribution and durable identity in one
    /// transaction. A blank destination removes the identity assignment and
    /// restores the lowest available meeting-local `Speaker N` label.
    pub(crate) async fn rename_meeting_speaker(
        pool: &SqlitePool,
        meeting_id: &str,
        from: &str,
        to: &str,
    ) -> Result<SpeakerRenameOutcome, sqlx::Error> {
        let to = to.trim();
        let mut tx = pool.begin().await?;
        let removed_name = to.is_empty();
        let resolved_to = if removed_name {
            next_available_speaker_label(&mut tx, meeting_id).await?
        } else {
            to.to_string()
        };
        let result =
            sqlx::query("UPDATE transcripts SET speaker = ? WHERE meeting_id = ? AND speaker = ?")
                .bind(&resolved_to)
                .bind(meeting_id)
                .bind(from)
                .execute(&mut *tx)
                .await?;
        let count = result.rows_affected();

        if removed_name {
            sqlx::query("DELETE FROM person_speakers WHERE meeting_id = ? AND speaker_label = ?")
                .bind(meeting_id)
                .bind(from)
                .execute(&mut *tx)
                .await?;
            delete_orphan_people(&mut tx).await?;
        } else if count > 0 {
            Self::reconcile_speaker_identity(&mut tx, meeting_id, from, &resolved_to).await?;
        }
        tx.commit().await?;
        Ok(SpeakerRenameOutcome {
            count,
            speaker: resolved_to,
            removed_name,
        })
    }

    async fn reconcile_speaker_identity(
        tx: &mut Transaction<'_, Sqlite>,
        meeting_id: &str,
        from: &str,
        to: &str,
    ) -> Result<(), sqlx::Error> {
        let current_person: Option<String> = sqlx::query_scalar(
            "SELECT person_id FROM person_speakers WHERE meeting_id = ? AND speaker_label = ?",
        )
        .bind(meeting_id)
        .bind(from)
        .fetch_optional(&mut **tx)
        .await?;

        sqlx::query("DELETE FROM person_speakers WHERE meeting_id = ? AND speaker_label = ?")
            .bind(meeting_id)
            .bind(from)
            .execute(&mut **tx)
            .await?;

        if !is_person_name(to) {
            delete_orphan_people(tx).await?;
            return Ok(());
        }

        let normalized = normalize_person_name(to);
        let named_person = find_person_by_normalized_name(tx, &normalized).await?;
        // Removing this meeting/label mapping first lets us distinguish a truly
        // private profile from a shared identity. Any surviving mapping, even a
        // second alias in this same meeting, means changing the person row would
        // silently rename records the dialog did not claim to edit.
        let current_has_remaining_mappings = if let Some(current) = current_person.as_deref() {
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM person_speakers WHERE person_id = ?")
                    .bind(current)
                    .fetch_one(&mut **tx)
                    .await?;
            count > 0
        } else {
            false
        };

        let person_id = match (current_person.as_deref(), named_person.as_deref()) {
            // Exact-name auto-link: assigning a known name joins its existing
            // profile instead of creating a duplicate person.
            (_, Some(named)) => named.to_string(),
            // The old person is now unreferenced, so it is safe to reuse its ID
            // and preserve profile notes while changing the display name.
            (Some(current), None) if !current_has_remaining_mappings => {
                sqlx::query(
                    "UPDATE people SET display_name = ?, normalized_name = ?, \
                     updated_at = datetime('now') WHERE id = ?",
                )
                .bind(to)
                .bind(&normalized)
                .bind(current)
                .execute(&mut **tx)
                .await?;
                current.to_string()
            }
            // Shared profiles split here. This keeps the rename meeting-local
            // while leaving the other meetings attached to the original person.
            _ => {
                let id = format!("person-{}", Uuid::new_v4());
                sqlx::query(
                    "INSERT INTO people \
                     (id, display_name, normalized_name, notes, created_at, updated_at) \
                     VALUES (?, ?, ?, NULL, datetime('now'), datetime('now'))",
                )
                .bind(&id)
                .bind(to)
                .bind(&normalized)
                .execute(&mut **tx)
                .await?;
                id
            }
        };

        sqlx::query(
            "INSERT INTO person_speakers (person_id, meeting_id, speaker_label) \
             VALUES (?, ?, ?) \
             ON CONFLICT(meeting_id, speaker_label) DO UPDATE SET person_id = excluded.person_id",
        )
        .bind(person_id)
        .bind(meeting_id)
        .bind(to)
        .execute(&mut **tx)
        .await?;
        delete_orphan_people(tx).await?;
        Ok(())
    }

    pub(crate) async fn load_person_context(
        pool: &SqlitePool,
        person_id: &str,
    ) -> Result<(String, Vec<PersonContextMeeting>), sqlx::Error> {
        let display_name: String =
            sqlx::query_scalar("SELECT display_name FROM people WHERE id = ?")
                .bind(person_id)
                .fetch_optional(pool)
                .await?
                .ok_or(sqlx::Error::RowNotFound)?;

        let meeting_rows = sqlx::query_as::<_, (String, String, String, Option<String>)>(
            "SELECT DISTINCT m.id, m.title, m.created_at, s.result \
             FROM person_speakers ps \
             JOIN meetings m ON m.id = ps.meeting_id \
             LEFT JOIN summary_processes s ON s.meeting_id = m.id \
             WHERE ps.person_id = ? \
             ORDER BY m.created_at DESC LIMIT 100",
        )
        .bind(person_id)
        .fetch_all(pool)
        .await?;

        let message_rows = sqlx::query_as::<_, (String, String, String, Option<f64>)>(
            "SELECT t.meeting_id, t.transcript, t.timestamp, t.audio_start_time \
             FROM transcripts t \
             JOIN person_speakers ps ON ps.meeting_id = t.meeting_id \
                                    AND ps.speaker_label = t.speaker \
             JOIN meetings m ON m.id = t.meeting_id \
             WHERE ps.person_id = ? \
             ORDER BY m.created_at DESC, COALESCE(t.audio_start_time, 1e30), t.timestamp \
             LIMIT 5000",
        )
        .bind(person_id)
        .fetch_all(pool)
        .await?;

        let mut messages: HashMap<String, Vec<PersonContextMessage>> = HashMap::new();
        for (meeting_id, text, timestamp, audio_start_time) in message_rows {
            messages
                .entry(meeting_id)
                .or_default()
                .push(PersonContextMessage {
                    text,
                    timestamp,
                    audio_start_time,
                });
        }

        let meetings = meeting_rows
            .into_iter()
            .map(
                |(meeting_id, title, created_at, raw_summary)| PersonContextMeeting {
                    messages: messages.remove(&meeting_id).unwrap_or_default(),
                    summary: raw_summary.and_then(|raw| visible_summary_text(&raw)),
                    meeting_id,
                    title,
                    created_at,
                },
            )
            .collect();
        Ok((display_name, meetings))
    }
}

#[tauri::command]
pub async fn api_global_search(
    state: tauri::State<'_, AppState>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<GlobalSearchResult>, String> {
    PeopleRepository::global_search(state.db_manager.pool(), &query, limit)
        .await
        .map_err(|error| format!("Global search failed: {}", error))
}

#[tauri::command]
pub async fn api_get_person_profile(
    state: tauri::State<'_, AppState>,
    person_id: String,
) -> Result<PersonProfile, String> {
    PeopleRepository::get_profile(state.db_manager.pool(), &person_id)
        .await
        .map_err(|error| match error {
            sqlx::Error::RowNotFound => "Person not found".to_string(),
            _ => format!("Failed to load person profile: {}", error),
        })
}

#[tauri::command]
pub async fn api_update_person_notes(
    state: tauri::State<'_, AppState>,
    person_id: String,
    notes: Option<String>,
) -> Result<(), String> {
    PeopleRepository::update_notes(state.db_manager.pool(), &person_id, notes)
        .await
        .map_err(|error| match error {
            sqlx::Error::RowNotFound => "Person not found".to_string(),
            _ => format!("Failed to update person notes: {}", error),
        })
}

pub(crate) fn normalize_person_name(name: &str) -> String {
    name.trim().to_lowercase()
}

pub(crate) fn is_person_name(name: &str) -> bool {
    let trimmed = name.trim();
    let lower = trimmed.to_ascii_lowercase();
    if trimmed.is_empty()
        || matches!(
            lower.as_str(),
            "you" | "guest" | "mic" | "microphone" | "system" | "system audio" | "speaker"
        )
        || lower.starts_with("speaker ")
        || trimmed.contains(" + ")
    {
        return false;
    }
    true
}

async fn next_available_speaker_label(
    tx: &mut Transaction<'_, Sqlite>,
    meeting_id: &str,
) -> Result<String, sqlx::Error> {
    let labels: Vec<String> = sqlx::query_scalar(
        "SELECT speaker FROM transcripts WHERE meeting_id = ? AND speaker IS NOT NULL \
         UNION SELECT speaker_label FROM person_speakers WHERE meeting_id = ?",
    )
    .bind(meeting_id)
    .bind(meeting_id)
    .fetch_all(&mut **tx)
    .await?;

    for index in 1_u64.. {
        let candidate = format!("Speaker {}", index);
        if !labels
            .iter()
            .any(|label| label.eq_ignore_ascii_case(&candidate))
        {
            return Ok(candidate);
        }
    }
    unreachable!("positive speaker labels are unbounded")
}

pub(crate) fn visible_summary_text(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(value) => visible_summary_value(&value),
        Err(_) if raw.starts_with('{') || raw.starts_with('[') => None,
        Err(_) => Some(raw.to_string()),
    }
}

fn visible_summary_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => {
            let text = text.trim();
            if text.starts_with('{') || text.starts_with('[') {
                visible_summary_text(text)
            } else {
                (!text.is_empty()).then(|| text.to_string())
            }
        }
        serde_json::Value::Array(blocks) => blocknote_text(blocks),
        serde_json::Value::Object(object) => {
            if let Some(markdown) = object
                .get("markdown")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                return Some(markdown.to_string());
            }
            if let Some(blocks) = object
                .get("summary_json")
                .and_then(serde_json::Value::as_array)
            {
                if let Some(text) = blocknote_text(blocks) {
                    return Some(text);
                }
            }

            let mut sections = Vec::new();
            let ordered_keys: Vec<&str> = object
                .get("_section_order")
                .and_then(serde_json::Value::as_array)
                .map(|keys| keys.iter().filter_map(serde_json::Value::as_str).collect())
                .unwrap_or_else(|| object.keys().map(String::as_str).collect());
            for key in ordered_keys {
                if matches!(
                    key,
                    "markdown"
                        | "summary_json"
                        | "_section_order"
                        | "MeetingName"
                        | "english_cache"
                ) {
                    continue;
                }
                let Some(section) = object.get(key).and_then(serde_json::Value::as_object) else {
                    continue;
                };
                let Some(blocks) = section.get("blocks").and_then(serde_json::Value::as_array)
                else {
                    continue;
                };
                if let Some(title) = section
                    .get("title")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
                {
                    sections.push(title.to_string());
                }
                for block in blocks {
                    let text = inline_text(block).trim().to_string();
                    if !text.is_empty() {
                        sections.push(text);
                    }
                }
            }
            (!sections.is_empty()).then(|| sections.join("\n"))
        }
        _ => None,
    }
}

fn blocknote_text(blocks: &[serde_json::Value]) -> Option<String> {
    fn walk(blocks: &[serde_json::Value], output: &mut Vec<String>) {
        for block in blocks {
            let text = block
                .get("content")
                .map(inline_text)
                .unwrap_or_default()
                .trim()
                .to_string();
            if !text.is_empty() {
                output.push(text);
            }
            if let Some(children) = block.get("children").and_then(serde_json::Value::as_array) {
                walk(children, output);
            }
        }
    }

    let mut output = Vec::new();
    walk(blocks, &mut output);
    (!output.is_empty()).then(|| output.join("\n"))
}

fn inline_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(values) => values.iter().map(inline_text).collect(),
        serde_json::Value::Object(object) => {
            if let Some(text) = object.get("text").and_then(serde_json::Value::as_str) {
                text.to_string()
            } else {
                object.get("content").map(inline_text).unwrap_or_default()
            }
        }
        _ => String::new(),
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn match_quality(value: &str, query: &str) -> i32 {
    match value.cmp(query) {
        Ordering::Equal => 0,
        _ if value.starts_with(query) => 3,
        _ => 10,
    }
}

fn snippet_around(text: &str, query: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_chars {
        return text.to_string();
    }

    let lower = text.to_lowercase();
    let query_lower = query.to_lowercase();
    let match_char = lower
        .find(&query_lower)
        .map(|byte| lower[..byte].chars().count())
        .unwrap_or(0)
        .min(chars.len());
    let start = match_char.saturating_sub(max_chars / 3);
    let end = (start + max_chars).min(chars.len());
    let mut snippet: String = chars[start..end].iter().collect();
    if start > 0 {
        snippet.insert_str(0, "...");
    }
    if end < chars.len() {
        snippet.push_str("...");
    }
    snippet
}

pub(crate) fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut value: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        value.push_str("...");
    }
    value
}

pub(crate) fn build_person_context(
    display_name: &str,
    meetings: &[PersonContextMeeting],
) -> String {
    let mut context = String::new();
    let display_label = display_name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    for meeting in meetings {
        let header = format!(
            "\nMEETING: {}\nDATE: {}\nMEETING ID: {}\nPERSON MESSAGES (attributed to {}):\n",
            meeting.title, meeting.created_at, meeting.meeting_id, display_label
        );
        if context.chars().count() + header.chars().count() > PERSON_CONTEXT_CHARS {
            break;
        }
        context.push_str(&header);

        let mut message_chars = 0;
        for message in &meeting.messages {
            let citation = message
                .audio_start_time
                .map(format_audio_time)
                .unwrap_or_else(|| message.timestamp.clone());
            let message_text = message
                .text
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            let line = format!(
                "[{}] {}: {}\n",
                citation,
                display_label,
                truncate_chars(&message_text, MESSAGE_TEXT_CHARS)
            );
            let line_chars = line.chars().count();
            if message_chars + line_chars > MEETING_MESSAGE_CHARS
                || context.chars().count() + line_chars > PERSON_CONTEXT_CHARS
            {
                let omitted = "[additional person messages omitted]\n";
                if context.chars().count() + omitted.chars().count() <= PERSON_CONTEXT_CHARS {
                    context.push_str(omitted);
                }
                break;
            }
            message_chars += line_chars;
            context.push_str(&line);
        }
        if meeting.messages.is_empty() {
            let empty = "(no attributed messages)\n";
            if context.chars().count() + empty.chars().count() <= PERSON_CONTEXT_CHARS {
                context.push_str(empty);
            }
        }
        if let Some(summary) = meeting.summary.as_deref() {
            let summary_header = "MEETING SUMMARY (meeting-level; not attributed to the person):\n";
            let remaining = PERSON_CONTEXT_CHARS
                .saturating_sub(context.chars().count() + summary_header.chars().count() + 1);
            if remaining >= 3 {
                context.push_str(summary_header);
                context.push_str(&truncate_chars(
                    summary,
                    MEETING_SUMMARY_CHARS.min(remaining.saturating_sub(3)),
                ));
                context.push('\n');
            }
        }
    }
    context
}

fn format_audio_time(seconds: f64) -> String {
    let seconds = seconds.max(0.0).floor() as u64;
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

pub(crate) async fn clear_meeting_speaker_mappings(
    tx: &mut Transaction<'_, Sqlite>,
    meeting_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM person_speakers WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut **tx)
        .await?;
    delete_orphan_people(tx).await
}

async fn delete_orphan_people(tx: &mut Transaction<'_, Sqlite>) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM people WHERE NOT EXISTS \
         (SELECT 1 FROM person_speakers ps WHERE ps.person_id = people.id)",
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// SQLite's built-in lower/LIKE folding is ASCII-only. Migration values remain
/// compatible with SQL search, while this Rust fallback compares display names
/// with Unicode lowercase before deciding that a new identity is necessary.
async fn find_person_by_normalized_name(
    tx: &mut Transaction<'_, Sqlite>,
    normalized: &str,
) -> Result<Option<String>, sqlx::Error> {
    if let Some(id) = sqlx::query_scalar("SELECT id FROM people WHERE normalized_name = ?")
        .bind(normalized)
        .fetch_optional(&mut **tx)
        .await?
    {
        return Ok(Some(id));
    }

    let candidates = sqlx::query_as::<_, (String, String, String)>(
        "SELECT id, display_name, normalized_name FROM people",
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(candidates
        .into_iter()
        .find(|(_, display_name, stored_normalized)| {
            normalize_person_name(display_name) == normalized
                || normalize_person_name(stored_normalized) == normalized
        })
        .map(|(id, _, _)| id))
}

#[cfg(test)]
mod tests {
    use super::{
        build_person_context, clear_meeting_speaker_mappings, escape_like, is_person_name,
        normalize_person_name, visible_summary_text, PeopleRepository, PersonContextMeeting,
        PersonContextMessage, PERSON_CONTEXT_CHARS,
    };

    #[test]
    fn normalizes_and_filters_identity_labels() {
        assert_eq!(normalize_person_name("  Alice SMITH  "), "alice smith");
        assert_eq!(escape_like(r"50%_off\today"), r"50\%\_off\\today");
        assert!(is_person_name("Alice Smith"));
        for label in [
            "",
            " You ",
            "guest",
            "Speaker 1",
            "speaker 004",
            "Speaker One",
            "Speaker facilitator",
            "mic",
            " Microphone ",
            "SYSTEM",
            "system audio",
            "Alice + Bob",
        ] {
            assert!(!is_person_name(label), "{} should not be a person", label);
        }
    }

    #[test]
    fn extracts_only_visible_markdown() {
        let raw = r#"{
            "markdown":"Visible decision",
            "english_cache":{"markdown":"Hidden cache instruction"}
        }"#;
        assert_eq!(
            visible_summary_text(raw).as_deref(),
            Some("Visible decision")
        );
        let double_encoded = serde_json::to_string(raw).unwrap();
        assert_eq!(
            visible_summary_text(&double_encoded).as_deref(),
            Some("Visible decision")
        );
    }

    #[test]
    fn extracts_blocknote_and_legacy_sections() {
        let blocknote = r#"{"summary_json":[
            {"type":"heading","content":[{"text":"Overview"}],"children":[
                {"type":"paragraph","content":[{"text":"Nested detail"}]}
            ]}
        ]}"#;
        assert_eq!(
            visible_summary_text(blocknote).as_deref(),
            Some("Overview\nNested detail")
        );

        let legacy = r#"{
            "_section_order":["actions"],
            "actions":{"title":"Action Items","blocks":[{"content":"Call Alice"}]},
            "english_cache":{"markdown":"not visible"}
        }"#;
        assert_eq!(
            visible_summary_text(legacy).as_deref(),
            Some("Action Items\nCall Alice")
        );
    }

    #[tokio::test]
    async fn people_migration_backfills_only_custom_names() {
        let pool = sqlx::SqlitePool::connect(":memory:").await.unwrap();
        sqlx::raw_sql(
            "PRAGMA foreign_keys = ON; \
             CREATE TABLE meetings (id TEXT PRIMARY KEY); \
             CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker TEXT); \
             INSERT INTO meetings (id) VALUES ('m1'), ('m2'); \
             INSERT INTO transcripts (id, meeting_id, speaker) VALUES \
                ('t1', 'm1', 'Alice'), ('t2', 'm2', ' alice '), \
                ('t3', 'm1', 'You'), ('t4', 'm1', 'Guest'), \
                ('t5', 'm1', 'Speaker 12'), ('t6', 'm1', 'Speaker Facilitator'), \
                ('t7', 'm1', 'Alice + Bob'), ('t8', 'm1', 'mic'), \
                ('t9', 'm1', ' Microphone '), ('t10', 'm1', 'SYSTEM'), \
                ('t11', 'm1', 'system audio'), ('t12', 'missing', 'Charlie');",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../../migrations/20260811000000_add_people.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();

        let people: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM people")
            .fetch_one(&pool)
            .await
            .unwrap();
        let mappings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM person_speakers")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(people, 1);
        assert_eq!(mappings, 2);
    }

    #[tokio::test]
    async fn meeting_local_rename_splits_shared_people_and_links_existing_names() {
        let pool = sqlx::SqlitePool::connect(":memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, \
                 normalized_name TEXT NOT NULL UNIQUE, notes TEXT, created_at TEXT NOT NULL, \
                 updated_at TEXT NOT NULL); \
             CREATE TABLE person_speakers (person_id TEXT NOT NULL, meeting_id TEXT NOT NULL, \
                 speaker_label TEXT NOT NULL, UNIQUE(meeting_id, speaker_label)); \
             CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker TEXT); \
             INSERT INTO people VALUES \
                 ('person-alice', 'Alice', 'alice', NULL, 'now', 'now'), \
                 ('person-bob', 'Bob', 'bob', NULL, 'now', 'now'), \
                 ('person-david', 'David', 'david', NULL, 'now', 'now'); \
             INSERT INTO person_speakers VALUES \
                 ('person-alice', 'm1', 'Alice'), ('person-alice', 'm2', 'Alice'), \
                 ('person-bob', 'm3', 'Bob'), ('person-david', 'm4', 'David'); \
             INSERT INTO transcripts VALUES ('t1', 'm1', 'Alice'), ('t2', 'm4', 'David');",
        )
        .execute(&pool)
        .await
        .unwrap();

        PeopleRepository::rename_meeting_speaker(&pool, "m1", "Alice", "Alicia")
            .await
            .unwrap();
        let m1_person: String =
            sqlx::query_scalar("SELECT person_id FROM person_speakers WHERE meeting_id = 'm1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_ne!(m1_person, "person-alice");
        let alice_name: String =
            sqlx::query_scalar("SELECT display_name FROM people WHERE id = 'person-alice'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(alice_name, "Alice");

        PeopleRepository::rename_meeting_speaker(&pool, "m1", "Alicia", "Bob")
            .await
            .unwrap();
        let linked: String =
            sqlx::query_scalar("SELECT person_id FROM person_speakers WHERE meeting_id = 'm1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(linked, "person-bob");
        let alicia_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM people WHERE normalized_name = 'alicia'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(alicia_count, 0);

        PeopleRepository::rename_meeting_speaker(&pool, "m4", "David", "Dave")
            .await
            .unwrap();
        let renamed_id: String =
            sqlx::query_scalar("SELECT person_id FROM person_speakers WHERE meeting_id = 'm4'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(renamed_id, "person-david");
    }

    #[tokio::test]
    async fn rename_splits_when_old_person_has_another_label_in_same_meeting() {
        let pool = sqlx::SqlitePool::connect(":memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, \
                 normalized_name TEXT NOT NULL UNIQUE, notes TEXT, created_at TEXT NOT NULL, \
                 updated_at TEXT NOT NULL); \
             CREATE TABLE person_speakers (person_id TEXT NOT NULL, meeting_id TEXT NOT NULL, \
                 speaker_label TEXT NOT NULL, UNIQUE(meeting_id, speaker_label)); \
             CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker TEXT); \
             INSERT INTO people VALUES ('person-carol', 'Carol', 'carol', NULL, 'now', 'now'); \
             INSERT INTO person_speakers VALUES \
                 ('person-carol', 'm1', 'Carol'), ('person-carol', 'm1', 'C.'); \
             INSERT INTO transcripts VALUES ('t1', 'm1', 'Carol'), ('t2', 'm1', 'C.');",
        )
        .execute(&pool)
        .await
        .unwrap();

        PeopleRepository::rename_meeting_speaker(&pool, "m1", "Carol", "Caroline")
            .await
            .unwrap();
        let renamed_person: String = sqlx::query_scalar(
            "SELECT person_id FROM person_speakers \
             WHERE meeting_id = 'm1' AND speaker_label = 'Caroline'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let remaining_person: String = sqlx::query_scalar(
            "SELECT person_id FROM person_speakers \
             WHERE meeting_id = 'm1' AND speaker_label = 'C.'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let original_name: String =
            sqlx::query_scalar("SELECT display_name FROM people WHERE id = 'person-carol'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_ne!(renamed_person, "person-carol");
        assert_eq!(remaining_person, "person-carol");
        assert_eq!(original_name, "Carol");
    }

    #[tokio::test]
    async fn unicode_runtime_lookup_reuses_ascii_migration_profile() {
        let pool = sqlx::SqlitePool::connect(":memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, \
                 normalized_name TEXT NOT NULL UNIQUE, notes TEXT, created_at TEXT NOT NULL, \
                 updated_at TEXT NOT NULL); \
             CREATE TABLE person_speakers (person_id TEXT NOT NULL, meeting_id TEXT NOT NULL, \
                 speaker_label TEXT NOT NULL, UNIQUE(meeting_id, speaker_label)); \
             CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker TEXT); \
             INSERT INTO people VALUES ('person-elodie', 'Élodie', 'Élodie', NULL, 'now', 'now'); \
             INSERT INTO transcripts VALUES ('t1', 'm1', 'Speaker 1');",
        )
        .execute(&pool)
        .await
        .unwrap();

        PeopleRepository::rename_meeting_speaker(&pool, "m1", "Speaker 1", "élodie")
            .await
            .unwrap();
        let linked: String =
            sqlx::query_scalar("SELECT person_id FROM person_speakers WHERE meeting_id = 'm1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let people: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM people")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(linked, "person-elodie");
        assert_eq!(people, 1);
    }

    #[tokio::test]
    async fn replacement_cleanup_removes_meeting_mappings_and_orphans() {
        let pool = sqlx::SqlitePool::connect(":memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE people (id TEXT PRIMARY KEY); \
             CREATE TABLE person_speakers (person_id TEXT NOT NULL, meeting_id TEXT NOT NULL, \
                 speaker_label TEXT NOT NULL, UNIQUE(meeting_id, speaker_label)); \
             INSERT INTO people VALUES ('only-m1'), ('shared'); \
             INSERT INTO person_speakers VALUES \
                 ('only-m1', 'm1', 'Alice'), ('shared', 'm1', 'Bob'), ('shared', 'm2', 'Bob');",
        )
        .execute(&pool)
        .await
        .unwrap();
        let mut tx = pool.begin().await.unwrap();
        clear_meeting_speaker_mappings(&mut tx, "m1").await.unwrap();
        tx.commit().await.unwrap();

        let m1_mappings: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM person_speakers WHERE meeting_id = 'm1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let orphan: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM people WHERE id = 'only-m1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let shared: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM people WHERE id = 'shared'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(m1_mappings, 0);
        assert_eq!(orphan, 0);
        assert_eq!(shared, 1);
    }

    #[test]
    fn person_context_stays_conservative_and_keeps_citation_lines_complete() {
        let messages = (0..100)
            .map(|index| PersonContextMessage {
                text: format!("message {} {}", index, "x".repeat(2_000)),
                timestamp: "ignored".to_string(),
                audio_start_time: Some(index as f64),
            })
            .collect();
        let meetings = vec![PersonContextMeeting {
            meeting_id: "m1".to_string(),
            title: "Budget Test".to_string(),
            created_at: "2026-08-11".to_string(),
            summary: Some("summary ".repeat(2_000)),
            messages,
        }];

        let context = build_person_context("Alice", &meetings);
        assert_eq!(PERSON_CONTEXT_CHARS, 12_000);
        assert!(context.chars().count() <= PERSON_CONTEXT_CHARS);
        assert!(context
            .lines()
            .filter(|line| line.starts_with("[00:"))
            .all(|line| line.contains("] Alice: ")));
    }

    #[tokio::test]
    async fn removing_name_uses_available_local_label_and_unlinks_person() {
        let pool = sqlx::SqlitePool::connect(":memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE people (id TEXT PRIMARY KEY); \
             CREATE TABLE person_speakers (person_id TEXT NOT NULL, meeting_id TEXT NOT NULL, \
                 speaker_label TEXT NOT NULL, UNIQUE(meeting_id, speaker_label)); \
             CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker TEXT); \
             INSERT INTO people (id) VALUES ('person-alice'); \
             INSERT INTO person_speakers (person_id, meeting_id, speaker_label) VALUES \
                 ('person-alice', 'm1', 'Alice'), ('person-alice', 'm2', 'Alice'); \
             INSERT INTO transcripts (id, meeting_id, speaker) VALUES \
                 ('t1', 'm1', 'Speaker 1'), ('t2', 'm1', 'Alice'), \
                 ('t3', 'm1', 'Alice'), ('t4', 'm1', 'You');",
        )
        .execute(&pool)
        .await
        .unwrap();

        let removed = PeopleRepository::rename_meeting_speaker(&pool, "m1", "Alice", "   ")
            .await
            .unwrap();
        assert_eq!(removed.speaker, "Speaker 2");
        assert_eq!(removed.count, 2);
        assert!(removed.removed_name);

        let meeting_mapping_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM person_speakers WHERE meeting_id = 'm1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let other_meeting_mapping_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM person_speakers WHERE meeting_id = 'm2'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(meeting_mapping_count, 0);
        assert_eq!(other_meeting_mapping_count, 1);

        let removed_you = PeopleRepository::rename_meeting_speaker(&pool, "m1", "You", "")
            .await
            .unwrap();
        assert_eq!(removed_you.speaker, "Speaker 3");
        assert_eq!(removed_you.count, 1);
        assert!(removed_you.removed_name);
        let people_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM people")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(people_count, 1);
    }
}

//! Durable cross-meeting people, global search, and person-AI context.
//!
//! A transcript's `speaker` remains the meeting-local display snapshot used by
//! existing renderers and diarization. `person_speakers` is the authoritative
//! identity link: generated/capture labels never become people, while equal
//! normalized custom names intentionally auto-link across meetings. All profile
//! and AI queries join through that mapping instead of guessing from label text.

use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, SqlitePool, Transaction};
use std::cmp::Ordering;
use std::collections::HashMap;
use uuid::Uuid;

use super::action_item::{ActionItemFilter, ActionItemView, ActionItemsRepository};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
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
pub struct PersonGroupRef {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub meeting_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonListItem {
    pub id: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    pub meeting_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    pub groups: Vec<PersonGroupRef>,
}

/// Contact details the user can edit. Updates send the full state.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonInput {
    pub display_name: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub company: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonProfile {
    pub id: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    pub meeting_count: i64,
    pub message_count: i64,
    pub total_speaking_seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_seen_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<String>,
    pub meetings: Vec<PersonMeeting>,
    pub groups: Vec<PersonGroupRef>,
    /// Items this person owns, each linked back to its meeting.
    pub action_items: Vec<ActionItemView>,
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
                    group_id: None,
                    color: None,
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
                    group_id: None,
                    color: None,
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
                    group_id: None,
                    color: None,
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
                    group_id: None,
                    color: None,
                },
            });
        }

        let groups = sqlx::query_as::<_, (String, String, Option<String>, i64)>(
            "SELECT g.id, g.name, g.color, (SELECT COUNT(*) FROM meetings m WHERE m.group_id = g.id) \
             FROM groups g WHERE g.normalized_name LIKE ? ESCAPE '\\' LIMIT ?",
        )
        .bind(&like_query)
        .bind(limit)
        .fetch_all(pool)
        .await?;

        for (id, name, color, meeting_count) in groups {
            ranked.push(RankedResult {
                score: match_quality(&normalize_person_name(&name), &normalized_query) + 1,
                sort_time: String::new(),
                result: GlobalSearchResult {
                    kind: "group".to_string(),
                    id: id.clone(),
                    meeting_id: None,
                    person_id: None,
                    transcript_id: None,
                    title: name,
                    snippet: format!(
                        "{} meeting{}",
                        meeting_count,
                        if meeting_count == 1 { "" } else { "s" }
                    ),
                    timestamp: None,
                    speaker: None,
                    audio_start_time: None,
                    meeting_count: Some(meeting_count),
                    group_id: Some(id),
                    color,
                },
            });
        }

        let actions = sqlx::query_as::<_, (String, String, String, String, String, Option<String>, Option<f64>)>(
            "SELECT a.id, a.meeting_id, m.title, m.created_at, a.text, a.owner_label, a.audio_time \
             FROM action_items a JOIN meetings m ON m.id = a.meeting_id \
             WHERE lower(a.text) LIKE ? ESCAPE '\\' OR lower(COALESCE(a.owner_label, '')) LIKE ? ESCAPE '\\' \
             ORDER BY a.done, m.created_at DESC LIMIT ?",
        )
        .bind(&like_query)
        .bind(&like_query)
        .bind(limit)
        .fetch_all(pool)
        .await?;

        for (id, meeting_id, title, created_at, text, owner, audio_time) in actions {
            ranked.push(RankedResult {
                score: 18,
                sort_time: created_at.clone(),
                result: GlobalSearchResult {
                    kind: "action".to_string(),
                    id,
                    meeting_id: Some(meeting_id),
                    person_id: None,
                    transcript_id: None,
                    title,
                    snippet: text,
                    timestamp: Some(created_at),
                    speaker: owner,
                    audio_start_time: audio_time,
                    meeting_count: None,
                    group_id: None,
                    color: None,
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
        let person = sqlx::query_as::<
            _,
            (
                String,
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
            ),
        >(
            "SELECT id, display_name, notes, email, company, role, phone FROM people WHERE id = ?",
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

        let groups = person_groups(pool, person_id).await?;
        let action_items = ActionItemsRepository::list(
            pool,
            &ActionItemFilter {
                person_id: Some(person_id.to_string()),
                ..Default::default()
            },
        )
        .await?;

        Ok(PersonProfile {
            id: person.0,
            display_name: person.1,
            notes: person.2,
            email: person.3,
            company: person.4,
            role: person.5,
            phone: person.6,
            meeting_count: meetings.len() as i64,
            message_count,
            total_speaking_seconds,
            first_seen_at: meetings.last().map(|meeting| meeting.created_at.clone()),
            last_seen_at: meetings.first().map(|meeting| meeting.created_at.clone()),
            meetings,
            groups,
            action_items,
        })
    }

    /// After a meeting is saved, custom speaker names become contacts.
    /// Generated labels such as "Speaker 1" stay unlinked until the user names them.
    pub(crate) async fn link_named_speakers(
        tx: &mut Transaction<'_, Sqlite>,
        meeting_id: &str,
    ) -> Result<(), sqlx::Error> {
        let labels: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT speaker FROM transcripts \
             WHERE meeting_id = ? AND speaker IS NOT NULL",
        )
        .bind(meeting_id)
        .fetch_all(&mut **tx)
        .await?;
        for label in labels {
            if is_person_name(&label) {
                Self::reconcile_speaker_identity(tx, meeting_id, &label, &label).await?;
            }
        }
        Ok(())
    }

    pub async fn list_people(pool: &SqlitePool) -> Result<Vec<PersonListItem>, sqlx::Error> {
        let rows = sqlx::query_as::<
            _,
            (
                String,
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
                i64,
                Option<String>,
            ),
        >(
            "SELECT p.id, p.display_name, p.email, p.company, p.role, p.phone, \
                    COUNT(DISTINCT ps.meeting_id), MAX(m.created_at) \
             FROM people p \
             LEFT JOIN person_speakers ps ON ps.person_id = p.id \
             LEFT JOIN meetings m ON m.id = ps.meeting_id \
             GROUP BY p.id, p.display_name \
             ORDER BY p.display_name COLLATE NOCASE",
        )
        .fetch_all(pool)
        .await?;

        let group_rows = sqlx::query_as::<_, (String, String, String, Option<String>, i64)>(
            "SELECT ps.person_id, g.id, g.name, g.color, COUNT(DISTINCT m.id) \
             FROM person_speakers ps \
             JOIN meetings m ON m.id = ps.meeting_id \
             JOIN groups g ON g.id = m.group_id \
             GROUP BY ps.person_id, g.id \
             ORDER BY COUNT(DISTINCT m.id) DESC, g.name COLLATE NOCASE",
        )
        .fetch_all(pool)
        .await?;
        let mut groups_by_person: HashMap<String, Vec<PersonGroupRef>> = HashMap::new();
        for (person_id, id, name, color, meeting_count) in group_rows {
            groups_by_person.entry(person_id).or_default().push(PersonGroupRef {
                id,
                name,
                color,
                meeting_count,
            });
        }

        Ok(rows
            .into_iter()
            .map(
                |(id, display_name, email, company, role, phone, meeting_count, last_seen_at)| {
                    PersonListItem {
                        groups: groups_by_person.remove(&id).unwrap_or_default(),
                        id,
                        display_name,
                        email,
                        company,
                        role,
                        phone,
                        meeting_count,
                        last_seen_at,
                    }
                },
            )
            .collect())
    }

    async fn list_item(pool: &SqlitePool, person_id: &str) -> Result<PersonListItem, sqlx::Error> {
        Self::list_people(pool)
            .await?
            .into_iter()
            .find(|person| person.id == person_id)
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// A contact added by hand, before they have spoken in any meeting.
    pub async fn create_person(
        pool: &SqlitePool,
        input: PersonInput,
    ) -> Result<PersonListItem, sqlx::Error> {
        let name = input.display_name.trim().to_string();
        if !is_person_name(&name) {
            return Err(sqlx::Error::Protocol("Enter a name for the contact".into()));
        }
        let normalized = normalize_person_name(&name);
        let mut tx = pool.begin().await?;
        if find_person_by_normalized_name(&mut tx, &normalized).await?.is_some() {
            return Err(sqlx::Error::Protocol(format!("A contact named \"{}\" already exists", name)));
        }
        let id = format!("person-{}", Uuid::new_v4());
        sqlx::query(
            "INSERT INTO people (id, display_name, normalized_name, notes, email, company, role, phone, \
             is_manual, created_at, updated_at) \
             VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))",
        )
        .bind(&id)
        .bind(&name)
        .bind(&normalized)
        .bind(clean_field(input.email))
        .bind(clean_field(input.company))
        .bind(clean_field(input.role))
        .bind(clean_field(input.phone))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Self::list_item(pool, &id).await
    }

    /// Edits a contact. A new name is applied to every meeting the person
    /// spoke in, so transcripts, summaries on regeneration, and search agree.
    pub async fn update_person(
        pool: &SqlitePool,
        person_id: &str,
        input: PersonInput,
    ) -> Result<PersonListItem, sqlx::Error> {
        let name = input.display_name.trim().to_string();
        if !is_person_name(&name) {
            return Err(sqlx::Error::Protocol("Enter a name for the contact".into()));
        }
        let normalized = normalize_person_name(&name);
        let mut tx = pool.begin().await?;
        let current: String = sqlx::query_scalar("SELECT display_name FROM people WHERE id = ?")
            .bind(person_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
        if let Some(other) = find_person_by_normalized_name(&mut tx, &normalized).await? {
            if other != person_id {
                return Err(sqlx::Error::Protocol(format!(
                    "Another contact is already named \"{}\". Merge them instead.",
                    name
                )));
            }
        }

        sqlx::query(
            "UPDATE people SET display_name = ?, normalized_name = ?, email = ?, company = ?, role = ?, \
             phone = ?, is_manual = 1, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(&name)
        .bind(&normalized)
        .bind(clean_field(input.email))
        .bind(clean_field(input.company))
        .bind(clean_field(input.role))
        .bind(clean_field(input.phone))
        .bind(person_id)
        .execute(&mut *tx)
        .await?;

        if current != name {
            relabel_person(&mut tx, person_id, &name).await?;
        }
        tx.commit().await?;
        Self::list_item(pool, person_id).await
    }

    /// Folds `source` into `target`: every meeting, action item, and note of
    /// the duplicate ends up on the contact that is kept.
    pub async fn merge_people(
        pool: &SqlitePool,
        source_id: &str,
        target_id: &str,
    ) -> Result<PersonListItem, sqlx::Error> {
        if source_id == target_id {
            return Err(sqlx::Error::Protocol("Choose two different contacts to merge".into()));
        }
        let mut tx = pool.begin().await?;
        let source = sqlx::query_as::<
            _,
            (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>),
        >("SELECT notes, email, company, role, phone FROM people WHERE id = ?")
        .bind(source_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
        let target = sqlx::query_as::<
            _,
            (String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>),
        >("SELECT display_name, notes, email, company, role, phone FROM people WHERE id = ?")
        .bind(target_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
        let target_name = target.0.clone();

        let mappings = sqlx::query_as::<_, (String, String)>(
            "SELECT meeting_id, speaker_label FROM person_speakers WHERE person_id = ?",
        )
        .bind(source_id)
        .fetch_all(&mut *tx)
        .await?;
        for (meeting_id, label) in mappings {
            // If the target already spoke in this meeting, the two labels become one.
            let target_label: Option<String> = sqlx::query_scalar(
                "SELECT speaker_label FROM person_speakers WHERE person_id = ? AND meeting_id = ? LIMIT 1",
            )
            .bind(target_id)
            .bind(&meeting_id)
            .fetch_optional(&mut *tx)
            .await?;
            let new_label = target_label.unwrap_or_else(|| target_name.clone());
            let taken_by_other: Option<String> = sqlx::query_scalar(
                "SELECT person_id FROM person_speakers WHERE meeting_id = ? AND speaker_label = ? \
                 AND person_id NOT IN (?, ?)",
            )
            .bind(&meeting_id)
            .bind(&new_label)
            .bind(source_id)
            .bind(target_id)
            .fetch_optional(&mut *tx)
            .await?;
            let new_label = if taken_by_other.is_some() { label.clone() } else { new_label };

            sqlx::query("DELETE FROM person_speakers WHERE person_id = ? AND meeting_id = ? AND speaker_label = ?")
                .bind(source_id)
                .bind(&meeting_id)
                .bind(&label)
                .execute(&mut *tx)
                .await?;
            if new_label != label {
                sqlx::query("UPDATE transcripts SET speaker = ? WHERE meeting_id = ? AND speaker = ?")
                    .bind(&new_label)
                    .bind(&meeting_id)
                    .bind(&label)
                    .execute(&mut *tx)
                    .await?;
            }
            sqlx::query(
                "INSERT INTO person_speakers (person_id, meeting_id, speaker_label) VALUES (?, ?, ?) \
                 ON CONFLICT(meeting_id, speaker_label) DO UPDATE SET person_id = excluded.person_id",
            )
            .bind(target_id)
            .bind(&meeting_id)
            .bind(&new_label)
            .execute(&mut *tx)
            .await?;
        }

        sqlx::query("UPDATE action_items SET person_id = ?, owner_label = ?, updated_at = datetime('now') WHERE person_id = ?")
            .bind(target_id)
            .bind(&target_name)
            .bind(source_id)
            .execute(&mut *tx)
            .await?;

        let merged_notes = match (target.1.filter(|n| !n.trim().is_empty()), source.0.filter(|n| !n.trim().is_empty())) {
            (Some(kept), Some(extra)) => Some(format!("{}\n\n{}", kept, extra)),
            (kept, extra) => kept.or(extra),
        };
        sqlx::query(
            "UPDATE people SET notes = ?, email = COALESCE(email, ?), company = COALESCE(company, ?), \
             role = COALESCE(role, ?), phone = COALESCE(phone, ?), is_manual = 1, updated_at = datetime('now') \
             WHERE id = ?",
        )
        .bind(merged_notes)
        .bind(source.1)
        .bind(source.2)
        .bind(source.3)
        .bind(source.4)
        .bind(target_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM people WHERE id = ?")
            .bind(source_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Self::list_item(pool, target_id).await
    }

    /// Removes a contact. Each meeting keeps its lines, relabelled with the
    /// lowest free `Speaker N`, and their action items stay but are unlinked.
    pub async fn delete_person(pool: &SqlitePool, person_id: &str) -> Result<(), sqlx::Error> {
        let mut tx = pool.begin().await?;
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM people WHERE id = ?")
            .bind(person_id)
            .fetch_optional(&mut *tx)
            .await?;
        if exists.is_none() {
            return Err(sqlx::Error::RowNotFound);
        }
        let mappings = sqlx::query_as::<_, (String, String)>(
            "SELECT meeting_id, speaker_label FROM person_speakers WHERE person_id = ?",
        )
        .bind(person_id)
        .fetch_all(&mut *tx)
        .await?;
        for (meeting_id, label) in mappings {
            sqlx::query("DELETE FROM person_speakers WHERE person_id = ? AND meeting_id = ? AND speaker_label = ?")
                .bind(person_id)
                .bind(&meeting_id)
                .bind(&label)
                .execute(&mut *tx)
                .await?;
            let generated = next_available_speaker_label(&mut tx, &meeting_id).await?;
            sqlx::query("UPDATE transcripts SET speaker = ? WHERE meeting_id = ? AND speaker = ?")
                .bind(&generated)
                .bind(&meeting_id)
                .bind(&label)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("UPDATE action_items SET person_id = NULL WHERE person_id = ?")
            .bind(person_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM people WHERE id = ?")
            .bind(person_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
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
            sqlx::query(
                "UPDATE people SET notes = ?, is_manual = CASE WHEN ? IS NOT NULL THEN 1 ELSE is_manual END, \
                 updated_at = datetime('now') WHERE id = ?",
            )
                .bind(&notes)
                .bind(&notes)
                .bind(person_id)
                .execute(pool)
                .await?;
        if result.rows_affected() == 0 {
            return Err(sqlx::Error::RowNotFound);
        }
        Ok(())
    }

    /// Relabeling changes transcript attribution and durable identity in one
    /// transaction. A blank destination unlinks the contact from this meeting
    /// and restores the lowest available meeting-local `Speaker N` label; the
    /// contact itself is kept.
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

    /// Move one transcript line to another speaker. Other lines that share the
    /// old label stay where they are.
    pub(crate) async fn reassign_transcript_speaker(
        pool: &SqlitePool,
        meeting_id: &str,
        transcript_id: &str,
        to: &str,
    ) -> Result<SpeakerRenameOutcome, sqlx::Error> {
        let to = to.trim();
        let mut tx = pool.begin().await?;
        let current: Option<String> = sqlx::query_scalar(
            "SELECT speaker FROM transcripts WHERE id = ? AND meeting_id = ?",
        )
        .bind(transcript_id)
        .bind(meeting_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(from) = current else {
            return Err(sqlx::Error::RowNotFound);
        };
        let removed_name = to.is_empty();
        let resolved_to = if removed_name {
            next_available_speaker_label(&mut tx, meeting_id).await?
        } else {
            to.to_string()
        };

        let result = sqlx::query(
            "UPDATE transcripts SET speaker = ? WHERE id = ? AND meeting_id = ?",
        )
        .bind(&resolved_to)
        .bind(transcript_id)
        .bind(meeting_id)
        .execute(&mut *tx)
        .await?;

        let remaining: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM transcripts WHERE meeting_id = ? AND speaker = ?",
        )
        .bind(meeting_id)
        .bind(&from)
        .fetch_one(&mut *tx)
        .await?;
        if remaining == 0 {
            sqlx::query("DELETE FROM person_speakers WHERE meeting_id = ? AND speaker_label = ?")
                .bind(meeting_id)
                .bind(&from)
                .execute(&mut *tx)
                .await?;
        }
        if is_person_name(&resolved_to) {
            ensure_label_identity(&mut tx, meeting_id, &resolved_to).await?;
        }
        tx.commit().await?;
        Ok(SpeakerRenameOutcome {
            count: result.rows_affected(),
            speaker: resolved_to,
            removed_name,
        })
    }

    /// Moves this meeting's link from label `from` to label `to`. A person name
    /// joins the contact with that name, or adds one. The contact that `from`
    /// pointed at is never renamed or deleted: it keeps its details and its
    /// other meetings, and only loses this meeting's lines. Contacts go away
    /// only when the user deletes or merges them.
    pub(crate) async fn reconcile_speaker_identity(
        tx: &mut Transaction<'_, Sqlite>,
        meeting_id: &str,
        from: &str,
        to: &str,
    ) -> Result<(), sqlx::Error> {
        if from != to {
            sqlx::query("DELETE FROM person_speakers WHERE meeting_id = ? AND speaker_label = ?")
                .bind(meeting_id)
                .bind(from)
                .execute(&mut **tx)
                .await?;
        }
        if is_person_name(to) {
            ensure_label_identity(tx, meeting_id, to).await?;
        }
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
pub async fn api_list_people(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PersonListItem>, String> {
    PeopleRepository::list_people(state.db_manager.pool())
        .await
        .map_err(|error| format!("Failed to list contacts: {}", error))
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

fn person_error(action: &str, error: sqlx::Error) -> String {
    match error {
        sqlx::Error::RowNotFound => "Contact not found".to_string(),
        sqlx::Error::Protocol(message) => message,
        other => format!("Failed to {}: {}", action, other),
    }
}

#[tauri::command]
pub async fn api_create_person(
    state: tauri::State<'_, AppState>,
    display_name: String,
    email: Option<String>,
    company: Option<String>,
    role: Option<String>,
    phone: Option<String>,
) -> Result<PersonListItem, String> {
    PeopleRepository::create_person(
        state.db_manager.pool(),
        PersonInput {
            display_name,
            email,
            company,
            role,
            phone,
        },
    )
    .await
    .map_err(|error| person_error("create contact", error))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn api_update_person(
    state: tauri::State<'_, AppState>,
    person_id: String,
    display_name: String,
    email: Option<String>,
    company: Option<String>,
    role: Option<String>,
    phone: Option<String>,
) -> Result<PersonListItem, String> {
    let item = PeopleRepository::update_person(
        state.db_manager.pool(),
        &person_id,
        PersonInput {
            display_name,
            email,
            company,
            role,
            phone,
        },
    )
    .await
    .map_err(|error| person_error("update contact", error))?;
    crate::diarization::voice_profiles::contact_renamed(&person_id, &item.display_name);
    Ok(item)
}

#[tauri::command]
pub async fn api_merge_people(
    state: tauri::State<'_, AppState>,
    source_id: String,
    target_id: String,
) -> Result<PersonListItem, String> {
    let kept = PeopleRepository::merge_people(state.db_manager.pool(), &source_id, &target_id)
        .await
        .map_err(|error| person_error("merge contacts", error))?;
    crate::diarization::voice_profiles::contacts_merged(&source_id, &target_id, &kept.display_name);
    Ok(kept)
}

#[tauri::command]
pub async fn api_delete_person(
    state: tauri::State<'_, AppState>,
    person_id: String,
) -> Result<(), String> {
    PeopleRepository::delete_person(state.db_manager.pool(), &person_id)
        .await
        .map_err(|error| person_error("delete contact", error))?;
    crate::diarization::voice_profiles::contact_deleted(&person_id);
    Ok(())
}

async fn person_groups(
    pool: &SqlitePool,
    person_id: &str,
) -> Result<Vec<PersonGroupRef>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (String, String, Option<String>, i64)>(
        "SELECT g.id, g.name, g.color, COUNT(DISTINCT m.id) \
         FROM person_speakers ps \
         JOIN meetings m ON m.id = ps.meeting_id \
         JOIN groups g ON g.id = m.group_id \
         WHERE ps.person_id = ? \
         GROUP BY g.id, g.name \
         ORDER BY COUNT(DISTINCT m.id) DESC, g.name COLLATE NOCASE",
    )
    .bind(person_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, color, meeting_count)| PersonGroupRef {
            id,
            name,
            color,
            meeting_count,
        })
        .collect())
}

async fn ensure_label_identity(
    tx: &mut Transaction<'_, Sqlite>,
    meeting_id: &str,
    label: &str,
) -> Result<(), sqlx::Error> {
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT person_id FROM person_speakers WHERE meeting_id = ? AND speaker_label = ?",
    )
    .bind(meeting_id)
    .bind(label)
    .fetch_optional(&mut **tx)
    .await?;
    if existing.is_some() {
        return Ok(());
    }
    let normalized = normalize_person_name(label);
    let person_id = match find_person_by_normalized_name(tx, &normalized).await? {
        Some(id) => id,
        None => {
            let id = format!("person-{}", Uuid::new_v4());
            sqlx::query(
                "INSERT INTO people \
                 (id, display_name, normalized_name, notes, created_at, updated_at) \
                 VALUES (?, ?, ?, NULL, datetime('now'), datetime('now'))",
            )
            .bind(&id)
            .bind(label)
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
    .bind(label)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn clean_field(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

/// Applies a person's new display name to every meeting they are linked in.
/// A meeting where another speaker already uses that label keeps the old one.
async fn relabel_person(
    tx: &mut Transaction<'_, Sqlite>,
    person_id: &str,
    name: &str,
) -> Result<(), sqlx::Error> {
    let mappings = sqlx::query_as::<_, (String, String)>(
        "SELECT meeting_id, speaker_label FROM person_speakers WHERE person_id = ?",
    )
    .bind(person_id)
    .fetch_all(&mut **tx)
    .await?;
    for (meeting_id, label) in mappings {
        if label == name {
            continue;
        }
        let taken: Option<String> = sqlx::query_scalar(
            "SELECT person_id FROM person_speakers WHERE meeting_id = ? AND speaker_label = ?",
        )
        .bind(&meeting_id)
        .bind(name)
        .fetch_optional(&mut **tx)
        .await?;
        match taken {
            Some(owner) if owner != person_id => continue,
            Some(_) => {
                sqlx::query(
                    "DELETE FROM person_speakers WHERE person_id = ? AND meeting_id = ? AND speaker_label = ?",
                )
                .bind(person_id)
                .bind(&meeting_id)
                .bind(&label)
                .execute(&mut **tx)
                .await?;
            }
            None => {
                sqlx::query(
                    "UPDATE person_speakers SET speaker_label = ? \
                     WHERE person_id = ? AND meeting_id = ? AND speaker_label = ?",
                )
                .bind(name)
                .bind(person_id)
                .bind(&meeting_id)
                .bind(&label)
                .execute(&mut **tx)
                .await?;
            }
        }
        sqlx::query("UPDATE transcripts SET speaker = ? WHERE meeting_id = ? AND speaker = ?")
            .bind(name)
            .bind(&meeting_id)
            .bind(&label)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query("UPDATE action_items SET owner_label = ? WHERE person_id = ?")
        .bind(name)
        .bind(person_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
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
        build_person_context, escape_like, is_person_name, normalize_person_name,
        visible_summary_text, PeopleRepository, PersonContextMeeting, PersonContextMessage,
        PERSON_CONTEXT_CHARS,
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
    async fn meeting_local_rename_links_or_adds_contacts_and_keeps_the_old_one() {
        let pool = sqlx::SqlitePool::connect(":memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, \
                 normalized_name TEXT NOT NULL UNIQUE, notes TEXT, created_at TEXT NOT NULL, \
                 updated_at TEXT NOT NULL, is_manual INTEGER NOT NULL DEFAULT 0); \
             CREATE TABLE person_speakers (person_id TEXT NOT NULL, meeting_id TEXT NOT NULL, \
                 speaker_label TEXT NOT NULL, UNIQUE(meeting_id, speaker_label)); \
             CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker TEXT); \
             INSERT INTO people (id, display_name, normalized_name, notes, created_at, updated_at) VALUES \
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
        // Alicia no longer speaks anywhere but stays a contact.
        let alicia_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM people WHERE normalized_name = 'alicia'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(alicia_count, 1);

        // A new name for David's only lines adds a contact instead of renaming David.
        PeopleRepository::rename_meeting_speaker(&pool, "m4", "David", "Dave")
            .await
            .unwrap();
        let m4_person: String =
            sqlx::query_scalar("SELECT person_id FROM person_speakers WHERE meeting_id = 'm4'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_ne!(m4_person, "person-david");
        let david_name: String =
            sqlx::query_scalar("SELECT display_name FROM people WHERE id = 'person-david'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(david_name, "David");
    }

    #[tokio::test]
    async fn same_name_rename_repairs_live_saved_speaker_link() {
        let pool = sqlx::SqlitePool::connect(":memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); \
             CREATE TABLE person_speakers (person_id TEXT NOT NULL, meeting_id TEXT NOT NULL, speaker_label TEXT NOT NULL, UNIQUE(meeting_id, speaker_label)); \
             CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker TEXT); \
             INSERT INTO transcripts VALUES ('turn', 'meeting', 'Alice');"
        ).execute(&pool).await.unwrap();
        PeopleRepository::rename_meeting_speaker(&pool, "meeting", "Alice", "Alice").await.unwrap();
        let linked: String = sqlx::query_scalar(
            "SELECT p.display_name FROM person_speakers ps JOIN people p ON p.id = ps.person_id WHERE ps.meeting_id = 'meeting'"
        ).fetch_one(&pool).await.unwrap();
        assert_eq!(linked, "Alice");
    }

    #[tokio::test]
    async fn rename_splits_when_old_person_has_another_label_in_same_meeting() {
        let pool = sqlx::SqlitePool::connect(":memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, \
                 normalized_name TEXT NOT NULL UNIQUE, notes TEXT, created_at TEXT NOT NULL, \
                 updated_at TEXT NOT NULL, is_manual INTEGER NOT NULL DEFAULT 0); \
             CREATE TABLE person_speakers (person_id TEXT NOT NULL, meeting_id TEXT NOT NULL, \
                 speaker_label TEXT NOT NULL, UNIQUE(meeting_id, speaker_label)); \
             CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker TEXT); \
             INSERT INTO people (id, display_name, normalized_name, notes, created_at, updated_at) VALUES ('person-carol', 'Carol', 'carol', NULL, 'now', 'now'); \
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
                 updated_at TEXT NOT NULL, is_manual INTEGER NOT NULL DEFAULT 0); \
             CREATE TABLE person_speakers (person_id TEXT NOT NULL, meeting_id TEXT NOT NULL, \
                 speaker_label TEXT NOT NULL, UNIQUE(meeting_id, speaker_label)); \
             CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker TEXT); \
             INSERT INTO people (id, display_name, normalized_name, notes, created_at, updated_at) VALUES ('person-elodie', 'Élodie', 'Élodie', NULL, 'now', 'now'); \
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
            "CREATE TABLE people (id TEXT PRIMARY KEY, is_manual INTEGER NOT NULL DEFAULT 0); \
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

    use super::PersonInput;

    async fn contacts_pool() -> sqlx::SqlitePool {
        let pool = sqlx::SqlitePool::connect(":memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', \
                 created_at TEXT NOT NULL DEFAULT '2026-09-01', group_id TEXT); \
             CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT); \
             CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, \
                 normalized_name TEXT NOT NULL UNIQUE, notes TEXT, email TEXT, company TEXT, role TEXT, \
                 phone TEXT, is_manual INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT 'now', \
                 updated_at TEXT NOT NULL DEFAULT 'now'); \
             CREATE TABLE person_speakers (person_id TEXT NOT NULL, meeting_id TEXT NOT NULL, \
                 speaker_label TEXT NOT NULL, UNIQUE(meeting_id, speaker_label)); \
             CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, speaker TEXT); \
             CREATE TABLE action_items (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, text TEXT NOT NULL, \
                 owner_label TEXT, person_id TEXT, updated_at TEXT NOT NULL DEFAULT 'now'); \
             INSERT INTO meetings (id) VALUES ('m1'), ('m2'); \
             INSERT INTO people (id, display_name, normalized_name, notes) VALUES \
                 ('p-tom', 'Tom', 'tom', 'Met at kickoff'), ('p-thomas', 'Thomas Becker', 'thomas becker', NULL); \
             INSERT INTO person_speakers VALUES ('p-tom', 'm1', 'Tom'), ('p-thomas', 'm2', 'Thomas Becker'); \
             INSERT INTO transcripts VALUES ('t1', 'm1', 'Tom'), ('t2', 'm1', 'Speaker 1'), \
                 ('t3', 'm2', 'Thomas Becker'), ('t4', 'm2', 'You'); \
             INSERT INTO action_items (id, meeting_id, text, owner_label, person_id) VALUES \
                 ('a1', 'm1', 'Send the contract', 'Tom', 'p-tom');",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn speaker_of(pool: &sqlx::SqlitePool, transcript_id: &str) -> String {
        sqlx::query_scalar("SELECT speaker FROM transcripts WHERE id = ?")
            .bind(transcript_id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn renaming_a_contact_relabels_every_meeting_and_owner() {
        let pool = contacts_pool().await;
        let updated = PeopleRepository::update_person(
            &pool,
            "p-tom",
            PersonInput {
                display_name: "Tom Becker".into(),
                email: Some(" tom@acme.test ".into()),
                company: None,
                role: None,
                phone: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.display_name, "Tom Becker");
        assert_eq!(updated.email.as_deref(), Some("tom@acme.test"));
        assert_eq!(speaker_of(&pool, "t1").await, "Tom Becker");
        assert_eq!(speaker_of(&pool, "t2").await, "Speaker 1");
        let owner: String = sqlx::query_scalar("SELECT owner_label FROM action_items WHERE id = 'a1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(owner, "Tom Becker");

        // A name another contact already uses is refused with a merge hint.
        let clash = PeopleRepository::update_person(
            &pool,
            "p-tom",
            PersonInput {
                display_name: "thomas becker".into(),
                email: None,
                company: None,
                role: None,
                phone: None,
            },
        )
        .await;
        assert!(matches!(clash, Err(sqlx::Error::Protocol(message)) if message.contains("Merge")));
    }

    #[tokio::test]
    async fn merging_moves_meetings_items_and_notes_to_the_kept_contact() {
        let pool = contacts_pool().await;
        let kept = PeopleRepository::merge_people(&pool, "p-tom", "p-thomas").await.unwrap();
        assert_eq!(kept.id, "p-thomas");
        assert_eq!(kept.meeting_count, 2);
        assert_eq!(speaker_of(&pool, "t1").await, "Thomas Becker");
        let item_owner: (String, String) =
            sqlx::query_as("SELECT person_id, owner_label FROM action_items WHERE id = 'a1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(item_owner, ("p-thomas".to_string(), "Thomas Becker".to_string()));
        let notes: Option<String> = sqlx::query_scalar("SELECT notes FROM people WHERE id = 'p-thomas'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(notes.as_deref(), Some("Met at kickoff"));
        let gone: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM people WHERE id = 'p-tom'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(gone, 0);
    }

    #[tokio::test]
    async fn merging_two_labels_from_one_meeting_joins_them() {
        let pool = contacts_pool().await;
        sqlx::raw_sql(
            "INSERT INTO person_speakers VALUES ('p-tom', 'm2', 'Tom'); \
             INSERT INTO transcripts VALUES ('t5', 'm2', 'Tom');",
        )
        .execute(&pool)
        .await
        .unwrap();
        PeopleRepository::merge_people(&pool, "p-tom", "p-thomas").await.unwrap();
        assert_eq!(speaker_of(&pool, "t5").await, "Thomas Becker");
        let labels: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM person_speakers WHERE meeting_id = 'm2' AND person_id = 'p-thomas'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(labels, 1);
    }

    #[tokio::test]
    async fn deleting_a_contact_restores_generated_labels() {
        let pool = contacts_pool().await;
        PeopleRepository::delete_person(&pool, "p-tom").await.unwrap();
        // "Speaker 1" is taken in m1, so the next free label is used.
        assert_eq!(speaker_of(&pool, "t1").await, "Speaker 2");
        let person: Option<String> = sqlx::query_scalar("SELECT person_id FROM action_items WHERE id = 'a1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(person, None);
        let mappings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM person_speakers WHERE person_id = 'p-tom'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(mappings, 0);
    }

    async fn person_link_count(pool: &sqlx::SqlitePool, person_id: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM person_speakers WHERE person_id = ?")
            .bind(person_id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn unlinking_a_contacts_speech_keeps_the_contact() {
        let pool = contacts_pool().await;

        // Tom was named from a speaker label and only speaks in m1.
        let removed = PeopleRepository::rename_meeting_speaker(&pool, "m1", "Tom", "").await.unwrap();
        assert!(removed.removed_name);
        assert_eq!(speaker_of(&pool, "t1").await, "Speaker 2");
        let tom: (String, Option<String>) =
            sqlx::query_as("SELECT display_name, notes FROM people WHERE id = 'p-tom'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(tom, ("Tom".to_string(), Some("Met at kickoff".to_string())));
        assert_eq!(person_link_count(&pool, "p-tom").await, 0);

        // Handing Thomas's only lines to Tom by mistake keeps Thomas, and undoing it relinks him.
        PeopleRepository::rename_meeting_speaker(&pool, "m2", "Thomas Becker", "Tom").await.unwrap();
        assert_eq!(person_link_count(&pool, "p-tom").await, 1);
        assert_eq!(person_link_count(&pool, "p-thomas").await, 0);
        let thomas: String = sqlx::query_scalar("SELECT display_name FROM people WHERE id = 'p-thomas'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(thomas, "Thomas Becker");
        PeopleRepository::rename_meeting_speaker(&pool, "m2", "Tom", "Thomas Becker").await.unwrap();
        assert_eq!(person_link_count(&pool, "p-thomas").await, 1);
        assert_eq!(person_link_count(&pool, "p-tom").await, 0);

        // Moving a contact's last line to someone else leaves the contact too.
        PeopleRepository::reassign_transcript_speaker(&pool, "m2", "t3", "You").await.unwrap();
        assert_eq!(person_link_count(&pool, "p-thomas").await, 0);
        PeopleRepository::rename_meeting_speaker(&pool, "m2", "You", "").await.unwrap();

        let people: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM people")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(people, 2);
        let item_owner: Option<String> = sqlx::query_scalar("SELECT person_id FROM action_items WHERE id = 'a1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(item_owner.as_deref(), Some("p-tom"));
    }

    #[tokio::test]
    async fn hand_made_contacts_survive_speaker_changes() {
        let pool = contacts_pool().await;
        let created = PeopleRepository::create_person(
            &pool,
            PersonInput {
                display_name: "Sam Rivera".into(),
                email: None,
                company: Some("Acme".into()),
                role: None,
                phone: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(created.meeting_count, 0);
        PeopleRepository::rename_meeting_speaker(&pool, "m2", "You", "").await.unwrap();
        let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM people WHERE id = ?")
            .bind(&created.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(exists, 1);
        let duplicate = PeopleRepository::create_person(
            &pool,
            PersonInput {
                display_name: "sam rivera".into(),
                email: None,
                company: None,
                role: None,
                phone: None,
            },
        )
        .await;
        assert!(duplicate.is_err());
    }
}

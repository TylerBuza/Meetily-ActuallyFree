use crate::api::{TranscriptSearchResult, TranscriptSegment};
use chrono::Utc;
use sqlx::{Connection, Error as SqlxError, SqlitePool};
use tracing::{error, info};
use uuid::Uuid;

pub struct TranscriptsRepository;

impl TranscriptsRepository {
    /// Saves a new meeting and its associated transcript segments.
    /// This function uses a transaction to ensure that either both the meeting
    /// and all its transcripts are saved, or none of them are.
    pub async fn save_transcript(
        pool: &SqlitePool,
        meeting_title: &str,
        transcripts: &[TranscriptSegment],
        folder_path: Option<String>,
    ) -> Result<String, SqlxError> {
        let meeting_id = format!("meeting-{}", Uuid::new_v4());

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let now = Utc::now();

        // 1. Create the new meeting
        let result = sqlx::query(
            "INSERT INTO meetings (id, title, created_at, updated_at, folder_path) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&meeting_id)
        .bind(meeting_title)
        .bind(now)
        .bind(now)
        .bind(&folder_path)
        .execute(&mut *transaction)
        .await;

        if let Err(e) = result {
            error!("Failed to create meeting '{}': {}", meeting_title, e);
            transaction.rollback().await?;
            return Err(e);
        }

        info!("Successfully created meeting with id: {}", meeting_id);

        // 2. Save each transcript segment with audio timing fields
        for segment in transcripts {
            let transcript_id = format!("transcript-{}", Uuid::new_v4());
            let result = sqlx::query(
                // `speaker` must be persisted: the offline diarization pass
                // finds the local user by matching the live "You" ranges, so
                // omitting it here erased the user's identity from every
                // meeting the moment it was saved.
                "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(&transcript_id)
            .bind(&meeting_id)
            .bind(&segment.text)
            .bind(&segment.timestamp)
            .bind(segment.audio_start_time)
            .bind(segment.audio_end_time)
            .bind(segment.duration)
            .bind(&segment.speaker)
            .execute(&mut *transaction)
            .await;

            if let Err(e) = result {
                error!(
                    "Failed to save transcript segment for meeting {}: {}",
                    meeting_id, e
                );
                transaction.rollback().await?;
                return Err(e);
            }
        }

        info!(
            "Successfully saved {} transcript segments for meeting {}",
            transcripts.len(),
            meeting_id
        );

        // Commit the transaction
        transaction.commit().await?;

        Ok(meeting_id)
    }

    /// Searches for a query string across a meeting's transcript text, its
    /// generated summary, and its title. Returns one result per matching
    /// meeting (deduplicated), preferring a transcript snippet for context,
    /// then a summary snippet, then the title.
    pub async fn search_transcripts(
        pool: &SqlitePool,
        query: &str,
    ) -> Result<Vec<TranscriptSearchResult>, SqlxError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }

        let search_query = format!("%{}%", query.to_lowercase());

        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut results: Vec<TranscriptSearchResult> = Vec::new();

        // 1. Transcript text matches — richest context (a snippet around the hit).
        let transcript_rows = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT m.id, m.title, t.transcript, t.timestamp
             FROM meetings m
             JOIN transcripts t ON m.id = t.meeting_id
             WHERE LOWER(t.transcript) LIKE ?
             ORDER BY m.updated_at DESC",
        )
        .bind(&search_query)
        .fetch_all(pool)
        .await?;

        for (id, title, transcript, timestamp) in transcript_rows {
            if seen.insert(id.clone()) {
                let match_context = Self::get_match_context(&transcript, query);
                results.push(TranscriptSearchResult {
                    id,
                    title,
                    match_context,
                    timestamp,
                });
            }
        }

        // 2. Summary matches — for meetings not already matched via transcript.
        let summary_rows = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT m.id, m.title, s.result, m.updated_at
             FROM meetings m
             JOIN summary_processes s ON m.id = s.meeting_id
             WHERE s.result IS NOT NULL AND LOWER(s.result) LIKE ?
             ORDER BY m.updated_at DESC",
        )
        .bind(&search_query)
        .fetch_all(pool)
        .await?;

        for (id, title, result, timestamp) in summary_rows {
            if seen.insert(id.clone()) {
                let match_context = Self::get_match_context(&result, query);
                results.push(TranscriptSearchResult {
                    id,
                    title,
                    match_context,
                    timestamp,
                });
            }
        }

        // 3. Title matches — catch meetings found purely by name.
        let title_rows = sqlx::query_as::<_, (String, String, String)>(
            "SELECT id, title, updated_at
             FROM meetings
             WHERE LOWER(title) LIKE ?
             ORDER BY updated_at DESC",
        )
        .bind(&search_query)
        .fetch_all(pool)
        .await?;

        for (id, title, timestamp) in title_rows {
            if seen.insert(id.clone()) {
                let match_context = format!("Title match: {}", title);
                results.push(TranscriptSearchResult {
                    id,
                    title,
                    match_context,
                    timestamp,
                });
            }
        }

        Ok(results)
    }

    /// Helper function to extract a snippet of text around the first match of a
    /// query. UTF-8 safe: byte offsets are clamped and snapped to character
    /// boundaries so summaries/JSON containing multi-byte characters never
    /// cause a slice panic.
    fn get_match_context(text: &str, query: &str) -> String {
        let text_lower = text.to_lowercase();
        let query_lower = query.to_lowercase();
        let text_len = text.len();

        match text_lower.find(&query_lower) {
            Some(match_index) => {
                let mut start_index = match_index.saturating_sub(100).min(text_len);
                let mut end_index = (match_index + query.len() + 100).min(text_len);
                if start_index > end_index {
                    start_index = end_index;
                }
                // Snap to char boundaries (lowercasing can shift byte lengths).
                while start_index > 0 && !text.is_char_boundary(start_index) {
                    start_index -= 1;
                }
                while end_index < text_len && !text.is_char_boundary(end_index) {
                    end_index += 1;
                }

                let mut context = String::new();
                if start_index > 0 {
                    context.push_str("...");
                }
                context.push_str(&text[start_index..end_index]);
                if end_index < text_len {
                    context.push_str("...");
                }
                context
            }
            None => text.chars().take(200).collect(), // Fallback to the start of the text
        }
    }
}

use crate::api::{MeetingDetails, MeetingTranscript};
use crate::database::models::{MeetingModel, Transcript};
use crate::database::repositories::transcript::timestamp_from_offset;
use chrono::{DateTime, Utc};
use sqlx::{Connection, Error as SqlxError, SqliteConnection, SqlitePool};
use tracing::{error, info};

pub struct MeetingsRepository;

impl MeetingsRepository {
    pub async fn get_meetings(pool: &SqlitePool) -> Result<Vec<MeetingModel>, sqlx::Error> {
        let meetings = sqlx::query_as::<_, MeetingModel>(
            "SELECT id, title, created_at, updated_at, folder_path
             FROM meetings
             ORDER BY created_at DESC",
        )
        .fetch_all(pool)
        .await?;
        Ok(meetings)
    }

    pub async fn delete_meeting(pool: &SqlitePool, meeting_id: &str) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        match delete_meeting_with_transaction(&mut transaction, meeting_id).await {
            Ok(success) => {
                if success {
                    transaction.commit().await?;
                    info!(
                        "Successfully deleted meeting {} and all associated data",
                        meeting_id
                    );
                    Ok(true)
                } else {
                    transaction.rollback().await?;
                    Ok(false)
                }
            }
            Err(e) => {
                let _ = transaction.rollback().await;
                error!("Failed to delete meeting {}: {}", meeting_id, e);
                Err(e)
            }
        }
    }

    pub async fn get_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<MeetingDetails>, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        // Get meeting details
        let meeting: Option<MeetingModel> =
            sqlx::query_as("SELECT id, title, created_at, updated_at, folder_path FROM meetings WHERE id = ?")
                .bind(meeting_id)
                .fetch_optional(&mut *transaction)
                .await?;

        if meeting.is_none() {
            transaction.rollback().await?;
            return Err(SqlxError::RowNotFound);
        }

        if let Some(meeting) = meeting {
            // Get all transcripts for this meeting
            let transcripts =
                sqlx::query_as::<_, Transcript>("SELECT * FROM transcripts WHERE meeting_id = ?")
                    .bind(meeting_id)
                    .fetch_all(&mut *transaction)
                    .await?;

            transaction.commit().await?;

            // Convert Transcript to MeetingTranscript
            let meeting_transcripts = transcripts
                .into_iter()
                .map(|t| MeetingTranscript {
                    id: t.id,
                    text: t.transcript,
                    timestamp: t.timestamp,
                    audio_start_time: t.audio_start_time,
                    audio_end_time: t.audio_end_time,
                    duration: t.duration,
                    speaker: t.speaker,
                })
                .collect::<Vec<_>>();

            Ok(Some(MeetingDetails {
                id: meeting.id,
                title: meeting.title,
                created_at: meeting.created_at.0.to_rfc3339(),
                updated_at: meeting.updated_at.0.to_rfc3339(),
                transcripts: meeting_transcripts,
            }))
        } else {
            transaction.rollback().await?;
            Ok(None)
        }
    }

    /// Get meeting metadata without transcripts (for pagination)
    pub async fn get_meeting_metadata(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<MeetingModel>, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let meeting: Option<MeetingModel> =
            sqlx::query_as("SELECT id, title, created_at, updated_at, folder_path FROM meetings WHERE id = ?")
                .bind(meeting_id)
                .fetch_optional(pool)
                .await?;

        Ok(meeting)
    }

    /// Get meeting transcripts with pagination support
    pub async fn get_meeting_transcripts_paginated(
        pool: &SqlitePool,
        meeting_id: &str,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<Transcript>, i64), SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        // Get total count of transcripts for this meeting
        let total: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM transcripts WHERE meeting_id = ?"
        )
        .bind(meeting_id)
        .fetch_one(pool)
        .await?;

        // Get paginated transcripts ordered by audio_start_time
        let transcripts = sqlx::query_as::<_, Transcript>(
            "SELECT * FROM transcripts
             WHERE meeting_id = ?
             ORDER BY audio_start_time ASC
             LIMIT ? OFFSET ?"
        )
        .bind(meeting_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?;

        Ok((transcripts, total.0))
    }

    pub async fn repair_recording_start(
        pool: &SqlitePool,
        meeting_id: &str,
        recording_started_at: DateTime<Utc>,
    ) -> Result<(), SqlxError> {
        let mut transaction = pool.begin().await?;
        sqlx::query("UPDATE meetings SET created_at = ? WHERE id = ?")
            .bind(recording_started_at)
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        let transcript_offsets = sqlx::query_as::<_, (String, f64)>(
            "SELECT id, audio_start_time FROM transcripts
             WHERE meeting_id = ? AND audio_start_time IS NOT NULL",
        )
        .bind(meeting_id)
        .fetch_all(&mut *transaction)
        .await?;

        for (transcript_id, offset) in transcript_offsets {
            let timestamp = match timestamp_from_offset(recording_started_at, offset) {
                Ok(timestamp) => timestamp,
                Err(error) => {
                    error!(
                        "Skipping invalid audio offset while repairing transcript {}: {}",
                        transcript_id, error
                    );
                    continue;
                }
            };
            sqlx::query("UPDATE transcripts SET timestamp = ? WHERE id = ?")
                .bind(timestamp)
                .bind(transcript_id)
                .execute(&mut *transaction)
                .await?;
        }

        transaction.commit().await
    }

    pub async fn update_meeting_title(
        pool: &SqlitePool,
        meeting_id: &str,
        new_title: &str,
    ) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let now = Utc::now().naive_utc();

        let rows_affected = sqlx::query(
            "UPDATE meetings
             SET title = ?, title_is_manual = 1, updated_at = ?
             WHERE id = ?",
        )
                .bind(new_title)
                .bind(now)
                .bind(meeting_id)
                .execute(&mut *transaction)
                .await?;
        if rows_affected.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(false);
        }
        sqlx::query("UPDATE transcript_chunks SET meeting_name = ? WHERE meeting_id = ?")
            .bind(new_title)
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        transaction.commit().await?;
        Ok(true)
    }

    pub async fn update_generated_meeting_title(
        pool: &SqlitePool,
        meeting_id: &str,
        new_title: &str,
    ) -> Result<bool, SqlxError> {
        let mut transaction = pool.begin().await?;
        let now = Utc::now();

        // A manual rename that commits first makes this update a no-op. If this
        // commits first, the later manual rename remains authoritative.
        let meeting_update = sqlx::query(
            "UPDATE meetings
             SET title = ?, updated_at = ?
             WHERE id = ? AND title_is_manual = 0",
        )
                .bind(new_title)
                .bind(now)
                .bind(meeting_id)
                .execute(&mut *transaction)
                .await?;

        if meeting_update.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(false);
        }

        // Update transcript_chunks table
        sqlx::query("UPDATE transcript_chunks SET meeting_name = ? WHERE meeting_id = ?")
            .bind(new_title)
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        transaction.commit().await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE meetings (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                folder_path TEXT,
                title_is_manual INTEGER NOT NULL DEFAULT 1
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE transcript_chunks (
                meeting_id TEXT NOT NULL,
                meeting_name TEXT
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE transcripts (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL,
                transcript TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                audio_start_time REAL,
                audio_end_time REAL,
                duration REAL,
                speaker TEXT
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn insert_meeting(pool: &SqlitePool, manual: bool) {
        sqlx::query(
            "INSERT INTO meetings
             (id, title, created_at, updated_at, title_is_manual)
             VALUES ('meeting-1', 'Original', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)",
        )
        .bind(manual)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO transcript_chunks (meeting_id, meeting_name)
             VALUES ('meeting-1', 'Original')",
        )
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn repairing_recording_start_reanchors_transcript_timestamps() {
        let pool = test_pool().await;
        insert_meeting(&pool, false).await;
        sqlx::query(
            "INSERT INTO transcripts
             (id, meeting_id, transcript, timestamp, audio_start_time)
             VALUES ('transcript-1', 'meeting-1', 'hello', '2026-08-30T12:00:00Z', 14.97),
                    ('transcript-2', 'meeting-1', 'fallback', '2026-08-30T12:00:01Z', NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let recording_start = DateTime::parse_from_rfc3339("2026-08-30T23:59:50Z")
            .unwrap()
            .with_timezone(&Utc);
        MeetingsRepository::repair_recording_start(&pool, "meeting-1", recording_start)
            .await
            .unwrap();

        let created_at: String =
            sqlx::query_scalar("SELECT created_at FROM meetings WHERE id = 'meeting-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let timestamps: Vec<String> = sqlx::query_scalar(
            "SELECT timestamp FROM transcripts WHERE meeting_id = 'meeting-1' ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert!(created_at.starts_with("2026-08-30T23:59:50"));
        assert_eq!(timestamps[0], "2026-08-31T00:00:04.970Z");
        assert_eq!(timestamps[1], "2026-08-30T12:00:01Z");
    }

    #[tokio::test]
    async fn title_provenance_migration_only_marks_recognizable_defaults_automatic() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL); \
             INSERT INTO meetings (id, title) VALUES \
                ('generated', 'Meeting 30_08_26_12_34_56'), \
                ('legacy-generated', 'Meeting 2026-08-30_12-34-56'), \
                ('manual', 'Quarterly Review');",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../../migrations/20260830000000_add_title_provenance.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();

        let rows: Vec<(String, bool)> = sqlx::query_as(
            "SELECT id, title_is_manual FROM meetings ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                ("generated".to_string(), false),
                ("legacy-generated".to_string(), false),
                ("manual".to_string(), true),
            ]
        );
    }

    #[tokio::test]
    async fn generated_title_updates_only_automatic_titles() {
        let pool = test_pool().await;
        insert_meeting(&pool, false).await;

        assert!(MeetingsRepository::update_generated_meeting_title(
            &pool,
            "meeting-1",
            "Generated"
        )
        .await
        .unwrap());

        let row: (String, bool, String) = sqlx::query_as(
            "SELECT m.title, m.title_is_manual, c.meeting_name
             FROM meetings m
             JOIN transcript_chunks c ON c.meeting_id = m.id
             WHERE m.id = 'meeting-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, ("Generated".to_string(), false, "Generated".to_string()));
    }

    #[tokio::test]
    async fn generated_title_preserves_manual_titles() {
        let pool = test_pool().await;
        insert_meeting(&pool, true).await;

        assert!(!MeetingsRepository::update_generated_meeting_title(
            &pool,
            "meeting-1",
            "Generated"
        )
        .await
        .unwrap());

        let row: (String, String) = sqlx::query_as(
            "SELECT m.title, c.meeting_name
             FROM meetings m
             JOIN transcript_chunks c ON c.meeting_id = m.id
             WHERE m.id = 'meeting-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, ("Original".to_string(), "Original".to_string()));
    }

    #[tokio::test]
    async fn manual_title_marks_automatic_meeting_and_remains_authoritative() {
        let pool = test_pool().await;
        insert_meeting(&pool, false).await;

        assert!(MeetingsRepository::update_meeting_title(&pool, "meeting-1", "Manual")
            .await
            .unwrap());
        assert!(!MeetingsRepository::update_generated_meeting_title(
            &pool,
            "meeting-1",
            "Generated"
        )
        .await
        .unwrap());

        let row: (String, bool, String) = sqlx::query_as(
            "SELECT m.title, m.title_is_manual, c.meeting_name
             FROM meetings m
             JOIN transcript_chunks c ON c.meeting_id = m.id
             WHERE m.id = 'meeting-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, ("Manual".to_string(), true, "Manual".to_string()));
    }

    #[tokio::test]
    async fn manual_title_wins_after_generated_title() {
        let pool = test_pool().await;
        insert_meeting(&pool, false).await;

        assert!(MeetingsRepository::update_generated_meeting_title(
            &pool,
            "meeting-1",
            "Generated"
        )
        .await
        .unwrap());
        assert!(MeetingsRepository::update_meeting_title(&pool, "meeting-1", "Manual")
            .await
            .unwrap());

        let row: (String, bool, String) = sqlx::query_as(
            "SELECT m.title, m.title_is_manual, c.meeting_name
             FROM meetings m
             JOIN transcript_chunks c ON c.meeting_id = m.id
             WHERE m.id = 'meeting-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, ("Manual".to_string(), true, "Manual".to_string()));
    }
}

async fn delete_meeting_with_transaction(
    transaction: &mut SqliteConnection,
    meeting_id: &str,
) -> Result<bool, SqlxError> {
    // Check if meeting exists
    let meeting_exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .fetch_optional(&mut *transaction)
        .await?;

    if meeting_exists.is_none() {
        error!("Meeting {} not found for deletion", meeting_id);
        return Ok(false);
    }

    // Delete from related tables in proper order
    // Do not rely on SQLite FK enforcement: portable/legacy databases may have
    // opened connections before foreign_keys was enabled.
    sqlx::query("DELETE FROM person_speakers WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    sqlx::query("DELETE FROM meeting_whisper_vocabulary WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 1. Delete from transcript_chunks
    sqlx::query("DELETE FROM transcript_chunks WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 2. Delete from summary_processes
    sqlx::query("DELETE FROM summary_processes WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 3. Delete from transcripts
    sqlx::query("DELETE FROM transcripts WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 4. Finally, delete the meeting
    let result = sqlx::query("DELETE FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    sqlx::query(
        "DELETE FROM people WHERE NOT EXISTS \
         (SELECT 1 FROM person_speakers ps WHERE ps.person_id = people.id)",
    )
    .execute(&mut *transaction)
    .await?;

    Ok(result.rows_affected() > 0)
}

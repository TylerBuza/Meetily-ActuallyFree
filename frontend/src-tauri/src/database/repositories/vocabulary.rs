use std::collections::HashSet;

use chrono::Utc;
use sqlx::SqlitePool;
use tokio::sync::Mutex;

pub const MAX_VOCABULARY_CHARS: usize = 1000;
static GLOBAL_VOCABULARY_WRITE_LOCK: Mutex<()> = Mutex::const_new(());
static MEETING_VOCABULARY_WRITE_LOCK: Mutex<()> = Mutex::const_new(());

pub struct VocabularyRepository;

impl VocabularyRepository {
    pub fn normalize(raw: &str) -> Result<Option<String>, String> {
        if raw.contains('\0') {
            return Err("Vocabulary cannot contain null characters".to_string());
        }

        let mut seen = HashSet::new();
        let mut terms = Vec::new();
        for term in raw.split([',', '\n', '\r']) {
            let term = term.trim();
            if term.is_empty() {
                continue;
            }
            let key = term.to_lowercase();
            if seen.insert(key) {
                terms.push(term);
            }
        }

        if terms.is_empty() {
            return Ok(None);
        }

        let normalized = terms.join("\n");
        if normalized.chars().count() > MAX_VOCABULARY_CHARS {
            return Err(format!(
                "Vocabulary must be {} characters or fewer",
                MAX_VOCABULARY_CHARS
            ));
        }
        Ok(Some(normalized))
    }

    pub fn merge(primary: Option<&str>, secondary: Option<&str>) -> Option<String> {
        let combined = [primary, secondary]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n");

        // Stored values are already validated. This path can exceed the
        // per-scope character limit when meeting and global terms are combined.
        let mut seen = HashSet::new();
        let terms = combined
            .split([',', '\n', '\r'])
            .map(str::trim)
            .filter(|term| !term.is_empty())
            .filter(|term| seen.insert(term.to_lowercase()))
            .collect::<Vec<_>>();
        (!terms.is_empty()).then(|| terms.join(", "))
    }

    pub async fn get_global(pool: &SqlitePool) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT whisperVocabulary FROM transcript_settings WHERE id = '1' LIMIT 1",
        )
        .fetch_optional(pool)
        .await
        .map(Option::flatten)
    }

    pub async fn save_global(
        pool: &SqlitePool,
        vocabulary: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let _guard = GLOBAL_VOCABULARY_WRITE_LOCK.lock().await;
        Self::save_global_unlocked(pool, vocabulary).await
    }

    async fn save_global_unlocked(
        pool: &SqlitePool,
        vocabulary: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO transcript_settings (id, provider, model, whisperVocabulary)
            VALUES ('1', 'parakeet', $1, $2)
            ON CONFLICT(id) DO UPDATE SET
                whisperVocabulary = excluded.whisperVocabulary
            "#,
        )
        .bind(crate::config::DEFAULT_PARAKEET_MODEL)
        .bind(vocabulary)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn add_global(pool: &SqlitePool, raw: &str) -> Result<Option<String>, String> {
        let _guard = GLOBAL_VOCABULARY_WRITE_LOCK.lock().await;
        let existing = Self::get_global(pool).await.map_err(|error| error.to_string())?;
        let combined = [existing.as_deref(), Some(raw)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n");
        let normalized = Self::normalize(&combined)?;
        Self::save_global_unlocked(pool, normalized.as_deref())
            .await
            .map_err(|error| error.to_string())?;
        Ok(normalized)
    }

    pub async fn get_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT vocabulary FROM meeting_whisper_vocabulary WHERE meeting_id = ? LIMIT 1",
        )
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn add_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
        raw: &str,
    ) -> Result<Option<String>, String> {
        let _guard = MEETING_VOCABULARY_WRITE_LOCK.lock().await;
        let existing = Self::get_meeting(pool, meeting_id)
            .await
            .map_err(|error| error.to_string())?;
        let combined = [existing.as_deref(), Some(raw)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n");
        let normalized = Self::normalize(&combined)?;

        if let Some(vocabulary) = normalized.as_deref() {
            sqlx::query(
                r#"
                INSERT INTO meeting_whisper_vocabulary (meeting_id, vocabulary, updated_at)
                VALUES ($1, $2, $3)
                ON CONFLICT(meeting_id) DO UPDATE SET
                    vocabulary = excluded.vocabulary,
                    updated_at = excluded.updated_at
                "#,
            )
            .bind(meeting_id)
            .bind(vocabulary)
            .bind(Utc::now().to_rfc3339())
            .execute(pool)
            .await
            .map_err(|error| error.to_string())?;
        }
        Ok(normalized)
    }

    pub async fn save_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
        raw: &str,
    ) -> Result<Option<String>, String> {
        let _guard = MEETING_VOCABULARY_WRITE_LOCK.lock().await;
        let normalized = Self::normalize(raw)?;
        match normalized.as_deref() {
            Some(vocabulary) => {
                sqlx::query(
                    r#"
                    INSERT INTO meeting_whisper_vocabulary (meeting_id, vocabulary, updated_at)
                    VALUES ($1, $2, $3)
                    ON CONFLICT(meeting_id) DO UPDATE SET
                        vocabulary = excluded.vocabulary,
                        updated_at = excluded.updated_at
                    "#,
                )
                .bind(meeting_id)
                .bind(vocabulary)
                .bind(Utc::now().to_rfc3339())
                .execute(pool)
                .await
                .map_err(|error| error.to_string())?;
            }
            None => {
                sqlx::query("DELETE FROM meeting_whisper_vocabulary WHERE meeting_id = ?")
                    .bind(meeting_id)
                    .execute(pool)
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(normalized)
    }

    pub async fn get_effective(
        pool: &SqlitePool,
        meeting_id: Option<&str>,
    ) -> Result<Option<String>, sqlx::Error> {
        let global = Self::get_global(pool).await?;
        let meeting = match meeting_id {
            Some(meeting_id) => Self::get_meeting(pool, meeting_id).await?,
            None => None,
        };
        Ok(Self::merge(meeting.as_deref(), global.as_deref()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_and_deduplicates_terms() {
        assert_eq!(
            VocabularyRepository::normalize(" Meetily, Tauri\nmeetily \r\n OKR ")
                .unwrap()
                .as_deref(),
            Some("Meetily\nTauri\nOKR")
        );
    }

    #[test]
    fn meeting_terms_are_prioritized_when_merged() {
        assert_eq!(
            VocabularyRepository::merge(
                Some("Project Phoenix\nMeetily"),
                Some("meetily\nTauri")
            )
            .as_deref(),
            Some("Project Phoenix, Meetily, Tauri")
        );
    }

    #[test]
    fn rejects_invalid_or_oversized_values() {
        assert!(VocabularyRepository::normalize("bad\0term").is_err());
        assert!(VocabularyRepository::normalize(&"a".repeat(MAX_VOCABULARY_CHARS + 1)).is_err());
    }
}

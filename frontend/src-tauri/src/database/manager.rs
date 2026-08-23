use sqlx::{
    migrate::{MigrateDatabase, MigrateError, Migrator},
    Result, Sqlite, SqlitePool, Transaction,
};
use std::fs;
use std::path::Path;

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

const PEOPLE_MIGRATION_VERSION: i64 = 20260811000000;
const PEOPLE_MIGRATION_LF_CHECKSUM: &str =
    "3722B8A73598E02E31D989430BF2E756539BA575BC4C4A7D981BEE4FB218E549AB36C93071EAA73C006E14CF6CF58B1B";
const PEOPLE_MIGRATION_CRLF_CHECKSUM: &str =
    "75A90F5D84A2D6E6FE0AF8ABC583FEE66A10816AA39916AE2CB73AA728BD5F9FAB199C62CFEDD1F5D1083D795BD09B57";

#[derive(Clone)]
pub struct DatabaseManager {
    pool: SqlitePool,
}

impl DatabaseManager {
    pub async fn new(tauri_db_path: &str, backend_db_path: &str) -> Result<Self> {
        if let Some(parent_dir) = Path::new(tauri_db_path).parent() {
            if !parent_dir.exists() {
                fs::create_dir_all(parent_dir).map_err(|e| sqlx::Error::Io(e))?;
            }
        }

        if !Path::new(tauri_db_path).exists() {
            if Path::new(backend_db_path).exists() {
                log::info!(
                    "Copying database from {} to {}",
                    backend_db_path,
                    tauri_db_path
                );
                fs::copy(backend_db_path, tauri_db_path).map_err(|e| sqlx::Error::Io(e))?;
            } else {
                log::info!("Creating database at {}", tauri_db_path);
                Sqlite::create_database(tauri_db_path).await?;
            }
        }

        let migration_pool = SqlitePool::connect(tauri_db_path).await?;

        Self::run_migrations(&migration_pool).await?;
        // A failed checksum pass can leave another pooled SQLite connection
        // holding the pre-migration schema. Reopen before serving app queries.
        migration_pool.close().await;
        let pool = SqlitePool::connect(tauri_db_path).await?;

        Ok(DatabaseManager { pool })
    }

    async fn run_migrations(pool: &SqlitePool) -> Result<()> {
        match MIGRATOR.run(pool).await {
            Ok(()) => Ok(()),
            Err(MigrateError::VersionMismatch(PEOPLE_MIGRATION_VERSION)) => {
                Self::repair_people_migration_checksum(pool).await?;
                MIGRATOR.run(pool).await.map_err(Into::into)
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn repair_people_migration_checksum(pool: &SqlitePool) -> Result<()> {
        let mut transaction = pool.begin().await?;
        let stored_checksum = sqlx::query_scalar::<_, String>(
            "SELECT upper(hex(checksum)) FROM _sqlx_migrations WHERE version = ? AND success = 1",
        )
        .bind(PEOPLE_MIGRATION_VERSION)
        .fetch_optional(&mut *transaction)
        .await?;

        let Some(stored_checksum) = stored_checksum else {
            return Err(sqlx::Error::Protocol(
                "People migration checksum mismatch has no successful migration record".to_string(),
            ));
        };
        if stored_checksum != PEOPLE_MIGRATION_LF_CHECKSUM
            && stored_checksum != PEOPLE_MIGRATION_CRLF_CHECKSUM
        {
            return Err(MigrateError::VersionMismatch(PEOPLE_MIGRATION_VERSION).into());
        }

        let schema_objects = sqlx::query_as::<_, (String, String, String)>(
            r#"
            SELECT type, name, sql
            FROM sqlite_master
            WHERE (type = 'table' AND name IN ('people', 'person_speakers'))
               OR (type = 'index' AND name IN (
                   'idx_person_speakers_person_id',
                   'idx_person_speakers_meeting_id',
                   'idx_people_display_name'
               ))
            ORDER BY type, name
            "#,
        )
        .fetch_all(&mut *transaction)
        .await?;
        let expected_schema = [
            (
                "index",
                "idx_people_display_name",
                "CREATE INDEX idx_people_display_name ON people(display_name)",
            ),
            (
                "index",
                "idx_person_speakers_meeting_id",
                "CREATE INDEX idx_person_speakers_meeting_id ON person_speakers(meeting_id)",
            ),
            (
                "index",
                "idx_person_speakers_person_id",
                "CREATE INDEX idx_person_speakers_person_id ON person_speakers(person_id)",
            ),
            (
                "table",
                "people",
                r#"CREATE TABLE people (
                    id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
                    normalized_name TEXT NOT NULL UNIQUE CHECK (length(normalized_name) > 0),
                    notes TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )"#,
            ),
            (
                "table",
                "person_speakers",
                r#"CREATE TABLE person_speakers (
                    person_id TEXT NOT NULL,
                    meeting_id TEXT NOT NULL,
                    speaker_label TEXT NOT NULL,
                    PRIMARY KEY (person_id, meeting_id, speaker_label),
                    UNIQUE (meeting_id, speaker_label),
                    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
                    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
                )"#,
            ),
        ];
        let schema_matches = schema_objects.len() == expected_schema.len()
            && schema_objects.iter().zip(expected_schema).all(
                |((object_type, name, sql), (expected_type, expected_name, expected_sql))| {
                    object_type == expected_type
                        && name == expected_name
                        && Self::normalize_schema_sql(sql)
                            == Self::normalize_schema_sql(expected_sql)
                },
            );
        if !schema_matches {
            return Err(sqlx::Error::Protocol(
                "Refusing to repair the people migration checksum because its schema differs"
                    .to_string(),
            ));
        }

        let current_migration = MIGRATOR
            .iter()
            .find(|migration| migration.version == PEOPLE_MIGRATION_VERSION)
            .ok_or_else(|| MigrateError::VersionNotPresent(PEOPLE_MIGRATION_VERSION))?;
        let result = sqlx::query(
            "UPDATE _sqlx_migrations SET checksum = ? WHERE version = ? AND success = 1 AND upper(hex(checksum)) = ?",
        )
        .bind(current_migration.checksum.as_ref())
        .bind(PEOPLE_MIGRATION_VERSION)
        .bind(&stored_checksum)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() != 1 {
            return Err(sqlx::Error::Protocol(
                "Failed to repair the people migration checksum".to_string(),
            ));
        }
        transaction.commit().await?;

        log::warn!(
            "Repaired migration {} checksum after the known Windows LF/CRLF packaging mismatch",
            PEOPLE_MIGRATION_VERSION
        );
        Ok(())
    }

    fn normalize_schema_sql(sql: &str) -> String {
        sql.chars()
            .filter(|character| !character.is_whitespace())
            .flat_map(char::to_lowercase)
            .collect()
    }

    // NOTE: So for the first time users they needs to start the application
    // after they can just delete the existing .sqlite file and then copy the existing .db file to
    // the current app dir, So the system detects legacy db and copy it and starts with that data
    // (Newly created .sqlite with the copied content from .db)
    pub async fn new_from_app_handle(app_handle: &tauri::AppHandle) -> Result<Self> {
        // Resolve the install-local data directory (portable / self-contained).
        let _ = app_handle; // retained for signature compatibility
        let app_data_dir = crate::paths::install_data_root();
        if !app_data_dir.exists() {
            fs::create_dir_all(&app_data_dir).map_err(|e| sqlx::Error::Io(e))?;
        }

        // Define database paths
        let tauri_db_path = app_data_dir
            .join("meeting_minutes.sqlite")
            .to_string_lossy()
            .to_string();
        // Legacy backend DB path (for auto-migration if exists)
        let backend_db_path = app_data_dir
            .join("meeting_minutes.db")
            .to_string_lossy()
            .to_string();

        // WAL file paths for defensive cleanup
        let wal_path = app_data_dir.join("meeting_minutes.sqlite-wal");
        let shm_path = app_data_dir.join("meeting_minutes.sqlite-shm");

        log::info!("Tauri DB path: {}", tauri_db_path);
        log::info!("Legacy backend DB path: {}", backend_db_path);

        // Try to open database with defensive WAL handling
        match Self::new(&tauri_db_path, &backend_db_path).await {
            Ok(db_manager) => {
                log::info!("Database opened successfully");
                Ok(db_manager)
            }
            Err(e) => {
                // Check if error is due to corrupted WAL file
                let error_msg = e.to_string();
                if error_msg.contains("malformed") || error_msg.contains("corrupt") {
                    log::warn!("Database appears corrupted, likely due to orphaned WAL file. Attempting recovery...");
                    log::warn!("Error details: {}", error_msg);

                    // Delete potentially corrupted WAL/SHM files
                    if wal_path.exists() {
                        match fs::remove_file(&wal_path) {
                            Ok(_) => log::info!("Removed orphaned WAL file: {:?}", wal_path),
                            Err(e) => log::warn!("Failed to remove WAL file: {}", e),
                        }
                    }
                    if shm_path.exists() {
                        match fs::remove_file(&shm_path) {
                            Ok(_) => log::info!("Removed orphaned SHM file: {:?}", shm_path),
                            Err(e) => log::warn!("Failed to remove SHM file: {}", e),
                        }
                    }

                    // Retry connection without WAL files
                    log::info!("Retrying database connection after WAL cleanup...");
                    match Self::new(&tauri_db_path, &backend_db_path).await {
                        Ok(db_manager) => {
                            log::info!("Database opened successfully after WAL recovery");
                            Ok(db_manager)
                        }
                        Err(retry_err) => {
                            log::error!(
                                "Database connection failed even after WAL cleanup: {}",
                                retry_err
                            );
                            Err(retry_err)
                        }
                    }
                } else {
                    // Not a WAL-related error, propagate original error
                    log::error!("Database connection failed: {}", error_msg);
                    Err(e)
                }
            }
        }
    }

    /// Check if this is the first launch (sqlite database doesn't exist yet)
    pub async fn is_first_launch(app_handle: &tauri::AppHandle) -> Result<bool> {
        let _ = app_handle; // retained for signature compatibility
        let app_data_dir = crate::paths::install_data_root();

        let tauri_db_path = app_data_dir.join("meeting_minutes.sqlite");

        Ok(!tauri_db_path.exists())
    }

    /// Import a legacy database from the specified path and initialize
    pub async fn import_legacy_database(
        app_handle: &tauri::AppHandle,
        legacy_db_path: &str,
    ) -> Result<Self> {
        let _ = app_handle; // retained for signature compatibility
        let app_data_dir = crate::paths::install_data_root();

        if !app_data_dir.exists() {
            fs::create_dir_all(&app_data_dir).map_err(|e| sqlx::Error::Io(e))?;
        }

        // Copy legacy database to app data directory as meeting_minutes.db
        let target_legacy_path = app_data_dir.join("meeting_minutes.db");
        log::info!(
            "Copying legacy database from {} to {}",
            legacy_db_path,
            target_legacy_path.display()
        );

        fs::copy(legacy_db_path, &target_legacy_path).map_err(|e| sqlx::Error::Io(e))?;

        // Now use the standard initialization which will detect and migrate the legacy db
        Self::new_from_app_handle(app_handle).await
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn with_transaction<T, F, Fut>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut Transaction<'_, Sqlite>) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let mut tx = self.pool.begin().await?;
        let result = f(&mut tx).await;

        match result {
            Ok(val) => {
                tx.commit().await?;
                Ok(val)
            }
            Err(err) => {
                tx.rollback().await?;
                Err(err)
            }
        }
    }

    /// Cleanup database connection and checkpoint WAL
    /// This should be called on application shutdown to ensure:
    /// - All WAL changes are written to the main database file
    /// - The .wal and .shm files are deleted
    /// - Connection pool is gracefully closed
    pub async fn cleanup(&self) -> Result<()> {
        log::info!("Starting database cleanup...");

        // Force checkpoint of WAL to main database file and remove WAL file
        // TRUNCATE mode: checkpoints all pages AND deletes the WAL file
        match sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&self.pool)
            .await
        {
            Ok(_) => log::info!("WAL checkpoint completed successfully"),
            Err(e) => log::warn!("WAL checkpoint failed (non-fatal): {}", e),
        }

        // Close the connection pool gracefully
        self.pool.close().await;
        log::info!("Database connection pool closed");

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn repairs_known_people_migration_line_ending_checksum() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        MIGRATOR.run(&pool).await.unwrap();
        sqlx::query(
            "UPDATE _sqlx_migrations SET checksum = X'75A90F5D84A2D6E6FE0AF8ABC583FEE66A10816AA39916AE2CB73AA728BD5F9FAB199C62CFEDD1F5D1083D795BD09B57' WHERE version = ?",
        )
        .bind(PEOPLE_MIGRATION_VERSION)
        .execute(&pool)
        .await
        .unwrap();

        DatabaseManager::run_migrations(&pool).await.unwrap();

        let stored_checksum: String = sqlx::query_scalar(
            "SELECT upper(hex(checksum)) FROM _sqlx_migrations WHERE version = ?",
        )
        .bind(PEOPLE_MIGRATION_VERSION)
        .fetch_one(&pool)
        .await
        .unwrap();
        let expected_checksum = MIGRATOR
            .iter()
            .find(|migration| migration.version == PEOPLE_MIGRATION_VERSION)
            .unwrap()
            .checksum
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<String>();
        assert_eq!(stored_checksum, expected_checksum);
    }

    #[tokio::test]
    async fn rejects_unknown_people_migration_checksum() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        MIGRATOR.run(&pool).await.unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = ?")
            .bind(PEOPLE_MIGRATION_VERSION)
            .execute(&pool)
            .await
            .unwrap();

        let error = DatabaseManager::run_migrations(&pool).await.unwrap_err();
        assert!(error
            .to_string()
            .contains("previously applied but has been modified"));
    }

    #[tokio::test]
    async fn rejects_known_checksum_when_people_schema_differs() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        MIGRATOR.run(&pool).await.unwrap();
        sqlx::query("DROP INDEX idx_people_display_name")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE INDEX idx_people_display_name ON people(normalized_name)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE _sqlx_migrations SET checksum = X'75A90F5D84A2D6E6FE0AF8ABC583FEE66A10816AA39916AE2CB73AA728BD5F9FAB199C62CFEDD1F5D1083D795BD09B57' WHERE version = ?",
        )
        .bind(PEOPLE_MIGRATION_VERSION)
        .execute(&pool)
        .await
        .unwrap();

        let error = DatabaseManager::run_migrations(&pool).await.unwrap_err();
        assert!(error.to_string().contains("schema differs"));
    }
}

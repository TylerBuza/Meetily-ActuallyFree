//! File cleanup follows a committed database deletion. A failed database write
//! must never destroy a surviving meeting's audio. Cleanup can fail independently
//! and returns a visible warning with the retained folder for manual recovery.
use crate::audio::recording_preferences::resolve_path_for_containment;
use crate::database::repositories::meeting::delete_meeting_with_transaction;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};

fn checked_folder(
    folder: &Path,
    roots: &[PathBuf],
    others: &[String],
) -> Result<Option<PathBuf>, String> {
    if folder.as_os_str().is_empty() {
        return Ok(None);
    }
    let candidate = resolve_path_for_containment(folder).map_err(|e| e.to_string())?;
    let roots: Vec<_> = roots
        .iter()
        .map(|p| resolve_path_for_containment(p).map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;
    if roots.iter().any(|root| root == &candidate)
        || !roots.iter().any(|root| candidate.starts_with(root))
    {
        return Err("Refusing to delete path outside recording folders or a recording root".into());
    }
    // Resolve every other reference, including missing descendants. Raw string
    // equality misses case aliases, junctions/symlinks, dot components and parents.
    for other in others.iter().filter(|p| !p.trim().is_empty()) {
        let other = resolve_path_for_containment(Path::new(other)).map_err(|e| e.to_string())?;
        if candidate.starts_with(&other) || other.starts_with(&candidate) {
            return Err(
                "Recording folder overlaps another meeting; meeting and files were kept".into(),
            );
        }
    }
    if !candidate.try_exists().map_err(|e| e.to_string())? {
        return Ok(None);
    }
    if !candidate.is_dir() {
        return Err("Recording path is not a directory; files were kept".into());
    }
    Ok(Some(candidate))
}

pub(super) async fn delete_with_files(
    pool: &SqlitePool,
    meeting: &str,
    roots: Vec<PathBuf>,
) -> Result<Option<String>, String> {
    delete_with_cleanup(pool, meeting, roots, std::fs::remove_dir_all).await
}

async fn delete_with_cleanup<F>(
    pool: &SqlitePool,
    meeting: &str,
    roots: Vec<PathBuf>,
    cleanup: F,
) -> Result<Option<String>, String>
where
    F: FnOnce(PathBuf) -> std::io::Result<()> + Send + 'static,
{
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let folder: Option<Option<String>> =
        sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id = ?")
            .bind(meeting)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    let folder = folder.ok_or_else(|| "Meeting not found; files were kept".to_string())?;
    let others: Vec<String> = sqlx::query_scalar(
        "SELECT folder_path FROM meetings WHERE id != ? AND folder_path IS NOT NULL",
    )
    .bind(meeting)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    let path = tokio::task::spawn_blocking(move || match folder {
        Some(folder) => checked_folder(Path::new(&folder), &roots, &others),
        None => Ok(None),
    })
    .await
    .map_err(|e| e.to_string())??;
    // The read/check and all related-row deletes share the transaction snapshot;
    // a competing DB write must resolve before this commit succeeds. No file
    // removal happens on a constraint, lock, transaction or commit failure.
    if !delete_meeting_with_transaction(&mut tx, meeting)
        .await
        .map_err(|e| format!("Meeting deletion failed; files were kept: {e}"))?
    {
        return Err("Meeting not found; files were kept".into());
    }
    tx.commit()
        .await
        .map_err(|e| format!("Meeting deletion failed; files were kept: {e}"))?;
    if let Some(path) = path {
        let display = path.display().to_string();
        match tokio::task::spawn_blocking(move || cleanup(path)).await {
            Ok(Ok(())) => {},
            Ok(Err(e)) => return Ok(Some(format!("Meeting removed, but local file cleanup failed at {display}: {e}. Some files may remain; review the folder manually."))),
            Err(e) => return Ok(Some(format!("Meeting removed, but local file cleanup did not complete at {display}: {e}. Review the folder manually."))),
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dirs() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let one = root.path().join("one");
        let two = root.path().join("two");
        std::fs::create_dir_all(&one).unwrap();
        std::fs::create_dir_all(&two).unwrap();
        (root, one, two)
    }
    #[test]
    fn aliases_and_containment_are_rejected_but_siblings_are_allowed() {
        let (root, one, two) = dirs();
        let roots = vec![root.path().to_owned()];
        for alias in [
            one.join("."),
            two.join("..").join("one"),
            one.join("child"),
            root.path().to_owned(),
        ] {
            assert!(checked_folder(&one, &roots, &[alias.to_string_lossy().into_owned()]).is_err());
        }
        let child = one.join("child");
        std::fs::create_dir(&child).unwrap();
        assert!(checked_folder(&child, &roots, &[one.to_string_lossy().into_owned()]).is_err());
        assert!(checked_folder(root.path(), &roots, &[]).is_err());
        assert!(checked_folder(&one, &roots, &[two.to_string_lossy().into_owned()]).is_ok());
        let outside = tempfile::tempdir().unwrap();
        assert!(checked_folder(outside.path(), &roots, &[]).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_alias_is_shared() {
        let (root, one, _) = dirs();
        let alias = root.path().join("alias");
        std::os::unix::fs::symlink(&one, &alias).unwrap();
        assert!(checked_folder(
            &one,
            &[root.path().to_owned()],
            &[alias.to_string_lossy().into_owned()]
        )
        .is_err());
    }
    #[cfg(windows)]
    #[test]
    fn windows_case_and_junction_alias_is_shared() {
        let (root, one, _) = dirs();
        let roots = vec![root.path().to_owned()];
        assert!(checked_folder(&one, &roots, &[one.to_string_lossy().to_uppercase()]).is_err());
        let alias = root.path().join("alias");
        // Junction creation needs no symlink privilege and remains in the temp root.
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&alias)
            .arg(&one)
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(checked_folder(&one, &roots, &[alias.to_string_lossy().into_owned()]).is_err());
        std::fs::remove_dir(alias).unwrap();
    }
    async fn pool(folder: &Path) -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE meetings(id TEXT PRIMARY KEY, folder_path TEXT); CREATE TABLE meeting_images(folder_path TEXT);
            CREATE TABLE person_speakers(meeting_id TEXT); CREATE TABLE meeting_whisper_vocabulary(meeting_id TEXT);
            CREATE TABLE action_items(meeting_id TEXT); CREATE TABLE meeting_notes(meeting_id TEXT);
            CREATE TABLE transcript_chunks(meeting_id TEXT); CREATE TABLE transcripts(meeting_id TEXT); CREATE TABLE summary_processes(meeting_id TEXT);")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO meetings VALUES ('one', ?)")
            .bind(folder.to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        pool
    }
    #[tokio::test]
    async fn database_failure_preserves_meeting_and_audio() {
        let (root, one, _) = dirs();
        std::fs::write(one.join("audio.mp4"), b"private fixture").unwrap();
        let pool = pool(&one).await;
        sqlx::raw_sql("CREATE TRIGGER reject_delete BEFORE DELETE ON meetings BEGIN SELECT RAISE(ABORT, 'test constraint'); END;")
            .execute(&pool).await.unwrap();
        assert!(
            delete_with_files(&pool, "one", vec![root.path().to_owned()])
                .await
                .is_err()
        );
        assert!(one.join("audio.mp4").exists());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM meetings")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
    }
    #[tokio::test]
    async fn cleanup_failure_is_explicit_after_database_commit() {
        let (root, one, _) = dirs();
        std::fs::write(one.join("audio.mp4"), b"fixture").unwrap();
        let pool = pool(&one).await;
        let warning = delete_with_cleanup(&pool, "one", vec![root.path().to_owned()], |_| {
            Err(std::io::Error::other("simulated locked file"))
        })
        .await
        .unwrap();
        assert!(warning.unwrap().contains("cleanup failed"));
        assert!(one.join("audio.mp4").exists());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM meetings")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }
    #[tokio::test]
    async fn success_removes_only_unshared_folder_and_missing_folder_is_ok() {
        let (root, one, two) = dirs();
        let pool = pool(&one).await;
        assert_eq!(
            delete_with_files(&pool, "one", vec![root.path().to_owned()])
                .await
                .unwrap(),
            None
        );
        assert!(!one.exists());
        assert!(two.exists());
        sqlx::query("INSERT INTO meetings VALUES ('one', ?)")
            .bind(one.to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            delete_with_files(&pool, "one", vec![root.path().to_owned()])
                .await
                .unwrap(),
            None
        );
    }
}

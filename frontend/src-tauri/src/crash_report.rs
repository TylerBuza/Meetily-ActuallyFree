use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::backtrace::Backtrace;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use sysinfo::System;
use tempfile::NamedTempFile;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const REPORT_SCHEMA_VERSION: u8 = 1;
const README: &str = "Meetily crash report\n\
\n\
Included:\n\
- Crash type, time, and anonymous report ID\n\
- Meetily version and selected acceleration backend\n\
- Operating system family/version, architecture, bucketed CPU core count, and a rounded memory size\n\
- Panic source and anonymous fingerprint when available\n\
\n\
Not included:\n\
- Recordings, audio checkpoints, transcripts, summaries, or meeting names\n\
- Meetily's database, settings, or WebView storage\n\
- API keys, tokens, environment variables, usernames, hostnames, or device names\n\
- Ordinary application logs or memory dumps\n";

static CURRENT_SESSION_ID: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static PANIC_RECORDED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecord {
    session_id: String,
    started_at: String,
    process_id: u32,
    app_version: String,
    operating_system: String,
    os_version: Option<String>,
    architecture: String,
    cpu_core_bucket: usize,
    memory_gib_bucket: u64,
    backend: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PanicRecord {
    occurred_at: String,
    app_version: String,
    source: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
    fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum CrashType {
    Panic,
    UnexpectedExit,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashReport {
    schema_version: u8,
    report_id: String,
    detected_at: String,
    crash_type: CrashType,
    app_version: String,
    operating_system: String,
    os_version: Option<String>,
    architecture: String,
    cpu_core_bucket: usize,
    memory_gib_bucket: u64,
    backend: String,
    panic: Option<PanicRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingCrashReport {
    report_id: String,
    detected_at: String,
    crash_type: CrashType,
    app_version: String,
}

impl From<&CrashReport> for PendingCrashReport {
    fn from(report: &CrashReport) -> Self {
        Self {
            report_id: report.report_id.clone(),
            detected_at: report.detected_at.clone(),
            crash_type: report.crash_type.clone(),
            app_version: report.app_version.clone(),
        }
    }
}

pub fn install_panic_hook() {
    let data_root = crate::paths::install_data_root();
    let previous = std::panic::take_hook();

    std::panic::set_hook(Box::new(move |info| {
        let occurred_at = Utc::now().to_rfc3339();
        let location = info.location();
        let backtrace = sanitize_backtrace(&Backtrace::force_capture().to_string());
        let source = location.map(|value| source_relative_path(value.file()));
        let fingerprint = panic_fingerprint(
            source.as_deref(),
            location.map(|value| value.line()),
            location.map(|value| value.column()),
        );
        let record = PanicRecord {
            occurred_at: occurred_at.clone(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            source,
            line: location.map(|value| value.line()),
            column: location.map(|value| value.column()),
            fingerprint,
        };

        if !PANIC_RECORDED.swap(true, Ordering::SeqCst) {
            let _ = write_json_atomic(&panic_path(&data_root), &record);
        }
        append_legacy_crash_log(&data_root, &occurred_at, info, &backtrace);
        log::error!("Meetily encountered a panic; a local crash record was written");
        previous(info);
    }));
}

pub fn start_session() -> Result<(), String> {
    let holder = CURRENT_SESSION_ID.get_or_init(|| Mutex::new(None));
    let mut current_session = holder
        .lock()
        .map_err(|_| "Crash session state is unavailable".to_string())?;
    if current_session.is_some() {
        return Ok(());
    }

    let root = crash_root(&crate::paths::install_data_root());
    let session = current_session_record();
    start_session_at(&root, session.clone()).map_err(|error| error.to_string())?;

    *current_session = Some(session.session_id);
    PANIC_RECORDED.store(false, Ordering::SeqCst);
    Ok(())
}

pub fn finish_session() -> Result<(), String> {
    let Some(holder) = CURRENT_SESSION_ID.get() else {
        return Ok(());
    };
    let mut current_session = holder
        .lock()
        .map_err(|_| "Crash session state is unavailable".to_string())?;
    let Some(session_id) = current_session.as_deref() else {
        return Ok(());
    };

    finish_session_at(&crash_root(&crate::paths::install_data_root()), session_id)
        .map_err(|error| error.to_string())?;
    *current_session = None;
    Ok(())
}

#[tauri::command]
pub fn prepare_for_app_restart() -> Result<(), String> {
    finish_session()
}

#[tauri::command]
pub fn resume_crash_session() -> Result<(), String> {
    start_session()
}

#[tauri::command]
pub fn get_pending_crash_report() -> Result<Option<PendingCrashReport>, String> {
    let report = read_json::<CrashReport>(&pending_path(&crash_root(
        &crate::paths::install_data_root(),
    )))
    .map_err(|error| format!("Failed to read pending crash report: {error}"))?;
    Ok(report.as_ref().map(PendingCrashReport::from))
}

#[tauri::command]
pub fn create_crash_report_zip(destination: String) -> Result<String, String> {
    let root = crash_root(&crate::paths::install_data_root());
    let report = read_json::<CrashReport>(&pending_path(&root))
        .map_err(|error| format!("Failed to read pending crash report: {error}"))?
        .ok_or_else(|| "No pending crash report is available".to_string())?;
    let destination = PathBuf::from(destination);

    write_report_zip(&destination, &report)
        .map_err(|error| format!("Failed to create crash report ZIP: {error}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn dismiss_pending_crash_report() -> Result<(), String> {
    remove_if_exists(&pending_path(&crash_root(
        &crate::paths::install_data_root(),
    )))
    .map_err(|error| format!("Failed to dismiss crash report: {error}"))
}

fn crash_root(data_root: &Path) -> PathBuf {
    data_root.join("crash-reports")
}

fn session_path(root: &Path) -> PathBuf {
    root.join("session.json")
}

fn panic_path(data_root: &Path) -> PathBuf {
    crash_root(data_root).join("panic.pending.json")
}

fn pending_path(root: &Path) -> PathBuf {
    root.join("pending.json")
}

fn start_session_at(root: &Path, session: SessionRecord) -> io::Result<()> {
    fs::create_dir_all(root)?;
    let stale_session = read_json::<SessionRecord>(&session_path(root))?;
    let panic = read_json::<PanicRecord>(&root.join("panic.pending.json"))?;

    // Keep the newest failure actionable instead of silently discarding it
    // behind a report that the user has not resolved yet.
    if stale_session.is_some() {
        let metadata = stale_session.as_ref().unwrap_or(&session);
        let report = CrashReport {
            schema_version: REPORT_SCHEMA_VERSION,
            report_id: Uuid::new_v4().to_string(),
            detected_at: panic
                .as_ref()
                .map(|value| value.occurred_at.clone())
                .unwrap_or_else(|| Utc::now().to_rfc3339()),
            crash_type: if panic.is_some() {
                CrashType::Panic
            } else {
                CrashType::UnexpectedExit
            },
            app_version: metadata.app_version.clone(),
            operating_system: metadata.operating_system.clone(),
            os_version: metadata.os_version.clone(),
            architecture: metadata.architecture.clone(),
            cpu_core_bucket: metadata.cpu_core_bucket,
            memory_gib_bucket: metadata.memory_gib_bucket,
            backend: metadata.backend.clone(),
            panic,
        };
        write_json_atomic(&pending_path(root), &report)?;
    }

    remove_if_exists(&root.join("panic.pending.json"))?;
    write_json_atomic(&session_path(root), &session)
}

fn finish_session_at(root: &Path, session_id: &str) -> io::Result<()> {
    let path = session_path(root);
    let session = read_json::<SessionRecord>(&path)?;
    if session
        .as_ref()
        .is_some_and(|value| value.session_id == session_id)
    {
        remove_if_exists(&path)?;
    }
    Ok(())
}

fn current_session_record() -> SessionRecord {
    let mut system = System::new();
    system.refresh_memory();
    system.refresh_cpu_all();
    let total_gib = system.total_memory().div_ceil(1024 * 1024 * 1024);
    let memory_gib_bucket = total_gib.max(1).div_ceil(4) * 4;

    SessionRecord {
        session_id: Uuid::new_v4().to_string(),
        started_at: Utc::now().to_rfc3339(),
        process_id: std::process::id(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        operating_system: System::name().unwrap_or_else(|| std::env::consts::OS.to_string()),
        os_version: coarse_os_version(System::os_version()),
        architecture: std::env::consts::ARCH.to_string(),
        cpu_core_bucket: core_count_bucket(system.cpus().len()),
        memory_gib_bucket,
        backend: selected_backend(),
    }
}

fn selected_backend() -> String {
    let configured =
        fs::read_to_string(crate::paths::install_data_root().join("selected-backend.txt"))
            .unwrap_or_default()
            .to_ascii_lowercase();

    for backend in [
        "cuda", "vulkan", "metal", "coreml", "openblas", "hipblas", "cpu",
    ] {
        if configured.trim() == backend {
            return backend.to_string();
        }
    }

    if cfg!(feature = "cuda") {
        "cuda"
    } else if cfg!(feature = "vulkan") {
        "vulkan"
    } else if cfg!(feature = "metal") {
        "metal"
    } else if cfg!(feature = "coreml") {
        "coreml"
    } else if cfg!(feature = "openblas") {
        "openblas"
    } else if cfg!(feature = "hipblas") {
        "hipblas"
    } else if cfg!(target_os = "macos") {
        "metal"
    } else {
        "cpu"
    }
    .to_string()
}

fn coarse_os_version(version: Option<String>) -> Option<String> {
    version.and_then(|value| {
        value
            .split(|character: char| !character.is_ascii_alphanumeric())
            .find(|part| {
                part.chars()
                    .next()
                    .is_some_and(|value| value.is_ascii_digit())
            })
            .map(str::to_string)
    })
}

fn core_count_bucket(cores: usize) -> usize {
    cores.max(1).next_power_of_two()
}

fn panic_fingerprint(source: Option<&str>, line: Option<u32>, column: Option<u32>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"meetily-panic-location-v1\0");
    hasher.update(source.unwrap_or_default().as_bytes());
    hasher.update(line.unwrap_or_default().to_le_bytes());
    hasher.update(column.unwrap_or_default().to_le_bytes());
    format!("{:x}", hasher.finalize())
}

fn source_relative_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    for marker in ["/src-tauri/src/", "/src/"] {
        if let Some((_, suffix)) = normalized.rsplit_once(marker) {
            return format!("src/{}", suffix);
        }
    }
    Path::new(&normalized)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_string()
}

fn sanitize_backtrace(backtrace: &str) -> String {
    let mut sanitized = backtrace.to_string();
    if let Some(home) = dirs::home_dir().and_then(|value| value.to_str().map(str::to_owned)) {
        sanitized = sanitized.replace(&home, "<home>");
        sanitized = sanitized.replace(&home.replace('\\', "/"), "<home>");
    }
    if sanitized.len() > 32 * 1024 {
        let mut end = 32 * 1024;
        while !sanitized.is_char_boundary(end) {
            end -= 1;
        }
        sanitized.truncate(end);
        sanitized.push_str("\n[stack trace truncated]");
    }
    sanitized
}

fn append_legacy_crash_log(
    data_root: &Path,
    occurred_at: &str,
    info: &std::panic::PanicHookInfo<'_>,
    backtrace: &str,
) {
    let path = data_root.join("crash.log");
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(path) {
        let _ = writeln!(file, "[{occurred_at}] panic: {info}");
        let _ = writeln!(file, "{backtrace}\n");
    }
}

fn write_report_zip(destination: &Path, report: &CrashReport) -> io::Result<()> {
    if !destination
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Crash report destination must use the .zip extension",
        ));
    }
    if let Some(parent) = destination.parent() {
        if !parent.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Crash report destination directory does not exist",
            ));
        }
    }
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let mut temporary = NamedTempFile::new_in(parent)?;
    {
        let mut zip = ZipWriter::new(temporary.as_file_mut());
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o600);
        let report_json = serde_json::to_vec_pretty(report).map_err(io::Error::other)?;

        zip.start_file("report.json", options)?;
        zip.write_all(&report_json)?;
        zip.start_file("README.txt", options)?;
        zip.write_all(README.as_bytes())?;
        zip.finish()?;
    }
    temporary.as_file().sync_all()?;
    temporary
        .persist(destination)
        .map(|_| ())
        .map_err(|error| error.error)
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| error.error)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> io::Result<Option<T>> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(value) => Ok(Some(value)),
            Err(_) => Ok(None),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Read;
    use tempfile::tempdir;
    use zip::ZipArchive;

    fn session(id: &str) -> SessionRecord {
        SessionRecord {
            session_id: id.to_string(),
            started_at: "2026-08-25T12:00:00Z".to_string(),
            process_id: 42,
            app_version: "0.2.7".to_string(),
            operating_system: "Windows".to_string(),
            os_version: Some("11".to_string()),
            architecture: "x86_64".to_string(),
            cpu_core_bucket: 8,
            memory_gib_bucket: 16,
            backend: "cuda".to_string(),
        }
    }

    #[test]
    fn stale_session_becomes_pending_report() {
        let temp = tempdir().unwrap();
        write_json_atomic(&session_path(temp.path()), &session("stale")).unwrap();

        start_session_at(temp.path(), session("current")).unwrap();

        let report = read_json::<CrashReport>(&pending_path(temp.path()))
            .unwrap()
            .unwrap();
        assert!(matches!(report.crash_type, CrashType::UnexpectedExit));
        assert_eq!(report.app_version, "0.2.7");
        assert_eq!(
            read_json::<SessionRecord>(&session_path(temp.path()))
                .unwrap()
                .unwrap()
                .session_id,
            "current"
        );
    }

    #[test]
    fn clean_exit_only_removes_matching_session() {
        let temp = tempdir().unwrap();
        write_json_atomic(&session_path(temp.path()), &session("current")).unwrap();

        finish_session_at(temp.path(), "other").unwrap();
        assert!(session_path(temp.path()).exists());

        finish_session_at(temp.path(), "current").unwrap();
        assert!(!session_path(temp.path()).exists());
    }

    #[test]
    fn panic_record_takes_priority_and_survives_clean_shutdown() {
        let temp = tempdir().unwrap();
        write_json_atomic(&session_path(temp.path()), &session("stale")).unwrap();
        let panic = PanicRecord {
            occurred_at: "2026-08-25T12:01:00Z".to_string(),
            app_version: "0.2.7".to_string(),
            source: Some("src/audio/pipeline.rs".to_string()),
            line: Some(12),
            column: Some(4),
            fingerprint: "fingerprint".to_string(),
        };
        write_json_atomic(&temp.path().join("panic.pending.json"), &panic).unwrap();

        start_session_at(temp.path(), session("current")).unwrap();
        finish_session_at(temp.path(), "current").unwrap();

        let report = read_json::<CrashReport>(&pending_path(temp.path()))
            .unwrap()
            .unwrap();
        assert!(matches!(report.crash_type, CrashType::Panic));
        assert_eq!(report.detected_at, panic.occurred_at);
        assert!(!session_path(temp.path()).exists());
        assert!(!temp.path().join("panic.pending.json").exists());
    }

    #[test]
    fn recovered_panic_without_stale_session_is_not_reported() {
        let temp = tempdir().unwrap();
        let panic = PanicRecord {
            occurred_at: "2026-08-25T12:01:00Z".to_string(),
            app_version: "0.2.7".to_string(),
            source: Some("src/audio/pipeline.rs".to_string()),
            line: Some(12),
            column: Some(4),
            fingerprint: "fingerprint".to_string(),
        };
        write_json_atomic(&temp.path().join("panic.pending.json"), &panic).unwrap();

        start_session_at(temp.path(), session("current")).unwrap();

        assert!(!pending_path(temp.path()).exists());
        assert!(!temp.path().join("panic.pending.json").exists());
    }

    #[test]
    fn zip_contains_only_allowlisted_redacted_files() {
        let temp = tempdir().unwrap();
        let report = CrashReport {
            schema_version: REPORT_SCHEMA_VERSION,
            report_id: "report-id".to_string(),
            detected_at: "2026-08-25T12:00:00Z".to_string(),
            crash_type: CrashType::Panic,
            app_version: "0.2.7".to_string(),
            operating_system: "Windows".to_string(),
            os_version: Some("11".to_string()),
            architecture: "x86_64".to_string(),
            cpu_core_bucket: 8,
            memory_gib_bucket: 16,
            backend: "cuda".to_string(),
            panic: Some(PanicRecord {
                occurred_at: "2026-08-25T12:00:00Z".to_string(),
                app_version: "0.2.7".to_string(),
                source: Some("src/audio/pipeline.rs".to_string()),
                line: Some(12),
                column: Some(4),
                fingerprint: "fingerprint".to_string(),
            }),
        };
        let destination = temp.path().join("report.zip");
        for (name, private_value) in [
            ("meeting_minutes.sqlite", "meeting title"),
            ("settings.json", "api-key"),
            ("transcript.txt", "transcript text"),
            ("device.txt", "C:\\Users\\friend"),
        ] {
            fs::write(temp.path().join(name), private_value).unwrap();
        }
        write_report_zip(&destination, &report).unwrap();

        let mut archive = ZipArchive::new(File::open(destination).unwrap()).unwrap();
        let names: Vec<String> = archive.file_names().map(str::to_owned).collect();
        assert_eq!(names, vec!["report.json", "README.txt"]);
        let mut report_json = String::new();
        archive
            .by_name("report.json")
            .unwrap()
            .read_to_string(&mut report_json)
            .unwrap();
        for private_value in [
            "meeting title",
            "transcript text",
            "api-key",
            "C:\\Users\\friend",
        ] {
            assert!(!report_json.contains(private_value));
        }
    }

    #[test]
    fn zip_accepts_uppercase_extension_and_replaces_existing_file() {
        let temp = tempdir().unwrap();
        let report = CrashReport {
            schema_version: REPORT_SCHEMA_VERSION,
            report_id: "report-id".to_string(),
            detected_at: "2026-08-25T12:00:00Z".to_string(),
            crash_type: CrashType::UnexpectedExit,
            app_version: "0.2.7".to_string(),
            operating_system: "Windows".to_string(),
            os_version: Some("11".to_string()),
            architecture: "x86_64".to_string(),
            cpu_core_bucket: 8,
            memory_gib_bucket: 16,
            backend: "cuda".to_string(),
            panic: None,
        };
        let destination = temp.path().join("report.ZIP");
        fs::write(&destination, b"previous file").unwrap();

        write_report_zip(&destination, &report).unwrap();

        let archive = ZipArchive::new(File::open(destination).unwrap()).unwrap();
        assert_eq!(archive.len(), 2);
    }
}

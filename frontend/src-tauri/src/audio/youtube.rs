use anyhow::{anyhow, Result};
use log::{debug, info};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter, Runtime};
use which::which;

#[cfg(not(windows))]
const YT_DLP_EXE: &str = "yt-dlp";

#[cfg(windows)]
const YT_DLP_EXE: &str = "yt-dlp.exe";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeVideoInfo {
    pub url: String,
    pub title: String,
    pub channel: String,
    pub duration_seconds: f64,
    pub thumbnail: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeProgress {
    pub stage: String, // "downloading_tool", "fetching_info", "downloading_video", "transcribing", "complete", "error"
    pub progress: u32,
    pub message: String,
}

/// Locate or download yt-dlp binary
pub async fn ensure_ytdlp_binary<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    // 1. Check in system PATH
    if let Ok(path) = which(YT_DLP_EXE) {
        debug!("Found yt-dlp in PATH: {:?}", path);
        return Ok(path);
    }

    // 2. Check in app install data bin directory
    let bin_dir = crate::paths::install_data_root().join("bin");
    let ytdlp_path = bin_dir.join(YT_DLP_EXE);
    if ytdlp_path.exists() && ytdlp_path.is_file() {
        debug!("Found yt-dlp in app bin: {:?}", ytdlp_path);
        return Ok(ytdlp_path);
    }

    // 3. Download yt-dlp
    info!("yt-dlp not found locally, downloading from GitHub releases...");
    let _ = app.emit(
        "youtube-progress",
        YouTubeProgress {
            stage: "downloading_tool".to_string(),
            progress: 5,
            message: "Downloading YouTube downloader tool (yt-dlp)...".to_string(),
        },
    );

    if !bin_dir.exists() {
        std::fs::create_dir_all(&bin_dir)
            .map_err(|e| anyhow!("Failed to create bin directory: {}", e))?;
    }

    #[cfg(windows)]
    let download_url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
    #[cfg(target_os = "macos")]
    let download_url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let download_url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| anyhow!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(download_url)
        .send()
        .await
        .map_err(|e| anyhow!("Failed to download yt-dlp from {}: {}", download_url, e))?;

    if !response.status().is_success() {
        return Err(anyhow!("Failed to download yt-dlp: HTTP status {}", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| anyhow!("Failed to read yt-dlp download bytes: {}", e))?;

    std::fs::write(&ytdlp_path, &bytes)
        .map_err(|e| anyhow!("Failed to write yt-dlp to {:?}: {}", ytdlp_path, e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&ytdlp_path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&ytdlp_path, perms)?;
    }

    info!("yt-dlp downloaded and verified at: {:?}", ytdlp_path);
    let _ = app.emit(
        "youtube-progress",
        YouTubeProgress {
            stage: "downloading_tool".to_string(),
            progress: 100,
            message: "YouTube downloader tool ready".to_string(),
        },
    );

    Ok(ytdlp_path)
}

/// Fetch metadata for a YouTube video URL without downloading
pub async fn fetch_youtube_info<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
) -> Result<YouTubeVideoInfo> {
    let ytdlp_path = ensure_ytdlp_binary(app).await?;

    let _ = app.emit(
        "youtube-progress",
        YouTubeProgress {
            stage: "fetching_info".to_string(),
            progress: 10,
            message: "Fetching video metadata...".to_string(),
        },
    );

    let output = tokio::task::spawn_blocking({
        let path = ytdlp_path.clone();
        let target_url = url.to_string();
        move || {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                Command::new(path)
                    .args(["--dump-single-json", "--no-playlist", "--skip-download", &target_url])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
            }
            #[cfg(not(windows))]
            {
                Command::new(path)
                    .args(["--dump-single-json", "--no-playlist", "--skip-download", &target_url])
                    .output()
            }
        }
    })
    .await
    .map_err(|e| anyhow!("Failed to execute metadata task: {}", e))?
    .map_err(|e| anyhow!("Failed to run yt-dlp command: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("yt-dlp error fetching video metadata: {}", stderr.trim()));
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let val: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| anyhow!("Failed to parse video metadata JSON: {}", e))?;

    let title = val["title"].as_str().unwrap_or("YouTube Video").to_string();
    let channel = val["uploader"]
        .as_str()
        .or_else(|| val["channel"].as_str())
        .unwrap_or("YouTube")
        .to_string();
    let duration_seconds = val["duration"].as_f64().unwrap_or(0.0);
    let thumbnail = val["thumbnail"].as_str().map(|s| s.to_string());
    let description = val["description"].as_str().map(|s| {
        let first_line = s.lines().next().unwrap_or("").trim();
        first_line.to_string()
    });

    Ok(YouTubeVideoInfo {
        url: url.to_string(),
        title,
        channel,
        duration_seconds,
        thumbnail,
        description,
    })
}

/// Download a YouTube video to a local temp file and return the path
pub async fn download_youtube_video<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    target_dir: &Path,
) -> Result<(PathBuf, String)> {
    let ytdlp_path = ensure_ytdlp_binary(app).await?;

    let _ = app.emit(
        "youtube-progress",
        YouTubeProgress {
            stage: "downloading_video".to_string(),
            progress: 15,
            message: "Downloading video from YouTube...".to_string(),
        },
    );

    let output_template = target_dir.join("youtube_video.%(ext)s");
    let output_template_str = output_template.to_string_lossy().to_string();

    let output = tokio::task::spawn_blocking({
        let path = ytdlp_path.clone();
        let target_url = url.to_string();
        let tmpl = output_template_str.clone();
        move || {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                Command::new(path)
                    .args([
                        "-f",
                        "b[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/b",
                        "--merge-output-format",
                        "mp4",
                        "-o",
                        &tmpl,
                        "--no-playlist",
                        &target_url,
                    ])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
            }
            #[cfg(not(windows))]
            {
                Command::new(path)
                    .args([
                        "-f",
                        "b[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/b",
                        "--merge-output-format",
                        "mp4",
                        "-o",
                        &tmpl,
                        "--no-playlist",
                        &target_url,
                    ])
                    .output()
            }
        }
    })
    .await
    .map_err(|e| anyhow!("Download task join error: {}", e))?
    .map_err(|e| anyhow!("Failed to run yt-dlp download: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("Failed to download YouTube video: {}", stderr.trim()));
    }

    // Locate the downloaded file
    let candidate_mp4 = target_dir.join("youtube_video.mp4");
    if candidate_mp4.exists() {
        return Ok((candidate_mp4, "mp4".to_string()));
    }

    // Look for any file matching youtube_video.*
    if let Ok(entries) = std::fs::read_dir(target_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                if stem == "youtube_video" && p.is_file() {
                    let ext = p
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("mp4")
                        .to_string();
                    return Ok((p, ext));
                }
            }
        }
    }

    Err(anyhow!("Could not locate downloaded YouTube video file"))
}

// ----------------------------------------------------------------------------
// Tauri IPC Commands
// ----------------------------------------------------------------------------

#[tauri::command]
pub async fn fetch_youtube_info_command<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> Result<YouTubeVideoInfo, String> {
    fetch_youtube_info(&app, &url).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn transcribe_youtube_url_command<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    title: Option<String>,
    language: Option<String>,
    model: Option<String>,
    provider: Option<String>,
) -> Result<crate::audio::import::ImportResult, String> {
    let app_clone = app.clone();
    let url_clone = url.clone();

    // Check if import already in progress
    if crate::audio::import::is_import_in_progress() {
        return Err("Another import is already in progress".to_string());
    }

    // 1. Fetch info for title if not provided
    let video_title = match title {
        Some(t) if !t.trim().is_empty() => t.trim().to_string(),
        _ => {
            let info = fetch_youtube_info(&app, &url_clone)
                .await
                .map_err(|e| format!("Could not fetch video info: {}", e))?;
            info.title
        }
    };

    // 2. Download video to temporary folder
    let temp_dir = tempfile::tempdir().map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let (video_file, _) = download_youtube_video(&app_clone, &url_clone, temp_dir.path())
        .await
        .map_err(|e| format!("Download error: {}", e))?;

    // 3. Delegate to start_import
    let result = crate::audio::import::start_import(
        app_clone,
        video_file.to_string_lossy().to_string(),
        video_title,
        language,
        model,
        provider,
    )
    .await
    .map_err(|e| format!("Import failed: {}", e))?;

    Ok(result)
}

//! Tauri commands backing the Claude Code CLI section of Model Settings.

use serde::Serialize;
use tauri::State;

use crate::database::repositories::setting::SettingsRepository;
use crate::state::AppState;

use super::claude_cli::{self, ClaudeCliModel, ClaudeCliStatus};

/// Outcome of the "Test connection" button.
#[derive(Debug, Serialize)]
pub struct ClaudeCliTestResult {
    pub status: String,
    pub message: String,
}

/// Detect the CLI and report its version and sign-in state.
///
/// `path` lets Model Settings preview an override the user has typed but not
/// saved yet; when omitted the saved path (if any) is used.
#[tauri::command]
pub async fn claude_cli_get_status(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<ClaudeCliStatus, String> {
    let configured = match path {
        Some(path) => Some(path),
        None => SettingsRepository::get_claude_cli_path(state.db_manager.pool())
            .await
            .map_err(|e| format!("Failed to read the Claude Code CLI path: {}", e))?,
    };

    Ok(claude_cli::probe(configured.as_deref()).await)
}

/// The model aliases offered for this provider.
#[tauri::command]
pub async fn claude_cli_list_models() -> Result<Vec<ClaudeCliModel>, String> {
    Ok(claude_cli::list_models())
}

/// Read the saved CLI path override, if the user set one.
#[tauri::command]
pub async fn claude_cli_get_path(state: State<'_, AppState>) -> Result<Option<String>, String> {
    SettingsRepository::get_claude_cli_path(state.db_manager.pool())
        .await
        .map_err(|e| format!("Failed to read the Claude Code CLI path: {}", e))
}

/// Save an explicit CLI path, or clear it to resume auto-discovery.
#[tauri::command]
pub async fn claude_cli_save_path(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<(), String> {
    SettingsRepository::save_claude_cli_path(state.db_manager.pool(), path.as_deref())
        .await
        .map_err(|e| format!("Failed to save the Claude Code CLI path: {}", e))
}

/// Send a throwaway prompt through the CLI to confirm summaries will actually run.
///
/// This is the only check that costs subscription usage, so it stays behind an
/// explicit button rather than running with the status probe.
#[tauri::command]
pub async fn claude_cli_test_connection(
    state: State<'_, AppState>,
    path: Option<String>,
    model: Option<String>,
) -> Result<ClaudeCliTestResult, String> {
    let configured = match path {
        Some(path) => Some(path),
        None => SettingsRepository::get_claude_cli_path(state.db_manager.pool())
            .await
            .map_err(|e| format!("Failed to read the Claude Code CLI path: {}", e))?,
    };

    let model = model.unwrap_or_else(|| claude_cli::DEFAULT_MODEL.to_string());

    match claude_cli::generate(
        configured.as_deref(),
        &model,
        "Reply with exactly one word and nothing else.",
        "Reply with the single word: ready",
        None,
    )
    .await
    {
        Ok(response) => Ok(ClaudeCliTestResult {
            status: "success".to_string(),
            message: format!("Claude Code CLI responded: {}", response.trim()),
        }),
        Err(e) => Ok(ClaudeCliTestResult {
            status: "error".to_string(),
            message: e,
        }),
    }
}

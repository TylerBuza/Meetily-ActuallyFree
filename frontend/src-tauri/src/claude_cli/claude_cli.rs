//! Discovery, health probing and one-shot invocation of the Claude Code CLI.
//!
//! Every summary is a fresh `claude --print` process: there is no long-lived
//! sidecar to keep warm, and no conversation state is carried between runs.
//! The CLI owns authentication, so this provider never reads or stores a key.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};


/// Matches the HTTP providers' ceiling in `llm_client.rs`; a long meeting
/// summarised by Opus can legitimately take several minutes.
const GENERATION_TIMEOUT: Duration = Duration::from_secs(300);

/// Probes only start the CLI and read a line or two of output.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// How often the generation loop re-checks the cancellation token.
const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Environment override for the CLI location, mirroring `MEETILY_LLAMA_HELPER`.
const BINARY_ENV_VAR: &str = "MEETILY_CLAUDE_CLI";

/// Selectable models, kept as CLI aliases rather than dated model IDs so the
/// list stays correct as Anthropic ships new versions.
const MODELS: &[(&str, &str)] = &[
    ("sonnet", "Sonnet — balanced quality and speed"),
    ("opus", "Opus — highest quality, slowest"),
    ("haiku", "Haiku — fastest, lightest summaries"),
    ("default", "Whatever the CLI is configured to use"),
];

/// The model alias used when nothing has been chosen yet.
pub const DEFAULT_MODEL: &str = "sonnet";

/// A model choice offered in Model Settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeCliModel {
    pub id: String,
    pub display_name: String,
}

/// Result of `claude auth status --json`, trimmed to the fields we display.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ClaudeCliAuth {
    #[serde(default, rename = "loggedIn")]
    pub logged_in: bool,
    #[serde(default, rename = "authMethod")]
    pub auth_method: Option<String>,
    #[serde(default, rename = "subscriptionType")]
    pub subscription_type: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default, rename = "orgName")]
    pub org_name: Option<String>,
}

/// Everything Model Settings needs to explain the current state of the CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeCliStatus {
    /// The executable was found and reported a version.
    pub installed: bool,
    /// Absolute path of the executable that was used, when one was found.
    pub path: Option<String>,
    /// Raw `claude --version` output, e.g. "2.1.270 (Claude Code)".
    pub version: Option<String>,
    /// Auth details, when the CLI was runnable.
    pub auth: Option<ClaudeCliAuth>,
    /// True when `ANTHROPIC_API_KEY` is set for this app's process. The CLI
    /// prefers that key over the subscription, so summaries would be billed
    /// per-token — worth warning about given why people pick this provider.
    pub api_key_env_detected: bool,
    /// Why detection failed, for display under the provider picker.
    pub error: Option<String>,
}

impl ClaudeCliStatus {
    fn not_installed(error: String) -> Self {
        Self {
            installed: false,
            path: None,
            version: None,
            auth: None,
            api_key_env_detected: api_key_env_detected(),
            error: Some(error),
        }
    }
}

/// The models offered for this provider.
pub fn list_models() -> Vec<ClaudeCliModel> {
    MODELS
        .iter()
        .map(|(id, display_name)| ClaudeCliModel {
            id: (*id).to_string(),
            display_name: (*display_name).to_string(),
        })
        .collect()
}

fn api_key_env_detected() -> bool {
    std::env::var("ANTHROPIC_API_KEY")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

// ============================================================================
// Binary discovery
// ============================================================================

#[cfg(target_os = "windows")]
const EXECUTABLE_NAMES: &[&str] = &["claude.exe", "claude.cmd", "claude.bat", "claude"];

#[cfg(not(target_os = "windows"))]
const EXECUTABLE_NAMES: &[&str] = &["claude"];

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// Install locations the CLI's own installers use, checked before falling back
/// to a PATH scan. A Tauri app launched from Explorer or the Dock does not
/// always inherit the shell PATH, so these matter more than they look.
fn well_known_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(home) = home_dir() {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".claude").join("local"));
        dirs.push(home.join("bin"));
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let root = PathBuf::from(local_app_data);
            dirs.push(root.join("Programs").join("claude"));
            dirs.push(root.join("Programs").join("claude-code"));
        }
        if let Some(app_data) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(app_data).join("npm"));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
    }

    dirs
}

fn first_executable_in(dir: &Path) -> Option<PathBuf> {
    EXECUTABLE_NAMES
        .iter()
        .map(|name| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Walk `PATH` looking for the CLI. Done by hand rather than relying on the
/// OS resolving a bare `claude`, so the status panel can show which file was
/// picked and so `.cmd` shims get the `cmd.exe` treatment they need.
fn search_path_env() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var).find_map(|dir| first_executable_in(&dir))
}

/// Resolve the executable to run.
///
/// `configured` is the user's explicit override from Model Settings. When it is
/// set but missing we fail loudly instead of silently falling back, so a typo
/// in the path is visible rather than mysterious.
pub fn resolve_binary(configured: Option<&str>) -> Result<PathBuf, String> {
    if let Some(configured) = configured.map(str::trim).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Ok(path);
        }
        // A directory is a forgiving thing for a user to paste in.
        if path.is_dir() {
            if let Some(found) = first_executable_in(&path) {
                return Ok(found);
            }
        }
        return Err(format!(
            "The configured Claude Code CLI path does not exist: {}",
            path.display()
        ));
    }

    if let Some(from_env) = std::env::var_os(BINARY_ENV_VAR) {
        let path = PathBuf::from(from_env);
        if path.is_file() {
            info!("Using Claude Code CLI from {}: {}", BINARY_ENV_VAR, path.display());
            return Ok(path);
        }
    }

    for dir in well_known_dirs() {
        if let Some(found) = first_executable_in(&dir) {
            return Ok(found);
        }
    }

    if let Some(found) = search_path_env() {
        return Ok(found);
    }

    Err(
        "Claude Code CLI not found. Install it from https://claude.com/claude-code, \
         then sign in with `claude auth login`. If it is installed somewhere unusual, \
         set the path in Model Settings."
            .to_string(),
    )
}

// ============================================================================
// Process construction
// ============================================================================

/// Build a `Command` for the resolved binary.
///
/// Windows `.cmd`/`.bat` shims (npm global installs) cannot be started directly
/// by `CreateProcess`, so they are run through `cmd.exe /C`.
fn build_command(binary: &Path, args: &[&str], working_dir: &Path) -> Command {
    let is_shim = binary
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        .unwrap_or(false);

    let mut command = if is_shim {
        let mut command = Command::new("cmd.exe");
        command.arg("/C").arg(binary);
        command
    } else {
        Command::new(binary)
    };

    command.args(args);
    command.current_dir(working_dir);

    // The CLI renders differently when it thinks a human is watching.
    command.env("CI", "1");
    command.env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
}

/// A scratch directory to run the CLI in.
///
/// The CLI discovers `CLAUDE.md`, hooks and plugins relative to its working
/// directory. Running in an empty app-owned folder keeps summaries reproducible
/// and stops a user's unrelated project instructions from leaking into them.
fn working_dir() -> PathBuf {
    let dir = crate::paths::install_data_root().join("claude-cli");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        warn!("Failed to create Claude CLI working directory: {}", e);
        return std::env::temp_dir();
    }
    dir
}

struct CommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

/// Run a short-lived CLI command and collect its output.
///
/// `stdin_data` is streamed from a task of its own: transcripts routinely exceed
/// the OS pipe buffer, and writing inline would deadlock against a child that is
/// waiting for us to drain its stdout.
async fn run_command(
    mut command: Command,
    stdin_data: Option<String>,
    timeout: Duration,
    cancellation_token: Option<&CancellationToken>,
) -> Result<CommandOutput, String> {
    command
        .stdin(if stdin_data.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start the Claude Code CLI: {}", e))?;

    if let Some(data) = stdin_data {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open Claude Code CLI stdin".to_string())?;
        tokio::spawn(async move {
            if let Err(e) = stdin.write_all(data.as_bytes()).await {
                warn!("Failed to write prompt to Claude Code CLI: {}", e);
            }
            // Dropping stdin signals end-of-prompt; the CLI waits for it.
            drop(stdin);
        });
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open Claude Code CLI stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to open Claude Code CLI stderr".to_string())?;

    let stdout_task = tokio::spawn(async move {
        let mut buffer = String::new();
        let _ = BufReader::new(stdout).read_to_string(&mut buffer).await;
        buffer
    });
    let stderr_task = tokio::spawn(async move {
        let mut buffer = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut buffer).await;
        buffer
    });

    // Poll rather than `select!` on `child.wait()`: the cancellation and timeout
    // branches both need `&mut child` to kill it, which a single `select!` will
    // not let us borrow. `Child::wait` is cancel-safe, so dropping it each tick
    // loses nothing.
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(token) = cancellation_token {
            if token.is_cancelled() {
                let _ = child.kill().await;
                return Err("Summary generation was cancelled".to_string());
            }
        }

        match tokio::time::timeout(CANCELLATION_POLL_INTERVAL, child.wait()).await {
            Ok(status) => {
                break status.map_err(|e| format!("Claude Code CLI failed: {}", e))?;
            }
            Err(_) if Instant::now() >= deadline => {
                let _ = child.kill().await;
                return Err(format!(
                    "The Claude Code CLI did not respond within {} seconds",
                    timeout.as_secs()
                ));
            }
            Err(_) => continue,
        }
    };

    Ok(CommandOutput {
        success: status.success(),
        stdout: stdout_task.await.unwrap_or_default(),
        stderr: stderr_task.await.unwrap_or_default(),
    })
}

// ============================================================================
// Status probe
// ============================================================================

/// Detect the CLI and report its version and sign-in state.
///
/// Both sub-commands are local and free — no model is invoked — so this is safe
/// to call whenever Model Settings opens.
pub async fn probe(configured: Option<&str>) -> ClaudeCliStatus {
    let binary = match resolve_binary(configured) {
        Ok(binary) => binary,
        Err(e) => return ClaudeCliStatus::not_installed(e),
    };

    let working_dir = working_dir();

    let version_output = run_command(
        build_command(&binary, &["--version"], &working_dir),
        None,
        PROBE_TIMEOUT,
        None,
    )
    .await;

    let version = match version_output {
        Ok(output) if output.success => output.stdout.trim().to_string(),
        Ok(output) => {
            return ClaudeCliStatus::not_installed(format!(
                "`claude --version` failed: {}",
                first_meaningful_line(&output.stderr, &output.stdout)
            ));
        }
        Err(e) => return ClaudeCliStatus::not_installed(e),
    };

    let auth = match run_command(
        build_command(&binary, &["auth", "status", "--json"], &working_dir),
        None,
        PROBE_TIMEOUT,
        None,
    )
    .await
    {
        Ok(output) => serde_json::from_str::<ClaudeCliAuth>(output.stdout.trim()).ok(),
        Err(e) => {
            warn!("Failed to read Claude Code CLI auth status: {}", e);
            None
        }
    };

    ClaudeCliStatus {
        installed: true,
        path: Some(binary.display().to_string()),
        version: Some(version),
        auth,
        api_key_env_detected: api_key_env_detected(),
        error: None,
    }
}

fn first_meaningful_line<'a>(stderr: &'a str, stdout: &'a str) -> &'a str {
    stderr
        .lines()
        .chain(stdout.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no output")
}

// ============================================================================
// Generation
// ============================================================================

/// The `--print` result envelope. Only the fields we act on are modelled.
#[derive(Debug, Deserialize)]
struct PrintResult {
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    result: Option<String>,
}

/// The system prompt for one call, written next to the CLI's working
/// directory and removed however the call ends.
struct SystemPromptFile(PathBuf);

impl SystemPromptFile {
    fn create(dir: &Path, contents: &str) -> Result<Self, String> {
        let path = dir.join(format!("system-prompt-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&path, contents)
            .map_err(|e| format!("Failed to write the Claude Code CLI prompt: {}", e))?;
        Ok(Self(path))
    }
}

impl Drop for SystemPromptFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Model names come from settings and end up on a command line, which runs
/// under cmd.exe for `.cmd` shims. Aliases (`sonnet`, `opus[1m]`) and model IDs
/// only need these characters.
fn is_safe_model_name(model: &str) -> bool {
    !model.is_empty()
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '[' | ']'))
}

/// Turns the CLI's terse failures into the step the user has to take.
fn explain_cli_error(detail: &str) -> String {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("not logged in") || lower.contains("please run /login") {
        return "Claude Code isn't signed in. Open a terminal, run `claude auth login` and sign \
                in with your Claude account, then try again."
            .to_string();
    }
    if lower.contains("unknown option") {
        return format!(
            "This Claude Code CLI is too old for Meetily ({}). Run `claude update`, then try again.",
            detail
        );
    }
    format!("Claude Code CLI returned an error: {}", detail)
}

/// Produce one completion via `claude --print`.
///
/// Neither prompt goes on the command line. The transcript is written to
/// stdin and the system prompt to a file: Windows caps a command line at ~32k
/// characters (8191 through cmd.exe, which `.cmd` shims need), and cmd.exe
/// reads quotes, `&` and `%` in prompt text as its own syntax.
pub async fn generate(
    configured_path: Option<&str>,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    cancellation_token: Option<&CancellationToken>,
) -> Result<String, String> {
    if let Some(token) = cancellation_token {
        if token.is_cancelled() {
            return Err("Summary generation was cancelled".to_string());
        }
    }

    let model = model_name.trim();
    if !model.is_empty() && !is_safe_model_name(model) {
        return Err(format!("\"{}\" is not a Claude model name", model));
    }

    let binary = resolve_binary(configured_path)?;
    let working_dir = working_dir();
    let prompt_file = SystemPromptFile::create(&working_dir, system_prompt)?;
    let prompt_path = prompt_file
        .0
        .to_str()
        .ok_or_else(|| "The Claude Code CLI working folder has an unreadable path".to_string())?;

    // Strip the CLI down to a plain text-in/text-out model call: no tools, no
    // MCP servers, no user settings, no saved session, so a user's hooks and
    // CLAUDE.md never reach a summary. With no tools there is nothing to ask
    // permission for, and print mode never prompts.
    let mut args: Vec<&str> = vec![
        "--print",
        "--output-format",
        "json",
        "--system-prompt-file",
        prompt_path,
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--no-session-persistence",
    ];

    if !model.is_empty() && model != "default" {
        args.push("--model");
        args.push(model);
    }

    info!(
        "🐞 Claude Code CLI request: model={}, binary={}",
        if model.is_empty() { "default" } else { model },
        binary.display()
    );

    let output = run_command(
        build_command(&binary, &args, &working_dir),
        Some(user_prompt.to_string()),
        GENERATION_TIMEOUT,
        cancellation_token,
    )
    .await?;

    let trimmed = output.stdout.trim();

    let parsed = serde_json::from_str::<PrintResult>(trimmed).map_err(|e| {
        if output.success {
            format!(
                "Could not read the Claude Code CLI response: {}. Output began: {}",
                e,
                truncate_for_error(trimmed)
            )
        } else {
            explain_cli_error(first_meaningful_line(&output.stderr, trimmed))
        }
    })?;

    if parsed.is_error || parsed.subtype.as_deref() != Some("success") {
        let detail = parsed
            .result
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .unwrap_or_else(|| first_meaningful_line(&output.stderr, trimmed).to_string());
        return Err(explain_cli_error(&detail));
    }

    let text = parsed.result.unwrap_or_default();
    let text = text.trim();
    if text.is_empty() {
        return Err("The Claude Code CLI returned an empty response".to_string());
    }

    info!("🐞 Claude Code CLI response received ({} chars)", text.len());
    Ok(text.to_string())
}

fn truncate_for_error(value: &str) -> String {
    const LIMIT: usize = 200;
    if value.chars().count() <= LIMIT {
        return value.to_string();
    }
    let head: String = value.chars().take(LIMIT).collect();
    format!("{}…", head)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_names_are_limited_to_alias_and_id_characters() {
        for name in ["sonnet", "opus[1m]", "claude-sonnet-4-5-20250929", "haiku"] {
            assert!(is_safe_model_name(name), "{name}");
        }
        for name in ["", "sonnet & calc", "opus\"", "%PATH%", "haiku|x", "a b"] {
            assert!(!is_safe_model_name(name), "{name}");
        }
    }

    #[test]
    fn cli_errors_name_the_fix() {
        assert!(explain_cli_error("Not logged in · Please run /login").contains("claude auth login"));
        assert!(explain_cli_error("error: unknown option '--tools'").contains("claude update"));
        assert_eq!(
            explain_cli_error("Overloaded"),
            "Claude Code CLI returned an error: Overloaded"
        );
    }

    /// Runs the installed CLI. Signed out, the call is free and must come back
    /// as the sign-in message; signed in, it must return text. Either way the
    /// flags have to be accepted and the output parsed.
    #[tokio::test]
    #[ignore = "Runs the local Claude Code CLI"]
    async fn installed_cli_accepts_the_invocation() {
        let result = generate(None, "haiku", "Reply with one word.", "Say: ready", None).await;
        println!("{result:?}");
        match result {
            Ok(text) => assert!(!text.is_empty()),
            Err(error) => {
                assert!(!error.contains("too old"), "{error}");
                assert!(!error.starts_with("Could not read"), "{error}");
                assert!(error.contains("claude auth login"), "{error}");
            }
        }
    }

    #[test]
    fn system_prompt_file_is_removed_after_the_call() {
        let dir = tempfile::tempdir().unwrap();
        let path = {
            let file = SystemPromptFile::create(dir.path(), "Say \"hi\" & 100% more").unwrap();
            assert_eq!(std::fs::read_to_string(&file.0).unwrap(), "Say \"hi\" & 100% more");
            file.0.clone()
        };
        assert!(!path.exists());
    }
}

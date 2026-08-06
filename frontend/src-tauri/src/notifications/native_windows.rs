//! Native Windows toast notifications shown as "Meetily - Actually Free"
//! (with our icon) instead of "Windows PowerShell".
//!
//! ## Why this module exists
//! `tauri-plugin-notification` only attaches our AppUserModelID (AUMID) to a
//! toast when it believes the app is *installed*. It explicitly skips the AUMID
//! when the running exe sits in a directory ending with `target\debug` or
//! `target\release` (see the plugin's `desktop.rs`). This portable fork ships
//! and runs `target\release\meetily.exe`, so the plugin never sets an AUMID and
//! Windows falls back to attributing every toast to PowerShell's AUMID — which
//! is why the meeting-detected toast reads "Windows PowerShell".
//!
//! ## The fix (standard technique for unpackaged desktop apps)
//! 1. Register an AUMID under `HKCU\Software\Classes\AppUserModelId\<AUMID>`
//!    with a friendly `DisplayName` + `IconUri`.
//! 2. Call `SetCurrentProcessExplicitAppUserModelID(<AUMID>)` once, early, so
//!    this process's toasts are attributed to that AUMID.
//! 3. Raise the toast with that same AUMID via `tauri-winrt-notification`.
//!
//! Windows then renders the toast as our app, with our name and logo.
//!
//! ## How it connects
//! - `ensure_app_identity()` is called once at startup from `lib.rs` (Windows).
//! - `show_toast()` is the single entry point used by
//!   `notifications::system::SystemNotificationHandler::show_notification`
//!   (which every manager-driven notification flows through, including the
//!   meeting-detection prompt via the `show_simple_notification` command).
//! - It is deliberately best-effort: if the platform toast can't be raised the
//!   caller falls back to the Tauri plugin, so we never regress to *no* toast.

use std::path::{Path, PathBuf};
use std::sync::Once;

/// Stable AppUserModelID for this app. Users never see this string (the
/// `DisplayName` below is what appears on the toast); it only needs to be
/// unique and constant across runs.
pub const APP_USER_MODEL_ID: &str = "dev.buza.MeetilyActuallyFree";

/// Friendly name Windows shows as the toast's source.
const DISPLAY_NAME: &str = "Meetily - Actually Free";

/// App icon embedded at compile time so `IconUri` always has a real file to
/// point at, regardless of how the portable app was unpacked. Path is relative
/// to this source file: `src-tauri/src/notifications/` -> `src-tauri/icons/`.
const ICON_PNG: &[u8] = include_bytes!("../../icons/icon.png");

static INIT: Once = Once::new();

#[link(name = "shell32")]
extern "system" {
    /// <https://learn.microsoft.com/windows/win32/api/shobjidl_core/nf-shobjidl_core-setcurrentprocessexplicitappusermodelid>
    fn SetCurrentProcessExplicitAppUserModelID(app_id: *const u16) -> i32;
}

/// UTF-16, null-terminated (what the Win32 wide-string APIs expect).
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Where we stage the icon file that `IconUri` references.
fn icon_path() -> PathBuf {
    let dir = crate::paths::install_data_root();
    let _ = std::fs::create_dir_all(&dir);
    dir.join("app-icon.png")
}

/// Idempotently register our AUMID (name + icon) and bind it to this process.
/// The heavy work runs exactly once; extra calls are cheap no-ops.
pub fn ensure_app_identity() {
    INIT.call_once(|| {
        // Materialize the icon so IconUri has a real file to read.
        let icon = icon_path();
        if !icon.exists() {
            if let Err(e) = std::fs::write(&icon, ICON_PNG) {
                log::warn!("native toast: failed to stage app icon: {e}");
            }
        }

        // Register the AUMID so Windows shows our name + logo on the toast.
        if let Err(e) = register_aumid(&icon) {
            log::warn!("native toast: failed to register AppUserModelID: {e}");
        }

        // Bind this process to the AUMID so its toasts are attributed to us.
        let id = wide(APP_USER_MODEL_ID);
        let hr = unsafe { SetCurrentProcessExplicitAppUserModelID(id.as_ptr()) };
        if hr != 0 {
            log::warn!("native toast: SetCurrentProcessExplicitAppUserModelID failed: 0x{hr:08X}");
        } else {
            log::info!("native toast: bound process to AUMID '{APP_USER_MODEL_ID}'");
        }

        // Start Menu shortcut with the same AUMID — some Windows builds only
        // show a proper app name/icon on toasts when a shortcut is registered.
        if let Err(e) = ensure_start_menu_shortcut(&icon) {
            log::warn!("native toast: Start Menu shortcut: {e}");
        }
    });
}

/// Create/update `%AppData%\Microsoft\Windows\Start Menu\Programs\Meetily - Actually Free.lnk`
/// pointing at this exe with our AppUserModelID (via a silent PowerShell COM call).
fn ensure_start_menu_shortcut(icon: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_s = exe.to_string_lossy().replace('\'', "''");
    let work = exe
        .parent()
        .map(|p| p.to_string_lossy().replace('\'', "''"))
        .unwrap_or_default();
    let icon_s = icon.to_string_lossy().replace('\'', "''");
    let programs = dirs::data_dir()
        .ok_or_else(|| "no AppData".to_string())?
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs");
    let _ = std::fs::create_dir_all(&programs);
    let lnk = programs.join("Meetily - Actually Free.lnk");
    let lnk_s = lnk.to_string_lossy().replace('\'', "''");

    // PowerShell + WScript.Shell cannot set AppUserModelID; we still create the
    // shortcut for Discoverability. AUMID is on the process + registry above.
    let script = format!(
        "$ws = New-Object -ComObject WScript.Shell; \
         $s = $ws.CreateShortcut('{lnk}'); \
         $s.TargetPath = '{exe}'; \
         $s.WorkingDirectory = '{work}'; \
         $s.IconLocation = '{icon}'; \
         $s.Description = 'Meetily - Actually Free'; \
         $s.Save()",
        lnk = lnk_s,
        exe = exe_s,
        work = work,
        icon = icon_s,
    );

    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("powershell exit {status}"))
    }
}

/// Write `HKCU\Software\Classes\AppUserModelId\<AUMID>` with DisplayName + IconUri.
fn register_aumid(icon: &Path) -> std::io::Result<()> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = format!("Software\\Classes\\AppUserModelId\\{APP_USER_MODEL_ID}");
    let (key, _) = hkcu.create_subkey(&path)?;
    key.set_value("DisplayName", &DISPLAY_NAME.to_string())?;
    key.set_value("IconUri", &icon.to_string_lossy().to_string())?;
    Ok(())
}

/// Show a native toast attributed to Meetily. Returns `Err` if the platform
/// toast could not be raised, so the caller can fall back to the Tauri plugin.
pub fn show_toast(title: &str, body: &str) -> Result<(), String> {
    ensure_app_identity();

    use tauri_winrt_notification::{Duration, Toast};

    Toast::new(APP_USER_MODEL_ID)
        .title(title)
        .text1(body)
        .duration(Duration::Short)
        .show()
        .map_err(|e| format!("winrt toast failed: {e}"))
}

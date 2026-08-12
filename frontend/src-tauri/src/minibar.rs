//! Compact recording mode.
//!
//! While a meeting is being recorded the full window is mostly in the way â€” the
//! user is working in other apps. Compact mode hides it and shows a small
//! frameless, always-on-top bar with just the timer, input meters and the
//! pause/stop controls, so recording stays visible and controllable without
//! occupying the screen.
//!
//! The bar is a separate webview window (label `minibar`) rendering the
//! `/minibar` route, rather than a resized main window: the main window keeps
//! its own state and layout untouched, so expanding again is instant and
//! nothing has to be re-mounted or re-fetched.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

const MINIBAR_LABEL: &str = "minibar";
const MINIBAR_WIDTH: f64 = 580.0;
const MINIBAR_HEIGHT: f64 = 76.0;

// Serialize window lifecycle changes so a queued minimize request cannot race a
// recording stop and recreate the bar after native shutdown closed it.
static MINIBAR_LIFECYCLE: Mutex<()> = Mutex::new(());
static MAIN_HIDDEN_BY_MINIBAR: AtomicBool = AtomicBool::new(false);

fn close_minibar_locked<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    if let Some(bar) = app.get_webview_window(MINIBAR_LABEL) {
        // `destroy` bypasses webview close-request/event handling. Recording
        // shutdown must be able to remove a stale or unresponsive frontend.
        return match bar.destroy() {
            Ok(()) => Ok(true),
            Err(destroy_error) => {
                // A failed destroy is recoverable on a later lifecycle call.
                // Hide the stopped always-on-top controls in the meantime so
                // they cannot remain stuck over the restored main window.
                match bar.hide() {
                    Ok(()) => Err(format!(
                        "{}; compact bar hidden for a later cleanup retry",
                        destroy_error
                    )),
                    Err(hide_error) => Err(format!(
                        "{}; fallback hide also failed: {}",
                        destroy_error, hide_error
                    )),
                }
            }
        };
    }
    Ok(false)
}

fn restore_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

/// Native recording shutdown calls this directly; it never relies on a
/// frontend event reaching the dynamically-created webview.
pub fn close_for_recording_stop<R: Runtime>(app: &AppHandle<R>, restore_main: bool) {
    let _lifecycle = MINIBAR_LIFECYCLE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let hidden_by_minibar = MAIN_HIDDEN_BY_MINIBAR.load(Ordering::SeqCst);
    let minibar_closed = match close_minibar_locked(app) {
        Ok(_) => {
            MAIN_HIDDEN_BY_MINIBAR.store(false, Ordering::SeqCst);
            true
        }
        Err(error) => {
            // Preserve ownership so an Expand/retry can clean up the surviving
            // webview. Also recover the hidden main window on this exceptional
            // path; leaving both the app and its failed overlay unreachable is
            // worse than focusing main for a tray-origin stop.
            log::warn!("Failed to close compact recording bar: {}", error);
            false
        }
    };

    // Only a Stop pressed in the compact bar restores the window it hid. A
    // main-window or tray stop must not unexpectedly show or focus `main`, unless
    // native destruction failed and main is the only reliable recovery surface.
    if (restore_main || !minibar_closed) && hidden_by_minibar {
        restore_main_window(app);
    }
}

/// Show the compact recording bar and hide the main window.
///
/// A non-None `elapsed_seconds` identifies an explicit UI collapse (and permits
/// focusing the bar). The timer itself always reads native recording duration.
#[tauri::command]
pub async fn enter_compact_mode<R: Runtime>(
    app: AppHandle<R>,
    elapsed_seconds: Option<u64>,
) -> Result<(), String> {
    let focus_bar = elapsed_seconds.is_some();
    let _lifecycle = MINIBAR_LIFECYCLE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    // The minimize callback is asynchronous, so its earlier recording check
    // can become stale while shutdown starts. Recheck under the window lock.
    if !crate::audio::recording_commands::can_enter_compact_mode() {
        return Ok(());
    }

    // Reuse the window if it already exists. Do not send a new elapsed seed:
    // the webview reads native monotonic duration, and reseeding caused timer
    // jumps when duplicate minimize events arrived.
    let bar = if let Some(existing) = app.get_webview_window(MINIBAR_LABEL) {
        existing
    } else {
        let window = WebviewWindowBuilder::new(
            &app,
            MINIBAR_LABEL,
            WebviewUrl::App("minibar".into()),
        )
        .title("Recording")
        .inner_size(MINIBAR_WIDTH, MINIBAR_HEIGHT)
        .resizable(false)
        .decorations(false)   // frameless: the bar draws its own chrome
        .transparent(true)    // lets the rounded corners read as rounded
        .always_on_top(true)  // the point of compact mode
        .skip_taskbar(true)   // it's an overlay, not a second app entry
        .shadow(false)
        .visible(false)       // reveal only after main is hidden
        .build()
        .map_err(|e| format!("Failed to create compact bar: {}", e))?;

        // Park it top-centre, clear of the title bars of whatever is behind it.
        if let Ok(Some(monitor)) = window.primary_monitor() {
            let size = monitor.size();
            let scale = monitor.scale_factor();
            let screen_w = size.width as f64 / scale;
            let x = (screen_w - MINIBAR_WIDTH) / 2.0;
            let _ = window.set_position(tauri::LogicalPosition::new(x.max(0.0), 12.0));
        }

        window
    };

    if let Some(main) = app.get_webview_window("main") {
        if let Err(error) = main.hide() {
            let _ = close_minibar_locked(&app);
            return Err(error.to_string());
        }
        MAIN_HIDDEN_BY_MINIBAR.store(true, Ordering::SeqCst);
    }

    if let Err(error) = bar.show() {
        let hidden_by_minibar = MAIN_HIDDEN_BY_MINIBAR.swap(false, Ordering::SeqCst);
        let _ = close_minibar_locked(&app);
        if hidden_by_minibar {
            restore_main_window(&app);
        }
        return Err(error.to_string());
    }
    if focus_bar {
        let _ = bar.set_focus();
    }

    log::info!("Entered compact recording mode");
    Ok(())
}

/// Close the compact bar and bring the main window back.
#[tauri::command]
pub async fn exit_compact_mode<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let _lifecycle = MINIBAR_LIFECYCLE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    close_minibar_locked(&app)?;
    if MAIN_HIDDEN_BY_MINIBAR.swap(false, Ordering::SeqCst) {
        restore_main_window(&app);
    }
    log::info!("Left compact recording mode");
    Ok(())
}

/// Whether compact mode is currently active.
#[tauri::command]
pub async fn is_compact_mode<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    Ok(app.get_webview_window(MINIBAR_LABEL).is_some())
}

/// Stop the recording from the compact bar. Native shutdown owns both window
/// teardown and the main-window-only post-processing completion signal.
#[tauri::command]
pub async fn stop_recording_from_minibar<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    let save_path = crate::paths::install_data_root()
        .join(format!(
            "recording-{}.wav",
            chrono::Local::now().format("%Y-%m-%dT%H-%M-%S")
        ))
        .to_string_lossy()
        .to_string();

    let outcome = crate::audio::recording_commands::stop_recording_from_compact(
        app.clone(),
        crate::audio::recording_commands::RecordingArgs { save_path },
    )
    .await?;

    Ok(outcome == crate::audio::recording_commands::StopOutcome::Completed)
}

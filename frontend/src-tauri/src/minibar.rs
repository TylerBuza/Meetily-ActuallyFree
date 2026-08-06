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

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

const MINIBAR_LABEL: &str = "minibar";
const MINIBAR_WIDTH: f64 = 580.0;
const MINIBAR_HEIGHT: f64 = 76.0;

/// Show the compact recording bar and hide the main window.
///
/// `elapsed_seconds` seeds the bar's timer so it continues from the current
/// recording position rather than restarting at zero.
#[tauri::command]
pub async fn enter_compact_mode<R: Runtime>(
    app: AppHandle<R>,
    elapsed_seconds: Option<u64>,
) -> Result<(), String> {
    let elapsed = elapsed_seconds.unwrap_or(0);

    // Reuse the window if it already exists â€” rebuilding it would flash.
    if let Some(existing) = app.get_webview_window(MINIBAR_LABEL) {
        let _ = existing.eval(&format!(
            "window.dispatchEvent(new CustomEvent('minibar-sync',{{detail:{{elapsed:{}}}}}))",
            elapsed
        ));
        existing.show().map_err(|e| e.to_string())?;
        let _ = existing.set_focus();
    } else {
        let window = WebviewWindowBuilder::new(
            &app,
            MINIBAR_LABEL,
            WebviewUrl::App(format!("minibar?elapsed={}", elapsed).into()),
        )
        .title("Recording")
        .inner_size(MINIBAR_WIDTH, MINIBAR_HEIGHT)
        .resizable(false)
        .decorations(false)   // frameless: the bar draws its own chrome
        .transparent(true)    // lets the rounded corners read as rounded
        .always_on_top(true)  // the point of compact mode
        .skip_taskbar(true)   // it's an overlay, not a second app entry
        .shadow(false)
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
    }

    if let Some(main) = app.get_webview_window("main") {
        main.hide().map_err(|e| e.to_string())?;
    }

    log::info!("ðŸŽ¬ Entered compact recording mode");
    Ok(())
}

/// Close the compact bar and bring the main window back.
#[tauri::command]
pub async fn exit_compact_mode<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(bar) = app.get_webview_window(MINIBAR_LABEL) {
        let _ = bar.close();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    log::info!("ðŸŽ¬ Left compact recording mode");
    Ok(())
}

/// Whether compact mode is currently active.
#[tauri::command]
pub async fn is_compact_mode<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    Ok(app.get_webview_window(MINIBAR_LABEL).is_some())
}

/// Stop the recording from the compact bar.
///
/// The bar is a separate webview, and cross-window frontend events to/from it
/// have proven unreliable (a stop emitted at the main window, or a
/// `recording-stopped` broadcast back to the bar, can be silently dropped —
/// leaving a "zombie" bar still counting after the recording ended). So the bar
/// does not signal the main window; it drives the stop through Rust directly,
/// mirroring the tray's proven path: stop the recording (which also tears down
/// this bar) and emit `recording-stop-complete` so the main window runs its
/// post-processing (save + navigate) exactly as it does for a tray stop.
#[tauri::command]
pub async fn stop_recording_from_minibar<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    use tauri::Emitter;

    let save_path = crate::paths::install_data_root()
        .join(format!(
            "recording-{}.wav",
            chrono::Local::now().format("%Y-%m-%dT%H-%M-%S")
        ))
        .to_string_lossy()
        .to_string();

    crate::audio::recording_commands::stop_recording(
        app.clone(),
        crate::audio::recording_commands::RecordingArgs { save_path },
    )
    .await?;

    // Drive the main window's save/navigate flow (RecordingPostProcessingProvider
    // listens for this), the same signal the tray uses.
    let _ = app.emit("recording-stop-complete", true);
    Ok(())
}

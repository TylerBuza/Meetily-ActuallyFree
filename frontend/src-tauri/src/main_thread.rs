//! Main-thread marshalling for Tauri window handles.
//!
//! `AppHandle`, `Window` and `WebviewWindow` all embed
//! `tauri_runtime_wry::Context`. On Windows that struct transitively owns tao's
//! `Rc<EventLoopRunner>` — a *non-atomic* refcount — even though
//! tauri-runtime-wry marks the containing `DispatcherMainThreadContext`
//! `Send + Sync` on the claim that it "is only used on the main thread".
//!
//! Cloning or dropping one of those handles off the main thread races the event
//! loop's own increments of that same counter. A single lost update walks the
//! count past zero to `usize::MAX`, and the next clone trips `Rc`'s overflow
//! guard, which calls `core::intrinsics::abort()`. That lands as a bare `ud2`,
//! so the process dies with STATUS_ILLEGAL_INSTRUCTION (0xC000001D) and no
//! panic payload — which is why these crashes arrive as an `unexpected_exit`
//! report with `panic: null`.
//!
//! Tauri runs `async fn` commands on the async runtime, so anything reached
//! from one is already on a background thread. Look window handles up *inside*
//! the closure passed here, never outside it.

use std::sync::mpsc;
use std::sync::Arc;

use tauri::{AppHandle, Runtime};

/// Runs `f` on the main thread and blocks until it returns.
///
/// Exactly one handle clone crosses the thread boundary, instead of one per
/// handle lookup inside `f`; the closure's copy sits behind an `Arc`, whose
/// refcount is atomic.
///
/// Any lock `f` takes must be one that is only ever taken on the main thread.
/// Holding a lock across this call and re-taking it inside `f` deadlocks: the
/// main thread would be waiting for a lock the blocked caller still owns.
pub fn on_main_thread<R, T, F>(app: &AppHandle<R>, f: F) -> Result<T, String>
where
    R: Runtime,
    T: Send + 'static,
    F: FnOnce(&AppHandle<R>) -> T + Send + 'static,
{
    let inner = Arc::new(app.clone());
    let for_closure = Arc::clone(&inner);
    let (tx, rx) = mpsc::sync_channel(1);

    // Called from the main thread this runs inline, so the bounded channel is
    // still empty when the send happens and the recv below returns at once.
    app.run_on_main_thread(move || {
        let _ = tx.send(f(&for_closure));
    })
    .map_err(|error| format!("could not reach the main thread: {error}"))?;

    rx.recv()
        .map_err(|error| format!("main-thread task did not report back: {error}"))
}

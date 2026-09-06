use serde::Serialize;
use std::sync::Mutex;
use tauri::{ipc::Channel, AppHandle, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio_util::sync::CancellationToken;

const DOWNLOAD_CANCELLED: &str = "Update download cancelled";

struct DownloadedUpdate {
    update: Update,
    bytes: Vec<u8>,
}

struct UpdateDownloadInner {
    generation: u64,
    request_id: String,
    installing: bool,
    active: Option<CancellationToken>,
    downloaded: Option<DownloadedUpdate>,
}

pub struct UpdateDownloadState {
    inner: Mutex<UpdateDownloadInner>,
}

impl Default for UpdateDownloadState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(UpdateDownloadInner {
                generation: 0,
                request_id: String::new(),
                installing: false,
                active: None,
                downloaded: None,
            }),
        }
    }
}

impl UpdateDownloadState {
    fn begin(&self, request_id: String) -> Result<(u64, CancellationToken), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Update download state is unavailable".to_string())?;
        if inner.active.is_some() || inner.downloaded.is_some() || inner.installing {
            return Err("An update download is already in progress".to_string());
        }

        inner.generation = inner.generation.wrapping_add(1);
        inner.request_id = request_id;
        inner.downloaded = None;
        let token = CancellationToken::new();
        inner.active = Some(token.clone());
        Ok((inner.generation, token))
    }

    fn finish(&self, generation: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.generation == generation {
                inner.active = None;
            }
        }
    }

    fn store(&self, generation: u64, update: Update, bytes: Vec<u8>) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        if inner.generation != generation || inner.active.is_none() {
            return false;
        }

        inner.active = None;
        inner.downloaded = Some(DownloadedUpdate { update, bytes });
        true
    }

    fn cancel(&self, request_id: &str) -> Result<bool, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Update download state is unavailable".to_string())?;
        if inner.request_id != request_id || inner.installing {
            return Ok(false);
        }
        inner.generation = inner.generation.wrapping_add(1);
        inner.downloaded = None;
        if let Some(token) = inner.active.take() {
            token.cancel();
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn take_downloaded(&self, request_id: &str) -> Result<DownloadedUpdate, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Update download state is unavailable".to_string())?;
        if inner.request_id != request_id || inner.installing {
            return Err("Update operation is no longer current".to_string());
        }
        let downloaded = inner
            .downloaded
            .take()
            .ok_or_else(|| "No verified update is ready to install".to_string())?;
        inner.installing = true;
        Ok(downloaded)
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum UpdateDownloadEvent {
    Started {
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
    },
    Progress {
        #[serde(rename = "chunkLength")]
        chunk_length: usize,
    },
    Finished,
}

#[tauri::command]
pub async fn download_app_update<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, UpdateDownloadState>,
    on_event: Channel<UpdateDownloadEvent>,
    request_id: String,
) -> Result<(), String> {
    let (generation, token) = state.begin(request_id.clone())?;

    let result = async {
        let updater = app
            .updater()
            .map_err(|error| format!("Failed to initialize updater: {error}"))?;
        let update = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(DOWNLOAD_CANCELLED.to_string()),
            result = updater.check() => result
                .map_err(|error| format!("Failed to check for updates: {error}"))?,
        }
        .ok_or_else(|| "Update no longer available".to_string())?;

        let events = on_event.clone();
        let download_token = token.clone();
        let mut first_chunk = true;
        let bytes = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(DOWNLOAD_CANCELLED.to_string()),
            result = update.download(
                move |chunk_length, content_length| {
                    if first_chunk {
                        first_chunk = false;
                        if events
                            .send(UpdateDownloadEvent::Started { content_length })
                            .is_err()
                        {
                            download_token.cancel();
                            return;
                        }
                    }
                    if events
                        .send(UpdateDownloadEvent::Progress { chunk_length })
                        .is_err()
                    {
                        download_token.cancel();
                    }
                },
                || {},
            ) => result.map_err(|error| format!("Failed to download update: {error}"))?,
        };

        if token.is_cancelled() || !state.store(generation, update, bytes) {
            return Err(DOWNLOAD_CANCELLED.to_string());
        }
        if on_event.send(UpdateDownloadEvent::Finished).is_err() {
            state.cancel(&request_id)?;
            return Err(DOWNLOAD_CANCELLED.to_string());
        }
        Ok(())
    }
    .await;

    if result.is_err() {
        state.finish(generation);
    }
    result
}

#[tauri::command]
pub fn cancel_app_update_download(state: State<'_, UpdateDownloadState>, request_id: String) -> Result<bool, String> {
    state.cancel(&request_id)
}

#[tauri::command]
pub fn install_downloaded_app_update(state: State<'_, UpdateDownloadState>, request_id: String) -> Result<(), String> {
    let downloaded = state.take_downloaded(&request_id)?;
    let result = downloaded
        .update
        .install(downloaded.bytes)
        .map_err(|error| format!("Failed to install update: {error}"));
    if let Ok(mut inner) = state.inner.lock() {
        inner.installing = false;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_invalidates_active_download() {
        let state = UpdateDownloadState::default();
        let (generation, token) = state.begin("first".into()).unwrap();

        assert!(state.cancel("first").unwrap());
        assert!(token.is_cancelled());
        state.finish(generation);

        assert!(state.begin("second".into()).is_ok());
    }

    #[test]
    fn stale_completion_does_not_clear_new_download() {
        let state = UpdateDownloadState::default();
        let (old_generation, _) = state.begin("first".into()).unwrap();
        state.cancel("first").unwrap();
        let (_, token) = state.begin("second".into()).unwrap();

        state.finish(old_generation);

        assert!(!state.cancel("first").unwrap());
        assert!(!token.is_cancelled());
        assert!(state.begin("third".into()).is_err());
        assert!(state.cancel("second").unwrap());
    }

    #[test]
    fn installation_cannot_be_cancelled_or_replaced() {
        let state = UpdateDownloadState::default();
        {
            let mut inner = state.inner.lock().unwrap();
            inner.request_id = "install".into();
            inner.installing = true;
        }
        assert!(!state.cancel("install").unwrap());
        assert!(state.begin("replacement".into()).is_err());
        assert!(state.take_downloaded("install").is_err());
        assert!(state.inner.lock().unwrap().installing);
    }
}

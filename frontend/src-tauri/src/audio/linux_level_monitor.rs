//! Preview capture has a session-scoped stop token. Old meter tasks cannot be
//! resurrected by a later Start, and libpulse is destroyed on its creating thread.
use super::*;
use crate::audio::capture::pulse_linux;
use crate::audio::devices::{list_audio_devices, DeviceType};
use crate::audio::capture_worker::NativeCleanup;
use tokio::sync::{Mutex as AsyncMutex, oneshot};

static OWNER: AsyncMutex<Option<Meters>> = AsyncMutex::const_new(None);
static CLEANUP: once_cell::sync::Lazy<NativeCleanup> =
    once_cell::sync::Lazy::new(NativeCleanup::default);

struct Meters {
    stop: Arc<AtomicBool>,
    threads: Vec<thread::JoinHandle<()>>,
}

impl Meters {
    fn close(&mut self) -> Result<()> {
        self.stop.store(true, Ordering::Release);
        let threads = std::mem::take(&mut self.threads);
        if threads.is_empty() { return Ok(()); }
        CLEANUP.run(move || {
            let mut result = Ok(());
            for thread in threads {
                if thread.join().is_err() { result = Err("Linux meter worker panicked".to_string()); }
            }
            result
        }, Duration::from_secs(3)).map_err(anyhow::Error::msg)
    }
}
impl Drop for Meters {
    fn drop(&mut self) { let _ = self.close(); }
}

pub(super) async fn stop() -> Result<()> {
    let mut owner = OWNER.lock().await;
    IS_MONITORING.store(false, Ordering::Release);
    if let Some(mut old) = owner.take() { old.close()?; }
    Ok(())
}

pub(super) async fn start<R: Runtime>(app: AppHandle<R>, names: Vec<String>) -> Result<()> {
    start_session(names, move |update| app.emit("audio-levels", update).is_ok()).await
}

async fn start_session(
    names: Vec<String>,
    emit: impl Fn(AudioLevelUpdate) -> bool + Send + 'static,
) -> Result<()> {
    let mut owner = OWNER.lock().await;
    IS_MONITORING.store(false, Ordering::Release);
    if let Some(mut old) = owner.take() { old.close()?; }
    anyhow::ensure!(!CLEANUP.is_pending(), "Previous Linux meter cleanup is still running");
    let devices = list_audio_devices().await?;
    let chosen = select_devices(&names, &devices)?;
    anyhow::ensure!(!chosen.is_empty(), "No audio devices available to monitor");
    let levels: LevelMap = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let mut meters = Meters { stop: Arc::new(AtomicBool::new(false)), threads: Vec::new() };
    for device in chosen {
        let stop = meters.stop.clone();
        let levels = levels.clone();
        let (ready, wait) = oneshot::channel();
        meters.threads.push(thread::Builder::new().name("linux-meter".into()).spawn(move || {
            let mut ready = Some(ready);
            let result = (|| -> Result<()> {
                let system = device.device_type == DeviceType::Output;
                let role = if system { "output" } else { "input" };
                let mut previous_id = None;
                while !stop.load(Ordering::Acquire) {
                    let id = if device.follow_default {
                        if system { pulse_linux::default_sink_name()? } else { pulse_linux::default_source_name()? }
                            .ok_or_else(|| anyhow!("No default audio meter device"))?
                    } else { device.name.clone() };
                    let mut native = if system {
                        pulse_linux::PulseCapture::new_system(&pulse_linux::find_sink_by_name(&id)?.monitor_source_name)?
                    } else {
                        pulse_linux::PulseCapture::new_microphone(&pulse_linux::find_source_by_name(&id)?.source_name)?
                    }.with_controls(stop.clone(), Arc::new(AtomicBool::new(false)));
                    if device.follow_default { native = native.follow_default(system, id.clone()); }
                    // Remove only this meter's previous route, not another
                    // explicitly selected endpoint of the same role.
                    if let Some(previous) = previous_id.replace(id.clone()) {
                        levels.lock().unwrap_or_else(|e| e.into_inner())
                            .remove(&format!("{previous} ({role})"));
                    }
                    let result = native.run_ready(|data| {
                        push_levels(data, if system { 2 } else { 1 }, &id, role, &levels);
                    }, || {
                        if let Some(ready) = ready.take() { let _ = ready.send(Ok(())); }
                    });
                    if result.as_ref().err().is_some_and(|e| e.is::<pulse_linux::DefaultRouteChanged>()) { continue; }
                    return result;
                }
                Ok(())
            })();
            if let Err(error) = result {
                if let Some(ready) = ready.take() { let _ = ready.send(Err(error.to_string())); }
                log::warn!("Linux meter stopped: {}", error);
            }
            stop.store(true, Ordering::Release);
        })?);
        tokio::time::timeout(Duration::from_secs(15), wait).await
            .map_err(|_| anyhow!("Linux meter startup timed out"))?
            .map_err(|_| anyhow!("Linux meter startup worker exited"))?
            .map_err(anyhow::Error::msg)?;
    }
    let stopped = meters.stop.clone();
    *owner = Some(meters);
    IS_MONITORING.store(true, Ordering::Release);
    tokio::spawn(async move {
        while !stopped.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(80)).await;
            // Serialize emission with Stop/replacement, so a stale tick can't
            // be delivered after Stop completes or a new session starts.
            let _owner = OWNER.lock().await;
            if stopped.load(Ordering::Acquire) { break; }
            let update = AudioLevelUpdate {
                timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default().as_millis() as u64,
                levels: levels.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect(),
            };
            if !emit(update) { stopped.store(true, Ordering::Release); }
        }
        // Only this session may clear the shared status. A replacement may have
        // acquired ownership while this emitter was sleeping.
        let owner = OWNER.lock().await;
        if owner.as_ref().is_some_and(|m| Arc::ptr_eq(&m.stop, &stopped)) {
            IS_MONITORING.store(false, Ordering::Release);
        }
    });
    Ok(())
}

fn select_devices(names: &[String], devices: &[crate::audio::devices::AudioDevice])
    -> Result<Vec<crate::audio::devices::AudioDevice>>
{
    if names.is_empty() {
        return Ok(devices.iter().filter(|d| d.is_default).cloned().map(|d| d.following_default()).collect());
    }
    names.iter().map(|name| {
        if name == "default (input)" || name == "default (output)" {
            let role = if name == "default (input)" { DeviceType::Input } else { DeviceType::Output };
            return devices.iter().find(|d| d.device_type == role && d.is_default).cloned()
                .map(|d| d.following_default()).ok_or_else(|| anyhow!("No default audio meter device"));
        }
        // Persisted role-qualified values take precedence over a raw ID which
        // happens to contain the same suffix, matching recording Start.
        if let Some(device) = devices.iter().find(|d| d.to_string() == *name) {
            return Ok(device.clone());
        }
        let matches = devices.iter().filter(|d| d.name == *name).collect::<Vec<_>>();
        match matches.as_slice() {
            [device] => Ok((*device).clone()),
            _ => Err(anyhow!("Audio meter device is missing or ambiguous: {}", name)),
        }
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::devices::AudioDevice;
    #[test]
    fn meter_selection_requires_exact_role_and_retains_default_intent() {
        let devices = vec![
            AudioDevice::new("shared".into(), DeviceType::Input).with_default(true),
            AudioDevice::new("shared".into(), DeviceType::Output).with_default(true),
        ];
        assert!(select_devices(&["shared".into()], &devices).is_err());
        let selected = select_devices(&["shared (output)".into()], &devices).unwrap();
        assert_eq!(selected[0].device_type, DeviceType::Output);
        assert!(!selected[0].follow_default);
        let defaults = select_devices(&["default (input)".into()], &devices).unwrap();
        assert_eq!(defaults[0].device_type, DeviceType::Input);
        assert!(defaults[0].follow_default);
        assert!(select_devices(&["missing (input)".into()], &devices).is_err());
        let suffix_ids = vec![
            AudioDevice::new("a (output)".into(), DeviceType::Output),
            AudioDevice::new("a".into(), DeviceType::Output),
        ];
        assert_eq!(select_devices(&["a (output)".into()], &suffix_ids).unwrap()[0].name, "a");
        assert_eq!(select_devices(&["a (output) (output)".into()], &suffix_ids).unwrap()[0].name, "a (output)");
    }

    #[tokio::test]
    #[ignore = "Run test-linux-audio.sh: requires an isolated Pulse server"]
    async fn isolated_linux_lifecycle_restarts_preview_and_follows_default() {
        assert_eq!(std::env::var("MEETILY_TEST_PULSE_ISOLATED").as_deref(), Ok("1"));
        fn pactl(args: &[&str]) {
            let output = std::process::Command::new("pactl").args(args).output().unwrap();
            assert!(output.status.success(), "{:?}: {}", args, String::from_utf8_lossy(&output.stderr));
        }
        async fn expect_level(rx: &mut tokio::sync::mpsc::UnboundedReceiver<AudioLevelUpdate>, id: &str) {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let update = rx.recv().await.unwrap();
                    if update.levels.iter().any(|level| level.device_name == id && level.rms_level > 0.01) {
                        assert!(update.levels.iter().all(|level| level.device_name == id));
                        break;
                    }
                }
            }).await.expect("nonzero preview level");
        }
        // The private server is disposable. All modules go away with it.
        pactl(&["load-module", "module-null-sink", "sink_name=meetily_preview_a"]);
        pactl(&["load-module", "module-null-sink", "sink_name=meetily_preview_b"]);
        pactl(&["set-default-sink", "meetily_preview_a"]);
        pactl(&["load-module", "module-sine", "sink=meetily_preview_a"]);
        let (tx, mut old) = tokio::sync::mpsc::unbounded_channel();
        start_session(vec!["default (output)".into()], move |update| tx.send(update).is_ok()).await.unwrap();
        expect_level(&mut old, "meetily_preview_a").await;
        pactl(&["set-default-sink", "meetily_preview_b"]);
        pactl(&["load-module", "module-sine", "sink=meetily_preview_b"]);
        expect_level(&mut old, "meetily_preview_b").await;
        stop().await.unwrap();

        // Restart immediately before the former emitter's next 80 ms tick.
        let (tx, mut next) = tokio::sync::mpsc::unbounded_channel();
        start_session(vec!["meetily_preview_b (output)".into()], move |update| tx.send(update).is_ok()).await.unwrap();
        while old.try_recv().is_ok() {}
        assert!(tokio::time::timeout(Duration::from_secs(2), old.recv()).await.unwrap().is_none());
        expect_level(&mut next, "meetily_preview_b").await;
        assert!(IS_MONITORING.load(Ordering::Acquire));
        stop().await.unwrap();
        assert!(!IS_MONITORING.load(Ordering::Acquire));
        assert!(!CLEANUP.is_pending());
    }
}

//! Lightweight pre-recording level meters (mic + system/loopback).
//! Used by onboarding audio test and DeviceSelection meters.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat};
use log::{error, info, warn};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Debug, Serialize, Clone)]
pub struct AudioLevelData {
    pub device_name: String,
    pub device_type: String, // "input" | "output"
    pub rms_level: f32,
    pub peak_level: f32,
    pub is_active: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct AudioLevelUpdate {
    pub timestamp: u64,
    pub levels: Vec<AudioLevelData>,
}

static IS_MONITORING: AtomicBool = AtomicBool::new(false);

/// Latest levels keyed by device name (shared with cpal callbacks).
type LevelMap = Arc<Mutex<std::collections::HashMap<String, AudioLevelData>>>;

/// Start real level monitoring for the given device names.
/// Empty list → default mic (input) + default output (system loopback on WASAPI).
pub async fn start_monitoring<R: Runtime>(
    app_handle: AppHandle<R>,
    mut device_names: Vec<String>,
) -> Result<()> {
    stop_monitoring().await?;
    tokio::time::sleep(Duration::from_millis(80)).await;

    if device_names.is_empty() {
        device_names = default_monitor_devices();
    }
    if device_names.is_empty() {
        return Err(anyhow!("No audio devices available to monitor"));
    }

    info!("Starting real audio level monitoring for: {:?}", device_names);
    IS_MONITORING.store(true, Ordering::SeqCst);

    let levels: LevelMap = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let levels_for_emit = levels.clone();
    let running = Arc::new(AtomicBool::new(true));
    let running_flag = running.clone();

    // Build streams on a dedicated thread (cpal streams are !Send on some hosts).
    let names = device_names.clone();
    let stream_thread = thread::Builder::new()
        .name("af-level-monitor".into())
        .spawn(move || {
            let mut _streams: Vec<cpal::Stream> = Vec::new();

            for name in &names {
                match open_level_stream(name, levels.clone()) {
                    Ok(stream) => {
                        if let Err(e) = stream.play() {
                            warn!("Failed to play level stream for '{}': {}", name, e);
                        } else {
                            info!("Level stream playing: {}", name);
                            _streams.push(stream);
                        }
                    }
                    Err(e) => warn!("Could not open level stream for '{}': {}", name, e),
                }
            }

            if _streams.is_empty() {
                error!("No level streams started");
                running_flag.store(false, Ordering::SeqCst);
                IS_MONITORING.store(false, Ordering::SeqCst);
                return;
            }

            while IS_MONITORING.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(50));
            }

            for s in _streams {
                let _ = s.pause();
                drop(s);
            }
            running_flag.store(false, Ordering::SeqCst);
            info!("Level monitor streams stopped");
        })
        .map_err(|e| anyhow!("Failed to spawn level monitor thread: {}", e))?;

    // Detach stream thread lifetime from the emit loop (join would block the runtime).
    std::mem::forget(stream_thread);

    // Emit aggregated levels to the UI ~12 Hz
    let app = app_handle.clone();
    tokio::spawn(async move {
        while IS_MONITORING.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(80)).await;
            let snapshot: Vec<AudioLevelData> = {
                let guard = levels_for_emit.lock().unwrap_or_else(|e| e.into_inner());
                guard.values().cloned().collect()
            };
            if snapshot.is_empty() {
                continue;
            }
            let update = AudioLevelUpdate {
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                levels: snapshot,
            };
            if let Err(e) = app.emit("audio-levels", &update) {
                error!("Failed to emit audio-levels: {}", e);
                break;
            }
        }
        IS_MONITORING.store(false, Ordering::SeqCst);
        info!("Level monitor emit loop ended");
    });

    Ok(())
}

pub async fn stop_monitoring() -> Result<()> {
    info!("Stopping audio level monitoring");
    IS_MONITORING.store(false, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(60)).await;
    Ok(())
}

pub fn is_monitoring() -> bool {
    IS_MONITORING.load(Ordering::SeqCst)
}

fn default_monitor_devices() -> Vec<String> {
    let mut out = Vec::new();

    #[cfg(target_os = "windows")]
    let host = cpal::host_from_id(cpal::HostId::Wasapi).unwrap_or_else(|_| cpal::default_host());
    #[cfg(not(target_os = "windows"))]
    let host = cpal::default_host();

    if let Some(d) = host.default_input_device() {
        if let Ok(n) = d.name() {
            out.push(n);
        }
    }
    if let Some(d) = host.default_output_device() {
        if let Ok(n) = d.name() {
            if !out.contains(&n) {
                out.push(n);
            }
        }
    }
    out
}

/// Open a cpal input stream for levels. Tries mic input first, then WASAPI loopback on output.
fn open_level_stream(device_name: &str, levels: LevelMap) -> Result<cpal::Stream> {
    #[cfg(target_os = "windows")]
    let host = cpal::host_from_id(cpal::HostId::Wasapi).unwrap_or_else(|_| cpal::default_host());
    #[cfg(not(target_os = "windows"))]
    let host = cpal::default_host();

    // 1) Input (microphone)
    if let Ok(devices) = host.input_devices() {
        for device in devices {
            if let Ok(name) = device.name() {
                if name == device_name || name.contains(device_name) || device_name.contains(&name)
                {
                    if let Ok(cfg) = device.default_input_config() {
                        return build_input_level_stream(
                            &device,
                            cfg,
                            device_name.to_string(),
                            "input",
                            levels,
                        );
                    }
                }
            }
        }
    }

    // 2) Output device via WASAPI loopback (system audio) — build_input_stream on output device
    if let Ok(devices) = host.output_devices() {
        for device in devices {
            if let Ok(name) = device.name() {
                if name == device_name || name.contains(device_name) || device_name.contains(&name)
                {
                    // Prefer an input config if the host exposes loopback that way
                    if let Ok(cfg) = device.default_input_config() {
                        return build_input_level_stream(
                            &device,
                            cfg,
                            device_name.to_string(),
                            "output",
                            levels,
                        );
                    }
                    // Fallback: use output config shape with input stream (WASAPI loopback)
                    if let Ok(cfg) = device.default_output_config() {
                        return build_input_level_stream(
                            &device,
                            cfg,
                            device_name.to_string(),
                            "output",
                            levels,
                        );
                    }
                }
            }
        }
    }

    Err(anyhow!("Device not found for level monitor: {}", device_name))
}

fn build_input_level_stream(
    device: &cpal::Device,
    config: cpal::SupportedStreamConfig,
    device_name: String,
    device_type: &'static str,
    levels: LevelMap,
) -> Result<cpal::Stream> {
    let channels = config.channels();
    let sample_format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();
    let err_fn = |e| error!("Level stream error: {}", e);

    let stream = match sample_format {
        SampleFormat::F32 => {
            let levels = levels.clone();
            let name = device_name.clone();
            let dtype = device_type.to_string();
            device.build_input_stream(
                &stream_config,
                move |data: &[f32], _| {
                    push_levels(data, channels, &name, &dtype, &levels);
                },
                err_fn,
                None,
            )?
        }
        SampleFormat::I16 => {
            let levels = levels.clone();
            let name = device_name.clone();
            let dtype = device_type.to_string();
            device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    let f: Vec<f32> = data.iter().map(|&s| s.to_sample::<f32>()).collect();
                    push_levels(&f, channels, &name, &dtype, &levels);
                },
                err_fn,
                None,
            )?
        }
        SampleFormat::U16 => {
            let levels = levels.clone();
            let name = device_name.clone();
            let dtype = device_type.to_string();
            device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    let f: Vec<f32> = data.iter().map(|&s| s.to_sample::<f32>()).collect();
                    push_levels(&f, channels, &name, &dtype, &levels);
                },
                err_fn,
                None,
            )?
        }
        SampleFormat::I32 => {
            let levels = levels.clone();
            let name = device_name.clone();
            let dtype = device_type.to_string();
            device.build_input_stream(
                &stream_config,
                move |data: &[i32], _| {
                    let f: Vec<f32> = data.iter().map(|&s| s.to_sample::<f32>()).collect();
                    push_levels(&f, channels, &name, &dtype, &levels);
                },
                err_fn,
                None,
            )?
        }
        other => return Err(anyhow!("Unsupported sample format: {:?}", other)),
    };

    Ok(stream)
}

fn push_levels(
    data: &[f32],
    channels: u16,
    device_name: &str,
    device_type: &str,
    levels: &LevelMap,
) {
    if data.is_empty() {
        return;
    }

    let mono: Vec<f32> = if channels > 1 {
        let ch = channels as usize;
        let frames = data.len() / ch;
        let mut m = Vec::with_capacity(frames);
        for i in 0..frames {
            let mut s = 0.0f32;
            for c in 0..ch {
                s += data[i * ch + c];
            }
            m.push(s / ch as f32);
        }
        m
    } else {
        data.to_vec()
    };

    let rms = if mono.is_empty() {
        0.0
    } else {
        (mono.iter().map(|x| x * x).sum::<f32>() / mono.len() as f32).sqrt()
    };
    let peak = mono.iter().map(|x| x.abs()).fold(0.0f32, f32::max);

    if let Ok(mut map) = levels.try_lock() {
        map.insert(
            device_name.to_string(),
            AudioLevelData {
                device_name: device_name.to_string(),
                device_type: device_type.to_string(),
                rms_level: rms.min(1.0),
                peak_level: peak.min(1.0),
                is_active: rms > 0.001,
            },
        );
    }
}

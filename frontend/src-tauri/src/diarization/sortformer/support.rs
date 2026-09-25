//! App integration and Slaney filterbank helpers adapted from parakeet-rs.
//! See LICENSE and README.md in this directory.
use ndarray::{Array2, Array3, Ix3};
use ort::{session::Session, value::DynValue};

pub type Result<T> = anyhow::Result<T>;
pub struct Error;
#[allow(non_snake_case)]
impl Error {
    pub fn Config(message: String) -> anyhow::Error { anyhow::anyhow!(message) }
    pub fn Audio(message: String) -> anyhow::Error { anyhow::anyhow!(message) }
}

#[derive(Default)]
pub struct ModelConfig;
impl ModelConfig {
    pub fn build_session(&self, path: &std::path::Path) -> Result<Session> {
        crate::onnx_runtime::ensure_available()?;
        #[cfg(windows)]
        {
            #[cfg(test)]
            let force_cpu = std::env::var("MEETILY_NEMOTRON_TEST_CPU").as_deref() == Ok("1");
            #[cfg(not(test))]
            let force_cpu = false;
            #[cfg(test)]
            let device = std::env::var("MEETILY_NEMOTRON_TEST_DEVICE").ok()
                .and_then(|v| v.parse().ok()).unwrap_or(0);
            #[cfg(not(test))]
            let device = 0;
            if !force_cpu {
                match directml_session(path, device) {
                    Ok(session) => {
                        log::info!("Nemotron: DirectML session initialized on adapter 0");
                        return Ok(session);
                    }
                    Err(error) => log::warn!("Nemotron: DirectML unavailable, using CPU: {error}"),
                }
            }
        }
        log::info!("Nemotron: CPU execution provider");
        let builder = Session::builder()?.with_intra_threads(4)?;
        #[cfg(test)]
        let builder = if let Ok(profile) = std::env::var("MEETILY_NEMOTRON_PROFILE") {
            builder.with_profiling(profile)?
        } else { builder };
        Ok(builder.commit_from_file(path)?)
    }
}

#[cfg(windows)]
fn directml_session(path: &std::path::Path, device: i32) -> Result<Session> {
    use ort::execution_providers::DirectMLExecutionProvider;
    // DirectML requires sequential execution and disabled memory patterns.
    let builder = Session::builder()?.with_parallel_execution(false)?
        .with_memory_pattern(false)?
        .with_execution_providers([DirectMLExecutionProvider::default()
            .with_device_id(device).build().error_on_failure()])?;
    #[cfg(test)]
    let builder = if let Ok(profile) = std::env::var("MEETILY_NEMOTRON_PROFILE") {
        builder.with_profiling(profile)?
    } else { builder };
    Ok(builder.commit_from_file(path)?)
}

pub fn extract_3d_f32(value: &DynValue, name: &str) -> Result<Array3<f32>> {
    let array = value.try_extract_array::<f32>()?.into_dimensionality::<Ix3>()?;
    anyhow::ensure!(array.iter().all(|v| v.is_finite()), "Non-finite {name}");
    Ok(array.to_owned())
}

pub fn apply_preemphasis(audio: &[f32], factor: f32) -> Vec<f32> {
    let Some(first) = audio.first() else { return Vec::new(); };
    let mut result = Vec::with_capacity(audio.len());
    result.push(*first);
    result.extend(audio.windows(2).map(|w| w[1] - factor * w[0]));
    result
}

pub fn create_mel_filterbank(n_fft: usize, n_mels: usize, sample_rate: usize) -> Array2<f32> {
    const F_SP: f64 = 200.0 / 3.0;
    const LOG_STEP: f64 = 0.06875177742094912;
    let hz_to_mel = |hz: f64| if hz < 1000.0 { hz / F_SP } else { 15.0 + (hz / 1000.0).ln() / LOG_STEP };
    let mel_to_hz = |mel: f64| if mel < 15.0 { mel * F_SP } else { 1000.0 * ((mel - 15.0) * LOG_STEP).exp() };
    let max_mel = hz_to_mel(sample_rate as f64 / 2.0);
    let points: Vec<_> = (0..n_mels + 2).map(|i| mel_to_hz(max_mel * i as f64 / (n_mels + 1) as f64)).collect();
    let mut bank = Array2::zeros((n_mels, n_fft / 2 + 1));
    for m in 0..n_mels {
        let norm = (2.0 / (points[m + 2] - points[m])) as f32;
        for k in 0..bank.ncols() {
            let hz = k as f64 * sample_rate as f64 / n_fft as f64;
            let lower = (hz - points[m]) / (points[m + 1] - points[m]);
            let upper = (points[m + 2] - hz) / (points[m + 2] - points[m + 1]);
            bank[[m, k]] = lower.min(upper).max(0.0) as f32 * norm;
        }
    }
    bank
}

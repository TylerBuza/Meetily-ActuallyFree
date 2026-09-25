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
        // Use the same verified CPU runtime as VAD/Parakeet. GPU providers need
        // separate qualification rather than silent provider fallback.
        Ok(Session::builder()?.with_intra_threads(4)?.commit_from_file(path)?)
    }
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

//! ONNX model runners for diarization: pyannote segmentation-3.0 (powerset)
//! and the WeSpeaker ResNet34 embedding extractor, plus the VBx-style
//! x-vector LDA transform loaded from `xvec_transform.npz`.

use anyhow::{anyhow, Result};
use ndarray::Array3;
use ort::execution_providers::CPUExecutionProvider;
use ort::inputs;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::TensorRef;
use std::io::Read;
use std::path::Path;

use super::dsp::{self, NUM_MEL_BINS};

/// pyannote segmentation-3.0 powerset class → active local speaker indices.
/// 3 speakers, max 2 simultaneous → 7 classes.
const POWERSET: [&[usize]; 7] = [
    &[],     // 0: silence
    &[0],    // 1
    &[1],    // 2
    &[2],    // 3
    &[0, 1], // 4
    &[0, 2], // 5
    &[1, 2], // 6
];
pub const MAX_LOCAL_SPEAKERS: usize = 3;

pub struct DiarizationModels {
    segmentation: Session,
    embedding: Session,
    // x-vector transform (VBx front-end): out = normalize(lda^T (emb - mean1) - mean2)
    mean1: Vec<f32>, // (256,)
    lda: Vec<f32>,   // (256*128,) row-major
    mean2: Vec<f32>, // (128,)
    lda_in: usize,   // 256
    lda_out: usize,  // 128
}

impl DiarizationModels {
    pub fn load(model_dir: &Path) -> Result<Self> {
        let seg_path = model_dir.join("segmentation-3.0-fp16.onnx");
        let emb_path = model_dir.join("wespeaker-resnet34-LM.onnx");
        let xform_path = model_dir.join("xvec_transform.npz");

        for p in [&seg_path, &emb_path, &xform_path] {
            if !p.exists() {
                return Err(anyhow!("Missing diarization model file: {}", p.display()));
            }
        }

        let build = |path: &Path| -> Result<Session> {
            Ok(Session::builder()?
                .with_optimization_level(GraphOptimizationLevel::Level3)?
                .with_execution_providers(vec![CPUExecutionProvider::default().build()])?
                .commit_from_file(path)?)
        };

        let segmentation = build(&seg_path)?;
        let embedding = build(&emb_path)?;

        let (mean1, _s1) = read_npz_array(&xform_path, "mean1")?;
        let (lda, s_lda) = read_npz_array(&xform_path, "lda")?;
        let (mean2, _s2) = read_npz_array(&xform_path, "mean2")?;

        if s_lda.len() != 2 {
            return Err(anyhow!("Unexpected lda shape: {:?}", s_lda));
        }
        let lda_in = s_lda[0];
        let lda_out = s_lda[1];

        log::info!(
            "🧑‍🤝‍🧑 Diarization models loaded (lda {}x{}, mean1 {}, mean2 {})",
            lda_in,
            lda_out,
            mean1.len(),
            mean2.len()
        );

        Ok(Self {
            segmentation,
            embedding,
            mean1,
            lda,
            mean2,
            lda_in,
            lda_out,
        })
    }

    /// Run segmentation on a single window (16 kHz mono). Returns per-frame
    /// local-speaker activity `[frames][MAX_LOCAL_SPEAKERS]`.
    pub fn segment_window(&mut self, window: &[f32]) -> Result<Vec<[bool; MAX_LOCAL_SPEAKERS]>> {
        let n = window.len();
        let arr = Array3::<f32>::from_shape_vec((1, 1, n), window.to_vec())?;
        let outputs = self
            .segmentation
            .run(inputs!["waveform" => TensorRef::from_array_view(arr.view())?])?;
        let seg = outputs
            .get("segmentation")
            .ok_or_else(|| anyhow!("segmentation output missing"))?
            .try_extract_array::<f32>()?;

        // Shape [1, frames, 7].
        let shape = seg.shape().to_vec();
        if shape.len() != 3 || shape[2] != POWERSET.len() {
            return Err(anyhow!("Unexpected segmentation shape: {:?}", shape));
        }
        let frames = shape[1];
        let seg = seg.into_dimensionality::<ndarray::Ix3>()?;

        let mut out = Vec::with_capacity(frames);
        for f in 0..frames {
            // Argmax over the 7 powerset classes.
            let mut best = 0usize;
            let mut best_v = f32::NEG_INFINITY;
            for c in 0..POWERSET.len() {
                let v = seg[[0, f, c]];
                if v > best_v {
                    best_v = v;
                    best = c;
                }
            }
            let mut active = [false; MAX_LOCAL_SPEAKERS];
            for &s in POWERSET[best] {
                if s < MAX_LOCAL_SPEAKERS {
                    active[s] = true;
                }
            }
            out.push(active);
        }
        Ok(out)
    }

    /// Extract a length-normalized 128-d x-vector for a 16 kHz mono segment.
    pub fn embed(&mut self, segment: &[f32]) -> Result<Vec<f32>> {
        let feats = dsp::compute_fbank(segment);
        if feats.is_empty() {
            return Err(anyhow!("segment too short for fbank"));
        }
        let t = feats.len();
        let mut flat = Vec::with_capacity(t * NUM_MEL_BINS);
        for row in &feats {
            flat.extend_from_slice(row);
        }
        let arr = Array3::<f32>::from_shape_vec((1, t, NUM_MEL_BINS), flat)?;

        // Scope the session borrow so `outputs` is dropped before we call
        // `transform_xvector` (which needs an immutable borrow of `self`).
        let emb: Vec<f32> = {
            let outputs = self
                .embedding
                .run(inputs!["fbank" => TensorRef::from_array_view(arr.view())?])?;
            let emb = outputs
                .get("embedding")
                .ok_or_else(|| anyhow!("embedding output missing"))?
                .try_extract_array::<f32>()?;
            emb.iter().copied().collect()
        };

        Ok(self.transform_xvector(&emb))
    }

    /// Apply the VBx x-vector transform + length normalization.
    fn transform_xvector(&self, emb: &[f32]) -> Vec<f32> {
        let din = self.lda_in.min(emb.len());
        // centered = emb - mean1
        let mut centered = vec![0f32; self.lda_in];
        for i in 0..din {
            let m = self.mean1.get(i).copied().unwrap_or(0.0);
            centered[i] = emb[i] - m;
        }
        // out[j] = sum_i centered[i] * lda[i][j]
        let mut out = vec![0f32; self.lda_out];
        for i in 0..self.lda_in {
            let ci = centered[i];
            if ci == 0.0 {
                continue;
            }
            let base = i * self.lda_out;
            for j in 0..self.lda_out {
                out[j] += ci * self.lda[base + j];
            }
        }
        // out -= mean2
        for j in 0..self.lda_out {
            out[j] -= self.mean2.get(j).copied().unwrap_or(0.0);
        }
        // length-normalize
        let norm = out.iter().map(|v| v * v).sum::<f32>().sqrt();
        if norm > 1e-8 {
            for v in out.iter_mut() {
                *v /= norm;
            }
        }
        out
    }
}

/// Read one array from an `.npz` (zip of `.npy`) as `f32`, returning (data, shape).
fn read_npz_array(npz_path: &Path, name: &str) -> Result<(Vec<f32>, Vec<usize>)> {
    let file = std::fs::File::open(npz_path)?;
    let mut zip = zip::ZipArchive::new(file)?;
    let entry_name = format!("{}.npy", name);

    let mut buf = Vec::new();
    {
        let mut entry = zip
            .by_name(&entry_name)
            .map_err(|_| anyhow!("{} not found in {}", entry_name, npz_path.display()))?;
        entry.read_to_end(&mut buf)?;
    }
    parse_npy(&buf)
}

/// Minimal `.npy` v1/v2 parser → f32 data + shape. Supports `<f4` and `<f8`,
/// C-contiguous (fortran_order == False).
fn parse_npy(bytes: &[u8]) -> Result<(Vec<f32>, Vec<usize>)> {
    if bytes.len() < 10 || &bytes[0..6] != b"\x93NUMPY" {
        return Err(anyhow!("Not a .npy file"));
    }
    let major = bytes[6];
    let (header_len, header_start) = if major >= 2 {
        let hl = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
        (hl, 12usize)
    } else {
        let hl = u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
        (hl, 10usize)
    };
    let header = std::str::from_utf8(&bytes[header_start..header_start + header_len])?;

    let descr = extract_between(header, "'descr':", ",")
        .or_else(|| extract_between(header, "'descr': ", ","))
        .ok_or_else(|| anyhow!("npy: no descr"))?;
    let descr = descr.trim().trim_matches('\'');
    let fortran = header.contains("'fortran_order': True");
    if fortran {
        return Err(anyhow!("npy: fortran_order not supported"));
    }

    // shape tuple
    let shape_str =
        extract_between(header, "'shape':", ")").ok_or_else(|| anyhow!("npy: no shape"))?;
    let shape: Vec<usize> = shape_str
        .trim()
        .trim_start_matches('(')
        .split(',')
        .filter_map(|s| s.trim().parse::<usize>().ok())
        .collect();

    let data_start = header_start + header_len;
    let raw = &bytes[data_start..];

    let data: Vec<f32> = match descr {
        d if d.ends_with("f4") => raw
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
        d if d.ends_with("f8") => raw
            .chunks_exact(8)
            .map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]) as f32)
            .collect(),
        other => return Err(anyhow!("npy: unsupported dtype {}", other)),
    };

    Ok((data, shape))
}

fn extract_between(s: &str, start: &str, end: &str) -> Option<String> {
    let i = s.find(start)? + start.len();
    let rest = &s[i..];
    let j = rest.find(end)?;
    Some(rest[..j].to_string())
}

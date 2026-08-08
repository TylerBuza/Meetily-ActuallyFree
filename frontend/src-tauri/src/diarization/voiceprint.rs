//! Persistent local-user voiceprint (WeSpeaker embedding).
//!
//! Updated from the dedicated mic track after each dual-track diarization pass.
//! Used offline to pin which cluster is "You" when only a mixed file is available.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const FILE_NAME: &str = "user_voiceprint.json";
/// Cosine similarity above which a cluster is considered the enrolled user.
pub const MATCH_THRESHOLD: f32 = 0.45;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserVoiceprint {
    /// Length-normalized 128-d (post-LDA) embedding.
    pub embedding: Vec<f32>,
    /// How many mic turns have been folded into the running mean.
    pub samples: u32,
    pub updated_at: String,
    /// Recording identities already folded into this profile.
    #[serde(default)]
    pub enrolled_sources: Vec<String>,
}

fn path() -> PathBuf {
    let dir = crate::paths::install_data_root().join("voiceprint");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(FILE_NAME)
}

pub fn load() -> Option<UserVoiceprint> {
    let p = path();
    let bytes = std::fs::read(&p).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn save(vp: &UserVoiceprint) -> Result<()> {
    let p = path();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(vp)?;
    let tmp = p.with_extension("json.tmp");
    let backup = p.with_extension("json.bak");
    std::fs::write(&tmp, json)?;
    if p.exists() {
        let _ = std::fs::remove_file(&backup);
        std::fs::rename(&p, &backup)?;
    }
    if let Err(error) = std::fs::rename(&tmp, &p) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, &p);
        }
        return Err(error.into());
    }
    let _ = std::fs::remove_file(backup);
    Ok(())
}

/// Fold a batch of mic embeddings into the running user voiceprint.
pub fn update_from_embeddings(embeddings: &[Vec<f32>], source: &str) -> Result<UserVoiceprint> {
    if embeddings.is_empty() {
        return Err(anyhow!("no embeddings to enroll"));
    }
    let dim = embeddings[0].len();
    let mut mean = vec![0f32; dim];
    let mut valid = 0usize;
    for e in embeddings {
        if e.len() != dim {
            continue;
        }
        for d in 0..dim {
            mean[d] += e[d];
        }
        valid += 1;
    }
    if valid == 0 {
        return Err(anyhow!("no consistent embeddings to enroll"));
    }
    let n = valid as f32;
    for d in 0..dim {
        mean[d] /= n;
    }
    l2_normalize(&mut mean);

    let vp = if let Some(existing) = load() {
        if existing.enrolled_sources.iter().any(|item| item == source) {
            return Ok(existing);
        }
        // Running mean weighted by prior sample count.
        let w_old = existing.samples as f32;
        let w_new = valid as f32;
        let mut merged = vec![0f32; dim];
        if existing.embedding.len() == dim {
            for d in 0..dim {
                merged[d] = (existing.embedding[d] * w_old + mean[d] * w_new) / (w_old + w_new);
            }
            l2_normalize(&mut merged);
            UserVoiceprint {
                embedding: merged,
                samples: existing.samples + valid as u32,
                updated_at: chrono::Utc::now().to_rfc3339(),
                enrolled_sources: existing
                    .enrolled_sources
                    .into_iter()
                    .chain(std::iter::once(source.to_string()))
                    .collect(),
            }
        } else {
            UserVoiceprint {
                embedding: mean,
                samples: valid as u32,
                updated_at: chrono::Utc::now().to_rfc3339(),
                enrolled_sources: vec![source.to_string()],
            }
        }
    } else {
        UserVoiceprint {
            embedding: mean,
            samples: valid as u32,
            updated_at: chrono::Utc::now().to_rfc3339(),
            enrolled_sources: vec![source.to_string()],
        }
    };

    save(&vp)?;
    log::info!(
        "🎙️ User voiceprint updated ({} samples total, dim {})",
        vp.samples,
        vp.embedding.len()
    );
    Ok(vp)
}

/// Which cluster centroid best matches the enrolled user, if any.
pub fn match_cluster(centroids: &[Vec<f32>]) -> Option<usize> {
    let vp = load()?;
    if vp.embedding.is_empty() || centroids.is_empty() {
        return None;
    }
    let mut best = 0usize;
    let mut best_sim = f32::NEG_INFINITY;
    for (i, c) in centroids.iter().enumerate() {
        let sim = cosine(&vp.embedding, c);
        if sim > best_sim {
            best_sim = sim;
            best = i;
        }
    }
    if best_sim >= MATCH_THRESHOLD {
        Some(best)
    } else {
        None
    }
}

fn l2_normalize(v: &mut [f32]) {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-8);
    for x in v.iter_mut() {
        *x /= n;
    }
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut s = 0f32;
    for i in 0..n {
        s += a[i] * b[i];
    }
    s
}

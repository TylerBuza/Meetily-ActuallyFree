//! Agglomerative hierarchical clustering (AHC) of speaker embeddings.
//!
//! Embeddings are length-normalized, so cosine distance = 1 - dot product.
//! Uses average linkage via the Lance-Williams update. Stops either at a fixed
//! number of speakers (when known) or when the closest pair exceeds a distance
//! threshold.

/// Cluster `embeddings` (each already length-normalized) into speaker labels.
///
/// * `num_speakers` – if `Some(k)`, force exactly `k` clusters (when possible).
/// * `threshold` – cosine-distance stop threshold when `num_speakers` is None.
///
/// Returns a label (0-based, contiguous) for each input embedding.
pub fn agglomerative(
    embeddings: &[Vec<f32>],
    num_speakers: Option<usize>,
    threshold: f32,
) -> Vec<usize> {
    let n = embeddings.len();
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return vec![0];
    }

    // Pairwise cosine distance matrix.
    let mut dist = vec![vec![0f32; n]; n];
    for i in 0..n {
        for j in (i + 1)..n {
            let d = 1.0 - dot(&embeddings[i], &embeddings[j]);
            dist[i][j] = d;
            dist[j][i] = d;
        }
    }

    // Each point starts as its own cluster.
    let mut active: Vec<bool> = vec![true; n];
    let mut size: Vec<f32> = vec![1.0; n];
    // members[c] = indices belonging to cluster c
    let mut members: Vec<Vec<usize>> = (0..n).map(|i| vec![i]).collect();
    let mut num_clusters = n;

    let target = num_speakers.map(|k| k.max(1).min(n));

    loop {
        if let Some(t) = target {
            if num_clusters <= t {
                break;
            }
        } else if num_clusters <= 1 {
            break;
        }

        // Find the closest active pair.
        let mut best = f32::INFINITY;
        let mut bi = 0usize;
        let mut bj = 0usize;
        for i in 0..n {
            if !active[i] {
                continue;
            }
            for j in (i + 1)..n {
                if !active[j] {
                    continue;
                }
                if dist[i][j] < best {
                    best = dist[i][j];
                    bi = i;
                    bj = j;
                }
            }
        }

        // Stop on threshold only when the speaker count isn't fixed.
        if target.is_none() && best > threshold {
            break;
        }

        // Merge bj into bi (average linkage, Lance-Williams).
        let si = size[bi];
        let sj = size[bj];
        for k in 0..n {
            if !active[k] || k == bi || k == bj {
                continue;
            }
            let new_d = (si * dist[bi][k] + sj * dist[bj][k]) / (si + sj);
            dist[bi][k] = new_d;
            dist[k][bi] = new_d;
        }
        size[bi] = si + sj;
        active[bj] = false;
        let moved = std::mem::take(&mut members[bj]);
        members[bi].extend(moved);
        num_clusters -= 1;
    }

    // Emit contiguous labels.
    let mut labels = vec![0usize; n];
    let mut next = 0usize;
    for c in 0..n {
        if active[c] {
            for &idx in &members[c] {
                labels[idx] = next;
            }
            next += 1;
        }
    }
    labels
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut s = 0f32;
    for i in 0..n {
        s += a[i] * b[i];
    }
    s
}

//! Agglomerative hierarchical clustering (AHC) of speaker embeddings.
//!
//! Embeddings are length-normalized, so cosine distance = 1 - dot product.
//! Uses average linkage via the Lance-Williams update. Stops either at a fixed
//! number of speakers (when known) or when the closest pair exceeds a distance
//! threshold.

/// Cluster `embeddings` (each already length-normalized) into speaker labels.
///
/// * `num_speakers` â€“ if `Some(k)`, force exactly `k` clusters (when possible).
/// * `threshold` â€“ cosine-distance stop threshold when `num_speakers` is None.
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

    // When a speaker count is known, refine with a few centroid reassignment
    // passes (spherical k-means). AHC gives a good partition; reassignment
    // cleans boundary points that average-linkage left in the wrong cluster.
    if target.is_some() && next >= 2 {
        refine_centroids(embeddings, &mut labels, next, 8);
    }

    labels
}

/// Iterative nearest-centroid reassignment on unit embeddings.
fn refine_centroids(embeddings: &[Vec<f32>], labels: &mut [usize], k: usize, iters: usize) {
    let n = embeddings.len();
    if n == 0 || k == 0 {
        return;
    }
    let dim = embeddings[0].len();
    for _ in 0..iters {
        // Mean centroids, re-normalized.
        let mut cents = vec![vec![0f32; dim]; k];
        let mut counts = vec![0f32; k];
        for i in 0..n {
            let c = labels[i].min(k - 1);
            counts[c] += 1.0;
            for d in 0..dim {
                cents[c][d] += embeddings[i][d];
            }
        }
        for c in 0..k {
            if counts[c] <= 0.0 {
                continue;
            }
            for d in 0..dim {
                cents[c][d] /= counts[c];
            }
            let norm = cents[c].iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-8);
            for d in 0..dim {
                cents[c][d] /= norm;
            }
        }

        let mut changed = false;
        let mut proposed = labels.to_vec();
        for i in 0..n {
            let mut best = labels[i].min(k - 1);
            let mut best_sim = f32::NEG_INFINITY;
            for c in 0..k {
                if counts[c] <= 0.0 {
                    continue;
                }
                let sim = dot(&embeddings[i], &cents[c]);
                if sim > best_sim {
                    best_sim = sim;
                    best = c;
                }
            }
            if best != labels[i] {
                proposed[i] = best;
                changed = true;
            }
        }
        // A forced count must remain exact. Reject an iteration that would
        // empty any cluster (plain k-means can otherwise collapse k to k-1).
        let mut proposed_counts = vec![0usize; k];
        for &lab in &proposed {
            proposed_counts[lab] += 1;
        }
        if proposed_counts.iter().any(|&count| count == 0) {
            break;
        }
        labels.copy_from_slice(&proposed);
        if !changed {
            break;
        }
    }

    // Relabel to contiguous 0..k'-1 in case empty clusters dropped out.
    let mut map = vec![None; k];
    let mut next = 0usize;
    for lab in labels.iter_mut() {
        let old = *lab;
        if map[old].is_none() {
            map[old] = Some(next);
            next += 1;
        }
        *lab = map[old].unwrap();
    }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut s = 0f32;
    for i in 0..n {
        s += a[i] * b[i];
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forced_count_stays_exact_after_refinement() {
        let embeddings = vec![
            vec![1.0, 0.0],
            vec![0.99, 0.01],
            vec![0.0, 1.0],
            vec![0.01, 0.99],
        ];
        let labels = agglomerative(&embeddings, Some(2), 0.60);
        assert_eq!(labels.iter().copied().max().unwrap() + 1, 2);
        assert_eq!(labels[0], labels[1]);
        assert_eq!(labels[2], labels[3]);
        assert_ne!(labels[0], labels[2]);
    }

    #[test]
    fn threshold_keeps_obvious_speakers_apart() {
        let embeddings = vec![vec![1.0, 0.0], vec![0.99, 0.01], vec![0.0, 1.0]];
        let labels = agglomerative(&embeddings, None, 0.20);
        assert_eq!(labels[0], labels[1]);
        assert_ne!(labels[0], labels[2]);
    }
}

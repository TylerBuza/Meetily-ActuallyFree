# Sortformer integration

Adapted from `altunenes/parakeet-rs`, commit
`4e082e537cc5a765d6a17440a360dcb7e3dcab55`, `src/sortformer.rs` and the
preemphasis/Slaney-filterbank helpers in `src/audio.rs`. The MIT license and
copyright notice are retained in LICENSE.

The app adapter uses our existing ort rc.10 dependency and verified shared CPU
runtime. It does not add another ONNX runtime. This implementation preserves the
model's feature preprocessing, per-speaker activity, lookahead, and speaker-aware
cache compression. NVIDIA model weights carry their own license.

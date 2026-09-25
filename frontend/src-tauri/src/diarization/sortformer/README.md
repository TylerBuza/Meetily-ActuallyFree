# Sortformer integration

Adapted from `altunenes/parakeet-rs`, commit
`4e082e537cc5a765d6a17440a360dcb7e3dcab55`, `src/sortformer.rs` and the
preemphasis/Slaney-filterbank helpers in `src/audio.rs`. The MIT license and
copyright notice are retained in LICENSE.

The app adapter uses our existing ort rc.10 dependency and verified shared
runtime. Windows bundles ONNX Runtime 1.22.0 DirectML and DirectML 1.15.4,
with Nemotron preferring DirectML and falling back to CPU on session creation
failure. DirectML sessions use sequential execution and disabled memory patterns.
Other speech models retain their CPU sessions. This implementation preserves the
model's feature preprocessing, per-speaker activity, lookahead, and speaker-aware
cache compression. NVIDIA model weights carry their own license.

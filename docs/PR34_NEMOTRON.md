# PR #34 qualification

Based on @ampersandru's `feat/nemotron-diarization` at
`125b6f0022bd3314c108b184456d98c7e95edb9c`.

## Supported integration

- Optional Nemotron-3 post-call Auto-detect; default remains Pyannote.
- Explicit speaker counts and live labels use the existing bundled engine.
- Separate microphone and system files, local-user provenance, overlapping
  activity, names, transcript text and timestamps are preserved.
- Native CPU inference on the existing shared ONNX Runtime. The application's
  CPU/Vulkan/CUDA Whisper variants do not change Nemotron's execution provider.
- A roughly 382 MB model download plus its license; immutable source revision,
  exact byte counts and SHA-256 verification, including manually placed weights.
- Sortformer preprocessing/cache implementation adapted from Enes Altun's
  `parakeet-rs` (MIT), with its source revision recorded alongside the adapter.

## Corrections to the submitted implementation

Removed destructive text-length-based splitting, its nonexistent database column,
speaker-duration-based user identification, winner-only overlap conversion,
Parakeet-preprocessor substitution, recent-history-only speaker cache, and
unverified model acceptance. Restored the startup crash-report gate, pinned
shared CPU runtime, frozen frontend lockfile, and configured transcription model
selection. CUDA development flags are Windows-script-scoped and respect an
explicit architecture override; the full release architecture list is retained.

## Verification

The real-model test is explicitly ignored unless invoked with a pinned model:

```text
MEETILY_NEMOTRON_MODEL=<path to nemotron3_diar_v3.onnx>
MEETILY_NEMOTRON_WAV=<optional synthetic/public test WAV>
MEETILY_NEMOTRON_EXPECTED=<optional voice/start/end JSON turn annotations>
cargo test --release -p meetily --no-default-features --features custom-protocol --lib real_model_silence_and_optional_speech -- --ignored --nocapture
```

Missing required model configuration fails that test rather than silently passing.
On Windows with the David and Zira desktop voices installed, generate the
synthetic WAV and annotations using Windows PowerShell:

```powershell
powershell -NoProfile -File frontend/scripts/make-nemotron-fixture.ps1 -OutputDirectory .build-tools/synthetic-speech
```

Set the optional WAV and EXPECTED variables to `conversation.wav` and
`expected.json` in that output directory. The assertions require distinct voices,
stable returning-speaker identity, both overlapping speakers, and no extra IDs.

Synthetic tests cover silence, overlapping speaker intervals, short turns,
returning-speaker identity, and transcript-update rollback/preservation.
Synthetic voice results are integration checks, not a diarization-error benchmark
on real meetings or proof of superiority over the default engine.

### Checks completed locally

- Frozen frontend dependency installation, 35 frontend tests, production Next.js
  build, and standalone TypeScript check passed.
- Targeted native diarization run: 14 reported passes, zero failures, one
  explicitly ignored model test. The legacy `diarize_sample` diagnostic in that
  count returned early without its external recording, so it is not evidence of
  a real-meeting benchmark.
- The ignored Nemotron test was then explicitly executed with the pinned model,
  generated conversation, and expected turn annotations: passed, including
  65 seconds of silence, distinct voices, returning-speaker identity, overlap,
  and bounds checks. The generated conversation lasts 104.985 seconds.
- All four shared ONNX Runtime tests passed, including recoverable missing-runtime
  behavior and bundled Pyannote model inference.
- The first universal build hit transient compiler process-launch failures in
  Whisper's Vulkan shader generator. Running the same generator separately
  completed successfully; the subsequent universal build passed for CPU, Vulkan,
  and CUDA (architectures 75/80/86/89/90/100/120), including NSIS and bootstrapper
  packaging.
- `node frontend/scripts/verify-windows-release.mjs` passed: manifest/checksums,
  cryptographic updater signatures, archive integrity, packaged backend hashes,
  shared ONNX Runtime and attribution license hashes, and bootstrapper payload
  verification without installation.

The local candidate retains the current 0.2.16 version for qualification; it is
not a replacement for the published release. Artifacts are under `dist/` and
lack Authenticode signing; the updater signature is present and verified.
No real fresh-install,
upgrade, GUI recording soak, or real-meeting accuracy result is claimed here.

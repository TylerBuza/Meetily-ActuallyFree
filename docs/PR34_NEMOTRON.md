# PR #34 qualification

Based on @ampersandru's `feat/nemotron-diarization` at
`125b6f0022bd3314c108b184456d98c7e95edb9c`.

## Supported integration

- Optional Nemotron-3 post-call Auto-detect; default remains Pyannote.
- Explicit speaker counts and live labels use the existing bundled engine.
- Separate microphone and system files, local-user provenance, overlapping
  activity, names, transcript text and timestamps are preserved.
- Windows DirectML inference on the shared ONNX Runtime, with CPU fallback on
  GPU session initialization failure. All CPU/Vulkan/CUDA Whisper variants get
  the same Nemotron DirectML capability; those variants select Whisper's backend.
- A roughly 382 MB model download plus its license; immutable source revision,
  exact byte counts and SHA-256 verification, including manually placed weights.
- Sortformer preprocessing/cache implementation adapted from Enes Altun's
  `parakeet-rs` (MIT), with its source revision recorded alongside the adapter.

## Corrections to the submitted implementation

Removed destructive text-length-based splitting, its nonexistent database column,
speaker-duration-based user identification, winner-only overlap conversion,
Parakeet-preprocessor substitution, recent-history-only speaker cache, and
unverified model acceptance. Restored the startup crash-report gate, pinned
shared runtime, frozen frontend lockfile, and configured transcription model
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

Initial qualification used a 0.2.16 candidate; the DirectML build is now versioned
0.2.17 for local installation. It has not been published. Artifacts are under `dist/` and
lack Authenticode signing; the updater signature is present and verified.
No fresh-install, GUI recording soak, or real-meeting accuracy result is claimed
here. The user's existing installation was upgraded locally to 0.2.17 with the
verified NSIS payload: installer exit code 0, installed version 0.2.17, CUDA
backend and DirectML runtime hashes matching the candidate, and pre-existing
top-level app-data file hashes unchanged before reopening. The app reopened and
loaded both ONNX Runtime and DirectML from its installed app-owned directory.
The previous executable and database were backed up privately before upgrading.

## DirectML follow-up

The Windows runtime is now the pinned Microsoft.ML.OnnxRuntime.DirectML 1.22.0
NuGet payload, plus Microsoft.AI.DirectML 1.15.4. Both package downloads and each
staged DLL/license are checked for exact length and SHA-256. The DirectML DLL is
preloaded from the app-owned absolute path and retained for the process lifetime.
Nemotron requests adapter 0 using sequential execution and disabled memory
patterns, as required by the DirectML execution provider. A failure to register
the provider or create its session is logged and recreates a CPU session.

Tested on NVIDIA RTX 4070 Ti, driver 32.0.16.1714:

- Actual ONNX kernel profiling recorded 13,272 DirectML events, including 1,330
  MatMul events, plus 6,251 CPU events. This verifies GPU work rather than merely
  successful provider registration; the graph still has CPU partitions.
- The 104.985-second synthetic conversation passed all identity/overlap
  assertions. An initial timed inference was 0.77 seconds on DirectML versus
  3.11 seconds on CPU, excluding model/session initialization. This is not a
  real-meeting performance or accuracy benchmark.
- An intentionally invalid adapter exercised CPU fallback and passed the same
  inference assertions. Its profile contained 19,369 CPU events and no GPU events.
- CPU VAD detected speech, and all three Parakeet int8 sessions transcribed the
  generated speech correctly using the new shared runtime. Bundled Pyannote and
  the four standard runtime tests also passed.
- Production frontend build and TypeScript passed with the updated settings copy.
- Rebuilt CPU, Vulkan, and CUDA variants, the NSIS updater, and the bootstrapper
  with the DirectML runtime. Final payload verification passed, including both
  DirectML DLL/license hashes, backend hashes, updater signatures, archive
  integrity, and bootstrapper payload verification without installation.

For the opt-in native model test, set `MEETILY_NEMOTRON_PROFILE` to an absolute
profile prefix. Then verify the generated JSON with:

```text
python frontend/scripts/verify-nemotron-profile.py <profile.json> --provider directml
```

Test builds also accept `MEETILY_NEMOTRON_TEST_CPU=1` or
`MEETILY_NEMOTRON_TEST_DEVICE=-1`; the latter exercises real provider failure and
fallback. Verify either CPU profile with `--provider cpu`. These switches are
compiled out of the shipped application. No real AMD/Intel hardware qualification
has been performed.

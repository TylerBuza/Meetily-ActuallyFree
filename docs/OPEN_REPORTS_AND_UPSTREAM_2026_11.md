# Open reports and upstream release review — November 24, 2026

Scope: all 8 open issues and 19 open PRs in `TylerBuza/Meetily-ActuallyFree`
on this date. Fork main was `613f375`; this review builds on the local
`fix/hardware-setup-compatibility` fixes through `4b1279a`. “Local” is not
“released.” The Linux preview (`9928ce7`), Windows Latest (`v0.2.23`), and
Apple Silicon preview (`v0.2.22-macos`) are separate artifacts.

## Issues

| Issue | Finding and disposition |
| --- | --- |
| [#76](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/76) Windows detection | Local fix in `4b1279a`: ignored apps no longer count as competing media holders. Running Teams with no eligible lease can prompt, never auto-start. A reporter-device call remains useful. |
| [#74](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/74) crash ZIP | The attached JSON says Windows v0.2.20, CUDA, `unexpected_exit`, no panic. No triggering operation or stage timeline. CUDA is the installed backend, not a diagnosed cause. Need steps and a v0.2.23-or-later timeline. |
| [#73](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/73) stepwise track drift | Two reproducible timing defects corrected locally; see the experiment below. The issue links a noise stimulus, not the two captured tracks. Keep open pending measurements on the affected system. |
| [#72](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/72) automatic exports | Feature gap confirmed. `useCopyOperations` is an interactive export action. Automatic updates need an explicit destination, per-meeting file ownership, a filename-collision policy and hooks after successful transcript/summary persistence, including while the page is closed. |
| [#67](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/67) Teams freeze | Earlier investigation did not isolate a cause. `v0.2.23` added stage diagnostics. Need a repeat on that build to distinguish model loading, capture start and a hung UI. |
| [#65](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/65) unexpected exit | Prior investigation found an unclassified exit on Windows v0.2.16. No evidence it shares a cause with #67 or #74. Need a current trace and last user action. |
| [#42](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/42) Mac distortion/stalls | The reporter confirmed the permission banner is gone and stability improved after the Mac preview. That is useful confirmation, not a sustained recording/track-alignment measurement. See `MACOS_OCT22_STABILITY.md`. |
| [#20](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/20) summary templates | Feature gap confirmed: `useTemplates` initializes `standard_meeting` on mount. The editor exists; a persistent default needs deletion fallback and must be loaded before automatic post-call summary generation. |

## Pull requests

| PR | Disposition |
| --- | --- |
| [#22](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/22) | Native Pulse capture adapted into the published Linux preview with fork-owned cleanup and source switching. |
| [#38](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/38) | Large conflicting bundle. Prior component-speaker edits were incorporated; review near-live captions, word timing, voice suggestions and file operations separately. Preserve text, opt-in voice enrollment and meeting-owned paths. |
| [#48](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/48) | A quiet system track does not establish an in-person meeting (it can be a quiet or muted call). Qualify room mode separately with an explicit choice and opt-in identity evidence. |
| [#49](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/49) | Whisper subtitle hallucinations are credible. The proposed unconditional phrase drop and “cut everything after a credit marker” can remove genuine dictated text. Needs positive **and** negative speech fixtures before enabling. |
| [#50](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/50) | Bundle-ID collision is credible. A new ID changes TCC and WebKit storage; qualify side-by-side installs, pre-existing destination data and interrupted migration before adopting it. |
| [#52](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/52) | Narrow local correction: resolve the PID to a Core Audio process object, reject missing objects, and never widen a failed per-app tap to global capture. Enabling chosen-app mode with an empty list now fails before opening capture. Browser audio helpers, multiple apps and following late launches are **not** incorporated; they need target-hardware qualification. |
| [#54](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/54) | Mac mic-based detection/automation is separate from Windows #76. Verify idle apps, browser helpers, muted calls, and the quiet-call stop timeout on macOS before changing automatic recording. |
| [#55](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/55) | Live echo cancellation changes the mic signal, latency, model payload and retained tracks. Require synchronized references and double-talk/near-end retention tests on Mac hardware. |
| [#57](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/57) | Uses trash rather than permanent deletion, but the shared-folder ownership query compares raw `folder_path` strings. Canonical aliases and nested meeting folders must be protected before deleting user audio. |
| [#58](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/58) | Adapted locally in `4b1279a`. The stop-time clock survives cleanup, including an open pause. |
| [#59](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/59) | Adapted Simone Scarduzio’s `0104d5ec` locally. Drain real resampled tail once before closing the pipeline; cap padding and report busy DSP rather than waiting indefinitely. Timestamp emitted output, not yet-buffered input. |
| [#60](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/60) | Recovery fixes are local. Encoding FLAC checkpoints then a single AAC stream is a separate proposal: measure disk, Stop latency and recovery on long recordings. Cumulative priming at 30 s boundaries alone cannot explain #73’s steps within 21 s. |
| [#61](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/61), [#62](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/62), [#63](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/63), [#64](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/64), [#66](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/66) | CUDA discovery, CPU/Vulkan DEB/AppImage packaging, meeting-scoped playback, build docs and platform-specific compiler flags were selectively integrated on the **Linux preview** branch. Its public packages are CPU/Vulkan; this is not a released CUDA binary or a merge into Windows main. |
| [#69](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/69) | A real attribution problem, distinct from header overcount. The proposed `line_source` infers source from mutable display text such as `Speaker 2`. Persist actual capture/transcription source separately first; legacy or mixed rows must not lose genuine overlaps or hand edits. |
| [#70](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/70) | Offline bleed detection is opt-in but can discard mic transcript chunks. Its lag estimator searches −50 to +500 ms; #73 reports excursions down to −320 ms. Establish alignment and verify soft local speech/double-talk retention before integrating. |

## What the timing experiments establish

- A deterministic bounded-queue replay drops three separate 8 ms stereo packets
  on one source. Preserving the known missing frame counts as silence keeps every
  subsequent surviving sample at its original position. This path does not
  guess losses from callback scheduling jitter; long gaps remain the mixer's
  responsibility. Driver-side losses need separate evidence.
- With irregular callback sizes at 16 kHz the old timestamp exceeded the emitted
  end by **40.29 ms** in a failing regression. At 16 and 44.1 kHz all tested
  block ends and the drained tail now match emitted sample counts to within one
  48 kHz sample. The last 20 ms tone and mute/Stop tests exercise the actual
  resampler. These are synthetic tests, not recordings from the reporter.
- `python frontend/scripts/measure-track-drift.py "<meeting folder>"` produces
  local CSV from `mic.mp4` and `system.mp4` (requires NumPy and FFmpeg on PATH).
  It compares two-second windows within ±500 ms. Positive means the mic copy
  arrives later. Blank means insufficient, weak or ambiguous shared audio,
  **not** zero lag. It does not identify speakers, upload audio, or modify
  recordings. A generated pair of AAC files measured **70, 62, 54, 46 ms**
  as injected; unrelated audio and silence returned blanks. For #73, the most
  useful next evidence is this CSV plus endpoint formats and local continuity/
  queue-overflow counters on the same run; no meeting content is needed.

## Upstream: actually released vs on main

Latest published upstream is [v0.5.0](https://github.com/Zackriya-Solutions/meetily/releases/tag/v0.5.0),
released November 14, commit `9e50dc2`. The previous published version was
`v0.4.1`; earlier selective ports are listed in `UPSTREAM_0_4_1_PORTS.md`.

- **Parakeet (#805):** new downloads use upstream's immutable Hugging Face
  revisions (`8f23f0c…` v3, `0bbb45a…` v2) and a versioned fork User-Agent.
  Verified the Hugging Face tree metadata for all eight INT8 artifacts against
  the fork's expected byte counts. The v3 fork mirror, cancellation/resume and
  existing model storage are retained. No model binaries downloaded in this check.
- **Diagnostics (#755):** compare upstream bounded local log retention with the
  fork’s existing allowlisted crash journal. They are not identical. No blanket
  adoption of general logs into shared crash ZIPs.
- **Linux (#822, #834, #874, #882, #893, #904, #909, release #907):** capture,
  exact IDs, recovery and packaging were previously adapted for the fork’s
  [published preview](https://github.com/TylerBuza/Meetily-ActuallyFree/releases/tag/v0.2.23-linux-preview.1).
  The upstream mixer, its automatic route fallback, signing/update channel and
  UI/seasonal assets are not interchangeable with the fork’s. #905 is contributor
  guidance, not a runtime fix.
- **Release build (#915, #916):** the helper uses the same `llama-cpp-2 0.1.146`.
  Applied the helper-only OpenSSL discovery opt-out in the Apple Silicon workflow,
  local Apple build and Unix GPU build/dev scripts. The fork's Mac workflow
  already pins Rust and the published Linux build already used Ubuntu 24.04 and
  pinned Rust. Keep the fork’s release verification and keys.
- Upstream `main` at `2166bc6` is three commits past the tag. Its one-line Linux
  installer and documentation/description updates are **not** a newer release.
  That installer targets upstream's packages; it is not a fork update command.

Verification on Windows: **401 native app tests passed, 11 opt-in tests
ignored**; both helper tests and four frontend recording-start error tests
passed. TypeScript and Unix script syntax checks passed. The Windows helper's
CMake cache recorded `CMAKE_DISABLE_FIND_PACKAGE_OpenSSL=TRUE`. No physical
capture or model inference ran in this pass. This branch needs an Apple Silicon
build and a physical selected-app capture test before Mac qualification. No
upstream/fork PR was closed or merged on GitHub as part of this review.

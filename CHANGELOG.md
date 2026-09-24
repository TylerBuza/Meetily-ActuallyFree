# Changelog

## Unreleased

### Features

- Add a **Claude Code CLI** summary provider. Summaries and the live assistant can
  now run through the `claude` command installed on your computer, so they draw on
  a Claude subscription instead of a pay-as-you-go API key. Model Settings detects
  the executable, shows the signed-in account and plan, warns when
  `ANTHROPIC_API_KEY` would override the subscription, and can send a test call.
  Nothing is bundled and no key is stored — the CLI owns sign-in.

## 0.2.16 - 2026-09-18

### Selective Upstream Integration

This update selectively incorporates improvements from
[upstream Meetily v0.4.1](https://github.com/Zackriya-Solutions/meetily/releases/tag/v0.4.1)
into Meetily - Actually Free. Many of the fixes in that release were already
implemented or addressed independently in our build, so we brought over the
remaining applicable improvements and adapted them to our fork's architecture.
We retained our existing solutions where they already covered the same issues;
this is a selective integration rather than a full upstream merge.

Existing fixes we retained include Claude thinking-block handling, preservation
of short transcript segments, responsive toolbar controls, and much of our
model-download resume and file-retention protection.

### Newly Incorporated Improvements

- Preserve transcript coverage when splitting long summaries into chunks.
- Correct HE-AAC import timing and repair stale duration metadata during
  explicit retranscription.
- Pass selected audio devices and meeting names correctly to native recording.
- Restore summary progress after navigation and improve recording-control
  positioning.
- Bundle a pinned Windows ONNX Runtime shared by VAD, Parakeet, and diarization,
  with recoverable startup errors before recording storage begins.
- Add the missing download-recovery protections: rejected-range fallback,
  stricter range validation, and safer cancellation/retry ownership.

Thanks to the upstream contributors for these improvements. Individual PRs,
attribution, fork-specific adaptations, and verification details are recorded in
[the upstream integration notes](docs/UPSTREAM_0_4_1_PORTS.md).

### Windows Qualification

- Retains the full Windows runtime ownership crash fix from v0.2.14.
- Passed 35 frontend and 70 targeted native tests, fresh CPU/Vulkan/CUDA builds,
  updater signature and payload checks, and an extracted ONNX DLL load test.
- Physical non-AVX2 hardware and real fresh-install/upgrade testing remain
  unverified. Release qualification uses native regression tests and packaged
  payload checks; this does not establish compatibility with every older CPU.
- Manual downloads use the universal setup; in-app updates use the separate
  Tauri-signed updater engine. Windows Authenticode remains unconfigured.
- No macOS release or permission-probe changes are included.

## 0.2.15 - 2026-09-17

### Maintenance

- Keep Export, Enhance, and other meeting toolbar actions accessible at narrow
  panel widths, using responsive icon labels, wrapping, and keyboard tooltips (#25).
- Make Claude summary output length configurable with a larger application
  default, model-aware validation, explicit errors for truncated responses,
  effective-budget cache invalidation, and an LF-pinned migration (#29).
- Preserve unavailable audio-device preferences while allowing explicit Default
  selection, and use the active theme for native form controls (#23).
- Keep the runtime resource directory present in clean source checkouts (#7).
- Add read-only frontend PR checks: unit tests, production build, and TypeScript.
- Retain the full Windows runtime crash fix from v0.2.14; PR #30 is superseded.
- PR #12 remains pending macOS revisions and qualification. No macOS release.

### Contributors

- Thanks to @mhlas7, @cedstrom, and @0cv for the maintenance contributions.

### Windows Downloads

- Fresh CPU, Vulkan, and multi-architecture CUDA builds.
- Manual installation uses the universal setup; in-app updates use the separate
  Tauri-signed updater engine and matching signature. Authenticode is not configured.

## 0.2.14 - 2026-09-17

### Windows Crash Fix

- Correct Windows event-loop target ownership in a narrowly patched, vendored
  Tauri runtime 2.11.4. This addresses the background reference-count race
  associated with the reported long-recording crash.
- Keep strong ownership and destruction on the event-loop thread, use private
  atomic weak references in cloned contexts, and route runtime monitor queries
  to the owning thread. Preserve teardown ordering during panic unwinding.
- This release contains the crash fix and release metadata only, with no PR
  feature merges or macOS release changes.

### Validation

- Nine native lifecycle scenarios cover thread-affine destruction, shutdown,
  panic unwinding, monitor dispatch, and WebView2 traffic. The stress case sends
  50,000 IPC messages through two WebViews while workers clone/drop five million
  webview handles. Three compile-fail doctests cover ownership boundaries.
- The reporting user said the patched test build worked fine so far. The trial
  duration is unconfirmed; these results do not establish a completed multi-hour
  recording/minibar soak or guarantee that all causes of crashes are resolved.

### Windows Downloads

- Fresh CPU, Vulkan, and CUDA variants; CUDA targets multiple GPU generations.
- Use `Meetily-ActuallyFree-0.2.14-x64-universal-setup.exe` for manual installation.
  In-app updates use the universal updater engine and its matching Tauri signature.
- `latest.json` and `SHA256SUMS.txt` provide updater metadata and file checksums.
  Windows Authenticode remains unconfigured; Tauri updater signing is separate.

## 0.2.13 - 2026-09-06

### Bug Fixes

- Display complete multilingual summary Markdown with original headings, lists,
  tables, and code blocks; custom sections and decisions no longer disappear (#17).
- Allow dragging the compact recording bar from any non-button surface with a
  minibar-scoped native permission, preserving native recording lifecycle (#24).
- Import OGG Opus and Vorbis through the existing bundled FFmpeg conversion path;
  temporary conversion files no longer require a writable source folder (#21).
- Use the application accent for checked settings switches in both themes (#18).

### Reliability

- Surface persistent summary failures and retry controls, validate selected Ollama
  models, and prevent cancelled preflight requests from starting generation.
- Reject empty summaries and failed transcript chunks rather than silently
  saving incomplete summaries.
- Keep recoverable transcription failures non-terminal and preserve IndexedDB
  recovery writes when listener closures predate meeting initialization.
- Cancel updater downloads natively, isolate stale cancellation by request ID,
  and guard the non-cancellable installation phase.
- Match Windows audio devices exactly and warn about unavailable loopback capture
  or possible Zoom speaker-route mismatches. Zoom warnings are heuristic: endpoint
  sound cannot be attributed to a particular application.

### Windows Packaging

- Fresh CPU, Vulkan, and CUDA variants are required for this release.
- The universal setup is for manual installation; the signed universal updater
  engine and its matching signature remain the target of `latest.json`.
- Windows Authenticode is not configured. The Tauri updater signature is separate
  and remains required. No macOS release is included.

## 0.2.12 - 2026-08-30

### Meeting Details

- Preserved user-renamed meeting titles when summaries are generated or
  regenerated, while still allowing AI names to replace recognizable default
  and automatically assigned titles.
- Kept sidebar and meeting-detail titles synchronized without allowing stale
  pagination or summary responses from another meeting to overwrite the active
  view.
- Restored the summary template selector, custom-template management, summary
  language, and AI model settings to the visible meeting toolbar.
- Removed duplicate summary actions and stacked transcript and summary panels on
  narrow screens.

### Time Accuracy

- Stored the native recording start as the meeting start instead of the later
  database save time.
- Derived transcript timestamps from the recording start plus each segment's
  audio offset so enhancement no longer rewrites them to the current time.
- Repaired upgraded recordings from their existing `metadata.json` start time
  when meetings are listed, opened, or retranscribed.
- Preserved recording-start timestamps through crash recovery and audio import.

### Reliability

- Added title-provenance migration and regression coverage for manual,
  generated, imported, and legacy default titles.
- Added request-generation guards for metadata, transcript, and summary loading,
  and made summary completion idempotent across native events and polling.

### Windows Downloads

- `Meetily-ActuallyFree-0.2.12-x64-universal-setup.exe`: recommended installer;
  automatically selects CPU, Vulkan, or CUDA.
- `Meetily-ActuallyFree-0.2.12-x64-universal-updater.exe`: Tauri updater engine
  used by the in-app updater.
- `latest.json` and the matching `.sig`: updater metadata and cryptographic
  signature.
- `SHA256SUMS.txt`: SHA-256 checksums for release verification.

Windows binaries are published without Authenticode and may show an Unknown
Publisher warning. The updater payload remains signed with the app's Tauri
updater key.

The same `0.2.12` source can be released separately for Apple Silicon as
`v0.2.12-macos` only after its exact candidate passes the required physical
macOS 14.2 qualification. The macOS release will not replace Windows Latest or
modify Windows updater metadata.

## 0.2.11 - 2026-08-28

### Audio Balance

- Added a persisted `0.5×–3.0×` system-audio gain control alongside microphone
  gain.
- Applied system gain once before source meters, transcription, retained source
  tracks, and playback mixing while preserving source alignment.
- Added waveform-preserving peak limiting and a live warning when boosted
  system audio repeatedly reaches the safety limiter.

### CUDA Setup Recovery

- Detects NVIDIA display hardware even before the vendor driver is installed
  and explains why setup temporarily selected Vulkan or CPU.
- Requires a compatible NVIDIA driver and compute capability before selecting
  CUDA, with timeout-bounded checks that cannot stall setup.
- Rechecks CUDA readiness in Setup Overview and at startup for existing users,
  then offers the current universal setup when the installed executable needs
  to be replaced with the CUDA build.

### Recording Storage

- Added native folder selection for meeting recordings in Preferences and
  Recording Settings.
- Kept both settings views synchronized with the persisted destination and
  preserved the previous folder when selection or validation fails.
- Prevented macOS recordings from being placed inside the signed application
  bundle.

### Development

- Made Tauri launch the checked-in Next.js development binary directly instead
  of relying on a package-manager script.

### Windows Downloads

- `Meetily-ActuallyFree-0.2.11-x64-universal-setup.exe`: recommended installer;
  automatically selects CPU, Vulkan, or CUDA.
- `Meetily-ActuallyFree-0.2.11-x64-universal-updater.exe`: Tauri updater engine
  used by the in-app updater.
- `latest.json` and the matching `.sig`: updater metadata and cryptographic
  signature.
- `SHA256SUMS.txt`: SHA-256 checksums for release verification.

The same `0.2.11` source can be released separately for Apple Silicon as
`v0.2.11-macos` only after its exact candidate passes the required physical
macOS 14.2 qualification. The macOS release will not replace Windows Latest or
modify Windows updater metadata.

## 0.2.10 - 2026-08-26

### Light Theme

- Added a light semantic palette so meeting lists, transcript views, search,
  settings, and other shared surfaces no longer inherit dark colors.
- Synchronized the saved interface theme with the native Tauri window theme.
- Fixed meeting summaries, meeting Q&A, person overviews, and person Q&A so
  Markdown uses light typography unless dark mode is active.

### Auto Summary Preference

- Fixed the Auto Summary setting so disabling it stops post-call processing
  after transcript enhancement and speaker identification instead of generating
  a summary.
- Kept enhanced transcripts and saved live transcripts available for manual
  summary generation when automatic summaries are disabled.
- Preserved automatic post-call summaries when the preference is enabled and
  added regression coverage for recording and existing-meeting entry paths.

### Windows Downloads

- `Meetily-ActuallyFree-0.2.10-x64-universal-setup.exe`: recommended installer;
  automatically selects CPU, Vulkan, or CUDA.
- `Meetily-ActuallyFree-0.2.10-x64-universal-updater.exe`: Tauri updater engine
  used by the in-app updater.
- `latest.json` and the matching `.sig`: updater metadata and cryptographic
  signature.
- `SHA256SUMS.txt`: SHA-256 checksums for release verification.

The same `0.2.10` source can be released separately for Apple Silicon as
`v0.2.10-macos` only after its exact candidate passes the required physical
macOS 14.2 qualification. The macOS release will not replace Windows Latest or
modify Windows updater metadata.

## 0.2.9 - 2026-08-26

### Post-call Reliability

- Prevented idle cleanup, manual memory cleanup, and local LLM startup from
  unloading Whisper or Parakeet during a long import or post-call
  retranscription batch.
- Added lifecycle-lock regression coverage so cleanup remains blocked until
  every transcription segment and persistence step finishes.
- Kept the existing live transcript readable and scrollable while enhancement,
  speaker identification, and transcript refresh run in the background.
- Replaced the blocking processing dialog with a compact progress card while
  preserving modal speaker-count choices and actionable errors.

### Acceleration Visibility

- Added the automatically selected Whisper backend to first-run setup and Local
  Stack settings: NVIDIA CUDA, Vulkan GPU, Apple Metal, AMD HIP, or CPU.
- Clearly distinguished Whisper acceleration from Parakeet, which currently
  uses ONNX Runtime on the CPU.
- Shows a backend as active only while the Whisper model is actually loaded.

### Windows Downloads

- `Meetily-ActuallyFree-0.2.9-x64-universal-setup.exe`: recommended installer;
  automatically selects CPU, Vulkan, or CUDA.
- `Meetily-ActuallyFree-0.2.9-x64-universal-updater.exe`: Tauri updater engine
  used by the in-app updater.
- `latest.json` and the matching `.sig`: updater metadata and cryptographic
  signature.
- `SHA256SUMS.txt`: SHA-256 checksums for release verification.

The same `0.2.9` source can be released separately for Apple Silicon as
`v0.2.9-macos` only after its exact candidate passes the required physical
macOS 14.2 qualification. The macOS release will not replace Windows Latest or
modify Windows updater metadata.

## 0.2.8 - 2026-08-25

### Recording Reliability

- Fixed the native Windows crash that could occur when Stop or Expand destroyed
  the floating recording bar while its WebView IPC command was still returning.
- Hid the minibar immediately, serialized its lifecycle, and deferred destruction
  until the originating command can finish safely.
- Preserved one main-window stop completion event and prevented updater restarts
  from being mistaken for crashes.

### Private Crash Recovery

- Added an opt-in next-launch prompt after an unexpected exit or native panic.
- Reports expose exactly **Send Report**, **Save ZIP**, and **Ignore** actions.
- Diagnostic ZIPs contain only allowlisted app/runtime metadata and panic details;
  they exclude transcripts, recordings, databases, logs, credentials, usernames,
  hostnames, and audio-device names.
- Kept native memory dumps in the separate, manually run Windows diagnostics
  collector rather than collecting them automatically.

### Installer And Runtime

- Added a real Vulkan capability probe before the universal installer selects
  the Vulkan backend, with safe CPU fallback when probing fails.
- Added a Windows support collector for users who explicitly choose to gather
  broader crash diagnostics.
- Updated the supported Tauri desktop stack and matching JavaScript plugins to
  current compatible patch releases without forcing an unsupported Wry override.
- Applied compatible security patches to transitive editor and frontend build
  dependencies while retaining the release's existing React and Next.js majors.

### Windows Downloads

- `Meetily-ActuallyFree-0.2.8-x64-universal-setup.exe`: recommended installer;
  automatically selects CPU, Vulkan, or CUDA.
- `Meetily-ActuallyFree-0.2.8-x64-universal-updater.exe`: Tauri updater engine
  used by the in-app updater.
- `latest.json` and the matching `.sig`: updater metadata and cryptographic
  signature.
- `SHA256SUMS.txt`: SHA-256 checksums for release verification.

The same `0.2.8` source will be released separately for Apple Silicon as
`v0.2.8-macos` only after its exact candidate passes the required physical
macOS 14.2 qualification. The macOS release will not replace Windows Latest or
modify Windows updater metadata.

## 0.2.7 - 2026-08-23

<p align="center">
  <img src="docs/images/v0.2.7-whisper-vocabulary.png" alt="Meetily Whisper vocabulary settings for global and meeting-specific terms" width="1100" />
</p>

### Critical Windows Upgrade Fix

Meetily `v0.2.6` could fail to launch after an upgrade from `v0.2.5` because
Windows builds embedded different line endings for one SQLx migration checksum.
`v0.2.7` recognizes only the two known checksums, verifies the exact people-table
and index definitions, repairs the recorded checksum, and preserves the existing
database.

If `v0.2.6` currently will not open, download and run the
[`v0.2.7` universal setup](https://github.com/TylerBuza/Meetily-ActuallyFree/releases/tag/v0.2.7)
manually. The in-app updater cannot run while `v0.2.6` is unable to launch. Do
not delete your Meetily data.

### Transcription Improvements

- Added independent live and post-call transcription defaults.
- Added global and meeting-specific Whisper vocabulary hints for names,
  acronyms, products, and technical terms.
- Carried vocabulary hints through live transcription, imports,
  retranscription, direct Whisper, and parallel processing paths.
- Prioritized meeting terms, deduplicated terms case-insensitively, and limited
  Whisper prompts to 224 tokens.
- Made model selection persistence-first and prevented overlapping preference
  saves.
- Hid the legacy Compact Parakeet model from new selections while retaining
  compatibility for existing installations.
- Added lighter navy-gray transcription panels and clearer selected-model
  states.
- Improved Whisper download-progress contrast and accessibility.

### Community Request

This release addresses the core request from the original Meetily project's
issue [Zackriya-Solutions/meetily#474](https://github.com/Zackriya-Solutions/meetily/issues/474):

> "Meeting Domain vocabulary hints for Whisper (initial_prompt)"

Global defaults now make recurring vocabulary available across meetings, while
meeting-specific terms take priority for specialized names and terminology.

### Windows Downloads

- `Meetily-ActuallyFree-0.2.7-x64-universal-setup.exe`: recommended installer;
  automatically selects CPU, Vulkan, or CUDA.
- `Meetily-ActuallyFree-0.2.7-x64-universal-updater.exe`: Tauri updater engine
  used by the in-app updater.
- `latest.json` and the matching `.sig`: updater metadata and cryptographic
  signature.
- `SHA256SUMS.txt`: SHA-256 checksums for release verification.

macOS remains on its separate qualification and release path.

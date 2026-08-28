# Changelog

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

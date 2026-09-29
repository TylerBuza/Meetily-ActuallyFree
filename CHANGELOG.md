# Changelog

## Unreleased

Prepared for **v0.2.18**; see [release notes and complete contributor
credits](docs/RELEASE_V0218.md). The workspace redesign is from **@jayjoe101's
PR #39**, including **@ampersandru's PRs #36–#38** and **@cedstrom's PR #28**
(original commit attribution: **@chris-edstrom**). Thanks to **@fernandog** for
the detailed issue #40 recording-artifact report and analysis.

### Recording and post-call corrections

- Preserve continuous microphone/system samples across jittered capture callback
  boundaries instead of repeatedly inserting zeros or dropping samples (#40).
  Applies to new recordings; older damaged files are not repaired.
- Retain speech-start pre-roll and correct VAD reset timestamps; increase live
  system-audio speech sensitivity and preserve quiet speech/short replies.
- Restore AI-generated titles for automatically named meetings while respecting
  manual names and rejecting template placeholders.
- Use a compact centered **Auto-detect & continue** action for Nemotron; show
  ongoing processing in a nonmodal bottom card so the meeting stays interactive.
- Restore the original text-only blue wordmark, add a system **Low audio**
  advisory, and improve capture startup, setup gating, and live speaker-edit recovery.

### Interface overhaul and workspace

- Three themes (Midnight, Vanilla and Charcoal) built on shared colour tokens, one
  component kit across every screen, and on Windows a title bar drawn inside the app
  with its own window buttons. Icons make a small, meaningful motion on hover.
- A home screen around the record card, with what is up next and open action items.
  During a call: an editable title, the group, people heard so far, the live
  transcript and a Speakers | Notes | Ask AI panel. The rest of the app stays usable
  while recording.
- A rebuilt meeting page: one row of people, a chat-style transcript with playback,
  and one document with your notes, action items and the editable summary.
- Groups (schedules, open items across meetings, Ask AI), contacts and person pages,
  and action items stored as records with owners, due dates and source moments.
- A Ctrl+K command bar that searches people, groups, meetings, transcripts, summaries
  and action items; an All meetings page; and export of any number of meetings to
  PDF, Word, Markdown, text or JSON.
- Contacts are kept when a speaker's lines are unlinked; only deleting or merging
  removes them. Useful summary-generated titles replace automatic meeting names;
  manual meeting titles remain authoritative.
- Each person is drawn in their contact colour across the transcript, with a faint
  tint on their chat bubbles, so it is easy to see who is talking.

### Claude Code CLI summaries

Thanks to **[@cedstrom](https://github.com/cedstrom)** for
[PR #28](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/28), which provides
this provider.

- Add a **Claude Code CLI** summary provider. Summaries and the live assistant can
  now run through the `claude` command installed on your computer, so they draw on
  a Claude subscription instead of a pay-as-you-go API key. Model Settings detects
  the executable, shows the signed-in account and plan, warns when
  `ANTHROPIC_API_KEY` would override the subscription, and can send a test call.
  Nothing is bundled and no key is stored — the CLI owns sign-in.
- Runs on current Claude Code releases. The system prompt is passed as a file rather
  than on the command line, and a signed-out or outdated CLI reports the step to take.

### Per-app recording and Labs

Thanks to **[@ampersandru](https://github.com/ampersandru)** for
[PR #38](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/38) (which also brings
their PRs #36 and #37), which provides these features. They are built into the
interface above.

- **Record only the apps you choose.** On Windows and macOS, computer audio can come
  from just the chosen apps, such as the call without music or notification sounds,
  instead of everything the computer plays. Choose in Settings > Recording or in the
  record card's system audio panel; each app shows whether it is open and playing
  sound.
- **Labs**, a new Settings section of experimental features. Each stays off until you
  turn it on, and each also appears where it is used:
  - Meeting automation records a detected call once it uses your microphone or
    camera, and stops and saves when the call ends. Recordings you start yourself
    are never stopped. Also in Meeting detection.
  - Waveform scrubbing shows the recording's waveform in the meeting player and adds
    0.5× and 0.75× speeds.
  - Clean transcript adds a Clean/Verbatim switch to the meeting player and writes
    new summaries from the clean text. The saved transcript stays word for word.
  - Whisper silence guard filters silence and noise more strictly when Whisper
    transcribes.
  - Parakeet on the GPU runs Parakeet's encoder through DirectML on Windows.
  - Voice profiles learn a contact's voice from their recorded meetings, and later
    meetings name a matching voice. Update voice on a contact's page relearns it from
    all their recent meetings, and the speaker card adds one meeting's audio. Renaming,
    merging or deleting a contact updates or removes their voice.
- Unnamed voices keep distinct colours in a meeting, and keep them when renamed.

## 0.2.17 - 2026-09-25

### Nemotron speaker diarization

Thanks to **[@ampersandru](https://github.com/ampersandru)** for
[PR #34](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/34), which provided
the starting point for this integration. This release adapts and hardens that
contribution and adds the live streaming path. Credit also goes to Enes Altun's
MIT-licensed `parakeet-rs` Sortformer implementation.

- Use the selected Nemotron engine for live remote-speaker labels as well as
  post-call refinement. Continuous 16 kHz audio is processed on a dedicated
  streaming worker; microphone audio remains You. Engine changes apply to the
  next recording, and inference failures visibly retain source-only labels.
- Save Nemotron's automatic selection inside the native download task so setup
  WebView reloads cannot lose activation. Open Settings and speaker dialogs
  refresh when the native task enables Nemotron.
- Automatically enable optional Nemotron after a successful download. Optional
  Whisper becomes the post-call enhancement/retranscription default; live
  transcription remains unchanged.
- Mark both optional setup choices Recommended. Already-installed models can be
  enabled without another download, and activation failures offer a retry.
- Refresh open Settings panels after automatic activation.

- Offer optional Whisper Large v3 Turbo Q5 and Nemotron downloads during setup.
  Download jobs are owned by the app, so navigating away or finishing onboarding
  does not stop them. Settings shows progress, completion, errors, and retry controls.
- Allow continuing setup while Parakeet and other models download. Recording still
  requires the transcription engine to be ready; finishing setup no longer marks
  unfinished models as downloaded.

- Fix a Windows stack-overflow crash when invoking diarization model downloads:
  checksum buffers now live on the heap instead of inside nested async futures.
- Make Nemotron Auto-detect-only in both speaker dialogs and backend dispatch;
  stale manual counts no longer silently select Pyannote. Manual speaker counts
  remain available when Pyannote is selected.
- Explain live and post-call engine selection, including next-recording behavior
  when the engine is changed during a call.

- Add optional NVIDIA Nemotron-3 post-call speaker Auto-detect, adapted from
  @ampersandru's PR #34. Live labels use the bundled Pyannote/WeSpeaker engine;
  manual speaker counts are offered only when Pyannote is selected.
- Preserve transcript text, row IDs, and timing across diarization reruns;
  speaker-label updates remain transactional. Sentence splitting requires
  actual word alignment and is not inferred from text length.
- Preserve overlapping speaker activity and avoid guessing the local user's
  identity from speaking duration. Separate mic/system tracks remain authoritative.
- Pin the optional ONNX export and license by revision, exact length and SHA-256;
  use model-specific native feature extraction and speaker-aware cache retention.
- Add Windows DirectML acceleration for Nemotron with CPU fallback, using a pinned
  shared ONNX Runtime and DirectML redistributable. VAD and Parakeet retain CPU execution.
- Retain the crash-report startup gate and full release
  CUDA architecture set. Credit Enes Altun/parakeet-rs for the MIT-licensed
  Sortformer reference implementation.

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

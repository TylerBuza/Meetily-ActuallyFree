# Development map: how the recording and speaker paths connect

This is an orientation map for contributors and coding agents, not a substitute
for reading the owning code. The map describes this branch's implementation;
release availability and qualification are separate facts documented below.

## 1. Keep these three responsibilities separate

| Responsibility | Owner | Meaning |
| --- | --- | --- |
| Transcription | Parakeet, Whisper, or configured provider | Produces words and transcript timing. |
| Diarization | Selected Pyannote/WeSpeaker or Nemotron engine | Assigns meeting-local speaker labels to audio/transcript turns. |
| Capture provenance | Independent microphone/system tracks | Establishes the local `You` label; it is not inferred from speaker channel 0. |

Nemotron is diarization, not voice isolation. Its overlapping activity predictions
do not produce separate audio tracks for each remote voice. Names, voiceprints,
and a model's anonymous speaker channels are also different concepts.

## 2. Recording data flow

Speech-start pre-roll, live system speech sensitivity, and real-call replay
qualification are documented in [LIVE_SPEECH_RETENTION.md](LIVE_SPEECH_RETENTION.md).
Sample continuity across jittered capture callbacks and issue #40 qualification
are documented in [AUDIO_CALLBACK_CONTINUITY.md](AUDIO_CALLBACK_CONTINUITY.md).
That note also covers the Windows/shared-mixer and macOS follow-ups for #42:
Windows CPAL mic/system blocks and macOS CPAL mic blocks use bounded workers, with
capture timestamps, queued mute state, and stop/drain ordering owned by
`audio/stream.rs`, `audio/pipeline.rs`, and `audio/recording_manager.rs`.
CPAL capture age is converted to block-end recording seconds before processing.
The shared mixer uses its full 400 ms missing-source allowance and drains input
before enforcing further waiting; it no longer pops queued samples off the front.
Per-instance local logs count inserted silence and discarded late samples.
Timeline resets save both pending source tails before replacing the mixer origin.
Windows Stop gates new callbacks and bounds native cleanup to three seconds per
stream; new capture is blocked while timed-out cleanup still owns a native stream.
Twenty-two pipeline regressions passed on Windows, including ten-minute dual
source skew/stall replays, bounded missing-source output, and queued mute state.
The ignored `audio::pipeline::hardware_qualification` test opens explicitly named
Windows endpoints and exercises the production mic worker, dual VAD, mixer, and
native Stop without saving audio. See the continuity note for its opt-in command,
results, and limitations (especially silent microphones and omitted ASR).
The corrected 11-minute G733 capture-only soak passed with 35 ms native Stop and
all nonzero system samples preserved. The microphone supplied silence; speech
retention remains unqualified. The native suite passed 370 tests (ten opt-in tests
ignored normally), including 22 pipeline and eight worker regressions.
Published previews predate these corrections; see the linked continuity note
for verification and limits.
The #42 follow-up uses `audio/capture_worker.rs` for explicit close/drain and a
bounded wait independent of retained native callbacks. Its five std-only
regressions passed on synthetic inputs; physical Mac Stop, missing microphone
audio, and live-text gaps remain unqualified (see the linked continuity note).
`AudioMixerRingBuffer` also recovers a source clock left behind emitted silence
or a full-window callback loss, but only once fresh capture timestamps reach the
un-emitted timeline. Old queued frames still cannot overwrite saved silence.
All 17 native pipeline regressions passed on Windows. Mac candidate builds run
worker and source-continuity regressions before upload.
The separate macOS system tap in `audio/capture/core_audio.rs` now survives
ring-buffer pressure and closes its async wake registration race; neither path
has a physical macOS reproduction/qualification yet.
`frontend/src/app/layout.tsx` now loads packaged Inter font files from
`@fontsource-variable/inter` rather than fetching Google CSS during a Next
production build. `globals.css` owns `--font-sans`, and `frontend/pnpm-lock.yaml`
pins the bundled font package; this removes a network-dependent build step.

Meeting details layout lives in `frontend/src/app/meeting-details/page-content.tsx`:
the transcript/notes separator stores its width locally and supports pointer and
keyboard resizing. Pane stacking now responds to the actual content width (which
the sidebar can reduce), not just viewport width; this retains the minimum
transcript and notes widths from issue #25. The existing wrapped toolbars and
Export access remain in `components/meeting/MeetingHeader.tsx` and
`MeetingDocument.tsx`. Narrow-content browser checks are still required.

```text
recording_commands.rs: start command
  -> initialize selected live diarizer before capture (blocking work off Tokio)
  -> recording_manager.rs: devices + recording state + capture/pipeline
     -> pipeline.rs: align microphone and system audio into windows
        -> separate VAD processors for microphone and system
           -> optional EchoGuard compares aligned tracks and filters mic playback
              before mic VAD/preview; filtered mic.mp4 supports post-call processing
           -> vad.rs: resample to 16 kHz
              -> continuous observer BEFORE silence removal
                 -> system only: live_nemotron::feed(recording_sample, audio)
              -> VAD speech turns -> transcription queue
                 (Labs near-live: quiet-frame split at about 2 s even without silence)
              -> latest-only provisional snapshots per source (Labs + Parakeet)
        -> persist mic/system source tracks and mixed playback audio
     -> transcription/worker.rs: transcribe each source's speech turn
        -> provisional Parakeet worker shares the model and yields to queued final turns
           -> near-live-caption event (UI only; never saved)
        -> microphone: You
        -> Pyannote selected: online embedding/centroid speaker matching
        -> Nemotron selected: query streaming timeline by turn start + duration
        -> transcript-update event
           (Labs mic playback suppression: compare final mic/system ASR text
            and timing before saving; bounded pending mic turns)
           -> frontend TranscriptContext + live transcript view
              (Labs near-live: display joins interleaved chunks per speaker)
           -> native recording transcript accumulator/save path
        -> near-live-finalized event clears replaced provisional text
```

### Source files to read together

Paths below are relative to `frontend/src-tauri/src/` unless marked frontend.

| File | Owns / why it matters |
| --- | --- |
| `audio/recording_commands.rs` | Start/stop orchestration, selected-engine initialization, task lifetime, and transcript-update saving. Both recording start entry points need consistent behavior. |
| `audio/recording_manager.rs` | Starts capture and the audio pipeline, coordinates source state and recording storage. |
| `audio/pipeline.rs` | Alignment, independent source VAD, queueing completed turns, source/mixed track persistence, final audio drain. |
| `audio/vad.rs` | Resampling and VAD clocks. `process_audio_observed` supplies continuous 16 kHz audio before speech segmentation. |
| `audio/near_live.rs` | Durable Labs flag, speech cap, and latest-only per-source preview channels. The pipeline snapshots the flag at recording start. Preview text never enters `transcript-update` or the save path. See [NEAR_LIVE_CAPTIONS.md](NEAR_LIVE_CAPTIONS.md). |
| `audio/echo_guard.rs` | Opt-in Labs mic playback suppression. A bounded reference to system audio estimates delay and removes strongly correlated playback from the mic transcription/source track. The mixed playback keeps original mic audio. See [MIC_PLAYBACK_SUPPRESSION.md](MIC_PLAYBACK_SUPPRESSION.md). |
| `audio/retranscription.rs` | With the mic playback Lab enabled, drops mic ASR turns that repeat overlapping system text before replacing post-call transcript rows, including on existing recordings with both source tracks. |
| `audio/transcription/worker.rs` | ASR execution and the final speaker/source string carried by transcript updates. |
| `diarization/online.rs` | Selects the live engine at recording start; retains the existing Pyannote/WeSpeaker online clustering implementation. |
| `diarization/live_nemotron.rs` | Dedicated streaming inference thread, bounded queue, timestamped history, overlap lookup, error notification, and input-close/stop distinction. |
| `diarization/nemotron.rs` | Validates the pinned model and adapts the attributed Sortformer API to Meetily. Live configuration must not change offline defaults. |
| `diarization/sortformer/` | Attributed model implementation, including speaker cache, feed/flush, streaming profiles, and ORT session construction. Preserve license/attribution. |
| `audio/recording_saver.rs`, `audio/incremental_saver.rs` | Persistent transcript/source hints and recording tracks. A displayed rename alone does not update every save path. |
| `frontend/src/contexts/TranscriptContext.tsx` | Frontend transcript events, ordering/buffering, local recovery, and live state. |
| `frontend/src/components/recording/LiveSession.tsx` | PR #39 live screen receives bounded provisional events and projects them into display-only lines, with optional mic preview deduplication. |
| `frontend/src/lib/labs-features.ts` | Syncs the two native-backed Labs switches and applies them before persisting the WebView mirror. |
| `frontend/src/components/VirtualizedTranscriptView.tsx` | Labs near-live display joins each speaker's short chunks even when the other source has an intervening turn; saved chunks are unchanged. |

### Time and identity invariants

- Capture/pipeline input is currently configured at 48 kHz. The streaming observer
  receives **16 kHz mono**, using the exact same resampled audio as VAD.
- Observer start positions and Sortformer segment boundaries use **16 kHz sample
  indices**. Transcript chunks carry recording-relative **seconds**. VAD speech
  boundaries expose **milliseconds**. Convert explicitly at boundaries.
- The observer position includes the VAD frame buffer, not just processed frames.
  Ignoring that buffer causes timestamp drift between diarization and transcripts.
- Preserve silence and timeline gaps. Concatenating VAD speech turns without
  their gaps is not a continuous recording and corrupts streaming timing.
- Mic and system audio must not be mixed before source attribution. Microphone
  audio retains `You`; remote model channels remain `Speaker N`.
- Speaker channels are meeting-local. The live model/cache is recreated for each
  recording. Changing settings during a call affects the next live session.
- One transcript turn currently gets one greatest-overlap label. Do not split
  text or fabricate word timestamps to represent within-turn speaker changes.

### Worker and shutdown ownership

The capture path only attempts a nonblocking send. A dedicated thread owns the
Nemotron model; ASR workers read its shared timeline rather than running model
inference on the capture/Tokio thread. The queue holds 600 50 ms windows. Full or
disconnected input reports an error and disables that session's labeling.

`finish()` closes streaming input after the pipeline has submitted its remaining
audio. The worker drains, flushes its final lookahead, and publishes a completion
watermark. **Do not destroy the timeline at this point**: final transcription
turns still need it. `stop()` releases the session after transcription processing
has been drained by recording-stop orchestration. Startup failures also clean up
the live session.

The low-latency profile buffers 1.04 s of audio, emits 0.72 s strides, and uses
0.32 s lookahead. These model parameters are not an end-to-end UI latency claim:
VAD boundaries, ASR time, and queue load also contribute. Timeline lookup waits
at most 1.5 s; history is limited to ten minutes. Missing/failed results retain
source labels rather than guessing a speaker or switching engines.

## 3. Post-call processing and model selection

Explicit meeting images use `meeting_images.rs` and the `meeting_images` table.
The image file lives in the recording's `images/` directory; the row is keyed
by folder path so live capture can be saved before the meeting row exists.
`MeetingImages.tsx` handles paste and one-frame display capture in the Notes
panel. `RecordingScreenshotButton.tsx` adds the same one-frame capture to the
recording bar and navigation pill; `screen-image.ts` owns display-stream cleanup.
The button remains busy through selection and saving, checks that recording is
still active, and notifies the Notes strip after saving. It reads the native active recording duration (seconds excluding pauses)
for live images and the player position for images added post-call. Capture is
user initiated and does not block the audio callback. A 1920-pixel JPEG limit
and an 8 MB native payload limit bound storage per image. Screen capture requires
platform support and separate screen permission; paste remains available if the
WebView does not support `getDisplayMedia`. Images are timestamp indexed but not
OCR indexed. No image is included in AI summary input.
The post-call meeting page loads these rows with `list_meeting_images` and
`VirtualizedTranscriptView.tsx` interleaves each thumbnail at its recording-relative time.
`lib/transcript-image-layout.ts` splits display text before speaker runs are merged;
a screenshot prevents re-merging across that point, and subsequent speech starts
a new row for the same speaker. Saved word timings (milliseconds) choose the text
break against image times (seconds). Older turns without aligned word timings use
a proportional display-only text estimate. Translation text is partitioned once
without fabricated translated word timings. Original transcript IDs are retained
for speaker edits and search; stored text, word timings and rows are unchanged. Images beyond a partially loaded
transcript wait for later pages. The Notes panel and transcript share an image
change event so additions and deletions appear without reopening the meeting.
On Windows, `convertFileSrc` uses `http://asset.localhost`; the Tauri image CSP
must allow that origin or saved JPGs appear as broken thumbnails. Existing saved
images need no migration. This display does not infer slide content or embed
images in exports.

Deleting a meeting now offers separate choices in `DeleteMeetingsDialog.tsx`.
`meeting-actions.ts` passes `deleteLocalFiles` to `api_delete_meeting`: the
default removes Meetily's database rows while keeping the recording folder;
the destructive choice deletes the database-owned folder through the native
recordings-root guard before removing database rows. A folder referenced by
another meeting is retained and the operation fails. This removes files in
that folder, including audio, transcript exports, and images, but does not
remove unrelated files elsewhere or restore a meeting after a later database
failure. The Notes screen capture uses the macOS system picker through
`getDisplayMedia`; Meetily can clarify how to select a window but cannot
restyle the picker’s outline or Share This Window button.

The macOS computer-audio warning now uses output-device readiness, not a silent
five-second tap probe as evidence of denial. A true probe remains a session
verification; false is inconclusive. Actual recorder start errors still report
capture failure. The post-call Nemotron prompt uses a single footer Continue
action to start automatic detection; Pyannote count selection is unchanged.
The Windows CUDA local-test build passed Next production type/build checks, a
native compile, and the focused PNG/JPEG header test. Its unsigned NSIS archive
passed `7z t`; real screen-picker, clipboard, recording-clock, and macOS capture
behavior remain device tests. This local installer is not a published release.

Summary-generated title ownership, placeholder rejection and completion refresh
are documented in [SUMMARY_GENERATED_TITLES.md](SUMMARY_GENERATED_TITLES.md).

`diarization/mod.rs` owns persisted engine settings and offline command dispatch.
Nemotron is Auto-detect only; manual counts belong to Pyannote. Rerunning speaker
identification must preserve transcript text, row identity, and timestamps.
With the mic playback Lab enabled, remote rows require a retained overlapping
mic transcript before diarization may include `You`; this prevents processed
mic echo from restoring a removed false user label. The Lab also strips an
unconfirmed `You` from an already saved combined label on rerun.
Read [PR34_NEMOTRON.md](PR34_NEMOTRON.md) before changing that contract.

Frontend post-call sequencing lives in
`frontend/src/components/MeetingDetails/PostCallProcessingWorker.tsx`, owned above
navigation by `frontend/src/contexts/PostCallJobsContext.tsx`. The page's
`PostCallProcessingDialog.tsx` registers/detaches only its view. Completion and
transcript refresh target the matching mounted meeting; inactive meetings refresh
on return. See [OCTOBER_PR_INTEGRATION.md](OCTOBER_PR_INTEGRATION.md) for cancellation
ownership and lifecycle limits. Related
speaker/retranscription dialogs. `useDiarizationEngine.ts` refreshes selected-engine
state for dialogs, including native activation events and stale-response guards.

Live ASR and post-call ASR defaults are independent. Optional Whisper activation
saves the **post-call** default; it must not replace the live Parakeet selection.

## 4. Optional download ownership and UI synchronization

### October integration interfaces

- `speakerUtils.ts` splits overlap labels for display and live aliases. Native
  `PeopleRepository` renames exact components transactionally; optional `from` on
  `reassign_transcript_speaker` selects one component without losing other voices.
  Speaker edits preserve transcript rows, text, timestamps, and source provenance.
  Coverage: `combined-speakers`, `combined-speaker-edit`, `live-speaker-edits`, and
  the native person-repository regressions.
- Markdown export uses `exportMarkdownFrontmatter.ts` and the current
  `useCopyOperations` hook. Named overlap components get separate optional links;
  generic labels do not become contacts. Other formats retain their old rendering.
- Vocabulary IPC names are now model-neutral (`api_get_vocabulary`,
  `api_save_global_vocabulary`, `api_save_meeting_vocabulary`). Existing vocabulary
  database tables remain. `parakeet_engine/model.rs` owns glossary token boosts and
  post-decode canonicalization; the seven synthetic regressions are not speech
  accuracy qualification. Import/live/post-call paths pass the saved glossary.
- Linux source builds map transcription `hipblas` to llama-helper `rocm` and
  resolve distro-specific SDK paths. Four ROCm parser regressions and normalized
  shell syntax checks ran; actual AMD build/inference did not.

See [OCTOBER_PR_INTEGRATION.md](OCTOBER_PR_INTEGRATION.md) for reviewed but blocked
PR #22/#38, qualification, and release status. These changes are source work;
published v0.2.20 installers do not contain them.

`frontend/src/contexts/OptionalModelDownloadsContext.tsx` owns optional jobs above
onboarding and Settings so normal navigation does not cancel them. This is not an
OS background service. An app exit and a WebView reload are different lifetimes.
The top-right `DownloadProgressToastProvider` consumes these same jobs alongside
Parakeet/summary transfers, including verification and activation progress; it
does not start downloads or duplicate optional completion notifications. See
`tests/download-progress/background.test.tsx` for the panel/provider integration.

For Nemotron, `download_diarization_models` in `diarization/mod.rs` performs the
verified download **and persists engine activation in native code**. On success
it emits `diarization-engine-changed`. This prevents page reloads from discarding
a required preference save in an abandoned JS completion callback.

The native event updates the optional-download card, Diarization Settings, and
open speaker dialogs. The frontend `optional-model-preferences-changed` DOM event
also refreshes preference views for frontend-triggered changes. These events are
different transports; neither is itself the persisted source of truth.

Read [NEMOTRON_NATIVE_ACTIVATION.md](NEMOTRON_NATIVE_ACTIVATION.md) for the regression
and installed-app test. Read [V0219_BACKGROUND_SETUP.md](V0219_BACKGROUND_SETUP.md)
and [V0220_OPTIONAL_ACTIVATION.md](V0220_OPTIONAL_ACTIVATION.md) as historical notes;
later fixes supersede earlier behavior. The post-v0.2.18 follow-up moves optional
Whisper activation into `whisper_download_model(enablePostCall=true)` and adds
native `uninstall_optional_model` ownership in `optional_models.rs`; see the
updated native-activation note for locking, settings events, tests, and limits.

## 5. Acceleration and packaging are separate from ASR selection

Windows Nemotron uses the pinned shared ONNX Runtime/DirectML integration, with
CPU-session recreation when provider initialization fails. It does not inherit
Whisper's CUDA/Vulkan/CPU backend selection. Read `onnx_runtime.rs`,
`frontend/src-tauri/build/onnxruntime.rs`, and the Sortformer session builder before
changing runtime loading or execution-provider settings.

Labs Parakeet GPU acceleration is a separate native preference in
`parakeet_engine/labs.rs`. It reloads the selected Parakeet model and places the
encoder session on DirectML device 0; the decoder and preprocessor remain on
CPU. Provider initialization errors are reported to Settings and the prior
preference/model is restored. This does not change Nemotron or Whisper's
backend. `get_local_stack_status` reports the native preference to the Local
stack UI; its previous Parakeet CPU pill was fixed text. An ignored test with
the installed v3 INT8 model and synthetic silence confirms encoder nodes run
on both DirectML and CPU; real speech performance remains unqualified.

The universal Windows build script is
`frontend/scripts/build-universal-windows.ps1`. It packages CPU/Vulkan/CUDA app
variants; the runtime payload must match the one validated in tests. Validate with
`node frontend/scripts/verify-windows-release.mjs`.
The packager reads release notes with .NET `ReadAllText` so Windows PowerShell
does not attach provider/filesystem metadata to updater `notes`. The payload
verifier requires `notes` to be a string. This was caught during v0.2.18 draft
preparation; the manifest/checksums were regenerated and reverified without
changing the signed executable payloads.

## 6. Tests, qualification, and historical notes

macOS publication supports an explicitly labeled CI-qualified preview via
`publish-macos.yml` (`preview=true`). It records no physical-test attestation,
publishes a separate non-Latest prerelease, and retains artifact/hash/source
provenance and public launch checks. Stable publication still requires the
physical checklist. Documentation/publishing-only commits may follow a candidate;
application, dependency, and build-workflow changes require a new candidate.
See `.github/workflows/MACOS_RELEASE.md` for dispatch and remaining limitations.
The `v0.2.19-macos` preview packages the #42 callback change; build
`36790029640` and published-asset smoke test `36790877680` passed. It remains
unqualified for physical microphone capture and the reporter's device. The
Windows Latest release is now v0.2.20; see
[RELEASE_V0220_QUALIFICATION.md](RELEASE_V0220_QUALIFICATION.md) for Windows build,
hardware-capture, installed-upgrade, and public updater verification.
The `v0.2.20-macos` follow-up packages explicit worker shutdown and short-gap
source recovery for #42. Apple Silicon build `36876715270` passed all 22 worker
and pipeline regressions plus bundle/launch checks; public smoke test
`36878960910` passed. See [RELEASE_V0220_MACOS.md](RELEASE_V0220_MACOS.md) for
provenance. Physical recording and live-transcription confirmation remain open.
The Windows VirusTotal submission normalizes CRLF checksum manifests before
filename matching and Linux checksum verification.

Live system-meter warnings are documented in
[SYSTEM_AUDIO_LEVEL_ADVICE.md](SYSTEM_AUDIO_LEVEL_ADVICE.md).

See [PR39_INTEGRATION.md](PR39_INTEGRATION.md) for capture-readiness, setup
gating, quiet-speech and meeting-scoped speaker-edit recovery corrections.

### Home meeting library

In the v0.2.18 workspace, the meeting library lives in
`frontend/src/app/meetings/page.tsx`. Each row can expand in place, and the
button beside a date expands or collapses all currently filtered meetings in
that section. `api_get_meetings` batches stored summary results and transcript
speaker labels with duration/group data; `SidebarProvider` carries the preview
fields to All meetings. Only explicitly named speakers are listed. The restored
`frontend/src/lib/summary-buckets.ts` reads Markdown, BlockNote, and older
section summaries for a brief AI summary and up to three short Key Topics.
Existing row selection, rename, group, export, delete, and Open meeting actions
stay independent of expansion. Parser tests cover stored formats and topic
labels; native compilation and the frontend production build cover the API/UI
integration. Summaries follow the saved result and can be stale until the
meeting list refreshes; an absent summary stays an explicit empty state.

`components/Sidebar/index.tsx` renders the text-only **Meetily · Actually Free**
wordmark, with the original blue/soft-blue colors on one line. It opens About;
the adjacent collapse control remains separate. The 16px wordmark was visually
checked in browser preview at the default 256px rail width (no clipping or
overlap), and the production frontend build/type validation passed.
The rebuilt v0.2.18 Windows package passed payload/signature verification and was
installed locally; the installed CUDA executable matched its packaged hash.
Installed-WebView inspection confirmed the single-line text, 16px size, no image,
and no overlap with Collapse. Startup, Nemotron availability, database integrity,
all six meetings/68 transcript rows, model hashes and preference values were
verified after upgrade. The app was reopened normally; this is not a publication.

`frontend/src/app/home/page.tsx` renders the date-sorted meeting library and is
the Tauri startup route (`/home`). The recording-ready screen remains `/`; the
sidebar's New Recording action opens it. `SidebarProvider` owns the shared meeting
list and refresh/error state. `api_get_meetings` in `api/api.rs` batches saved
summaries and transcript labels, returning raw summary data, a plain-text preview,
and distinct custom speaker names in first-spoken order alongside date/duration.
Generated/source labels are excluded using `is_person_name`; these names are only
meeting display snapshots, not inferred cross-meeting identities. Home and meeting
details share the legacy/Markdown/BlockNote topic classifier in
`frontend/src/lib/summary-buckets.ts`. Home groups full-width meeting cards by
local date, connects each day's cards with a timeline, and filters title, named
participants, summary, and topics with the search field. Cards show a short
summary paragraph and at most three short Key Topics labels. Topic bullets with
label/explanation markup display only the label; the full summary is retained.
Missing summaries remain an explicit empty state. Cards link to the existing meeting detail route; Home
refreshes its list on entry after a summary is saved. `StartupTranscriptRecovery`
now mounts in the shared layout so IndexedDB recovery checks still run when Home
opens first. Tray/notification start events from Home route to `/` with the
auto-start flag for the recording hook. Topic extraction remains heuristic and
depends on a recognizable Key Topics heading or legacy section. Verification
covers frontend/native builds and the Windows installer payload; a local installer
is not a published release.

### Speaker colors in transcripts

`speakerUtils.ts` supplies the shared dot/text palette for the live and post-call
virtualized transcript, the live speakers list, the person card and the identify
dialog. The Tailwind scan must include `src/utils`, where the palette class names
are declared, or named speakers can render without a dot or text color in
production. A named person is drawn in their avatar's colour (`colorForName`),
so they look the same in the transcript, the meeting header and their contact
page; their transcript bubbles take a faint wash of it (`.af-speaker-bubble`).
Unnamed voices ("Speaker 2") get palette slots by first-spoken meeting order, so
they stay apart until identified; `You` uses the theme accent. The palette has
eight slots, so meetings with more than eight unnamed voices reuse colors.
The focused `tests/lib/speaker-colors.test.mjs` checks slot continuity and the
contact colour; the Next production CSS output must also contain every dot
palette class.

Labs roadmap features 1, 3, 7, 8, and 12 are mapped in
[LABS_MACWHISPER_FEATURES.md](LABS_MACWHISPER_FEATURES.md). Read it before
changing meeting detection, recorded audio seeking, named voice enrollment,
Whisper silence thresholds, or the clean transcript display. Settings > Labs
holds the switches (`LabsSettings.tsx`, `lib/labs-features.ts`); the Whisper,
voice-profile and Parakeet GPU switches also persist in native app data so they
survive a WebView reload. Each feature also appears where it is used: the
automation switch in Meeting detection, the waveform, slower speeds and
Clean/Verbatim switch in the meeting player, voices on each contact's page and
in the speaker card, and per-app capture (not a Labs feature) in Settings >
Recording and the record card's system audio panel. Named profiles use
WeSpeaker embeddings in Pyannote live sessions and as a separate identity
matcher for Nemotron live and both post-call paths. Nemotron remains the selected
diarizer; its channel numbers never establish persistent identity.

From `frontend/`, run all frontend test files in separate Bun processes. The
portable runner discovers `tests/**/*.test.{js,mjs,ts,tsx}` and fails if any file
fails. CI uses the same command, including optional-download, diarization, Labs,
and audio-level lifecycle tests. Isolation is required: summary-language tests
define a read-only `window`, while meeting-automation tests install their own
window; combining them in one Bun process caused repeated CI failures.

```text
pnpm dlx bun@1.3.10 scripts/test-isolated.mjs
pnpm run build
```

Native tests containing `live_nemotron` cover timeline attribution, retained tail,
history bounds, and the resampled observer clock. With the project's native build
prerequisites configured, use `cargo test -p meetily --lib live_nemotron` and the
appropriate platform feature flags. Windows qualification uses release binaries
and the packaged shared runtime; local `.build-tools/` scripts are environment-
specific conveniences, not substitutes for documenting prerequisites/results.

Ignored real-model tests require `MEETILY_NEMOTRON_MODEL` and
`MEETILY_NEMOTRON_WAV` (16 kHz WAV). The identity test optionally reads
`MEETILY_NEMOTRON_EXPECTED`, a JSON array of `{voice, start, end}` in seconds.
Run with `--ignored --nocapture --test-threads=1`; a normal unit-test pass does
not mean these model tests ran. Use nonprivate fixtures and report synthetic
throughput separately from real-call accuracy and concurrent-ASR performance.

Do not run Next builds concurrently with native commands embedding `frontend/out`
or with standalone TypeScript checking. When using pnpm in this environment,
`PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false` avoids the known store-layout issue.

| Note | Purpose |
| --- | --- |
| [LIVE_NEMOTRON_AND_PR36.md](LIVE_NEMOTRON_AND_PR36.md) | Live implementation, qualification, limitations, and assessed PR #36 scope. |
| [PR34_NEMOTRON.md](PR34_NEMOTRON.md) | Model provenance, hardening, DirectML qualification, and release numbering. |
| [V0218_DOWNLOAD_FIX.md](V0218_DOWNLOAD_FIX.md) | Async stack-overflow diagnosis; keep large checksum buffers off the future's inline stack. |
| [NEMOTRON_NATIVE_ACTIVATION.md](NEMOTRON_NATIVE_ACTIVATION.md) | Native download/activation lifetime regression and verification. |
| [UPSTREAM_0_4_1_PORTS.md](UPSTREAM_0_4_1_PORTS.md) | Selective upstream integration decisions. |

The public release documented in README is distinct from a local candidate.
Development labels 0.2.18–0.2.20 in historical notes were consolidated into the
0.2.17 candidate after checking GitHub's published 0.2.16. Re-check the actual
release state before future version work; do not treat this historical statement
as a permanently current release number.

### Transcript layout preference

Settings > General, under Theme, offers left-aligned speaker names.
`lib/transcript-layout.ts` owns the WebView preference and change notifications;
the shared `VirtualizedTranscriptView` uses a left name column and indented
plain text for both local and remote speakers, in live and saved meetings.
The default bubble view remains available. Speaker clicks, colors, seeking,
virtualization and saved transcript data retain their existing owners. Production
frontend build/type validation passed; Chrome preview verified aligned live/saved
turns, the fixed caption box, and its stable paused state using synthetic meetings.
The preference is local to WebView storage and does not change exports.

Transcript appearance: `src/lib/transcript-layout.ts` owns persisted left-column and hide-speaker-dots preferences, shared through storage/events. Theme settings expose the dot option beneath left alignment. `VirtualizedTranscriptView` keeps the name/dot row together and places timestamps on a separate row below names in the left column; transcript content and provenance are unchanged. Production frontend compilation checks these interfaces.

The hide-speaker-dots preference is independent of left alignment and applies
to transcript names in both bubble and column layouts. Voice enrollment progress
is owned by `VoiceProfileNotifications.tsx`; model/sample selection and native
retry after saved post-call changes are documented in
[LABS_MACWHISPER_FEATURES.md](LABS_MACWHISPER_FEATURES.md). Supervised per-app
client recovery and its opt-in Windows fixture are documented in
[AUDIO_CALLBACK_CONTINUITY.md](AUDIO_CALLBACK_CONTINUITY.md).

### PR frontend CI dependency ownership

`frontend/pnpm-workspace.yaml` owns dependency overrides and build-script policy.
Regenerate `frontend/pnpm-lock.yaml` with CI's pnpm 11.9.0 whenever overrides
change; CI deliberately uses `pnpm install --frozen-lockfile` to detect drift.
PR #38's lockfile omitted the override configuration and prevented every later
check from running. Its CI action pins now use Node.js 24 runtimes.
The engine-selection fixtures resolve the newest status request because the hook
refreshes after listener registration to close the subscription gap; earlier
responses remain stale. Verification uses frozen installation, all 30 isolated
frontend test files, the production build, and a subsequent TypeScript check.
These checks do not qualify native capture or model/audio behavior.

### Combined speaker labels (issues #44 and #45)

Overlap labels retain the diarizer's ` + ` separator. `speakerUtils.ts` splits
components for display and live aliases: `You + Speaker 1` displays the local
user name plus the remote label, and has a distinct identity key from `You`.
The shared display helper is used by transcript views and copy/export.
`SpeakerIdentityDialog.tsx` offers a component selector for overlap labels;
meeting-wide edits rename that component everywhere, while per-line edits send
an optional `from` component to the native `reassign_transcript_speaker` command.
`PeopleRepository` updates only matching components inside a transaction and
keeps other voices, row IDs, text, timestamps and source provenance intact.
Merges deduplicate equal labels. Ambiguous legacy per-line calls fail rather
than replacing a combined label; single-speaker calls remain compatible.
`person_speakers` links named components independently without a schema change.
Live history, buffered turns and meeting-scoped recovery apply component aliases;
per-line overrides retain the other components.

Regression coverage includes shared display/export labels, exact matches
(`Speaker 3` versus `Speaker 30`), UI selection/IPC, live recovery, and native
SQLite rename/reassignment preserving text/times/source and meeting isolation.
The 32 isolated frontend test files and 17 native person-repository tests passed
on Windows (CPU feature configuration, synthetic in-memory database fixtures).
Production frontend build/type validation covers the affected interfaces.
No real audio/model test, installed-app update or release is implied. Existing
renames that left stale overlap components can be repaired by selecting that
remaining component and assigning the existing contact; labels already lost by
older per-line edits cannot be inferred back from transcript text.


Timed-image placement regression coverage uses a synthetic hour-long speaker turn,
multiple/simultaneous screenshots, pre-speech and gap images, pagination deferral,
legacy untimed text, translation preservation, and unchanged source/word data.
The frontend production build and isolated regression suite verify this projection;
exact text placement in older recordings without word timings remains approximate.

### Promoted settings and voice-profile learning

Waveform scrubbing is in General and Clean Transcript is in Transcription, both
on by default for absent preferences. Voice Profiles owns profile matching,
automatic enrollment, individual and bulk refresh, and an opt-in session-consensus
matcher. Existing preference keys and native files preserve saved choices. The
native `queue_voice_profile_learning` task owns bulk progress after navigation;
one enrollment worker serializes it with automatic and contact-level enrollment,
while a bounded cached WeSpeaker model runs only on blocking workers. Manual
refresh selects twelve windows per meeting across twelve recent meetings, replaces
repeated shares and validates normalized embeddings. See the linked
[voice-profile feature note](LABS_MACWHISPER_FEATURES.md#voice-profiles-settings-and-bounded-learning-october-2026)
for research, worker lifetimes, interfaces, tests, legacy behavior and accuracy limits.

Voice matching score is persisted natively via `get/set_voice_profiles_match_threshold`
and edited in Voice Profiles. Both matchers require repeated clear-window evidence;
automatic first enrollment now shares the twelve-window budget. The linked voice
feature note documents sample exclusion, consensus fallback and diagnostic limits.

Tentative lower-score candidates use `get_possible_voice_match` and the shared
`PossibleVoiceMatch.tsx` live/saved UI. Only explicit acceptance enters the existing
speaker rename flow; the voice feature note records bounds and unavailable tracks.

Live match correction retains `speaker_channel` through transcript events and
native history/export. Forward corrections are sequence-scoped in live-speaker-edits
and replayed during reload/crash recovery; detachment blocks only the chosen native
channel until session end. Automatic sample updates and keyboard naming are
documented in the linked voice feature note.

Transcript line duration is a persisted, disabled-by-default Transcription display
preference (`TranscriptLineLimitSetting.tsx`, `lib/transcript-line-limit.ts`).
Enabled defaults to one whole minute, with larger values allowed. Live interleaving
and final speaker-run merging honor the limit; long saved rows are split using word
boundaries or approximate legacy offsets. Source IDs, words, screenshots and
translations survive the display projection; recorded/saved text and source
attribution are not rewritten. Tests cover preference persistence/validation,
long timed/legacy rows, screenshot/translation placement and live merging.

Post-call translation targets in `app/meeting-details/page-content.tsx` include
English. The existing translation command receives the selected language name;
no transcript storage or translation-provider interface changes are needed.
Production frontend compilation verifies the menu change; actual translation
quality depends on the configured LLM and was not requalified for this addition.

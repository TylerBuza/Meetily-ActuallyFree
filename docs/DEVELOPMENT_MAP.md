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
panel. It reads the native active recording duration (seconds excluding pauses)
for live images and the player position for images added post-call. Capture is
user initiated and does not block the audio callback. A 1920-pixel JPEG limit
and an 8 MB native payload limit bound storage per image. Screen capture requires
platform support and separate screen permission; paste remains available if the
WebView does not support `getDisplayMedia`. Images are timestamp indexed but not
OCR indexed. No image is included in AI summary input.
The post-call meeting page loads these rows with `list_meeting_images` and
`VirtualizedTranscriptView.tsx` attaches each thumbnail below the transcript
turn preceding its recording-relative time. Images beyond a partially loaded
transcript wait for later pages. The Notes panel and transcript share an image
change event so additions and deletions appear without reopening the meeting.
On Windows, `convertFileSrc` uses `http://asset.localhost`; the Tauri image CSP
must allow that origin or saved JPGs appear as broken thumbnails. Existing saved
images need no migration. This display does not infer slide content or embed
images in exports.

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
`frontend/src/components/MeetingDetails/PostCallProcessingDialog.tsx` and related
speaker/retranscription dialogs. `useDiarizationEngine.ts` refreshes selected-engine
state for dialogs, including native activation events and stale-response guards.

Live ASR and post-call ASR defaults are independent. Optional Whisper activation
saves the **post-call** default; it must not replace the live Parakeet selection.

## 4. Optional download ownership and UI synchronization

`frontend/src/contexts/OptionalModelDownloadsContext.tsx` owns optional jobs above
onboarding and Settings so normal navigation does not cancel them. This is not an
OS background service. An app exit and a WebView reload are different lifetimes.

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
later fixes supersede earlier behavior. Whisper still has a frontend completion/
activation path: do not infer that Nemotron's native-lifetime fix covers it too.

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

From `frontend/`, run mock-heavy groups separately:

```text
pnpm dlx bun@1.3.10 test tests/optional-downloads/background.test.tsx
pnpm dlx bun@1.3.10 test tests/diarization/engine-selection.test.tsx
pnpm dlx bun@1.3.10 test tests/hooks
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

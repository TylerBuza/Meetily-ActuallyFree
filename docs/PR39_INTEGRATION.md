# PR #39 integration qualification (unreleased)

Baseline: `9d8113e`, by @jayjoe101, incorporates Claude CLI summaries (#28,
@cedstrom), speaker editing (#36, @ampersandru), and per-app audio/Labs (#38,
@ampersandru, including #37). The v0.2.17 Nemotron implementation is retained.

## Recording corrections

- `audio/capture/per_app.rs`: every Windows capture worker acknowledges readiness
  only after `IAudioClient::Start`. Startup waits for all selected apps with one
  eight-second deadline. A disconnected or late acknowledgement fails startup
  and signals all workers to stop. Completed workers are joined; stalled native
  calls retain ownership of their stop flag until they return. The handshake runs
  on `spawn_blocking` in `audio/stream.rs`, not on a capture callback/Tokio worker.
- macOS currently implements one process tap. Selecting multiple apps now fails
  explicitly before starting instead of silently recording only the first.
- `audio/vad.rs` no longer rejects Silero speech turns using a fixed RMS/peak
  floor. `audio/transcription/worker.rs` similarly skips only digital zero at
  its energy gate and no longer blacklists legitimate short replies. Whisper's
  own no-speech checks and optional Labs threshold remain responsible for
  hallucination rejection. These changes do not guarantee quiet-speech accuracy.

## Setup and speaker edit recovery

`app/layout.tsx` paints a setup-status screen before enabling recording. After
eight seconds it offers retry, but still accepts a late authoritative native
response. Failure never implies onboarding completion. An attempt cleanup ignores
responses from replaced attempts.

The main shell now mounts `RecordingNotice` after setup and crash-report handling.
It reminds users to disclose recording and obtain legally required consent on
each launch. “I understand” dismisses it for that shell lifetime; route changes
do not reopen it. Only the unchecked-by-default permanent acknowledgement option
writes `permanentlyAcknowledged` to the native `recording-notice.json` store.
The save completes before dismissal; failure offers retry or session-only
dismissal. An unreadable preference shows the notice. Tray/notification starts
and meeting automation wait for acknowledgement; the minibar does not mount it.
This is an informational acknowledgement, not participant consent or a native
recording authorization mechanism. A full WebView reload starts a new shell
session and shows the notice again unless permanently acknowledged.
`tests/recording-notice/notice.test.tsx` covers session dismissal, relaunch,
permanent acknowledgement, and preference read/save failures with a mocked store.
Qualification: all 26 isolated frontend test files and the production Next build
passed locally. Browser preview confirmed the notice over the main screen,
session dismissal across navigation, and its return on a full reload. Permanent
storage behavior is covered by store mocks; no new desktop installer was installed
or published for this change.

`lib/live-speaker-edits.ts` journals display edits in localStorage under the
IndexedDB meeting ID. Rename/merge aliases are flattened, and individual-turn
overrides use native sequence IDs because frontend row IDs change on reload.
Writes precede UI edits; failures report that the edit could not be saved.
`TranscriptContext` applies edits to future events and native reload history;
`useTranscriptRecovery` applies them to recovered IndexedDB transcripts before
saving. Native source labels, text, timestamps and audio remain intact. This is
a WebView-storage journal, not a native recording-history rewrite; copying raw
recording files alone does not transport those edits. Journals are meeting-scoped
and retained for crash recovery. Storage cleanup and cross-window editing are
not implemented here.

## Verification

Focused tests cover failed/partial capture readiness, successful readiness,
short-reply retention, meeting isolation, alias restoration, turn overrides,
merges and storage-write failure. Verified on Windows: 343 native CPU library
tests passed (eight model/CLI-dependent tests ignored); 122 frontend tests passed
with mock-heavy groups in separate Bun invocations; Next production build and
type validation passed. The quiet-finalization fixture is synthetic, not a
real-speech accuracy measurement.
The browser preview also completed a sample start/stop/save transition to meeting
details. Preview uses mocked audio/native APIs and does not qualify real capture.
Real Windows/macOS per-app capture, real-call voice matching and sustained
concurrent GPU inference still require hardware testing.

## Local v0.2.18 upgrade (2026-09-28)

The low-audio advisory was adapted to the redesigned recording meters; its three
monitor tests and separate component lifecycle test passed, followed by a Next
production build. CPU/Vulkan/CUDA variants were packaged with the universal
Windows build script. `verify-windows-release.mjs` verified payload hashes,
bundled variants/runtime files, bootstrapper integrity and updater signatures.

The existing v0.2.17 install and its native/WebView data were backed up before
upgrading locally. The installed v0.2.18 CUDA executable matched the packaged
variant. Native IPC confirmed version 0.2.18, completed onboarding and enabled,
available Nemotron; the redesigned workspace rendered successfully. The initial
smoke-check deadline expired before the workspace appeared; a subsequent check
passed. The app was then exited cleanly and reopened without debugging flags.

SQLite integrity passed. Existing meeting content/titles and transcript records
were preserved; startup workspace backfill touched two meeting `updated_at`
timestamps. Existing model files and preferences matched the backup hashes.
This establishes local upgrade preservation and startup, not a full real-call
qualification. v0.2.18 is installed locally, **not published on GitHub**.

## Installed synthetic capture qualification (2026-09-28)

Post-call speaker selection now uses a compact, viewport-centered modal via the
shared dialog portal. Nemotron's **Auto-detect & continue** is the primary action
and starts the existing ordered enhancement/diarization workflow directly;
there is no separate Continue step. Keep live transcript remains a secondary
action. Pyannote retains its count selection and Continue action. Native pipeline
ordering and engine/count semantics are unchanged by this presentation update.

While enhancing, diarizing, or refreshing, `PostCallHandoffCard` now switches
from that modal to a compact, nonmodal progress card in the recording dock.
There is no backdrop or focus trap during work, so the meeting behind it accepts
pointer and keyboard interaction. The prompt and retry/error choices remain
centered dialogs. Presentation changes do not dismiss or restart the ordered
processing workflow; WebView reload durability is not added by this change.

The actual installed CUDA build was exercised with a dedicated Windows test audio
process and the existing synthetic two-voice WAV. Both microphone endpoints were
muted for the tests and restored afterward. Test capture was restricted to that
process; automatic summaries/meeting automation were temporarily disabled and
original preferences restored afterward.

- With the selected test app absent, Start refused capture with a visible
  explanation instead of silently recording another source.
- With it running, native per-app audio reached Parakeet and live Nemotron.
  Twenty-five transcript turns and two remote speaker labels were retained.
- A live speaker rename survived a WebView reload while recording continued.
  Stop/save and reopening the saved meeting retained the name. All 25 saved turns
  matched the pre-stop native transcript text and start/end timestamps.
- The saved mixed/system/microphone files decoded. The microphone track's peak
  was negative infinity (digital silence); existing user meeting/transcript
  content was unchanged.
- A separate quiet synthetic tone triggered the visible Low audio advice in the
  installed recorder. Pausing cleared it. This is a meter/capture test, not proof
  of recognition accuracy on very quiet speech.

These are real installed-app tests with synthetic audio, not a real meeting or
an AMD/Intel/macOS qualification. The separate summary-title regression and fix
are described in [SUMMARY_GENERATED_TITLES.md](SUMMARY_GENERATED_TITLES.md).

# Labs: MacWhisper roadmap features 1, 3, 7, 8, 12

This note reviews the proposed architecture in
`H:/opencode/meetily/CHANGES_0.2.17_AND_MACWHISPER_ROADMAP.md` against this
branch. The attachment is a roadmap and historical inventory, not an
implementation specification or proof that a feature is present in a release.
The current branch already has per-app capture, live/post-call speaker editing,
VAD silence rejection, some Whisper repetition guards, a local-user voiceprint,
recording-relative transcript turn times, and process-based meeting prompts.

## Where each feature lives in the app

All switches are in Settings > Labs, and each feature also shows where it is
used:

- Meeting automation: a switch in Settings > Meeting detection as well. A
  notice says when a call starts a recording (with an option to keep it going
  after the call) and when the call's end stops it. The stop runs the
  recorder's normal stop and save from any page, without reloading.
- Audio and transcript seeking: the meeting player shows the waveform instead
  of a plain track and adds 0.5× and 0.75×. Seeking from a line's timestamp
  and following playback work without Labs.
- Named voice profiles: a Voice panel on each contact's page learns a voice
  from all their recent meetings (up to twelve), updates it the same way so new
  meetings count, or forgets it; the speaker card on a meeting page adds that
  meeting's audio (Remember voice, or Update voice once one exists). A profile
  keeps each meeting's share, so learning from a meeting again replaces its
  share instead of counting it twice; profiles saved before shares were kept
  count as one earlier share. Renaming, merging or deleting a contact updates,
  combines or removes their voice.
- Whisper silence guard and Parakeet GPU: tagged on the engine they change in
  Settings > Transcription.
- Clean transcript: a Clean/Verbatim switch in the meeting player. With Labs
  off the transcript still hides simple fillers, as before.

## Feature 1: meeting automation

`meeting_detection.rs` now includes packaged Teams microphone/camera leases and
Windows browser meeting window titles alongside the existing process and
NonPackaged lease checks. Blocking scans run in `spawn_blocking`, and a monitor
generation prevents duplicate loops after settings changes. The detector emits
`meeting-detected` with `active_media` and `meeting-ended` after 45 seconds of
missing signals. Labs auto-start acts only on an active Windows media lease;
process-only detection still prompts. The frontend stores ownership only after
a successful start and runs the usual stop/save workflow only for an owned
recording. Enabling Labs meeting automation also enables the existing Detection
monitor; switching Labs off leaves ordinary detection prompts available.

The plan's proposal to bind the detected PID directly to per-app capture is not
used. Browser PIDs can contain unrelated tabs, and process capture settings are
independently selected by the user. The detector does not yet meter WASAPI
sessions or distinguish a muted live call from an idle app with an open media
lease. macOS and Linux have no active-media automation signal here. A detection
event is not proof a meeting is underway; users should test the Labs action
against their conferencing apps before relying on it.

## Feature 3: audio and transcript seeking

`get_meeting_playback_audio` resolves the saved mixed audio for a meeting.
The asset protocol streams it to an HTML audio element, while a worker streams
8 kHz mono PCM through FFmpeg to compute one approximate peak per second.
One worker owns waveform extraction at a time; additional requests report busy.
The UI tracks recording-relative seconds, seeks from a transcript turn
timestamp or the waveform, highlights the active turn, and supports 0.5–2× playback. The
virtualized transcript keeps turns separate while seeking, since merging them
would erase individual seek positions.

The roadmap's `TokenData` claim does not apply to the current persisted data:
transcript turns have start/end seconds, but no verified per-word timings.
The UI therefore seeks/highlights turns, never invents word offsets. Waveform
extraction is on demand and may take time for a long recording; its peak history
is bounded to 24 hours. No word-level karaoke claim is made.

## Feature 7: named voice profiles

The existing `voiceprint.rs` belongs to the microphone user only. New
`voice_profiles.rs` stores opt-in WeSpeaker post-LDA embeddings for explicitly
named people, keyed by the existing `people` and `person_speakers` identity.
Enrollment uses the separate system track and, from each meeting, up to twenty
non-overlapping 2–15 second turns bearing that person's saved speaker label,
spread across the meeting. A voice keeps a share per meeting (up to twelve) and
is the mean of all their turns; it requires at least two successful embeddings. The model runs on a blocking worker; capture
does no inference. Profiles are saved in local app data, can be listed and
deleted in Labs, and matching is disabled by default.

On a future Pyannote live session, the remote centroid must clear cosine 0.80
and exceed the next profile by 0.08 before a name is assigned. For Nemotron
live sessions, a separate WeSpeaker matcher compares 2–15 second system-audio
speech turns on the transcription worker and caches a verified name for that
meeting-local channel. Nemotron still owns diarization; its channel number is
never treated as identity. Post-call diarization with either engine compares
at least two clean system-track turns per remote channel against the profiles.
Post-call transcription alone does not run this matching pass. The microphone
still labels `You`. The person link is persisted with the transcript when a
profile name is used. Profiles are a consent-based convenience, not verified
identity. Enrollment and matching need clean turns, a separate system track,
and the WeSpeaker model. Short, overlapping, or uncertain turns stay unnamed.
Profile changes take effect next call for live matching and the next post-call
diarization pass for an existing recording.

Live manual names now create person links when the meeting is saved. For older
meetings whose transcript has a name but lacks that link, enrollment repairs the
link using the saved label. Only generic labels prompt the user to name the
speaker; a named label missing from the saved transcript reports that condition.

## Feature 8: Whisper silence guard

The branch already uses VAD/energy checks, repetition cleanup, Whisper
`set_logprob_thold(-1.0)`, entropy threshold 2.4, and no-speech threshold 0.55.
Labs persists a stricter no-speech threshold of 0.45, read atomically by both
Whisper decode entry points. This may reject quiet speech; it does not imply
confidence calibration. The plan's `compression_ratio_threshold` call is not
available in the pinned whisper-rs API, and token suppression/temperature
fallback claims are not added without verified support.

## Feature 12: clean transcript view

The virtualized view previously stripped some filler words unconditionally.
Labs now provides a reversible clean/verbatim display switch. It removes a
small set of English hesitations and immediate repetitions, then repairs basic
spacing/capitalization. The saved transcript text, speaker, and start/end
times stay verbatim. New summaries use the derived clean text when this Labs
setting is enabled; export paths continue to use the saved raw text. The clean
version is derived at use time, so it does not suppress acoustic tokens,
alter words in other languages, or claim a second timestamp track. More
aggressive phrase removal and LLM rewriting would risk changing meaning.

## Verification and release status

Verification performed on this branch: Next production build, native CPU
`cargo check`, the voice-profile matcher unit test, CUDA native release compile,
and NSIS packaging passed. The CUDA executable imports bundled CUDA 13 cuBLAS,
and the installer SHA-256 matches `dist-labs-cuda-test/SHA256SUMS.txt`.
Earlier targeted meeting detection and waveform tests and frontend Labs tests
also passed before this follow-up. The installed model directory contains the
v3 INT8 ONNX encoder/decoder. An explicitly run ignored DirectML test with
that model and synthetic silence recorded 2,020 encoder node events on
DirectML and 479 on CPU. This establishes mixed-provider execution, not a
real-speech speedup or accuracy result. Real-call qualification remains open.
The installer built with
`frontend/scripts/build-labs-test-windows.ps1` produces an unsigned CPU installer
under `dist-labs-test/`; `-Cuda` produces an unsigned RTX 50-series-capable
Whisper CUDA installer under `dist-labs-cuda-test/`. Both use the same Labs app
identity so an upgrade can retain install-local profiles, models, and meetings.
Nemotron continues using DirectML independently of Whisper's CUDA backend.
The additional Labs Parakeet GPU switch uses DirectML for Parakeet's encoder
while keeping its decoder and preprocessor on CPU. Changing it reloads the
current Parakeet model and reports initialization failure in Settings; real
speech inference on the RTX 5080 still needs installed-app qualification. The
Local stack view now reports the native DirectML setting rather than a fixed
CPU label; it does not claim all encoder operations run on the GPU. The app's
default is `parakeet-tdt-0.6b-v3-int8` from the verified ONNX export. NVIDIA's
upstream NeMo checkpoint and the linked FastAPI project's FP32 CUDA benchmark
are different runtime and precision configurations.
The universal release build is owned by
`frontend/scripts/build-universal-windows.ps1` and must be checked with
`frontend/scripts/verify-windows-release.mjs` when release packaging is
requested. These checks are separate from real-call qualification. No private
recording or biometric profile belongs in the repository. A locally built
installer is not an installed or published release. The attachment's existing
installer path identifies an older build and must not be presented as
containing these Labs changes.

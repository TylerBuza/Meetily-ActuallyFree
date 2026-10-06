# Labs: MacWhisper roadmap features 1, 3, 7, 8, 12

This note reviews the proposed architecture in
`H:/opencode/meetily/CHANGES_0.2.17_AND_MACWHISPER_ROADMAP.md` against this
branch. The attachment is a roadmap and historical inventory, not an
implementation specification or proof that a feature is present in a release.
The current branch already has per-app capture, live/post-call speaker editing,
VAD silence rejection, some Whisper repetition guards, a local-user voiceprint,
recording-relative transcript turn times, and process-based meeting prompts.

## Where each feature lives in the app

Waveform scrubbing now lives in Settings > General and Clean Transcript in
Settings > Transcription; both default on for missing preferences. Saved explicit
choices are retained. Voice settings and saved profiles live in Settings > Voice
Profiles. The remaining experimental switches stay in Labs. Each feature also
shows where it is used:

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

Process-only selection now uses configured app priority and sorted process
names so multiple idle apps cannot rotate the selected candidate on each poll.
The monitor treats helper process changes within one app as the same alert and
keeps its alert state when settings change while detection remains enabled.
Process-only prompts say the app is open; they do not claim a call was detected.
Tests cover stable selection and same-app deduplication. This still cannot
identify the start or end of a call on macOS/Linux when the conferencing app
remains open.

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

Windows issue #43: `audio/waveform.rs::extract_peaks` launches FFmpeg with
`CREATE_NO_WINDOW`, matching the other audio decoding paths. Waveform requests
from the meeting player can spawn this process; a title update itself does not.
The launch flag preserves the piped PCM output and existing worker ownership.
Verification uses the native waveform unit test and Windows compilation; the
unit test checks peak binning, not visible console behavior. Installed-GUI
verification still requires opening an uncached waveform on Windows.

## Feature 7: named voice profiles

The existing `voiceprint.rs` belongs to the microphone user only. New
`voice_profiles.rs` stores opt-in WeSpeaker post-LDA embeddings for explicitly
named people, keyed by the existing `people` and `person_speakers` identity.
Enrollment uses the separate system track and, from each meeting, up to twelve
non-overlapping 2–15 second turns bearing that person's saved speaker label,
spread across the meeting. A voice keeps a share per meeting (up to twelve) and
is the mean of all their turns; it requires at least two successful embeddings. The model runs on a blocking worker; capture
does no inference. Profiles are saved in local app data, can be listed and
deleted in Voice Profiles, and matching is disabled by default.

Originally a future Pyannote live session required a remote centroid at cosine
0.80 with a 0.08 margin. The October matching update below replaces this policy. For Nemotron
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

## First-profile automatic enrollment (September 2026)

Settings > Voice Profiles adds an opt-in automatic first-profile switch beneath
Voice profiles. Its native preference is mirrored through `labs-features.ts`.
Durable speaker relabel/reassignment commands schedule enrollment after contact
link persistence; `api_save_transcript` does the same for names entered live.
The native job owns a cloned database pool and app handle, independent of the
invoking WebView promise. Eight permits bound pending jobs and one native async
mutex serializes enrollment; `meeting_share` performs model inference through
its existing blocking worker. Capture never runs enrollment inference.

Existing profiles are skipped by person ID and rechecked under the write lock,
so automatic enrollment does not replace a manually learned profile. Naming is
not biometric evidence: the normal saved system-track, model, clean-turn and
two-successful-embedding requirements still apply. Failure keeps the contact
and transcript and emits a visible toast; Learn voice remains the manual retry.
Success refreshes the voice-profile views through the shared change event.
Jobs survive navigation, but not app exit, and they are not persisted for restart.
Native compilation, 11 existing voice-profile tests, and three isolated frontend
preference tests (native save, rejection rollback, reload synchronization) passed.
No real-model
or private-audio enrollment fixture was run; first-profile model quality and
live-save enrollment require installed-app qualification.

### Automatic enrollment with Live Caption chunks and post-call updates

Enrollment now joins adjacent same-name saved ranges (up to a 250 ms quiet gap),
subtracts other remote voices, and makes independent 2–4 second audio windows.
Overlapping microphone rows do not disqualify the separate system track. Invalid
ranges and duplicate timing do not become biometric evidence. First automatic
profiles originally used up to four windows spread across available speech; manual learning
uses its twelve-window limit and existing profiles are never overwritten by
automatic saving. At least two successful embeddings are still required.

The automatic worker waits for the shared speaker-operation guard before reading
labels. Retranscription and diarization commit named contact links and schedule
another first-profile attempt after their saved attribution is final. Candidate
queries require a label still present in transcripts, excluding stale links.
Native learning/saved/failed events share a person ID, so a pending toast is
replaced by its actual result and views refresh only after success. Native read
or embedding failures now retain their specific error. The opt-in enrollment
diagnostic reads explicitly supplied model/audio paths and timing, reports only
vector counts, and never writes a profile. No fixture audio or biometric data is
committed. Live manual naming is enrolled once the meeting/source track is saved;
insufficient speech and missing audio/models still report failure.

Qualification for this follow-up: the isolated preference tests (3) and automatic
notification tests (3) passed. The native suite passed 372 tests with 11 optional
fixtures ignored by default. An explicitly run read-only diagnostic decoded the
reported saved meeting's system track using the installed bundled WeSpeaker
model and extracted four enrollment vectors in 33.2 seconds. It wrote no profile,
so it establishes audio/model extraction rather than end-to-end automatic profile
persistence in an installed build. Short-caption grouping, microphone overlap,
remote-voice exclusion, duplicate ranges, and final named-contact links have
synthetic/native regression coverage. The production Next build also passed.

## Voice Profiles settings and bounded learning (October 2026)

`VoiceProfilesSettings.tsx` owns matching, first-profile automatic saving, saved
voices, and opt-in consensus matching. General and Transcription share
`FeatureSettingsSwitch.tsx` for the promoted controls; compatibility keys remain
in `lib/labs.ts`, and native preferences remain authoritative for voice options.
The Defaults change applies when a value is absent, preserving saved true/false
choices. Clean/Verbatim remains available in the meeting player.

Learn more turns refreshes that profile from its latest twelve linked meetings;
Learn all profiles queues the same refresh for each saved profile (up to fifty).
First automatic enrollment uses up to twelve windows. Manual refresh uses at most twelve
independent 2–4 second clear windows per meeting, spread across the recording,
for a maximum of 144 windows per rebuilt profile. Repeated meeting audio replaces
its share, rather than increasing counts. Without new usable recordings a refresh
may not increase the sample count; it is not unlimited accumulation. Legacy
profiles are retained until explicit refresh, which may lower their sample count
under the new budget. Missing/unsuitable audio is reported and a completely failed
refresh keeps the prior profile. Profile audio is not duplicated into storage.

The manual bulk task clones its app handle and database pool in native code,
continues after navigation, serializes with automatic and existing manual learning,
and takes the speaker-operation guard before reading saved labels. One bulk job
may be pending/running, automatic jobs remain capped at eight, and the task reports
per-contact results plus a summary. It stops on app exit and has no restart queue.
Failed contacts do not prevent the other profiles being refreshed. A single cached
WeSpeaker model is mutex-owned by blocking enrollment workers; disabling voice
profiles clears this cache. Valid embeddings must have 128 finite elements and a
nonzero norm, and each new vector is normalized before aggregation. Existing
transactional profile-file replacement and per-meeting shares are retained.

Voice matching has a native-persisted score threshold in Voice Profiles (0.35–0.95,
default 0.55). The getter/setter validate finite values and update an atomic cached
value only after a successful file write. Settings provides a slider, numeric input,
and explicit Save score action; the setting applies to both matching modes.
Read-only qualification of the supplied recordings found genuine post-LDA scores
around 0.56–0.73, which the former 0.80 threshold rejected. These two voices do not
establish a universal accuracy or false-acceptance rate.

Both modes require at least two independent clear speech windows, two-thirds
agreement among confident windows (uncertain samples abstain), and a 0.12 margin over competing profiles. Post-call matching samples
up to eight 2–4 second windows after excluding overlapping remote speech. Live
Nemotron accumulates contiguous exclusive audio, rejects duplicate intervals,
and keeps bounded per-channel evidence instead of permanently caching one name.
Pyannote uses repeated clear embeddings of at least two seconds. Shorter isolated
Pyannote turns can remain unnamed. Capture does not run this inference.
Experimental consensus compares each real meeting mean with equal session weight,
requiring strict majority support and median similarity. Single-meeting and legacy
profiles fall back to their aggregate, still requiring repeated query confirmation.
Mixed-speaker diarization channels can remain anonymous: profile matching does not
repair an incorrectly clustered channel or infer identity from its number.

Research rationale: [Pelecanos et al., Odyssey 2004](https://www.isca-archive.org/odyssey_2004/pelecanos04_odyssey.html)
shows enrollment duration changes score distributions; it does not prescribe a
universal turn count. [Krzywdziak et al., EUSIPCO 2025](https://eusipco2025.org/wp-content/uploads/pdfs/0000026.pdf)
studies aggregation from five enrollment utterances and shows that aggregation
and acoustic conditions matter. Its trained attention backend and ECAPA encoder
are not this app's WeSpeaker system. [Das et al., Interspeech 2016](https://www.isca-archive.org/interspeech_2016/das16_interspeech.html)
studies session variability and template aging. These results motivate diverse
clear sessions and bounded sampling, not a claim that twelve is scientifically
optimal. Twelve is an engineering budget (roughly 24–48 seconds per meeting),
and median/majority consensus is an uncalibrated experimental adaptation, not a
reimplementation or measured accuracy improvement from those papers. More clean,
varied speech can help; duplicated, mislabeled or noisy speech can hurt.

Qualification uses synthetic native vectors/timing fixtures for consensus,
ambiguity rejection, normalized-vector validation, sample bounds and share
replacement; isolated frontend tests cover defaults, native persistence and
individual/bulk UI commands. No real model/audio enrollment or recognition
benchmark was run for the original promotion. Subsequent read-only recording qualification is documented below.

The ignored `voice_matching_recording_diagnostic` accepts external model, profile,
and recording-case paths. It reads audio/profile data without saving or modifying
profiles and logs scores and identities, never vectors or transcript text. Private
fixtures stay outside the repository.

Possible matches: `get_possible_voice_match` reads the current live Nemotron or
Pyannote clear-window history, or samples a saved meeting's separate system track
on a blocking worker. Saved inference shares the enrollment model owner, with at
most two active/waiting suggestion requests. Suggestions need two supporting
windows, a score floor 0.15 below the configured automatic threshold (minimum
0.35), and separation from competing profiles. They ignore session consensus for
candidate discovery. They are advisory and never relabel, link or train by themselves.
The live speaker panel and saved speaker popover show “Maybe [name]?”; Review match
opens speaker identification, where Match this person uses the existing all-lines
or single-line rename flow. Anonymous combined labels and microphone labels are
never guessed. Closing the UI ignores completed results; no audio is cached in JS.
Live suggestions poll existing evidence every three seconds with one request per
visible speaker; saved suggestions compute only when identification UI is opened.
Imported recordings lacking a separate system track have no saved suggestion.

Final qualification: 36 isolated frontend test files and TypeScript checking passed;
19 synthetic native profile tests plus one exclusive-timeline test passed. The
explicitly enabled real-audio diagnostic loaded the installed WeSpeaker models
and existing profiles and sampled the three user-supplied recordings read-only.
Both modes recognized the two separate channels in the second recording and the
clear single-person channel in the third; the third recording's mixed two-voice
channel remained unnamed. The first recording's manually named host channel also
contained windows matching the other voice and correctly lacked a confirmed name.
This is a narrow fixture check, not a diarization/recognition accuracy benchmark,
and does not establish runtime capture quality or mutate installed user data.

### Automatic refresh and correcting live matches

The existing automatic-save preference now means save **and update** named voices.
`get/set_voice_profiles_auto_samples` persists a per-meeting limit from 2 to 12
(default 12); the existing twelve-meeting history cap remains. Saved meetings and
explicit speaker naming trigger native enrollment. Repeated meetings replace
samples rather than inflate counts. Existing profiles update only if the new
meeting aggregate clearly matches that contact; failed/uncertain updates retain
prior samples and report the error. Changing the limit affects subsequent automatic
sampling; manual refresh still uses its twelve-sample budget. This is bounded
profile maintenance, not continuous inference or unlimited accumulation.

Live events and native transcript history/export retain `speaker_channel` separately
from the matched display name. `live-speaker-edits.ts` stores forward corrections by
raw channel and immutable sequence boundary; TranscriptContext and crash recovery
replay them without changing earlier lines, other channels, text, timing or source.
The live and saved naming dialogs default to Every line from the speaker. From this line onward stores a
new channel name and invokes `detach_live_voice_match`, which clears that channel's
voice evidence and blocks its profile matches/suggestions until recording ends.
Queued late results still carry the raw channel, so the forward correction applies.
Older live rows lacking channel metadata support per-line correction only. If the
diarizer reuses one channel for different people later, another forward correction
may be necessary; this does not repair diarization clustering.

Review match sits beside the speaker name in the live panel, with the possible
name below it. The identity dialog focuses its input on open; Enter accepts an
exact contact name (case-insensitive) or adds the typed name, regardless of a
highlighted partial match. IME composition does not submit. Regression coverage
includes typed Enter, safe default scope, forward history replay with sequence 0,
other-channel preservation, sample limits, and previously named overlap editing.

Qualification for these changes: 36 isolated frontend test files and TypeScript
checking passed. Native tests passed: 20 profile tests, 3 recording-saver tests,
and the worker regression. Model/audio fixtures were not rerun; the new correction
checks use synthetic histories and serialization, not an installed meeting test.

Hide speaker dots is an independent Theme preference, aligned with the left edge
of Align speaker names to the left rather than indented as its dependent control.

## Voice matching beta qualification

Moving the controls into Voice Profiles does not graduate identity inference:
recognition remains an opt-in beta, off by default in both frontend and native
preferences. Existing explicit opt-ins are preserved. The category and recognition
switch identify the beta, explain uncertainty and advise reviewing names. Automatic
matches and Maybe suggestions are estimates, never verified identity; microphone
and system provenance remains independent. The settings regression checks the beta
and uncertainty guidance. Synthetic profile tests and contributor recordings do
not constitute an accuracy benchmark or identity verification.

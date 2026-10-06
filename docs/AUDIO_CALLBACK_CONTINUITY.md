# Recording callback continuity — issue #40

## Windows/shared-mixer follow-up — issue #42 (2026-10-01)

Fernando also reported v0.2.18 Windows 11 microphone gaps: exact digital silence
in roughly 10–40 ms multiples, worsening during an 8:38 recording. The file
measurements alone do not distinguish capture loss from mixer padding.

A ten-minute synthetic replay delivers every block from both sources, but varies
arrival order with 100 ppm clock skew and recurrent scheduling stalls after two
minutes. It reproduces lost microphone samples in v0.2.18. The v0.2.20 recovery
change preserves the mic in some cases but loses system samples with 80 ms mic
stalls. Thus the published Mac preview does not qualify this shared-mixer case.

The follow-up corrects these paths:

- `AudioMixerRingBuffer::can_mix` uses the existing 400 ms waiting allowance
  instead of padding once the other source has only two 50 ms windows. A whole
  output window must be past that allowance before missing input becomes silence.
  When both sources are ready, mixing still proceeds immediately. Delayed-source
  waiting can add up to 400 ms to VAD/recording delivery.
- `add_samples` no longer discards the oldest samples before the consumer has a
  chance to drain them. That discard also moved surviving samples to incorrect
  timeline positions. The pipeline drains after each add: retained queues stay
  below the allowance plus one window (450 ms at production settings), with a
  temporary extra incoming callback. A genuinely absent source still produces
  silence and cannot stall output indefinitely.
- Per-mixer local counters report padded and discarded-late sample totals for
  both sources at a bounded logging frequency. These logs contain no audio/text
  and are not remote telemetry. The diagnostic input counter is instance-owned
  rather than a shared mutable static.
- Windows CPAL microphone processing now uses the same 256-block worker as
  macOS. Resampling, filtering, normalization and pipeline delivery run off the
  capture thread. Stream Stop pauses capture and explicitly closes/drains the
  worker before pipeline shutdown, with the existing two-second wait bound.
- CPAL callback metadata maps first-sample capture age to recording-relative
  **block-end seconds** before DSP. WASAPI's packet QPC timestamp therefore
  preserves when delayed driver packets were captured, rather than when DSP
  finished. Both CPAL mic and system paths use this mapping on Windows/macOS;
  per-app loopback and the separate Core Audio tap retain their existing clocks.
  An unavailable/invalid age falls back to callback time. Capture-time mute is
  retained with queued mic blocks, and callbacks received while paused are skipped.

Regressions use synthetic data, not private speech: both sources are checked for
every sample in order over ten minutes, with either source delayed, capture or
delivery timestamps, 80 ms stalls, 100 ppm drift, drift plus 40 ms stalls, and
drift plus 320 ms stalls. Capture-timed complete streams must gain no silence.
Additional cases cover oversized callbacks, bounded missing-source output, late
data after the waiting deadline, true gaps, jitter, driver backlog timestamp
mapping, and muted blocks processed after unmute. All 21 pipeline regressions
passed on Windows; the pre-fix new replay failed on system sample loss. The full
Windows native CPU suite passed 367 tests with nine opt-in model/audio-dependent
tests ignored. No real speech-model or physical microphone test ran.

Apple Silicon candidate `36901769206` at `854771d` also passed: six capture-worker
tests, all 21 pipeline tests, bundle/dependency/signature checks and repeated app
launch. Frontend CI `36901770954` passed. The candidate retains internal version
0.2.20 but is not the immutable `v0.2.20-macos` release asset; no replacement or
new release was published for this follow-up.

Limits: delivery-only timestamps remain a heuristic; the mixer cannot recover
audio the driver never delivered or replace silence already emitted after the
bounded wait. Adaptive resampling for indefinite independent-device clock drift
is not implemented. Physical sustained recording under inference load, Windows
installer qualification, and reporter-device confirmation are still required.
The Windows v0.2.20 release includes this follow-up and the subsequent hardware
corrections below; the existing v0.2.20-macos preview predates them. See
[RELEASE_V0220_QUALIFICATION.md](RELEASE_V0220_QUALIFICATION.md).

### Opt-in Windows hardware capture check

`audio/hardware_qualification.rs` is an ignored native test included under
`audio::pipeline::hardware_qualification`. It opens explicitly named Windows
CPAL microphone/output endpoints, plays a quiet generated tone, and runs the
production mic worker/DSP and dual-VAD pipeline. A test-only input tap and
retained-track sink compare counts and ordered nonzero-sample digests without
writing audio, transcripts, meetings, or preferences. The ASR queue is drained
without invoking a transcription model. It also measures native stream Stop
and complete pipeline shutdown.

Run from `frontend/src-tauri` with the normal Windows Rust/native prerequisites:

```powershell
$env:MEETILY_HW_MIC = 'Exact microphone endpoint name'
$env:MEETILY_HW_OUTPUT = 'Exact output endpoint name'
$env:MEETILY_HW_SECONDS = '660'
cargo test --release -p meetily --lib physical_windows_capture_continuity --no-default-features -- --ignored --nocapture --test-threads=1
```

The test accepts 3–900 seconds and currently requires an f32 output endpoint.
It checks that each source delivers at least 95% of its nominal sample count,
that no captured nonzero sample changes or disappears before retained-track
output, that output lengths agree, and that native stream shutdown stays below
three seconds. It reports capture timestamp gaps, sample counts, peaks, VAD turn
counts, and shutdown times. These are native capture/mixer checks, not a test of
FFmpeg file saving, installed WebView Stop, or live ASR under inference load.
A silent/muted microphone can pass the transport check but cannot qualify
microphone speech retention; check the reported microphone peak/nonzero count.

The initial three-second G733 probe passed on Windows with 44.1 → 48 kHz system
resampling and 47 ms native Stop (50 ms complete pipeline shutdown). The mic
provided only zero samples, so that probe established no speech retention.

The first 660-second hardware soak failed: after a roughly one-second capture
interruption, a timeline reset discarded 958 nonzero system samples. Its original
Stop timer also took 14.8 seconds (including test-tone teardown). This blocked
release and led to another correction:

- The pipeline now preflights timeline resets and saves both pending source tails
  through the normal retained-track/VAD path before changing the mixer origin.
  A production-pipeline regression reproduced the old loss and now passes.
- Windows system capture, as well as mic capture, now hands DSP to its own
  bounded worker. An accepting gate closes before Stop so callbacks stop adding
  work while WASAPI tears down.
- Windows native stream disposal runs on an owned cleanup thread with a
  three-second caller deadline per stream. Native cleanup can outlive that wait;
  further CPAL/per-app capture is blocked until cleanup finishes. Completion,
  timeout, panic, and restart-guard release have synthetic regressions. Worker
  drain retains its separate two-second limit; timeout/failure is returned to
  the recording manager and logged while its final-save path continues.
- The hardware test now times mic Stop, system Stop, and fixture-tone disposal
  separately.

The corrected 660-second release-mode G733 soak **passed**: all 31,680,015
nonzero system samples survived the production pipeline in order with an equal
digest. Mic capture delivered 31,687,200 zero samples; this was explicitly a
capture-only test, not microphone speech qualification. Maximum observed capture
gaps were 8.53 ms (mic) and 11.37 ms (system). Native Stop took 35 ms (mic 20 ms,
system 15 ms); fixture tone disposal took 46 ms and complete teardown 94 ms.
No audio was saved or uploaded and ASR was not invoked. The full native suite
passed 370 tests, with ten opt-in tests ignored in that ordinary invocation; this
hardware test was then run explicitly. The new total includes eight worker and
22 pipeline regressions.

## macOS microphone callback — issue #42 (unqualified)

### Follow-up after v0.2.19-macos (2026-10-01)

The reporter observed clear microphone checkpoint audio in one meeting, but
Stop hung and several intervals of live transcription were missing. A later
meeting only retained the first few seconds of microphone audio. This is not
confirmation that #42 is fixed.

The v0.2.19 worker waited for channel disconnection before exiting. CPAL 0.15.3's
macOS `add_disconnect_listener` retains a cloned stream in a listener owned by
that stream; dropping the public stream need not release its callback/sender.
Consequently `worker.join()` could wait forever even with an empty audio queue.

`audio/capture_worker.rs` now owns an explicit close signal. After capture is
paused, it drains accepted blocks and exits when the queue is empty, independent
of callback ownership. Receive waits check close every 20 ms. The caller allows
two seconds for processing, reports timeout/panic through the existing Stop
error/final-save path, and cancels pending work on timeout. A native DSP call
already in progress cannot be forcibly interrupted; it may finish after timeout.
Dropping the worker during stream creation/play failure also cancels its queue.
The existing 256-block capacity, callback timestamps and source labels remain.

Five tests compile the actual std-only worker module directly with `rustc --test`
on Windows: retained callback plus ordered audio/timestamp drain, blocked DSP
with bounded Stop, full-queue nonblocking send, DSP panic reporting, and early
owner drop. All passed using synthetic blocks and synchronization gates; no
recording, speech model, or Mac device was used. The Windows native audio suite
also compiled with the existing LLVM 18 helper: 143 tests passed, three opt-in
tests were ignored, and the new short-loss regression exposed an initial recovery
alignment error. After correcting it, all 17 pipeline regressions passed,
including jitter/drift preservation and both new recovery cases. No private
recording or real-microphone capture was used. This follow-up is not part of the
published v0.2.19 preview.

Apple Silicon candidate run `36872151061` at `8bf63ec` subsequently passed the
five capture-worker tests, all 17 pipeline tests, native build, bundle checks,
and repeated app launch. Frontend CI `36872130895` also passed. The artifact is
a test build with internal version 0.2.19, **not** the DMG published under
`v0.2.19-macos`; it does not change that immutable release. These are synthetic
regressions and CI launch checks, not physical mic capture or ASR accuracy tests.

There is also a source-clock recovery bug: after a short loss below the 100 ms
callback-gap threshold, the mixer may already have emitted silence past the
source's sample counter. Continuous resumed callbacks can then be trimmed
forever as stale. An empty source which has missed a full mixing window (50 ms
by default), or whose sample counter is behind emitted audio, now reanchors only
when its callback timestamp reaches un-emitted audio. Old
queued samples still get discarded; normal callback jitter still uses sample
counting. Regressions cover an 80 ms mic loss with a continuing system track,
and stale queued frames followed by a fresh frame. This affects source tracks,
mixed playback, and the VAD input without changing transcript text or labels.

The Mac build workflow now gates artifacts on the capture-worker and pipeline
regressions. Reporter-device confirmation is still needed. Audio present in
checkpoints but absent from text must also be investigated in VAD, ASR, or
transcript delivery; neither correction proves that those particular gaps are
resolved. The reporter's app log around onset/Stop, selected microphone and
transcription model, and macOS version would distinguish the remaining paths.

### v0.2.19 capture handoff

The macOS microphone is a CPAL input stream, **not** the CoreAudio system-audio
tap mentioned in the issue attachment. CPAL used to perform resampling,
normalization, and pipeline delivery synchronously in the device callback.
It now copies each microphone block and its recording-relative callback timestamp
into a bounded 256-block queue. A dedicated native worker owns the existing
stateful DSP and pipeline send. On stop, capture is paused and the worker drains
accepted blocks before recording state and the pipeline are stopped. System
audio and non-macOS CPAL paths are unchanged. Queue exhaustion drops blocks
instead of blocking the device thread; the worker reports the first overflow
and logs that audio was lost. The queue is bounded by blocks, not by bytes, so
device buffer size also determines the maximum buffered time and memory.

A synthetic regression has been added for deferred processing's callback
timestamp, but native tests did not run locally: the Windows `cargo check`
stops in the existing `whisper-rs` generated bindings before compiling this
crate. The regression does not reproduce several-minute distortion or
establish that this change fixes the reporter's device. Physical macOS mic/system capture
with live inference, pause/stop, and saved-track playback is still required.
The attached CoreAudio `should_terminate`/`poll_next` hypothesis concerns the
separate system-audio stream. That path now drops samples rather than permanently
terminating after ten full callbacks, and rechecks the ring buffer after waker
registration so a push during registration cannot strand the consumer. This
prevents a system-tap stall from stopping the entire meeting, but is **not** a
verified explanation for distortion on the microphone track.

## Report and reproduction

[@fernandog's report](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/40)
identified speech-dependent broadband artifacts at 480-sample wired-microphone
and 384-sample Bluetooth capture boundaries. The report concerns the saved
microphone/mixed files, not merely the preview player.

`useMeetingAudio.ts` streams the saved file through an HTML audio element. The
native mixer previously positioned **every** block from a callback-delivery
timestamp. That clock jitters relative to the device sample clock. Sub-millisecond
timing differences therefore caused zero insertion or sample deletion inside a
continuous waveform, before both source-track persistence and live VAD.

A regression supplies continuous synthetic sine samples in the reported block
sizes with opposing ±0.3 ms microphone/system callback jitter. It failed on the
old implementation at the 480-sample microphone case. With the correction, both
tracks preserve every input sample at both block sizes.

## Timing ownership

`audio/pipeline.rs::AudioMixerRingBuffer` owns one `SourceSampleClock` per source.
Each clock tracks a next-sample index relative to the shared mixer origin and
the last callback-end timestamp in recording-relative seconds.

- First input anchors the source to recording time, preserving late-source
  startup alignment. Subsequent continuous blocks advance by their sample count.
- Only a callback-free interval greater than 100 ms reanchors a returning source
  to wall time. This matches the default two-window missing-source allowance.
  Normal jitter and gradual delivery-clock drift do not splice the waveform.
- Already-emitted silence cannot be replaced: a genuinely late block's elapsed
  prefix is still trimmed, but its sample clock advances by the original length.
- Existing bounded buffering, source zero-padding, and large-gap reset behavior
  remain. A large shared timeline reset now also clears both source clocks.
- Empty/mixed inputs do not advance source clocks. Muted source callbacks still
  supply aligned zeros. Device provenance, ASR/diarizer selection, capture-worker
  ownership, gain, and saved-file formats are unchanged.

This adds constant-size clock state; no new worker, queue, inference, or blocking
capture operation is introduced.

## Qualification and remaining limits

Fourteen mixer tests passed, including bit-for-bit jittered-block preservation,
one minute of simulated gradual clock drift, a real 200 ms source gap followed
by jittered resumption, late-source startup, equal-length tails, bounded large
gaps, mute behavior, and gain handling. The complete native CPU suite subsequently
passed **350 tests**, with **nine opt-in tests ignored**. These new continuity
tests use synthetic samples, not real microphones or speech recognition.

The UI progress change was independently exercised in browser preview: enhancing
had no dialog/backdrop, body pointer events were enabled, an actual mouse click
opened About behind the progress card, and the transcription-start call count
stayed at one. The frontend suite passed **126 tests in 22 isolated invocations**;
production build and type checking passed.

The 100 ms gap decision is a delivery-time heuristic, not hardware timestamp
recovery. Severe scheduling stalls can still look like missing capture. There is
no adaptive resampling to compensate long-run oscillator drift between devices;
this correction prioritizes preserving continuous samples over repeatedly
cutting them to fit wall time. Hardware testing on the reporter's wired/Bluetooth
devices and sustained two-source load remains separate qualification.

Existing damaged recordings are not rewritten: deleted samples cannot be
reconstructed by changing playback. The correction applies to newly captured
audio. Private recordings, diagnostic output, and fixtures stay outside Git.

## Installed release-candidate check

The final CPU/Vulkan/CUDA v0.2.18 Windows payload was built and passed
`verify-windows-release.mjs` (updater signatures, hashes, runtime files, and
bootstrapper payload). After backing up the existing install and native/WebView
data, the installed CUDA executable matched the packaged SHA-256. Startup IPC
confirmed v0.2.18, completed onboarding, selected/available Nemotron, and a ready
workspace. The app exited cleanly through native IPC and reopened without debug
flags after the check.

SQLite integrity passed. Eight meetings, 157 transcript rows, four people, seven
person-speaker links, model hashes, and preference values were preserved. This
is local installation/startup qualification, not a new microphone capture test.
The reporter's devices remain untested here. v0.2.18 is prepared as a draft;
publication is separate from this verified local installation.

## Windows global-mute packet handling (September 2026)

`audio/capture/per_app.rs` now consumes a successful WASAPI packet with frames
when its silent flag is set even if its data pointer is null. The worker decodes
it as zeros and reaches `ReleaseBuffer`; previously the pointer check broke the
read loop before release, leaving later packets blocked. Nonempty null packets
are also released without dereferencing. Empty/failed reads do not own frames.
`AudioStreamManager::reconnect_source` replaces just the disconnected endpoint,
so microphone recovery preserves the selected per-app system capture threads.
Capture remains nonblocking, and the existing recording-state sender connects
replacement capture to the running pipeline.

The native synthetic null-silent packet followed by float speech test passed,
as did 14 existing mixer/source continuity tests. This establishes decoding and
sample continuity, not a physical SoundSwitch/Zoom/Chrome mute-cycle result.
The actual WASAPI release/notification sequence needs a Windows live-device test;
this change does not restart process capture after an unrelated terminal failure.

### Per-app process lifetime and notification continuity

Windows now selects the matching executable tree root, using active audio sessions to choose between independent trees. It no longer targets disposable audio children: replacement children remain included by process-tree loopback. Selection is deterministic and bounded for stale parent cycles; three native tests cover worker replacement, multiple trees, and missing/cyclic snapshots. Capture also drains packets after the 200 ms event timeout, so missed notifications do not strand queued audio. Existing silent-packet release and bounded per-app queues remain in place. Real Chrome/Zoom playback and SoundSwitch qualification still require hardware testing; restarting the entire application root is not automatic recovery.

### Supervised process capture

Each selected Windows app now has one long-lived native supervisor owning COM,
the target executable, and replacement WASAPI clients. Read, release, and wait
errors reopen only that client's capture. A complete parent map associates differently named audio helpers with their
selected executable tree. A two-second process check resolves replacement roots; no-packet watchdog reactivation starts at five seconds and
backs off to thirty seconds during ordinary app silence. Silence does not count
as failure. Three failed sessions without thirty seconds of healthy packet
delivery report `PerAppCaptureFailed` through the existing fatal-save/stop path
instead of leaving a recording silently active. Recovery reuses the processor,
source clock, and recording sender; it never recreates the microphone stream.
The callback releases each copied packet before downstream processing, checks
stop within a bounded 128-packet drain, and preserves null-silent packet handling.
All clients request 48 kHz stereo PCM conversion, matching the existing pipeline
and multi-app mixer contract. Burst queues retain at most 19,200 samples even
when one native packet exceeds the 200 ms queue bound. Event handles and each
successful COM initialization are balanced across recovery and process checks.

Synthetic regressions cover retry exhaustion, ordinary-silence backoff, healthy
reset, oversized packet queues, startup, and root selection. The opt-in Windows
endpoint test uses a generated tone in its own process and an injected client
failure, checking initial, recovered, and late signal delivery over two minutes.
Its result is reported separately from real Zoom/Chrome calls. This cannot
recover audio lost before reactivation, or treat a genuinely silent application's
valid silent packets as proof of a fault. Native activation can take up to five
seconds; shutdown waits for the owned worker rather than abandoning a client.

Qualification for this follow-up: the CPU native library suite passed 372 tests
(11 optional fixtures ignored by default). The explicitly run Windows process
loopback fixture passed for 120 seconds with generated tone playback, one injected
client invalidation, two client activations, and signal present before recovery,
after recovery, and in the final five seconds. This establishes native recovery
on this endpoint, not uninterrupted capture of a real Zoom/Chrome meeting.

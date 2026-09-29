# Recording callback continuity — issue #40

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

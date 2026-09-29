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

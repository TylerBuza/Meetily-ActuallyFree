# Linux native PipeWire/PulseAudio capture

Linux system audio and microphones bypass cpal's ALSA host and use the
PulseAudio client protocol (also served by `pipewire-pulse`). Device discovery,
default-device resolution, and capture live in `audio/capture/pulse_linux.rs`;
stream ownership lives in `audio/stream.rs` (`StreamBackend::Pulse`).

## Data flow

- System audio: the picker name `<sink description> (System Audio) (output)` is
  stripped back to the sink description and resolved to its monitor source.
- Microphones: names are PulseAudio source descriptions. An unknown description
  (stale preference, no Pulse server) falls back to the CPAL/ALSA path.
- `PulseCapture::run` does blocking `libpulse-simple` reads of 1024 frames
  (~21 ms at 48 kHz) on a dedicated `audio-capture-*` thread and hands
  interleaved f32 frames to `AudioCapture::process_audio_data`. The server
  resamples/remixes to 48 kHz, so the pipeline never sees the native format.
- alsa-lib enumeration is serialized (`devices/platform/linux.rs`) because
  concurrent enumeration corrupted the heap and aborted long recordings.

## Shutdown ownership

`read()` only observes the stop flag between chunks, and a stalled source can
block it indefinitely. `PulseCaptureThread` owns the thread handle:

- `AudioStream::stop()` stays synchronous. On Linux it signals the flag and
  runs the join through the shared `NATIVE_CLEANUPS` owner
  (`audio/capture_worker.rs::NativeCleanup`) with a 3 s caller deadline; the
  Windows WASAPI owner/deadline path is unchanged.
- Timeout or a capture-thread panic returns an error from `stop()`. On timeout
  the cleanup thread keeps owning the join (and the PulseAudio stream); while it
  is pending, `create_pulse_stream`/`create_pulse_mic_stream` reject Start
  instead of accumulating stuck capture threads.
- Dropping a stream without `stop()` signals the flag and hands the unjoined
  thread to `NATIVE_CLEANUPS` rather than detaching it.
- After a late `read()` returns, the loop re-checks the flag before delivering,
  so a timed-out thread cannot inject a chunk into a later recording.

## Reconnect serialization

`attempt_device_reconnect` runs with the manager left in `RECORDING_MANAGER`
and the lock held (`with_manager_in_place`). Stop/Start/status serialize behind
the reconnect instead of observing an empty slot or racing a restore. The hold
is bounded by the per-stream stop deadline above.

## Tests

- `audio::stream::pulse_shutdown_tests` (Linux, synthetic threads, no audio
  server): stalled read fails Stop and blocks restart until exit; panic is
  reported as failure; normal join; drop-without-stop hands off the join.
- `audio::recording_commands::reconnect_serialization_tests` (std-only):
  Stop/status issued mid-reconnect observe the same manager after reconnect;
  reconnect after Stop reports inactive and never restores a manager.
- `audio::capture_worker` NativeCleanup regressions cover the shared owner.
- `capture::pulse_linux` tests are `#[ignore]`d: they need a running
  PulseAudio/PipeWire server (and playing audio for the capture test).

On 2026-10-07 (Linux, PipeWire via pipewire-pulse) the full native suite
passed 377 tests with 10 ignored by default. Separately, the three ignored
`pulse_linux` tests passed against the live server. The capture test checks
only that samples arrive from a real monitor source; it does not check signal
content.

## Limits

- A source that never returns from `read()` keeps Start blocked until it does;
  libpulse-simple has no interruptible read.
- The reconnect regression exercises the serialization helper with a stand-in
  manager, not a full `RecordingManager` with live devices.
- Windows compilation of this branch is checked by Windows CI, not locally.

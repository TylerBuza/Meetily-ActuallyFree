## Recording reliability and setup improvements

This Windows update follows v0.2.18 and includes the fixes developed during the
macOS previews, plus the shared-mixer and Windows capture follow-up for #42.

### Recording fixes

- **Delayed audio:** use the mixer's full waiting allowance before padding a
  missing source, and drain queued samples instead of prematurely discarding
  them. Ten-minute synthetic tests cover both tracks, clock drift, and repeated
  scheduling stalls.
- **Windows capture:** move microphone and system-audio resampling/filtering
  and microphone normalization off capture threads into bounded workers. Preserve capture timestamps for
  delayed driver packets and retain mute decisions for queued audio.
- **Stop:** explicitly drain the capture worker with a bounded wait before
  closing the pipeline. Bound Windows native teardown and retain cleanup ownership
  if a driver takes too long; prevent restarting capture over unfinished cleanup.
- **Interrupted devices:** save pending audio before resetting source timelines,
  fixing a dropped-tail case found during real-device testing.
- **#43:** hide FFmpeg's console when generating the meeting audio waveform.

These changes apply to new recordings; they cannot restore samples missing from
older recordings. Device-specific audio and live-transcription reports in
[#42](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/42) still need
reporter confirmation. Capture-only hardware tests do not establish speech
retention or ASR accuracy with a silent microphone.

**Testing:** 370 native tests and all 26 isolated frontend test files passed.
An 11-minute release-mode Logitech G733 capture-only test passed with all
nonzero system samples preserved and native Stop completing in 35 ms. Its
microphone was silent and no ASR model ran; real microphone speech and
transcription under inference load remain separate checks.

### Setup and interface

- Show optional Whisper and Nemotron download/activation progress in the
  background notification stack and Transcription settings.
- Complete optional-model activation natively, including across WebView reloads,
  without replacing the selected live transcription model.
- Add optional-model uninstall controls and refresh the affected settings.
- Keep model status badges within narrow cards.
- Stack meeting panes based on available content width and support keyboard
  resizing (#25).
- Show the recording disclosure reminder at launch, with permanent acknowledgment
  available.
- Bundle interface fonts locally for reliable offline builds.

### Install

Download `Meetily-ActuallyFree-0.2.20-x64-universal-setup.exe`, or use the in-app
updater. The universal installer selects CPU, Vulkan, or NVIDIA CUDA. Upgrade in
place; no meeting, recording, model, or settings reset is required.

Windows 10/11 x64 is supported. As with earlier Windows releases, the installer
is not Authenticode-signed and SmartScreen may show **Unknown publisher**. The
updater payload is cryptographically signed; `SHA256SUMS.txt` verifies the assets.
macOS remains a separate Apple Silicon preview download.

Thanks to **@fernandog** and **@bikram990** for the detailed recording reports and
continued testing, and to everyone reporting setup and interface issues.

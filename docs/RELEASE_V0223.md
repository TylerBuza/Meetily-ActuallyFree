## Speaker labels, post-call processing, and useful crash reports

This Windows update includes the shared fixes developed since v0.2.20.

### Speaker labels and processing

- **Combined speakers (#44/#45):** labels such as `You + Speaker 1 + Speaker 2`
  keep every component in the meeting view and exports. Renaming or reassigning
  one component preserves the other speakers and the transcript text/timestamps.
  Existing correctly stored combined labels benefit without re-recording.
- **Post-call jobs (#31/#35):** processing is owned by the app across navigation,
  with meeting-scoped progress, cancellation, and completion refresh. Skip, Close,
  and Escape stop advancing the workflow; an already-running native diarization
  operation cannot be interrupted mid-inference.
- **Nemotron:** correct contiguous time-major feature layout. Synthetic regression
  coverage verifies tensor ordering; this is not a claim of verified speaker
  identity or real-call accuracy.
- **Parakeet vocabulary:** apply saved vocabulary hints to Parakeet transcription,
  alongside the existing Whisper vocabulary support.
- **Markdown export:** optional frontmatter and Obsidian-style speaker links,
  including separate links for named speakers in combined labels.

### Diagnostics

- Recording-start failures show the backend's reason more consistently.
- Crash ZIPs can now include a bounded timeline of model loading, runtime checks,
  recording startup, lifecycle-lock waits, and Stop/save stages, with outcomes,
  elapsed times, and unfinished operations from the failed session.
- Diagnostics remain local until you manually attach the ZIP. They exclude audio,
  transcript/summary text, meeting names, device names, credentials, and ordinary
  logs. Slow-operation markers are evidence of elapsed work, not proof of a crash
  cause. Older reports cannot gain this timeline retroactively.

The reported Teams/Vulkan startup freeze in #67 is still under investigation;
better diagnostics do not establish or fix its cause.

### Install

Download `Meetily-ActuallyFree-0.2.23-x64-universal-setup.exe`, or use the in-app
updater. The Windows 10/11 x64 installer selects CPU, Vulkan, or NVIDIA CUDA.
Upgrade in place; no meeting, recording, model, or settings reset is required.
Voice-profile matching remains optional and beta.

As with earlier Windows releases, the installer is not Authenticode-signed and
SmartScreen may show **Unknown publisher**. The updater payload is
cryptographically signed; `SHA256SUMS.txt` verifies the assets. macOS remains on
its separate Apple Silicon preview release.

Thanks to @ampersandru, @0cv, @pthurmond, @KARAtel218, @sscarduzio, and everyone
providing reports and reproduction details.

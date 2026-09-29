# Live speech retention (local v0.2.18 candidate)

## Ownership and corrections

`audio/vad.rs` owns the 16 kHz speech segmentation clock for both sources.
Silero emits `SpeechStart` only after minimum-speech confirmation (250 ms), with
a timestamp that includes earlier pre-speech padding. Previously the wrapper
assigned that earlier timestamp but only collected samples from the callback
that delivered the event. ASR therefore missed the beginning, and subsequent
split timestamps no longer matched their audio.

The processor now retains one second of contiguous pre-roll (16,000 samples per
source). On confirmation it copies from the reported start through the preceding
frame, then appends the current frame once. Starts are clamped to retained audio.
Timeline discontinuities discard the pre-roll. A recreated Silero session after
a consumed frame starts its clock at the next frame; Silero's fallback `reset`
retains its internal clock and must retain the corresponding offset.

`audio/pipeline.rs` now uses 0.20/0.10 positive/negative speech-probability
thresholds for **both** live sources. The previous system threshold (0.50/0.35)
skipped audible turns in real-call replay. These are probability thresholds, not
amplitude floors or automatic gain. Capture source provenance, model selection,
ASR worker ownership, and the continuous pre-VAD Nemotron observer are preserved.
Post-call system threshold settings remain independent; the shared pre-roll and
clock correction also apply to post-call segmentation.

## Verification and limits

- The sample-alignment regression failed on the old implementation at 390 ms.
  It compares every emitted sample with the source interval identified by its
  timestamps, including split turns; it now passes with both threshold pairs
  and both live latency settings. The synthetic signal verifies retention and
  timing, not natural-speech accuracy.
- Thirteen VAD tests passed after the fix. The broader affected audio group then
  passed 133 tests (three opt-in tests ignored). An opt-in `replay_live_audio_alignment`
  test accepts a local mono 16 kHz float32 little-endian fixture via
  `MEETILY_VAD_TEST_AUDIO`. Set `MEETILY_PARAKEET_TEST_MODEL` to the local INT8 v3
  directory to also run CPU ASR. `MEETILY_VAD_TEST_STRICT_SYSTEM=1` reproduces the
  previous loopback threshold for comparison. Run the test with `--ignored
  --nocapture`; its output can contain private transcript text.
- Actually ran the opt-in replay with the latest consenting user's real-call
  system and microphone recordings and local CPU Parakeet. All emitted audio
  matched its claimed source interval. With corrected pre-roll held constant,
  the stricter system threshold produced eight speech chunks / six nonempty
  transcripts; the more sensitive threshold produced 22 / 17 and recovered
  speech near the beginning. Microphone replay produced five chunks / three
  nonempty transcripts. These are coverage observations, not word-error scores.
- Original live text was unavailable: post-call enhancement had replaced both
  the saved transcript JSON and database rows. Replays do not establish exactly
  what the user saw live. Input tracks were decoded locally; no saved meeting
  content was rewritten. Fixtures, model files, and transcript logs are ignored
  local artifacts and must not be committed.

ASR still returned some empty or inaccurate results. Lower speech thresholds can
admit more nonspeech; real-call accuracy and sustained concurrent ASR/diarization
load still need qualification. This replay bypasses capture and WebView rendering
and is not an installed-app test of the new build.

## Local installation qualification

The CPU/Vulkan/CUDA v0.2.18 payloads were rebuilt after these changes and passed
`verify-windows-release.mjs` (hashes, updater signatures, bundled payloads).
The installed app/native data/WebView profile were backed up before the local
upgrade. The installed CUDA executable matched the packaged executable's SHA-256.
Startup IPC confirmed v0.2.18, completed onboarding, available/selected Nemotron,
and a ready workspace. Closing the previous tray process for backup produced an
unclean-exit prompt; Ignore dismissed it without sending a report. The checked
app then exited through native IPC and reopened normally without debug flags.

The installed speaker prompt was inspected using the existing synthetic QA
meeting without running enhancement: approximately 384 × 197 pixels, centered
within one pixel of the viewport midpoint, with an enabled **Auto-detect &
continue** button and no separate Continue action. The app was returned to Home.

SQLite integrity passed; all six meetings, 68 transcript rows, two people and
three person-speaker links were preserved. Model hashes and preference values
were preserved (Tauri reordered analytics JSON keys on exit). This establishes
installation/startup/UI and data preservation; the speech evidence above remains
a local recorded-audio replay, not a new live-capture accuracy qualification.
Latest public release was checked as v0.2.17; v0.2.18 remains locally installed,
not published.

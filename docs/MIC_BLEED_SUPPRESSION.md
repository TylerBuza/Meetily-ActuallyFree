# Microphone speaker-bleed suppression (post-processing)

Without headphones, remote speech plays from the speakers and reaches the
microphone. `mic.mp4` then contains a delayed, room-filtered copy of
`system.mp4`. Before this change, post-processing treated every mic segment as
`You`, so remote turns became `You + <remote>` and retranscription produced a
second, mic-sourced copy of the remote speaker's words labeled `You`.

The live path is unchanged. Live labels stay as captured until a diarization rerun
or a retranscription.

## Data flow

```text
mic.mp4 + system.mp4 (written from the same aligned mixer windows, pipeline.rs)
  -> 16 kHz mono samples
  -> diarization/bleed.rs  BleedAnalysis::analyze(mic, system)
       dsp::for_each_log_mel (10 ms frames, un-normalized) -> 16 dB bands
       per-30 s block delay: envelope correlation, lag -50..+500 ms
       per-band coupling: median(mic - delayed system) over active playback
       per frame: Local if >= 3 bands exceed predicted bleed (+ decaying tail) by 8 dB
                  Bleed if voiced, explained by playback; Silent otherwise
  -> diarize_meeting (diarization/mod.rs), dual-track Nemotron and Pyannote paths:
       mic segments -> local_mic_segments: bleed-only spans dropped, mixed spans
         trimmed to local regions, BEFORE cross-track overlap marking
       voiceprint enrollment skipped when > 10 % of mic speech is bleed
       stored "You" hint not forced onto a bleed line (apply_source_track_hint)
       preserved named composite labels on bleed lines lose only "You"
         ("You + Alice B." -> "Alice B."); text and timings never change
  -> run_retranscription (audio/retranscription.rs):
       both tracks decoded before VAD; mic VAD chunks that are bleed are dropped,
       so the remote speaker is transcribed once (from system.mp4)
```

Units: frames are 10 ms; `BleedAnalysis` takes and returns seconds;
`SpeechSegment` carries milliseconds and is converted at the call site.

## Decisions and constraints

- **No delay, no change.** When no block reaches envelope correlation 0.5, the
  analysis is inactive and every query reports local speech. This covers
  headphones, muted or silent system audio, and OS echo cancellation (for
  example, the PipeWire echo-cancel source). It never guesses a delay.
- **Conservative toward `You`.** Short local runs (< 50 ms) are discarded as
  noise, then local runs are widened by 100 ms. A span is bleed only when it has
  at least 10 voiced frames and under 20 % of them are local. Retranscription
  drops a whole chunk only when it is bleed; a chunk with any substantial local
  speech, including double-talk, is kept whole so no words are cut.
- **Diarization reruns stay label-only.** Bleed duplicates left by older
  transcriptions get the remote label rather than being deleted. Only
  retranscription, which regenerates text by design, removes them.
- An explicit solo count (`num_speakers == 1`) skips the analysis.
- Analysis runs inside the existing `spawn_blocking` work. It uses about 64 bytes
  per frame per track (≈ 23 MB per track-hour), and the real 26-minute meeting
  below took 2.9 s in a release build.

## Tests

- `diarization::bleed::tests` (synthetic, deterministic seeded noise with a
  syllable-rate envelope; speakers modeled as delay + attenuation + low-pass):
  - bleed detected at 0, 150, and 400 ms delay;
  - local speech without playback stays local;
  - double-talk is kept and its region is reported;
  - uncorrelated tracks, a silent system track, and a muted mic are inactive;
  - a delay change mid-meeting is tracked per block;
  - out-of-range queries are safe.
- `diarization::tests`: bleed "You" lines take the remote label; local
  double-talk keeps `You`; the inactive analysis keeps mic segments unchanged;
  `without_you_part` strips only the exact "You" part.
- `compute_fbank` was verified bit-identical to the pre-refactor implementation
  with a one-off comparison test. That test was not kept.
- `diarization::bleed::real_meeting::bleed_real_meeting` is ignored by default
  and needs `BLEED_MEETING_DIR`. On 2026-10-27 it ran on a private local
  26-minute two-person call recorded on Linux without headphones. Results:
  active, delay 60 ms, confidence 0.74, 46 % of mic speech flagged as bleed.
  Retranscription would drop 135 of 284 mic VAD chunks. The flagged chunks
  matched remote-speaker lines on manual inspection, and 0 of 71 stored lines
  labeled only `You` were flagged. Of 217 stored `You + <remote>` lines, 135 were
  flagged. The recording is not committed.

## Known limits

- Recall is partial. Mic VAD chunks and transcript lines that span both talkers
  keep `You` (by design), and about 80 of the 217 composite lines in the
  qualification meeting were not flagged.
- In-room participants who never pass through the system track still count as
  `You`.
- Strongly nonlinear or distorting loudspeakers, or very loud playback, may need
  margin tuning (`LOCAL_MARGIN_DB`, `LOCAL_MIN_BANDS`).
- A bleed `You` line with no overlapping diarization segment falls back to its
  stored label.
- Not qualified yet on macOS/Windows recordings, or with the in-app rerun and
  retranscription flows end to end.

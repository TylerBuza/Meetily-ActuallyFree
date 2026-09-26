# Live Nemotron and PR #36 assessment

## Implementation

The live engine is selected at recording start. Nemotron loads before capture
begins, consumes continuous system audio (including silence) after the existing
48 kHz-to-16 kHz resampling, and uses the same recording-relative clock as VAD
transcript turns. Its low-latency profile has 1.04 s input buffering, 0.72 s
stride, and 0.32 s lookahead; this is not an end-to-end transcription latency
guarantee. Microphone capture remains authoritative for `You`.

Inference runs on a dedicated thread behind a bounded, nonblocking capture
queue. The speaker cache persists across windows and starts fresh each meeting.
At recording stop, queued audio drains and the final model buffer is flushed;
speaker results remain available while the transcription task completes. Live
labels select the greatest speaker overlap with the transcript turn, without
inventing word-level timing or splitting text. A turn with multiple speakers
therefore still receives one label; post-call refinement remains available.

Overload/inference failure reports a visible error and retains source labels,
without silently switching to Pyannote. Speaker history is bounded to ten
minutes; excessively delayed transcript turns return source labels rather than
guessing identities. Engine changes during capture apply on the next recording.

## Qualification so far

- Native tests cover overlap-based label selection, history bounds, final-tail
  publication, and the continuous observer's 48 kHz-to-16 kHz conversion plus
  gap-adjusted VAD timestamps.
- A real-model streaming test feeds 50 ms windows from the local 104.985 s
  synthetic two-voice fixture. It checks repeated-voice identity, distinct
  speakers, timestamp bounds, flush, and silence after resetting the model.
  The tested run took approximately 19.2 s inference, excluding initialization.
  This is a synthetic throughput check, not a real-meeting accuracy benchmark.
- Nine optional-download/engine-selection frontend tests and TypeScript passed.
- The real-model worker lifecycle test also passed: it submits the complete
  fixture to the bounded channel, closes input, joins the worker, and verifies
  that the final watermark and first/last-turn labels remain available afterward.

## PR #36 review

Reviewed `97654b0c54ace9a2a60a67f8d5aa9228a666a701` from
<https://github.com/TylerBuza/Meetily-ActuallyFree/pull/36> by @ampersandru.

The detected-speaker panel and in-call rename/merge UI are useful complementary
features. They should be adapted with stable speaker IDs and durable per-meeting
aliases rather than incorporated wholesale with the streaming engine change:

- The proposed live mappings are keyed by display strings and held in React
  state. Rename chains/collisions and restoration after a reload need explicit
  tests, including newly arriving buffered transcript events and recovery data.
- Post-call name transfer uses temporal overlap and a greedy one-to-one match.
  This needs tests for deliberately merged speakers and changed boundaries;
  a display-name match is not a verified voice identity.
- The VAD modifications couple utterance slicing, state resets, and hard energy
  cutoffs (`rms < 0.005 && peak < 0.01`). Quiet speech retention should be tested
  before changing the current capture/transcription behavior.
- The PR also changes startup recovery, dev routing, CUDA setup, build flags,
  and dependencies. Those are independent of the live speaker panel.

No PR #36 commits have been merged or cherry-picked as part of this change.

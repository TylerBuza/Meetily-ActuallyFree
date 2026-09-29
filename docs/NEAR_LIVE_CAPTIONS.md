# Near-live captions Lab

## Current implementation

The native Labs setting persists outside WebView storage. `AudioPipeline` reads it
once when a recording begins and selects a 350 ms silence redemption and a
2,000 ms continuous-speech cap for each source VAD. `ContinuousVadProcessor`
cuts at the quietest nearby frame when the cap is reached, even if speech has
not paused. It retains the remainder as the start of the next chunk. The
existing transcription worker runs ASR and the selected diarizer on each
completed chunk, then emits its normal final `transcript-update` event. During
unfinished speech, a snapshot is offered after 0.8 s and at most every 0.5 s
of capture time. A latest-only channel per source bounds preview work if ASR
falls behind. The capture path checks timing before copying an unfinished
window. A separate Parakeet task shares the loaded model and skips
previews whenever a final chunk is queued. Its `near-live-caption` event is
display only; `near-live-finalized` replaces it after final transcription.
Neither event enters the saved transcript or IndexedDB. PR #39's `LiveSession` subscribes to these events, and the frontend joins
nearby chunks from the same speaker for live display, including when chunks
from the other capture source arrive between them. It does not rewrite saved
transcript text, timestamps, or source provenance.

Provisional decoding currently runs only for Parakeet. The shorter final-chunk
cap still applies to the selected live ASR. The setting does
not make the entire Parakeet graph GPU resident. The current DirectML setting
accelerates its encoder only. The actual delay includes capture, the 2 s cap,
queued ASR, diarization lookup, and event/render time. Shared Parakeet model
access can also delay a final chunk behind an in-flight preview. The 0.5 s
snapshot interval is not an end-to-end latency guarantee. A faster cap may
increase word cuts and transcription errors. Preview text may revise as more
audio arrives and is shown with an Updating marker. The live view updates
near-live text in place instead of replaying the typewriter effect over an
established paragraph. After a final event, it retains the provisional line
until the corresponding saved turn reaches `TranscriptContext`. A bounded
1.5 s expiry removes previews when transcription yields no saved turn. This
display handoff does not change saved text, timing, or speaker provenance;
unfinished preview words may still be revised by ASR.
The live renderer also remembers the longest visible prefix for each speaker
turn's start time, which remains stable when its first native segment ID changes.
Out-of-order final chunks can temporarily produce a shorter projection of the
same turn; this display cache keeps the older words visible while the missing
chunks settle, and accepts a longer or corrected projection. It resets when
near-live mode or recording stops. A speaker relabel that changes the first
turn ID can still create a new row, and genuine ASR edits can still replace
unfinished words.

The Labs setting warns that provisional captions may show extra speakers or
inaccurate words. Final live ASR and diarization replace provisional text and
labels. Running post-call transcription and diarization can improve the saved
result, but neither is guaranteed to correct every error, particularly when
remote voices overlap in a single system track.

Microphone and system audio have independent VAD and ASR paths, so their lines
can overlap in time. Two remote voices mixed into one system track cannot be
separately transcribed by diarization alone. A chunk receives one speaker label
from the selected engine; a speaker change inside a chunk is not split at word
level. Remote previews have a temporary label until final Nemotron/Pyannote
attribution arrives. Voice profile matching now accumulates up to four seconds
of short chunks per meeting-local Nemotron speaker, so the two-second embedding
minimum can still be met without treating a channel number as identity.

## Qualification and next stages

1. Measure microphone and system audio ingest, VAD split, ASR completion,
   diarization completion, and UI update on a Windows GPU machine. Record p50
   and p95 delay, queue depth, and error rate for continuous and overlapping
   speech. No model/audio fixture has qualified these timings in this PR.
2. Use the bounded provisional path to measure actual preview cadence and
   whether shared-model contention delays final turns. If the decoder cannot
   keep pace, evaluate a separate inference session or a streaming-trained model.
3. Evaluate full Parakeet graph acceleration and a streaming-trained model
   against the same audio fixtures. Require word-boundary and duplicate-text
   checks before reducing the cap. Supporting two remote voices at once would
   additionally require source separation or speaker-attributed ASR.

Native timing selection and voice-profile accumulation have pure unit tests.
Frontend preview merge has a targeted test. Frontend
build and Windows packaging verify integration. Real model quality, GPU load,
latency, and same-track overlap require a local audio fixture or live test.

## Fixed provisional-caption area (September 2026)

`LiveSession.tsx` projects only saved turns into `VirtualizedTranscriptView`.
Microphone/system previews live in a fixed-height box above the recording bar,
with Listening and Paused states keeping its position stable between previews.
The existing per-source finalization watermark, saved-turn handoff, expiry, and
optional mic duplicate suppression still own preview removal. Remote preview
labels never enter the final transcript, contact list, or persistence. Long
previews scroll inside the box; transcript bottom clearance includes the box.
Frontend build/type validation and the nine targeted near-live/Labs tests passed;
Chrome preview verified the box above the controls and stable paused placement
using simulated text, not an ASR latency/accuracy fixture.

The fixed meeting caption area is titled **Live Captions**. System previews show caption text without the temporary “Remote voice” prefix; microphone previews retain “You”. Final speaker labels remain in the transcript. This is presentation only and does not change provisional/final reconciliation.

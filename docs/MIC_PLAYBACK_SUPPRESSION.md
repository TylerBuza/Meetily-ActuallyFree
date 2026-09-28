# Mic playback suppression Lab

## Data flow

The native setting is off by default and snapshotted when a recording starts.
`AudioPipeline` already aligns 48 kHz microphone and system windows. `EchoGuard`
keeps at most about 350 ms of system reference, searches up to 250 ms of
positive delay at reduced resolution, and only subtracts a strongly correlated
system waveform from the microphone. The residual enters microphone VAD, live
Parakeet previews, and final ASR. It is also saved as `mic.mp4`, so post-call
retranscription and source-aware diarization consume the same filtered source.
`system.mp4` and remote speaker labeling are unchanged. The mixed playback
retains the original microphone window for audible review.

Processed microphones can destroy waveform correlation. In one local test
with NVIDIA Broadcast, matching mic/system speech had direct correlation below
0.14, so the acoustic filter left repeated mic words in place. A second,
source-aware check compares ordered ASR words and recording-relative time. The
check also compares 10 ms speech-energy envelopes when the words are close but
fall below the strict rule. This retains timing after NVIDIA Broadcast reshapes
the waveform; a measured duplicate in a second local recording aligned at
about 0.22–0.24 seconds with envelope correlation around 0.72–0.78. The looser
word rule only applies when this independent timing evidence is strong. The
live transcription worker holds final mic turns for at most three seconds to
compare a nearby system turn before emitting or saving them. Post-call
retranscription compares each overlapping system turn and their ordered
combined text before replacing transcript rows. This catches a single mic
phrase whose playback spans two system ASR chunks. It retains a candidate
mic turn that runs directly into an uncontested local turn, preserving local
speech at the edge of a remote turn. The
near-live view hides a provisional mic caption when it already matches an
overlapping system preview. This can fix existing recordings by rerunning
post-call transcription with the Lab enabled; it does not change audio tracks
that were saved before the Lab was enabled.

Post-call diarization can otherwise put `You` back on a remote row when the mic
track contains playback and its user diarization overlaps system speech. With
this Lab enabled, a remote row gets `You` only when a distinct retained mic
transcript overlaps it. A previously saved combined label such as `You + Chris`
is reduced to the remote name when that evidence is absent. Existing text and
timestamps are left intact. Retranscription also removes an unconfirmed `You`
part from a previously saved combined remote label when carrying names over
to new transcript rows. Run post-call transcription before diarization on
an affected recording so duplicate mic rows are removed first.

The filter preserves the residual when someone speaks locally over system
playback. A weak or uncertain acoustic match leaves the microphone untouched;
neither channel is used to infer a person's identity. The feature requires both
capture sources and affects only recordings started after it is enabled.

## Verification and limits

Pure unit tests use synthetic delayed playback, overlapping independent local
speech, unrelated mic audio, and text pairs from the failed local recording.
An offline read-only check of the first recording identified 14 duplicate mic
turns and retained three distinct mic turns. A second recording showed four
remaining duplicate mic turns and two combined `You + remote` labels that
motivated the envelope and diarization fallbacks. Read-only analysis of two
subsequent user recordings found that a mic phrase often spans adjacent
system ASR turns. Combining overlapping remote text covered a four-word
duplicate missed by either system turn alone and several longer duplicates
in a recording made before this Lab was enabled. This is fixture analysis,
not an end-to-end run of the revised app; the user still needs to retest it.
Acoustic reverb, noise suppression, device timing drift, and nonlinear speaker
distortion can reduce waveform correlation. Short or substantially different
ASR text can escape the fallback. A strong false match or a mic turn containing
both local and remote words can remove some local speech. The
setting is experimental and should be compared against a test call with the
microphone left open, including a period where the user talks over playback.
Existing recordings and transcripts are not changed.

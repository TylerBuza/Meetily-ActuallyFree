# v0.2.17 — Nemotron speaker diarization

This update brings **optional NVIDIA Nemotron-3 diarization** to Meetily, with
speaker labeling during live calls and refinement after the recording finishes.

## Nemotron, live and after the call

- **Live speaker labels:** when Nemotron is selected, it tracks remote voices as
  **Speaker 1 / 2 / 3…** while your microphone remains **You**. The streaming
  worker preserves speaker state between audio windows.
- **Post-call refinement:** use the complete recording to refine speaker labels,
  with Auto-detect for up to eight speaker channels and overlap-aware predictions.
  Transcript text and timestamps are preserved.
- **Windows GPU acceleration:** Nemotron uses DirectML with the bundled, verified
  ONNX Runtime. If GPU initialization fails, it uses CPU. This is independent of
  the CUDA/Vulkan/CPU backend used for Whisper transcription.
- **Easy optional setup:** select the **Recommended** Nemotron download during
  setup, continue onboarding while it downloads, and it enables automatically
  when the verified download finishes. Progress and retry controls are in Settings.
- **Your choice of engine:** Pyannote/WeSpeaker remains available. Changing the
  live engine takes effect on the next recording; Parakeet still handles live
  transcription when configured.

The live profile uses roughly one second of model buffering, plus transcription
and processing time. A transcript turn currently receives its dominant speaker
label; post-call refinement remains useful for difficult turns and overlap.

## Why Nemotron? Speaker-attribution accuracy

![NVIDIA's chart of VoiceArena Diarization-Bench v1: Nemotron 3 has 14.7% diarization error rate; lower is better.](https://cdn-uploads.huggingface.co/production/uploads/688d4bdfdeb55432d90e546d/APLexzMWO1Om9RTvX8EGN.png)

**Fewer speaker-labeling errors:** Nemotron scored **14.7%** vs **30.6%** for
pyannote Community-1 in VoiceArena's benchmark. Lower is better.

*[Chart: NVIDIA](https://huggingface.co/blog/nvidia/nemotron-diarization).
Measures accuracy, not speed; not a direct benchmark of Meetily's old pipeline.*

## Other fixes

- Fixed a Windows stack-overflow crash in diarization model downloads.
- Made optional Whisper setup downloads select Whisper for post-call enhancement
  and retranscription without changing the live transcription model.
- Improved background-download status, activation retries, Settings refresh, and
  onboarding completion while downloads are still running.
- Hardened model validation and preserved transcript text, timing, and source
  provenance during speaker-label updates.

## Thanks and attribution

**Thank you to [@ampersandru](https://github.com/ampersandru) for
[PR #34](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/34)**, which provided
the starting point for the Nemotron integration and DirectML work. This release
adapts and hardens that contribution and extends it with the live streaming path.

Thanks also to **Enes Altun / [parakeet-rs](https://github.com/altunenes/parakeet-rs)**
for the MIT-licensed Sortformer reference implementation. Attribution and license
notices are retained in the source.

## Download

For a new install or manual upgrade on Windows x64, use
**`Meetily-ActuallyFree-0.2.17-x64-universal-setup.exe`**. It includes the supported
Windows transcription backends; Nemotron's model is an optional download.

The separate updater executable, updater signature, update manifest, and SHA-256
checksums are also attached. This release's attached installers are for Windows;
the existing macOS release remains available separately.

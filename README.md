# Meetily - Actually Free

<p align="center">
  <img src="frontend/src-tauri/icon-source.png" alt="Meetily - Actually Free logo" width="280" />
</p>

An entirely free, fully unlocked fork of [Meetily](https://github.com/Zackriya-Solutions/meetily). Every feature is available without an account, subscription, license key, trial, or paid tier.

[Download the latest Windows release](https://github.com/TylerBuza/Meetily-ActuallyFree/releases/latest)

This fork also goes beyond removing feature restrictions. It adds a universal Windows installer, broader GPU support, more reliable multi-track recording and recovery, improved speaker diarization, portable local storage, and in-app updates.

The Windows installer includes all three transcription backends:

- **NVIDIA CUDA** for supported NVIDIA GPUs
- **Vulkan** for supported AMD, Intel, and NVIDIA GPUs
- **CPU** for systems without a compatible GPU

Setup detects the available hardware and installs the best compatible build. CPU remains the safe fallback, and advanced users can force a backend with `/BACKEND=cuda`, `/BACKEND=vulkan`, or `/BACKEND=cpu`.

## What This Fork Adds

The list below compares this project with the original Meetily baseline from which it was forked. Meetily's core local recording, transcription, meeting history, and summarization workflow remain the foundation; these are the additional capabilities and improvements maintained here.

### Fully Unlocked Access

- No account, login, subscription, license key, trial, or premium feature checks
- Every local feature is available immediately after setup
- No application analytics or telemetry sent by this fork
- No unsupported Python/FastAPI server, Docker stack, or separate transcription service required

### Universal Windows Distribution

- One x64 setup contains CPU, Vulkan, and NVIDIA CUDA application builds
- Automatic hardware detection selects the best compatible backend while retaining CPU fallback
- NVIDIA CUDA supports a broad range of Turing and newer GPU architectures
- Vulkan acceleration supports compatible AMD, Intel, and NVIDIA GPUs
- Required CUDA runtime, DirectML, Visual C++ runtime, FFmpeg, and local AI sidecars are packaged for end users
- A custom frameless Windows bootstrapper provides install location selection and byte-weighted progress
- Native update-specific UI replaces setup wording during in-app updates
- Signed Tauri updater metadata enables download-and-install updates from inside the app
- Release checksums and embedded-payload verification support manual integrity checks

### More Reliable Recording And Transcription

- Microphone and system audio are captured, VAD-processed, and transcribed independently
- Mixed `audio.mp4` is retained for playback while aligned `mic.mp4` and `system.mp4` preserve source identity
- Mic-specific and system-specific VAD calibration recovers quiet headset speech without making digital loopback overly sensitive
- Live utterances finalize after silence even when an audio backend suppresses zero-filled callbacks
- Recording checkpoints and incremental saves support recovery after interruptions
- Separate-source enhanced retranscription prevents one speaker from masking another
- Enhanced retranscription preserves deterministic microphone identity as `You`
- Whisper and Parakeet models unload when idle to release RAM and VRAM

### Speaker Identity And Diarization

- Source-aware live speaker labels distinguish the local microphone from system audio
- Fully local offline diarization uses bundled pyannote segmentation and WeSpeaker embeddings
- Exact speaker-count mode bypasses unreliable one-threshold-fits-all clustering when the participant count is known
- Optional automatic speaker detection remains available when the count is unknown
- The retained microphone track deterministically identifies `You`; only remote system audio needs clustering
- Simultaneous speech can be represented as `You + Speaker 1` instead of forcing one identity
- A local voiceprint can identify the user in older mixed-only recordings
- Stable speaker colors reserve blue for `You`, with distinct colors for remote speakers
- Speaker names can be corrected per meeting without silently renaming unrelated people

### Improved Post-Call Workflow

- A guided post-call sequence asks for the total speaker count before enhancement
- Retained mic/system tracks are retranscribed independently, then diarized, refreshed, and summarized in order
- The summary always uses fresh SQLite transcript rows rather than stale paginated UI state
- Failed enhancement, diarization, refresh, and summary stages can be retried independently
- The live transcript remains usable when retained audio is unavailable or enhancement is skipped
- Local model downloads resume partial files and validate exact sizes before reporting completion
- Parakeet downloads automatically fall back between public Hugging Face and this project's GitHub release mirror

### Search, People, And Meeting Intelligence

- Global `Ctrl/Cmd+K` search covers people, meeting titles, transcript text, and visible summaries
- Durable person profiles link explicitly named speakers across meetings
- Person pages collect mapped conversation history and visible meeting summaries
- Grounded person Q&A is assembled from local SQLite data with meeting/date/time citations
- Meeting-local speaker renames can split identities safely instead of changing every historical meeting
- Generated and source labels such as `Speaker 1`, `Guest`, and `You` are never incorrectly treated as people

### Export, Privacy, And Portability

- Native Save dialogs export PDF, DOCX, Markdown, text, and JSON to the destination the user chooses
- Clipboard export remains available without creating an intermediate file
- App-managed databases, settings, templates, and models prefer `<install directory>\data`, with an OS-data fallback when the installation directory is not writable
- Recordings use the user's Music folder and retain mixed plus aligned source tracks
- Existing legacy app-data content is migrated non-destructively on first portable launch
- Audio and transcripts stay local unless the user explicitly configures a cloud summary provider
- First-party GitHub assets and public Hugging Face repositories replace dependencies on upstream-hosted model files

## Why Choose This Fork?

- **Actually free:** no account system or paid-feature gate stands between the user and local functionality.
- **Easier Windows setup:** one installer handles dependencies and chooses CUDA, Vulkan, or CPU automatically.
- **Broader hardware support:** NVIDIA, AMD, Intel, and CPU-only computers use the same release.
- **Better speaker accuracy:** source tracks preserve who spoke, while local diarization separates remote participants.
- **Safer long meetings:** checkpoint recovery, resumable model downloads, and explicit retry stages reduce lost work.
- **More private and portable:** no telemetry, no required server, and app-managed data stays with writable installations instead of being scattered across services.
- **More useful history:** global search, durable people, grounded Q&A, and richer exports make past meetings actionable.
- **Maintained release path:** in-app updates, updater signatures, checksums, and release smoke tests are part of the build process.

This is not a separate rewrite. It retains Meetily's MIT-licensed local meeting foundation while maintaining a substantially different Windows distribution, storage model, audio pipeline, post-call workflow, search system, and speaker-identity path.

## Core Features

- Records microphone and system audio
- Transcribes locally with Whisper or Parakeet
- Uses CPU, Vulkan, or NVIDIA CUDA acceleration
- Labels speakers during and after meetings
- Summarizes with local models, Ollama, or user-configured cloud providers
- Searches previous meetings and people locally
- Exports to PDF, DOCX, Markdown, text, and JSON
- Stores meetings and settings on the local machine

## Install

1. Download the latest `.exe` from [GitHub Releases](https://github.com/TylerBuza/Meetily-ActuallyFree/releases/latest).
2. Run the installer.
3. Choose a transcription model on first launch.

The installer is currently unsigned. Windows may show an `Unknown publisher` or SmartScreen warning. The release page includes a SHA-256 checksum so the download can be verified.

`v0.1.0` users need to install `v0.2.0` manually because the first release did not have a usable updater signing key. In-app download and installation works for releases after `v0.2.0`.

### Requirements

- Windows 10 or 11, x64
- Microphone permission
- NVIDIA GPU with a recent driver for CUDA acceleration, or a supported AMD/Intel/NVIDIA GPU with a Vulkan driver

CPU mode works without a supported GPU. A CUDA Toolkit or Vulkan SDK is not required on the computer running the installed app.

## Local Data

- App data and downloaded models: `<install directory>\data` when writable; otherwise the OS application-data fallback
- Recordings: `%USERPROFILE%\Music\meetily-recordings\<meeting>`
- Mixed playback: `audio.mp4`
- Separate sources: `mic.mp4` and `system.mp4`

Audio and transcripts stay local unless a cloud summary provider is explicitly configured.

## Build On Windows

Prerequisites are Rust, Node.js, pnpm, Visual Studio 2022 Build Tools with the C++ workload, CMake, and Git.

```powershell
cd frontend
pnpm install
pnpm run tauri:dev:cpu
```

The universal release build is produced by:

```powershell
cd frontend
.\scripts\build-universal-windows.ps1 -AllowUnsigned
```

`-AllowUnsigned` is required for local builds without a configured code-signing certificate. See [`CLAUDE.md`](CLAUDE.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md) for build and implementation details.

## Upstream And License

Meetily - Actually Free is maintained by [Tyler Buza](https://buza.dev) and is based on the original [Meetily](https://github.com/Zackriya-Solutions/meetily) project by Zackriya Solutions.

The project remains available under the MIT License. See [`LICENSE.md`](LICENSE.md). Original copyright notices and license terms are retained.

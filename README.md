# Meetily - Actually Free

An entirely free, fully unlocked fork of [Meetily](https://github.com/Zackriya-Solutions/meetily). Every feature is available without an account, subscription, license key, trial, or paid tier.

[Download the latest Windows release](https://github.com/TylerBuza/Meetily-ActuallyFree/releases/latest)

This fork also goes beyond removing feature restrictions. It adds a universal Windows installer, broader GPU support, more reliable multi-track recording and recovery, improved speaker diarization, portable local storage, and in-app updates.

The Windows installer includes all three transcription backends:

- **NVIDIA CUDA** for supported NVIDIA GPUs
- **Vulkan** for supported AMD, Intel, and NVIDIA GPUs
- **CPU** for systems without a compatible GPU

Setup detects the available hardware and installs the best compatible build. CPU remains the safe fallback, and advanced users can force a backend with `/BACKEND=cuda`, `/BACKEND=vulkan`, or `/BACKEND=cpu`.

## How This Fork Differs

| Area | Meetily - Actually Free |
| --- | --- |
| Access | No account, subscription, license key, trial, or premium feature checks. |
| Windows installer | One x64 installer contains NVIDIA CUDA, AMD/Intel/NVIDIA Vulkan, and CPU builds. Setup selects a compatible backend and keeps CPU as the fallback. |
| Recording | Saves mixed playback audio and aligned microphone/system tracks. Checkpoints support recovery after an interrupted recording. |
| Speaker labels | Uses source-aware live labels, post-call diarization, overlap labels, and an optional local voiceprint for identifying the user. |
| Runtime | The supported app is the Tauri/Rust desktop application. It does not require Docker, FastAPI, or a separate transcription server. |
| Storage | App-managed data is portable under the install directory. Recordings remain in the user's Music folder. |
| Models | First-party release assets and public Hugging Face sources replace dependencies on upstream-hosted model files. |
| Telemetry | No application telemetry is sent by this fork. |

This is not a separate rewrite. It retains Meetily's local meeting workflow and MIT-licensed foundation while maintaining a different Windows distribution, storage model, audio pipeline, and speaker-labeling path.

## Features

- Records microphone and system audio
- Transcribes locally with Whisper or Parakeet
- Uses CPU, Vulkan, or NVIDIA CUDA acceleration
- Labels speakers during and after meetings
- Summarizes with local models, Ollama, or user-configured cloud providers
- Searches previous meetings locally
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

- App data and downloaded models: `<install directory>\data`
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

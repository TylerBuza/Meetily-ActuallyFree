# Meetily - Actually Free

<p align="center">
  <img src="frontend/src-tauri/icon-source.png" alt="Meetily - Actually Free logo" width="240" />
</p>

<p align="center">
  <strong>A Windows-focused fork of Meetily with local speaker identity, people profiles, automatic meeting detection, dark mode, advanced exports, and a universal GPU installer included.</strong>
</p>

<p align="center">
  <a href="https://github.com/TylerBuza/Meetily-ActuallyFree/releases/latest"><strong>Download for Windows</strong></a>
  ·
  <a href="https://github.com/TylerBuza/Meetily-ActuallyFree/releases">Release notes</a>
  ·
  <a href="PRIVACY_POLICY.md">Privacy</a>
</p>

Built from the open-source [Meetily Community Edition](https://github.com/Zackriya-Solutions/meetily), with a different Windows distribution and additional local meeting workflows.

## Fork Comparison

Compared with upstream Meetily Community `v0.4.0` (verified August 2026).

Both free desktop apps include real-time recording and local transcription, optional bring-your-own-key cloud summaries through Claude, OpenAI, Groq, and OpenRouter, and in-app updates. The features below are the additions that distinguish this fork:

| Area | Meetily Community | Meetily - Actually Free |
| --- | :---: | :---: |
| Windows, macOS, and Linux support | Yes | Windows release |
| Speaker distinction and local diarization | Marketed as planned for PRO | **Included free** |
| Deterministic local-user label from retained mic audio | Not present | **`You` + overlap labels** |
| Separate aligned mic/system recordings | Mixed playback recording | **`audio.mp4`, `mic.mp4`, `system.mp4`** |
| Automatic meeting-app detection | Marketed as PRO | **Included free, fully on-device** |
| Dark mode and redesigned interface | Light interface | **Overhauled dark-first theme with light mode** |
| Advanced PDF/DOCX/text/JSON exports | Marketed as PRO; Community exports Markdown | **Included with native Save dialogs** |
| Global title/transcript/summary/person search | Not present | **Included** |
| User/people profiles and grounded person Q&A | Not present | **Included** |
| One Windows installer for CUDA, Vulkan, and CPU | Separate build/backend choices | **Automatic selection in one setup** |
| App-managed portable data layout | Standard OS app-data layout | **Install-local when writable** |
| Telemetry and usage analytics | Optional, off by default | **Disabled; no analytics events are sent** |

Upstream provides the open-source foundation: local processing, live transcription, professional audio mixing, summaries, cloud providers, import and enhance, GPU acceleration, recovery checkpoints, and in-app updates. This fork adds free speaker identity, meeting detection, a dark-first interface, search/people workflows, advanced exports, portability, a simpler Windows installation experience, and reliability fixes.

## Highlights

- **Speaker-aware transcripts:** mic speech stays `You`; remote voices become `Speaker N`; overlap can render as `You + Speaker 1`.
- **Automatic meeting detection:** watches locally for Zoom, Teams, Slack, Webex, and other meeting apps, then prompts you to start recording.
- **Overhauled interface:** a cohesive dark-first theme across recording, transcripts, summaries, people, and settings, with light mode available.
- **Universal Windows setup:** one installer selects NVIDIA CUDA, Vulkan, or CPU and packages required runtimes.
- **Better post-call processing:** retranscribes retained mic/system tracks independently before diarization and summary.
- **Meeting memory:** global search, reusable people profiles, speaker naming, and grounded person Q&A.
- **Native exports:** PDF, DOCX, Markdown, text, JSON, or clipboard.
- **Resilient local models:** resumable, validated downloads with Parakeet mirror fallback.
- **Private updates and no telemetry:** opt-in launch checks and manual in-app updates, with analytics transmission disabled.

## Install

1. Download `Meetily-ActuallyFree-*-universal-setup.exe` from the [latest release](https://github.com/TylerBuza/Meetily-ActuallyFree/releases/latest).
2. Run setup. It selects CUDA, Vulkan, or CPU automatically.
3. Complete first-launch model setup.

Windows 10/11 x64 is supported. The installer is currently unsigned, so SmartScreen may show **Unknown publisher**. Every release includes `SHA256SUMS.txt` for verification.

## Local Data

| Data | Location |
| --- | --- |
| Database, settings, and models | `<install directory>\data` when writable; OS app-data fallback otherwise |
| Recordings | `%USERPROFILE%\Music\meetily-recordings\<meeting>` |
| Playback and retained tracks | `audio.mp4`, `mic.mp4`, `system.mp4` |

## Build

<details>
<summary>Windows build instructions</summary>

Requirements: Rust, Node.js, pnpm, Visual Studio 2022 Build Tools with C++, CMake, and Git.

```powershell
cd frontend
pnpm install
pnpm run tauri:dev:cpu
```

Universal release build:

```powershell
cd frontend
.\scripts\build-universal-windows.ps1 -AllowUnsigned
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for implementation and release details.

</details>

## Credits And License

Maintained by [Tyler Buza](https://buza.dev). Based on the original [Meetily](https://github.com/Zackriya-Solutions/meetily) project by Zackriya Solutions.

MIT licensed. See [`LICENSE.md`](LICENSE.md). Original copyright notices and license terms are retained.

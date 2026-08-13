# Meetily - Actually Free

<p align="center">
  <img src="frontend/src-tauri/icon-source.png" alt="Meetily - Actually Free logo" width="240" />
</p>

An entirely free, fully unlocked fork of [Meetily](https://github.com/Zackriya-Solutions/meetily). Every feature is available without an account, subscription, license key, trial, or paid tier.

[Download the latest Windows release](https://github.com/TylerBuza/Meetily-ActuallyFree/releases/latest)

This fork also goes beyond removing feature restrictions. It adds speaker identity, separate mic and system audio, automatic meeting detection, people profiles, richer exports, a redesigned interface, a universal Windows installer, and numerous recording and reliability improvements.

## Feature Comparison

Compared with Meetily Community `v0.4.0` and the PRO advantages advertised on its project page (verified August 2026).

**Legend:** ✅ Included · 🔒 Paid PRO feature · ⚠️ Limited · ❌ Not included · ➖ Not publicly listed

| Feature | Meetily Community | Meetily PRO (Paywalled) | Meetily - Actually Free |
| --- | :---: | :---: | :---: |
| Live recording and local transcription | ✅ Included | ✅ Included | ✅ Included |
| Local and BYOK cloud summaries | ✅ Included | ✅ Included | ✅ Included |
| Custom summary templates | ❌ Not included | 🔒 Paid | ✅ Included free |
| Advanced exports | ⚠️ Markdown only | 🔒 PDF, DOCX, and Markdown | ✅ PDF, DOCX, Markdown, text, and JSON |
| Automatic meeting detection | ❌ Not included | 🔒 Detect and join | ✅ Local meeting-app alerts |
| Speaker identification | ❌ Not included | 🔒 Announced as coming soon | ✅ Local `You` and speaker labels |
| Chat with meetings | ❌ Not included | 🔒 Announced as coming soon | ✅ Transcript-grounded Q&A |
| Separate mic and system recordings | ❌ Mixed recording only | ➖ Not publicly listed | ✅ Separate tracks plus mixed playback |
| Live mic and system meters | ⚠️ Setup test only | ➖ Not publicly listed | ✅ Visible throughout recording |
| Compact recording controls | ❌ Full window only | ➖ Not publicly listed | ✅ Floating bar with timer and controls |
| Search and people profiles | ❌ Not included | ➖ Not publicly listed | ✅ Meetings, transcripts, summaries, and people |
| Dark mode | ❌ Light interface | ➖ Not publicly listed | ✅ Redesigned dark and light themes |
| Windows GPU installation | ⚠️ Separate backend choices | ➖ Not publicly listed | ✅ One setup selects CUDA, Vulkan, or CPU |
| Usage telemetry | ⚠️ Optional, off by default | ➖ Not publicly listed | ✅ Disabled; no analytics events sent |

This fork independently implements the matching PRO capabilities above and makes them available without an account, subscription, or license key. It does not claim PRO features that are not implemented here, such as calendar integration, team self-hosting, compliance audit trails, or priority support.

## Highlights

- **Speaker-aware transcripts:** mic speech stays `You`; remote voices become `Speaker N`; overlap can render as `You + Speaker 1`.
- **Split audio pipeline:** microphone and system audio are VAD-processed and transcribed independently, while aligned source tracks are retained beside the mixed playback file.
- **Live source visualization:** separate mic and system meters show pre-mix activity throughout recording.
- **Floating recording bar:** shrink the main window into a compact minibar with a synchronized timer and pause, resume, stop, and restore controls.
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

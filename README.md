# Meetily - Actually Free

<p align="center">
  <img src="frontend/src-tauri/icon-source.png" alt="Meetily - Actually Free logo" width="240" />
</p>

An entirely free, fully unlocked fork of [Meetily](https://github.com/Zackriya-Solutions/meetily). Every feature is available without an account, subscription, license key, trial, or paid tier.

[Download for Windows](https://github.com/TylerBuza/Meetily-ActuallyFree/releases/latest) · [Download for macOS Apple Silicon](https://github.com/TylerBuza/Meetily-ActuallyFree/releases/tag/v0.2.5-macos)

This fork also goes beyond removing feature restrictions. It adds speaker identity, separate mic and system audio, automatic meeting detection, people profiles, richer exports, a redesigned interface, dedicated Windows and Apple Silicon installers, and numerous recording and reliability improvements.

## Interface

<p align="center">
  <img src="docs/images/meetily-interface.png" alt="Meetily live recording interface with speaker-labelled transcription" width="1100" />
</p>

<p align="center"><sub>Live speaker-labelled transcription with synchronized source controls, shown with sanitized demo meetings.</sub></p>

## Latest Release

Meetily `v0.2.11` adds adjustable system-audio gain with safety limiting,
improves NVIDIA driver recovery and CUDA setup guidance, and adds validated
custom recording folders.
[Read the v0.2.11 changelog](CHANGELOG.md).

## Feature Comparison

Compared with Meetily Community `v0.4.0` and the PRO advantages advertised on its project page (verified August 2026).

**Legend:** ✅ Included · ❌ Not included

| Feature | Meetily Community | Meetily PRO (Paywalled) | Meetily - Actually Free |
| --- | :---: | :---: | :---: |
| Live recording and local transcription | ✅ | ✅ | ✅ |
| Local and BYOK cloud summaries | ✅ | ✅ | ✅ |
| Create custom summary templates | ❌ | ✅ | ✅ |
| Automatic meeting joining | ❌ | ✅ | ❌ |
| Advanced PDF and DOCX exports | ❌ | ✅ | ✅ |
| Separate mic and system recordings | ❌ | ❌ | ✅ |
| Calendar integration | ❌ | ✅ | ❌ |
| Speaker identification | ❌ | ✅ | ✅ |
| Live mic and system audio visualizations | ❌ | ❌ | ✅ |
| Independent mic and system mute controls | ❌ | ❌ | ✅ |
| Automatic meeting detection | ❌ | ✅ | ✅ |
| Floating recording controls | ❌ | ❌ | ✅ |
| Compliance audit trails | ❌ | ✅ | ❌ |
| Chat with meetings | ❌ | ✅ | ✅ |
| Speaker profiles | ❌ | ❌ | ✅ |
| Dark mode | ❌ | ❌ | ✅ |
| Windows GPU acceleration | ❌ | ✅ | ✅ |
| Automatic GPU setup | ❌ | ❌ | ✅ |
| No analytics transmission or license checks | ❌ | ❌ | ✅ |

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
- **Whisper vocabulary hints:** teach live and post-call transcription recurring names, acronyms, products, and meeting-specific terms.
- **Private updates and no telemetry:** Windows update checks are opt-in, and analytics transmission is disabled on every platform.

## Install

### Windows

1. Download `Meetily-ActuallyFree-*-universal-setup.exe` from the [latest release](https://github.com/TylerBuza/Meetily-ActuallyFree/releases/latest).
2. Run setup. It selects CUDA, Vulkan, or CPU automatically.
3. Complete first-launch model setup.

Windows 10/11 x64 is supported. The installer is unsigned, so SmartScreen may
show **Unknown publisher**.

### macOS Apple Silicon

1. Download `Meetily-Actually-Free_0.2.5_aarch64.dmg` from the [macOS release](https://github.com/TylerBuza/Meetily-ActuallyFree/releases/tag/v0.2.5-macos).
2. Open the DMG and drag **Meetily - Actually Free** to Applications.
3. Grant microphone and Audio Capture permissions when prompted.

M1 and newer Macs running macOS 14.2 Sonoma or later are supported. The DMG is not Apple-notarized, so first launch may require Control-clicking the app and selecting **Open**. Both releases include SHA-256 checksums.

The current macOS 0.2.5 artifact passed automated Apple Silicon packaging and
launch checks, but physical macOS 14.2 capture qualification is still pending.
Treat it as a preview and verify recordings before relying on it for critical
meetings.

## Local Data

| Data | Location |
| --- | --- |
| Database, templates, and models | Windows/Linux: install-local when writable; macOS: `~/Library/Application Support/Meetily` |
| Recording/onboarding preference stores | macOS: `~/Library/Application Support/com.meetily.ai` |
| Recordings | Windows: `Music/meetily-recordings`; macOS: `Movies/meetily-recordings`; configurable in Settings |
| Playback and retained tracks | `audio.mp4`, `mic.mp4`, `system.mp4` |

Use **Settings → General → Data Storage Locations** or **Settings → Recording →
Save Location** to choose another writable recordings folder.
Meetily validates the destination before saving it and keeps core app data in
the platform-specific location above.

## Build

<details>
<summary>Build instructions</summary>

Windows requirements: Rust, Node.js, pnpm, Visual Studio 2022 Build Tools with C++, CMake, and Git.

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

Apple Silicon DMG build on macOS 14.2 or later:

```bash
cd frontend
pnpm install
./scripts/build-macos-apple-silicon.sh
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for implementation details and the
[`macOS release runbook`](.github/workflows/MACOS_RELEASE.md) for the native
candidate, publication, and physical-device checks.

</details>

## Credits And License

Maintained by [Tyler Buza](https://buza.dev). Based on the original [Meetily](https://github.com/Zackriya-Solutions/meetily) project by Zackriya Solutions.

MIT licensed. See [`LICENSE.md`](LICENSE.md). Original copyright notices and license terms are retained.

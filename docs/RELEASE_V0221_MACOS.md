## macOS Apple Silicon preview

This preview includes the tested shared fixes since v0.2.20-macos:

- Preserve delayed microphone/system samples and pending audio tails in the mixer.
- Preserve overlapping speakers in display, export, and component-level renaming (#44/#45).
- Keep post-call processing owned across navigation, retain progress, and add meeting-scoped cancellation (#31/#35). Keep live transcript and Close/Escape skip enhancement and speaker identification. Cancellation during diarization waits for that native operation to finish.
- Add Markdown metadata and optional Obsidian speaker links (#27).
- Apply saved vocabulary hints to Parakeet live, imported, and post-call transcription (#10).
- Distinguish macOS system-audio inactivity and capture ending from a closed processing channel (#42).

**The latest Mac recording failure in #42 is not confirmed fixed.** Its exact build, trigger, and logs are still needed. Improved messages help identify the failing path.

### Installation

Download `Meetily-Actually-Free_0.2.21_aarch64.dmg` for **Apple Silicon (M1 or newer), macOS 14.2 or later**. Quit Meetily and replace the app in Applications. No data reset is required; retain existing meetings, recordings, models, and settings. Updates are manual.

The app is ad-hoc signed, not notarized. If blocked, try opening it, then use **System Settings → Privacy & Security → Open Anyway**. Verify the download with `SHA256SUMS-macos.txt`.

### Qualification and limits

The preceding integrated source passed 379 Windows CPU native tests, 32 isolated frontend test files, a production frontend build, and Apple Silicon build/bundle checks with 30 synthetic capture regressions. The versioned candidate must also pass the macOS build, bundle checks, and capture regressions before publication.

No physical Apple Silicon capture test or real-speech vocabulary accuracy test was performed for this preview. Native diarization is not immediately preemptible, and post-call ownership across a WebView reload is not established. The remaining #38 feature bundle and #22 Linux capture changes are excluded.

For #42, please report the app version, macOS version, microphone/output devices, transcription model, capture mode, and whether the error followed idle audio, mute/pause, device switching, or Stop. Share only redacted logs; private recordings are not required.

**Windows stays on v0.2.20, the repository's Latest release.** This macOS-only preview does not change the Windows installer or updater.

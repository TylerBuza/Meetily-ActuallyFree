**The redesigned Meetily workspace is now available as an Apple Silicon preview.**
See the [v0.2.18 highlights and contributor thanks](https://github.com/TylerBuza/Meetily-ActuallyFree/releases/tag/v0.2.18)
for the new interface, meeting tools, and recording improvements. Per-app capture
and GPU options vary by platform.

## Install

- Requires an **Apple Silicon Mac (M1 or newer)** and **macOS 14.2 Sonoma or later**.
- Download `Meetily-Actually-Free_0.2.18_aarch64.dmg`, open it, and drag the app to
  **Applications**. Open it from there and grant **Microphone** and **Audio Capture**
  permissions when prompted.
- This build is **ad-hoc signed, not Apple-notarized**. If macOS blocks opening it,
  use **System Settings → Privacy & Security → Open Anyway** after attempting to
  launch it.
- Updates are manual; keep your application data and recordings when replacing
  the app. Checksums are included in `SHA256SUMS-macos.txt`.

**Preview qualification:** automated Apple Silicon packaging, signature,
dependency, and repeated-launch checks passed. Physical-device recording,
permission prompts, and the macOS 14.2 minimum remain untested for this build.
Please report problems through [Issues](https://github.com/TylerBuza/Meetily-ActuallyFree/issues).

Windows downloads remain on the repository's **Latest** release.

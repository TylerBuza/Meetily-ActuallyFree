## macOS recording stability preview

For **Apple Silicon (M1 or newer), macOS 14.2 or later**.

### Fixes

- Start the system-audio tap immediately, including when the computer is silent,
  instead of stopping the meeting after five seconds (#46 / #42).
- If the system tap later stalls, warn clearly and keep the microphone recording.
  Computer audio resumes if callbacks recover. An ended capture stream or changed
  sample rate still stops the recording rather than silently losing that source.
- Read Audio Capture authorization so a silent computer does not cause a false
  permission banner on every launch. Handle stale grants and permission revocation
  with a fresh status query; retain the audio-probe fallback when unavailable (#47).
- Show backend reasons for otherwise unrecognized recording-start errors (#53).
- Correct the transposed mel-feature layout behind a live Nemotron tensor error
  reported in #42. Speaker identity, source labels, and audio timing are preserved.

### Install

Quit Meetily, download `Meetily-Actually-Free_0.2.22_aarch64.dmg`, and replace the app
in Applications. **Keep existing meetings, recordings, models, and settings; no
reset is needed.** Updates are manual. This build keeps the existing app identity.

The app is ad-hoc signed, not Apple-notarized. If blocked, try opening it and use
**System Settings → Privacy & Security → Open Anyway**. Verify the DMG using
`SHA256SUMS-macos.txt`.

### Qualification and remaining limits

This is a CI-qualified preview, not physical-device signoff. Candidate run
`39810916314` passed the frontend production build, **374 native tests (8 ignored)**,
packaged permission helper, and Apple Silicon bundle checks. All 34 isolated
frontend test files also passed locally. The Nemotron layout regression uses
synthetic arrays, not a real speech/model accuracy fixture. The permission query
uses a private Apple API resolved at runtime and falls back if unavailable.

Please confirm startup in silence, playback starting later, saved mic/system audio,
and Stop on the original affected Mac. Bluetooth, Multi-Output Device, minimum
macOS 14.2 runtime, and real-call live Nemotron remain unqualified here.

Thanks to @KARAtel218 and @sscarduzio for fixes and physical-Mac investigation.
**Windows remains on v0.2.20 Latest; its installer and updater are unchanged.**

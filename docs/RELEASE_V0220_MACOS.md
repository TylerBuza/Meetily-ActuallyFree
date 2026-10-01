## macOS recording-fix preview

This Apple Silicon preview follows up on [#42](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/42):

- Fix Stop waiting indefinitely for a microphone callback retained by the native audio backend. The capture worker now has explicit shutdown and a bounded wait.
- Recover microphone audio when a brief interruption leaves its sample clock behind the mixer. Fresh audio can resume instead of being discarded indefinitely.

These fixes still need confirmation on the reporter's Mac. Missing live transcription where the saved audio is intact may have a separate cause.

### Download and test

Download `Meetily-Actually-Free_0.2.20_aarch64.dmg` for **Apple Silicon (M1 or newer), macOS 14.2 or later**. Quit Meetily, open the DMG, and replace the app in Applications. Keep your existing meetings, recordings, models, and settings; no data reset is required. This preview uses manual updates.

The app is ad-hoc signed, not notarized. If macOS blocks it, try opening it, then use **System Settings → Privacy & Security → Open Anyway**. Check the DMG against `SHA256SUMS-macos.txt` if needed.

Please make a new 10–15 minute recording, watch live transcription, click Stop, and replay the microphone track. Report whether Stop completes and whether audio or text goes missing in [#42](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/42). If it fails, include your macOS version, microphone, transcription model, and app log around the failure, with private content redacted.

### Qualification

The publication gate requires an Apple Silicon build, all 22 synthetic capture-worker/source-continuity regressions, bundle/signature/dependency verification, and repeated launch checks. These do not establish physical recording or speech-model accuracy. Real-device capture, permission prompts, and the macOS 14.2 minimum remain unqualified. Existing damaged recordings are not repaired.

This is a separate, non-Latest prerelease. Windows v0.2.18 remains Latest.

### Published build evidence

- Source: `9aa4f21baaf3cd1670aa9cbc8b88780afbc05d14`.
- [Apple Silicon build 36876715270](https://github.com/TylerBuza/Meetily-ActuallyFree/actions/runs/36876715270): all 22 targeted regressions, bundle checks, and repeated launches passed.
- [Frontend CI 36876715035](https://github.com/TylerBuza/Meetily-ActuallyFree/actions/runs/36876715035): passed.
- [Publisher 36878838754](https://github.com/TylerBuza/Meetily-ActuallyFree/actions/runs/36878838754): published the immutable prerelease.
- [Public smoke test 36878960910](https://github.com/TylerBuza/Meetily-ActuallyFree/actions/runs/36878960910): public download/provenance, installation, and repeated-launch checks passed.
- DMG SHA-256: `cf22a9264d80cbcebc0042cffaf13b07574426e752f1e3ed47a094b12e55bc92`.

No physical Mac recording or real-speech fixture was used for this qualification.

# Windows v0.2.23 qualification

Published build source: `8e7db421771b46f31f9c76fea0f60724d3f757b1`.
The user explicitly lifted the Windows publication hold on October 28, 2026.
Windows **v0.2.23** was installed locally and published as the immutable Latest
release on October 28, 2026 at 19:24:57 UTC. macOS remains on its separate
`v0.2.22-macos` Apple Silicon preview.

## Completed source checks

- Windows CPU native suite: **389 passed, ten ignored**. Includes lifecycle
  journal persistence, session recovery/ZIP export, bounded queues, privacy
  allowlists, speaker-component edits, post-call cancellation, vocabulary, and
  the contiguous Nemotron feature-layout regression.
- **34/34 isolated frontend test files passed**. Next production build, lint,
  and build-time TypeScript validation passed.
- GitHub frontend CI `40744890933` passed at the candidate source commit.
- Rebuilt the CPU summary helper from current source; its two native tests passed.
- Restored incomplete frontend dependencies using the existing frozen lockfile.
  Native compilation used MSVC and LLVM 18/libclang. LLVM 22 was incompatible
  with this Whisper/bindgen dependency combination; no dependency upgrade was
  introduced to work around it.

The ignored model/audio-dependent tests were not run. Existing bundled-model
tests exercise synthetic inputs; this release does not claim new physical
recording, real-speech accuracy, or reporter-device qualification. The Teams/
Vulkan freeze in #67 remains undiagnosed.

## Packaging and upgrade checks

The authoritative `frontend/scripts/build-universal-windows.ps1` completed all
CPU/Vulkan/CUDA variants and the universal setup/updater payload. As with prior
Windows releases, the app/installers are not Authenticode-signed; updater signing
uses the existing private key. Keys and local diagnostic/backup artifacts remain
outside Git. `node frontend/scripts/verify-windows-release.mjs` passed manifest,
checksum, cryptographic signature, archive integrity, staged variant/runtime hash,
and bootstrapper payload verification. The updater contains 38 files totaling
1,587,241,744 uncompressed bytes.

Before the user-approved local upgrade, a hash-verified private backup preserved
660 model/preference/recording files plus a consistent SQLite backup. Database
integrity was `ok`, with seven meetings and 4,486 transcript rows. No recording
or transcription content is included in this qualification note.

The v0.2.20 app exited cleanly before installation. The v0.2.23 updater `/S`
returned exit code 0 and selected CUDA on this machine. The installed executable
matched the staged CUDA hash; the installed summary helper matched the rebuilt
helper (`3c8eb5e1b366926da277c55b546bed10815aeaeae61532585bd922483a04a533`).
Before first launch, all 660 file hashes and every database table digest matched
the backup exactly. The WebView profile was also backed up privately.

Two installed-app launches passed native IPC and rendered-workspace checks:
version 0.2.23, onboarding completed, recording idle, Nemotron still selected,
runtime ready, Parakeet initialized, and no pending crash report or frontend
crash. The persisted journal contained completed `whisper_init`, `parakeet_init`,
and `runtime_check` events. Both native exits removed the session marker. The app
was reopened normally, without the temporary local WebView debugging port.
These checks did not record audio or run speech-model inference.

### Preservation and expected startup changes

The strict backup comparison intentionally reported startup differences; they
were investigated with a separate read-only verifier, not ignored or restored
over the running app's state:

- All seven meetings and all 4,486 transcript rows remain. Transcript rows and
  every table except the three below match the original table contents exactly;
  SQLite integrity remains `ok`.
- `action-item-sync.ts` performed its existing startup backfill on one summary.
  Its full 5,198-character Markdown is preserved exactly as `original_markdown`.
  The displayed Markdown exactly matches `extractActionItems(...).remainingMarkdown`;
  all ten new action rows match the extracted text, owner, and due fields.
- All 24 original action items are unchanged; there are now 34. Only one meeting's
  `updated_at`/`action_items_source` and one summary's `updated_at`/`result` changed.
  A second launch created no additional action items. The removed `english_cache`
  is a regenerable intermediate translation cache (owned by `summary/service.rs`),
  not the original summary or transcript.
- After clean exits, 659 of 660 files remain byte-identical. The remaining
  `analytics.json` has identical parsed values with reordered JSON keys. No
  settings values, model files, or recordings changed.

The backfill is pre-existing application behavior, not a new diagnostics migration.
Backup and verification artifacts remain private and are not release assets.

## Publication provenance

- [Published release](https://github.com/TylerBuza/Meetily-ActuallyFree/releases/tag/v0.2.23),
  release ID `427046907`; immutable, non-prerelease, and Latest.
- The published tag resolves to the build source above. All five uploaded asset
  sizes and GitHub SHA-256 digests matched local files before and after publication.
- The unauthenticated `releases/latest/download/latest.json` and public checksum
  manifest were downloaded and matched local bytes exactly.
- All public binaries and the signature were then downloaded independently.
  `verify-windows-release.mjs` passed again against that public-download directory,
  including signatures, archive integrity, staged hashes, and setup payload.
- Setup: `Meetily-ActuallyFree-0.2.23-x64-universal-setup.exe`, 674,377,216 bytes,
  SHA-256 `ff3cb2d6d1960b25b1913d015be9b06a07fdfe2a79a26e3131c463dc00eff435`.
- Updater: `Meetily-ActuallyFree-0.2.23-x64-universal-updater.exe`, 673,981,857 bytes,
  SHA-256 `769477279198407212c1f8c2b7c895a5fc17b43adf9408ed319360946fe9241e`.
- The other assets are the updater `.sig`, `latest.json`, and `SHA256SUMS.txt`.
- Release follow-ups were posted on
  [#44](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/44#issuecomment-6478522929)
  and [#67](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/67#issuecomment-6478522919).

Combined-label display/export fixes are available in this installer. Reporter
confirmation remains open for #44/#45; microphone leakage/excessive overlap labels
are separate from display collapse. #67's Teams/Vulkan freeze remains undiagnosed;
the new timeline improves future reports without establishing its cause. Voice
profiles remain opt-in and beta, and no telemetry was added. Physical Apple Silicon
release qualification, real-call Nemotron accuracy, and actual AMD ROCm
build/inference are not established by these Windows checks.

# Windows v0.2.20 qualification

Published immutable Latest release: [v0.2.20](https://github.com/TylerBuza/Meetily-ActuallyFree/releases/tag/v0.2.20).
The tag targets build source `e1311dccb19a2b1f191ab61eb0f1f3582ee3a7e4`.
Documentation-only follow-ups may be newer on main.

## Checks performed

- All 26 isolated frontend test files and the local Next production build/type
  validation passed. Frontend CI `36921734373` also passed.
- Windows native CPU suite: 370 passed, ten opt-in tests ignored. The physical
  capture test below was then invoked explicitly in release mode.
- The first 11-minute hardware soak exposed pending-tail loss across a timeline
  reset and a long Stop. These blocked release. The corrected soak passed using
  the Logitech G733 microphone and headphone loopback through the production
  capture workers, DSP, dual VAD, mixer, and retained-track output. All 31,680,015
  nonzero system samples were preserved in order. Native Stop took 35 ms.
- The microphone supplied silence. The loopback fixture was a generated tone;
  no ASR model was invoked and no captured audio was saved/uploaded. This does
  not qualify microphone speech retention, ASR accuracy/load, or the reporters'
  devices. See [AUDIO_CALLBACK_CONTINUITY.md](AUDIO_CALLBACK_CONTINUITY.md).
- `frontend/scripts/build-universal-windows.ps1` built CPU, Vulkan, and CUDA
  variants and the universal setup/updater payload. Local build tools were LLVM
  18, Vulkan headers/shader compiler, CUDA 13, and Visual Studio 2022 Build Tools.
- `node frontend/scripts/verify-windows-release.mjs` passed manifest validation,
  updater cryptographic signatures, checksums, archive integrity, packaged backend
  hashes, FFmpeg/ONNX runtime/license payloads, and bootstrapper payload verification.
- After a verified local backup, the existing install upgraded successfully
  (installer exit 0), selected CUDA, and matched the packaged executable hash.
  SQLite integrity/row counts, model hashes, and native preference files were
  preserved before and after launch.
- Installed WebView/native IPC confirmed version 0.2.20, completed onboarding,
  ready workspace, selected/available Nemotron, and inactive recording. Two
  launches exited cleanly through native IPC. Native waveform extraction passed
  with a generated three-second sine fixture. The app was reopened normally.
- Apple Silicon candidate `36921733421` passed build/bundle/launch checks and all
  30 targeted regressions (eight worker, 22 pipeline). It was not published;
  `v0.2.20-macos` remains the earlier preview and does not contain this follow-up.

## Published assets

All five uploaded asset digests/sizes matched the verified local files before
publication. The published tag target, immutable status, Latest designation, and
public `releases/latest/download/latest.json` bytes were verified afterward.

- Setup SHA-256: `9eb765c1060d064e91069eb207bcfab02bed0e2e8ad3b034d8511dc2f5a8fbb2`
- Updater SHA-256: `65c325538185f407a4b652d4ef22b621d8eee352237a2cd64c36b5941a129acf`

The release also includes the updater signature, `latest.json`, and
`SHA256SUMS.txt`. Windows binaries are not Authenticode-signed, consistent with
the documented distribution policy; the updater signature is separate and verified.

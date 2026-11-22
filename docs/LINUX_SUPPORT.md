# Linux capture, playback, and candidate builds

This branch integrates Linux support into the ActuallyFree recording pipeline.
It does not change the release number, existing meeting/model stores, source-track
attribution, or the opt-in beta voice-profile setting. Local test/package results
are separate from a published Linux release.

## Audio ownership

- `audio/capture/pulse_enumerator.rs` owns one serialized PulseAudio protocol
  connection, an eight-request queue, operation deadlines and cancellation.
  PipeWire is supported through `pipewire-pulse`. A missing server is an error;
  ALSA aliases are never fabricated as available capture endpoints.
- `audio/devices/platform/linux.rs` keeps exact source/sink IDs separate from
  readable labels. Duplicate descriptions receive distinct labels. Saved
  `${name} (input/output)` preferences remain valid. Legacy captions resolve only
  when unambiguous; stale explicit selections require reselection.
- Both recording Start commands share resolution. Default follows the desktop
  route; an explicit endpoint is pinned. System capture uses the chosen sink's
  monitor, while microphone enumeration excludes sink monitors.
- `audio/linux_stream.rs` owns readiness, cancellation and recovery. Each stream
  has a dedicated native thread and a bounded DSP worker (256 blocks, each at
  most 20 ms). Native delivery never waits for processing. Capture is 48 kHz,
  mono microphone / stereo system; DSP supplies block-end recording seconds
  minus completed pauses to the fork's existing pipeline.
- Default route changes drain the old stream before opening the new route.
  Disconnections warn and retry for approximately 30 seconds. Exhaustion, worker
  panic or DSP disconnection reports a fatal failure. Startup failure of a
  selected source fails Start. No silent source substitution occurs.
- Stop requests a server timing cutoff, preserves queued frames through that
  cutoff, then drains accepted DSP blocks. Native cleanup has a three-second
  caller wait; its retained owner blocks restart if cleanup continues.
- `AudioStreamManager::replace_linux_source` changes only the requested source.
  A failed replacement restores its previous endpoint; failed restoration or
  failed teardown is terminal. The manager mutex serializes replacements.
- `audio/linux_level_monitor.rs` owns preview streams separately, including
  cancellation during startup. Typed selections disambiguate equal names across
  roles; Default meters follow route changes. Old emitters cannot clear a new
  session's monitoring status.
- Linux onboarding previews the saved choices or desktop defaults, not the first
  enumerated devices. Only explicitly changed choices are saved on completion;
  choosing System default clears the pin and leaves other preferences intact.
- If mic and system report fatal errors concurrently, a per-recording claim
  permits only the first error to request teardown.

The existing independent mic/system tracks, mixer, VAD, ASR and selected
diarization engine remain downstream. Microphone provenance still supplies
`You`; a model's channel number is never an identity. Native fatal handling
initiates teardown, but durable database completion retains the fork's existing
frontend-orchestration limits.

## Playback

`api_get_meeting_audio` and `api_read_meeting_audio` share database meeting-ID
lookup. Linux's `useMeetingAudio` reads the mixed track through binary IPC into
a typed Blob because WebKitGTK media cannot reliably consume the asset scheme.
The native read is single-owner and limited to 256 MiB, with both a metadata
check and a bounded read for growing files. Missing tracks and limit errors are
visible; microphone tracks are not substituted for missing mixed audio.
Navigation releases the decoder/listeners and revokes its Blob URL. Windows and
macOS retain asset-protocol streaming. Larger recordings can be played from the
recording folder externally; Linux in-app range streaming is not implemented.

## Source builds and storage

See [building_in_linux.md](building_in_linux.md) for packages and commands.
`frontend/scripts/build-linux.sh` builds explicit CPU or Vulkan candidates,
stages the matching helper using Cargo's actual target directory, and produces
DEB/AppImage packages. `tauri.linux.conf.json` replaces Windows-only resources,
supplies Linux icons/media dependencies, and bundles the media framework for
AppImage. Linux's FFmpeg sidecar is `meetily-ffmpeg`, avoiding ownership of
the distribution's `/usr/bin/ffmpeg`.
`linux-portable-cpu.cmake` disables build-host CPU tuning in both inference
libraries. The pinned Whisper sys crate ignores `GGML_*` environment variables
and its CMake no longer implements the legacy `WHISPER_NO_AVX*` flags; the
candidate script therefore supplies a CMake project-include hook.

The existing source build/dev scripts respect `CARGO_TARGET_DIR`, preserve
other platforms' sidecars, map HIP to llama-helper ROCm, locate distro CUDA
archives, and respect explicit `CMAKE_CUDA_ARCHITECTURES`. MSVC-only CUDA flags
are owned by Windows build scripts, not global Cargo configuration.

No storage migration was introduced. Standalone Linux in `paths.rs` prefers writable
`<executable directory>/data`, otherwise `$XDG_DATA_HOME/Meetily` (normally
`~/.local/share/Meetily`). AppImage always uses that OS data root: the
`--appimage-extract-and-run` directory is writable but temporary, so storing data
beside its executable would lose meetings/models when the runtime removes it.
Recordings use XDG Documents / `meetily-recordings`
unless Settings selects another directory. New preferences fall back to
`~/Documents/meetily-recordings` if XDG Documents is unset, rather than a
potentially temporary current directory; existing saved preferences are retained.
Preferences in Tauri's application data location (`$XDG_DATA_HOME/com.meetily.ai`)
are distinct from this data root. Keep both when moving an existing installation.

## Verification

Automated entry points:

```sh
cd frontend
pnpm dlx bun@1.4.0 test tests/lib/audio-devices.test.ts
pnpm dlx bun@1.4.0 test tests/hooks/meeting-audio.test.tsx
pnpm exec tsc --noEmit
cd ..
cargo test --locked -p meetily --lib --no-default-features audio:: -- --test-threads=2
cargo test --locked -p meetily --lib --no-default-features meeting_audio_tests
bash frontend/scripts/test-linux-audio.sh
```

The opt-in script starts its own PulseAudio server, exercises synthetic virtual
devices, and tears it down. It checks active-output discovery on an empty server
and again with a named virtual default, including on headless CI runners.
It does not change desktop defaults. Ordinary native
tests skip live-server and real-model tests. Next production builds must run
serially with native builds embedding `frontend/out`.

Local qualification uses WSL Ubuntu 26.04 x86_64, Rust 1.99.1, Node 22.22.1,
pnpm 11.9.0, Tauri CLI 2.11.4 and PulseAudio 17.0:

- Full Linux native library suite with no desktop audio server: **419 passed,
  16 ignored**, including **191 passed, 12 ignored** in the audio module. Ignored tests require
  explicit live-server, model or audio fixtures.
- Native meeting playback regression passed: meeting-scoped mixed-file lookup,
  missing tracks/IDs and oversized-file rejection (a sparse synthetic file).
- Preview selection regression passed, including serialized endpoint IDs with
  literal `(output)` text; preview and recording Start use the same precedence.
- Private-server synthetic capture: graceful cutoff with nonzero audio, Default
  route switching, pause/resume, pinned selection, endpoint removal/recreation,
  failed-switch rollback, continued microphone delivery while switching system
  capture, real 30-second recovery exhaustion, and preview restart/default
  switching passed across four opt-in tests. A fifth opt-in test verified that
  an empty private server reports no output, then resolves the selected virtual sink.
- Native regressions cover cancelling Start while waiting for worker readiness
  and claiming teardown exactly once when two threads report a fatal error.
- Frontend: **36/36 isolated files passed**, including Linux onboarding,
  device selection (13 tests/21 assertions) and playback lifecycle (five
  tests/23 assertions).
  Linux Next production compilation, type validation and static export passed.
- Windows CPU library/test compilation passed with MSVC and LLVM 18. This was
  `cargo check`, not a Windows runtime or installer test. No macOS build ran.
- CPU **debug** DEB/AppImage packages passed payload verification: ELF binaries,
  resolved native dependencies on the build host, helper startup, FFmpeg, model
  resources/attribution, icons and desktop entries. Both opened in Xvfb with
  isolated HOME/XDG storage. The actual AppImage launcher in extract-and-run
  mode created its database under XDG data, outside its temporary extraction
  directory. Both packages used HOME/Documents for new recording preferences
  with XDG Documents unset. The DEB was extracted, not installed.
- Actual inference-library CMake caches confirmed `GGML_NATIVE`, `GGML_AVX2`
  and `GGML_FMA` OFF for the portable CPU build.
- Vulkan app and helper debug compilation passed; helper startup/EOF passed.
  Both inference-library caches confirmed Vulkan ON and host CPU tuning OFF.
  Vulkan DEB/AppImage payload and isolated startup/storage checks also passed,
  including the actual AppImage launcher. See below for inference on the
  release-profile binaries.

The updated **CPU and Vulkan release-profile** DEB and AppImage builds passed
payload, isolated launch/storage and checksum checks on WSL Ubuntu 26.04.
The Vulkan DEB declares `libvulkan1`, as required by the packaged executable.
The DEBs were extracted for testing rather than installed.

**Vulkan inference on an RTX 4070 Ti (12 GB).** WSL Ubuntu 26.04 exposed only
`llvmpipe` (CPU) by default. A test-local Mesa Dozen 26.0.8 driver selected
with `VK_DRIVER_FILES` exposed the physical card through D3D12; this driver is
not part of either artifact. Device and backend logs confirmed actual offload:

- Through the running app's `whisper_load_model` and `whisper_transcribe_audio`
  commands, the 11-second public `whisper.cpp` `samples/jfk.wav` clip produced
  the expected “ask not what your country can do for you” transcript. Large-v3
  took 1.49 s from the extracted DEB and 1.50 s from the actual extract-and-run
  AppImage, measured after model loading (single runs). Both identified the
  RTX, reported `using Vulkan backend` and allocated 3094.36 MB on `Vulkan0`.
  Whisper tiny also transcribed the clip from the DEB.
- The DEB's `llama-helper` generated a one-sentence summary from fictional
  meeting notes using Qwen3.5-4B-Q4_K_M. It preserved the owner, action, deadline
  and decision. llama.cpp identified the RTX on `Vulkan0`, reported **33/33
  layers offloaded** and allocated 2106.19 MiB of model buffers there.

This covers WSL's Vulkan-over-D3D12 path on one NVIDIA card; native Linux
drivers, AMD/Intel GPUs and the source-only CUDA/ROCm configurations need
separate runs. These transcription timings do not measure capture or compare
GPU performance to CPU performance.

The capture fixtures were generated tones on virtual sinks/remapped sources;
no private recordings were used. The public speech clip above was supplied
directly to inference, not through a microphone. The pending-Start and
simultaneous-failure regressions exercise the native ownership logic, not the
full desktop command flow. Frontend playback tests use mocked media objects
and do not establish WebKitGTK decoding/seeking on a physical desktop.

Unqualified: physical Linux microphone/PipeWire/Bluetooth, live speech retention,
native Linux GPU drivers, installed-upgrade preservation, and desktop end-to-end recording.
WSLg and virtual sinks do not establish those results. For Linux previews, use
the Ubuntu 24.04 candidate workflow's CPU/Vulkan artifacts from the tagged
source commit; each release's notes link to its build. The application version
is 0.2.23.

## Integration provenance

- Upstream [v0.5.0](https://github.com/Zackriya-Solutions/meetily/releases/tag/v0.5.0),
  commit `9e50dc245157de376b1a9a5b8dcd78a9cde3f2e6`: native Pulse capture,
  serialized enumeration, exact endpoint identities and readable labels.
  Related upstream work: #822, #874, #882, #904 and follow-ups
  `3755459c9e` / `70b829f37c`; packaging #834 / #893.
- ActuallyFree [#22](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/22),
  Michael Hlas (`mhlas7`) and Loïc Favory: native audio and lifecycle concerns,
  including bounded cleanup and serialized reconnect (`54926b3`), adapted to
  the fork's source-preserving mixer. The upstream v0.5.0 nonblocking Pulse
  client and exact IDs replace this PR's blocking Pulse Simple and ALSA fallback
  rather than adding a second capture path.
- Noah Passalacqua: [#61](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/61)
  CUDA archive discovery; [#62](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/62)
  Linux resources/icons/media packaging; [#63](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/63)
  binary-IPC/blob playback, adapted to meeting IDs and bounded reads;
  [#64](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/64) Linux
  source-build/runtime/storage documentation.
- mhlas7: [#66](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/66)
  user-selected CUDA architectures.
- Also reviewed mhlas7's `local-linux-improvements`, `dev`, and
  `fix/build-gpu-root-cd` branches. Adapted onboarding's Default choice and
  persistence (`ca663dc`, `f98f516`) and working-directory-independent source
  builds (`da98411`, `f3dfd94`). The branch's label-first lookup is not carried
  over: labels are for display, explicit capture opens by exact ID. The speaker
  edits, track-labeling and microphone bleed experiments are separate changes.

These are selective integrations, not claims that the pull requests were merged
or closed. Contributor claims are not substitutes for this branch's test results.

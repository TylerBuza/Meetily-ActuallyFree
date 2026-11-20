# Building ActuallyFree on Linux

The candidate baseline is x86_64 Ubuntu 24.04 with PulseAudio or PipeWire's
PulseAudio compatibility server (`pipewire-pulse`). DEB and AppImage are the
supported packaging targets in the candidate workflow. See
[LINUX_SUPPORT.md](LINUX_SUPPORT.md) for implementation, attribution and actual
qualification; this guide does not imply a published Linux release.

## Prerequisites

Use Rust 1.99.1, Node 24 and pnpm 11.9.0 (the candidate workflow versions).
Install Git LFS and retrieve the tracked diarization model resources:

```sh
git lfs install
git lfs pull
sudo apt-get update
sudo apt-get install -y build-essential cmake ninja-build pkg-config clang libclang-dev \
  libasound2-dev libpulse-dev libssl-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf \
  libvulkan-dev glslang-tools glslc pulseaudio-utils ffmpeg \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav
cd frontend
pnpm install --frozen-lockfile
cd ..
```

Run builds as your ordinary user. A Windows `node_modules` directory cannot be
reused by Linux: install Linux dependencies in a separate checkout/source copy.
Build-time downloads include FFmpeg and native inference dependencies.

## CPU and Vulkan candidates

```sh
export CMAKE_POLICY_VERSION_MINIMUM=3.5
bash frontend/scripts/build-linux.sh cpu
# Or, in a separate target directory:
CARGO_TARGET_DIR="$PWD/target-vulkan" bash frontend/scripts/build-linux.sh vulkan
```

An optional second argument `debug` makes a developer package. Default is
`release`. Both paths build llama-helper, build the frontend before the native
app, then verify the actual DEB and AppImage payloads. Output is under the Cargo
target directory's `<profile>/bundle/{deb,appimage}`. Keep each backend's outputs
separate; the payload verifier intentionally rejects ambiguous stale packages.
No signing, updater publication or version increment occurs.

For local development or source-only CUDA/ROCm experimentation:

```sh
cd frontend
TAURI_GPU_FEATURE=none bash dev-gpu.sh
# NVIDIA: requires a full CUDA SDK, including libcudart_static.a.
TAURI_GPU_FEATURE=cuda CMAKE_CUDA_ARCHITECTURES=86 bash build-gpu.sh
# AMD: requires a matching ROCm SDK/driver.
TAURI_GPU_FEATURE=hipblas ROCM_PATH=/opt/rocm bash build-gpu.sh
```

CUDA architectures are examples, not autodetected hardware qualification.
`CUDA_PATH`, `CUDA_HOME` or `CUDA_LIBRARY_PATH` can locate distro-installed SDK
archives. CUDA/ROCm source builds are not part of the CPU/Vulkan candidate matrix.
The source scripts preserve other targets' helper binaries and honor Cargo's
configured target directory.

## Runtime

The DEB declares PulseAudio client and GStreamer codec dependencies. The Vulkan
candidate also declares `libvulkan1`; install your GPU's Vulkan driver separately.
AppImage bundles the media framework but still needs a working desktop, graphics
driver and PulseAudio-compatible server. Capture does not require an ALSA
`.asoundrc` monitor alias. In containers/headless sessions, a server must be
supplied explicitly; missing servers are reported.

Use **System default** to follow route changes. Select an explicit device to
keep capture pinned to it. A stale or ambiguous saved caption asks for
reselection rather than recording a different device. In-app Linux playback
currently has a 256 MiB per-recording limit and reports that limit visibly.

Storage:

- App data/models/database: writable `<executable directory>/data`, otherwise
  `$XDG_DATA_HOME/Meetily`, usually `~/.local/share/Meetily`. AppImage always uses
  that OS data root, including extract-and-run mode.
- Tauri preferences: application data directory, normally
  `~/.local/share/com.meetily.ai`; some app-specific settings live in the data root.
- Audio: XDG Documents / `meetily-recordings`, or the folder selected in Settings.
  If XDG Documents is unset, new preferences use `~/Documents/meetily-recordings`.
  Existing saved folder preferences are retained.

Do not delete these directories when replacing binaries. This update does not
reset existing preferences, meetings, models or voice-profile opt-in.

## Synthetic capture tests

Install `pulseaudio`, `xauth`, `xvfb`, `x11-utils` and `dbus-x11` for the opt-in local/CI
qualification tools. Installing the test daemon is not a request to replace a
running PipeWire session.

```sh
bash frontend/scripts/test-linux-audio.sh
python3 frontend/scripts/verify-linux-package.py target/release/bundle --smoke
```

The test runner creates a private server/socket and synthetic tones. It never
changes the desktop server's default routes. These tests exercise lifecycle and
signal delivery, not physical-microphone quality, speech recognition accuracy,
Bluetooth stability or GPU inference.

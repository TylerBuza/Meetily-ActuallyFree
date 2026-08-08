# Architecture Notes

Practical notes on how this app fits together, aimed at someone (or some model)
opening the repo with no prior context. It deliberately focuses on the things
that are **not** obvious from reading the code — the traps, the "why is it like
this", and the places where a reasonable-looking change silently does nothing.

For build commands see [`frontend/build-cuda-env.bat`](frontend/build-cuda-env.bat).

---

## 1. Shape of the app

A Tauri 2 desktop app. Rust owns audio, transcription, storage and AI
orchestration; a Next.js 14 frontend renders the UI inside the webview. There is
no server — everything runs on the user's machine.

```
Next.js UI  ──invoke()──▶  Tauri commands (Rust)
     ▲                            │
     └──────── events ────────────┘      e.g. transcript-update,
                                          recording-audio-levels
```

The `backend/` directory in the upstream project (Python/FastAPI) is **not used**
and has been removed from this fork.

---

## 2. Audio pipeline

Capture → mix → VAD → transcription, in `src-tauri/src/audio/`.

```
mic  ─┐
      ├─▶ AudioPipeline ─┬─▶ recording file (mixed, saved to disk)
sys  ─┘                  └─▶ VAD ─▶ speech segments ─▶ transcription worker
```

### The mixed-audio trap ⚠️

By the time audio reaches transcription, mic and system audio have been **mixed
into one stream**. The `AudioChunk.device_type` on those chunks is a hard-coded
placeholder (`Microphone`) because no single device owns the samples.

This means **you cannot tell who is speaking from `device_type`**. An earlier
attempt at speaker labelling did exactly that and produced "You" for every
single line, including the other participants. Speaker identity comes from
diarization instead (§4).

### Live audio levels

`pipeline.rs` computes per-source RMS/peak *before* mixing and emits them as
`recording-audio-levels` events (~25/sec per source), which drive the meters in
`RecordingControls`. This is the only place the pre-mix mic/system distinction
survives.

Note: the webview **cannot** capture system audio itself, so browser-side
`getUserMedia` visualizers can only ever show the microphone. That is why the
levels come from Rust.

---

## 3. Where things are stored (portable design)

This fork is **portable**: everything it manages lives under the install
directory, not scattered across `%APPDATA%` / `~/Library`.

`src-tauri/src/paths.rs` is the single source of truth:

| What | Where |
|---|---|
| Database, templates, settings, models | `<exe dir>/data/…` |
| Bundled diarization models | `<exe dir>/resources/diarization/` |
| **Audio recordings** | `%USERPROFILE%\Music\meetily-recordings\<meeting>\audio.mp4` (mixed), plus `mic.mp4` / `system.mp4` source tracks |

Two gotchas:

1. **Recordings are the exception.** They follow the user's configured
   recordings folder (`audio/recording_preferences.rs`), *not* the data root,
   and they are **`.mp4`, not `.wav`**. New recordings retain aligned
   `audio.mp4` (mixed playback), `mic.mp4` (local user), and `system.mp4`
   (remote/computer audio). Code that looks for playback must prefer
   `audio.mp4` — see `diarization::find_meeting_audio`.
2. `paths.rs` falls back to the OS data dir if the install directory isn't
   writable (e.g. installed under Program Files).

A one-time migration (`paths::migrate_legacy_data`) copies data from the old
`%APPDATA%` location on first run so upgrading users keep their history.

---

## 4. Speaker diarization ("who spoke when")

Implemented from scratch on the ONNX Runtime already in the build (`ort`),
deliberately **not** by linking sherpa-onnx — that would pull in a second
onnxruntime and risk duplicate-symbol failures at link time.

`src-tauri/src/diarization/`:

| File | Role |
|---|---|
| `dsp.rs` | WAV reader + Kaldi-compatible 80-dim log-mel fbank (Povey window, pre-emphasis 0.97, HTK mel, per-utterance CMN) |
| `models.rs` | pyannote `segmentation-3.0` (7-class powerset) + WeSpeaker ResNet34 embeddings + VBx LDA transform; includes a minimal `.npz`/`.npy` reader |
| `clustering.rs` | Agglomerative clustering, cosine distance, average linkage |
| `mod.rs` | Offline pipeline + Tauri commands |
| `online.rs` | Streaming diarization for live transcription |
| `download.rs` | Repair-path model download from the project's own GitHub release |

### Offline pipeline

1. New recordings load `mic.mp4` and `system.mp4` independently. The mic track
   is deterministically the local user; only system audio is clustered into
   remote speakers. Older meetings fall back to mixed `audio.mp4` plus the
   enrolled user voiceprint. Decode/downmix/resample inputs to 16 kHz.
2. Slide a 10 s window; run segmentation; decode the powerset output into
   per-frame activity for up to 3 *local* speakers.
3. Embed each local speaker's audio in each window.
4. Cluster embeddings globally → *global* speaker identities.
5. Merge adjacent same-speaker regions.

The mic track updates `<data>/voiceprint/user_voiceprint.json`; live
diarization seeds the user centroid from that profile on later calls.
Overlapped speech remains excluded from embeddings, but overlap timing is
retained. Transcript rows can carry combined labels such as
`You + Speaker 1` rather than being forced to one voice.

Two non-obvious refinements, both from real failure cases:

- **Overlapped speech is excluded from embeddings.** Powerset segmentation
  assigns simultaneous frames to *every* active speaker; including them blends
  two voices into both embeddings.
- **Only turns ≥1.5 s may define a cluster.** Short fragments (usually speech
  clipped by a window edge) have noisy embeddings and used to spawn phantom
  speakers. They are still labelled, by nearest centroid.

### Calibration, and its limits

`DEFAULT_THRESHOLD = 0.60`, chosen by measurement against recordings with known
speaker counts, not by guess:

| Recording | Truth | Auto |
|---|---|---|
| Solo presenter | 1 | 1 ✅ |
| Team call | 5 | 5 ✅ |
| Panel | 6 | 8 |
| Interview | 3 | 2 |

**A single threshold cannot fit every recording** — how far apart two voices
land depends on mic, codec and room. The chosen value never invents speakers in
single-speaker audio, which is the worst failure mode. When the count is known,
passing `num_speakers` bypasses the threshold and resolved *every* test case
exactly; this is what the "Speakers" dialog asks for.

A silhouette-based automatic speaker-count search was tried and **removed** — it
consistently preferred the maximum candidate count and did worse than a fixed
threshold. Don't re-add it without evidence.

### Headless evaluation

Diarization can be evaluated without launching the GUI:

```bat
set DIARIZE_WAV=C:\path\to\audio.wav
set DIARIZE_MODELS=frontend\src-tauri\resources\diarization
build-cuda-env.bat test diarize_sample
```

Optional: `DIARIZE_SWEEP=0.55,0.60,0.65` (threshold sweep in one process),
`DIARIZE_SPEAKERS=4` (force count), `DIARIZE_DIAG=1` (embedding-distance
histogram — should be clearly bimodal if features are healthy).

Roughly 80× realtime on CPU.

---

## 5. Transcript rendering (frontend)

The most error-prone area in the codebase, because of duplicated components.

```
live screen        → app/_components/TranscriptPanel.tsx        ─┐
                                                                 ├─▶ VirtualizedTranscriptView
meeting details    → components/MeetingDetails/TranscriptPanel  ─┘
```

Two traps, both of which have bitten:

1. **Two components named `TranscriptPanel`.** Editing the wrong one compiles
   and does nothing visible.
2. **Three separate transcript→segment converters**, and every one must copy
   `speaker` or labels silently vanish on that screen:
   - `app/_components/TranscriptPanel.tsx` (live)
   - `components/MeetingDetails/TranscriptPanel.tsx` (non-paginated)
   - `hooks/usePaginatedTranscripts.ts` (paginated)

(A third, unrendered `components/TranscriptView.tsx` used to exist and caused
exactly this confusion; it has been deleted along with `SettingTabs.tsx`,
`CustomDialog.tsx` and the never-compiled `src-tauri/src/audio_v2/`.)

The label also has to survive the Rust side: `MeetingTranscript` must include
`speaker`, and every place constructing it must set it.

---

## 6. Model sources

No dependency on any third party's hosting:

| Model | Source |
|---|---|
| Whisper | HuggingFace (`ggerganov/whisper.cpp`) |
| Parakeet v2 | HuggingFace (`istupakov/…-v2-onnx`) |
| Parakeet v3 | This project's own GitHub release |
| Qwen / Gemma | HuggingFace (`unsloth`, `bartowski`) |
| Diarization | Bundled in the app (`resources/diarization/`) |

Parakeet v3 originally pointed at the upstream project's server; it was mirrored
so this fork doesn't consume someone else's bandwidth.

---

## 7. Building

`frontend/build-cuda-env.bat` sets up MSVC + LLVM + the reassembled CUDA toolkit
and has four modes:

| Mode | Purpose |
|---|---|
| `check` | Type-check only, no link — **safe while the app is running** |
| `lib` | Full build + stage bundled resources next to the exe |
| `test <name>` | Run a Rust test with output shown |
| `bundle` | Packaged installer |

Gotchas:

- A plain `cargo build` does **not** stage bundled resources the way Tauri's
  packaging does, so `lib` copies `resources/diarization` and `templates` next
  to the exe manually. Without this, `resource_dir()` finds nothing.
- The frontend is embedded at compile time. After changing frontend code you
  must rebuild the frontend *and* relink the exe.
- The exe cannot be relinked while it is running (LNK1104). Kill it first.
- Build with `--features cuda,custom-protocol`. Without `custom-protocol` the
  binary tries to load a dev server on localhost instead of the embedded UI.

---

## 8. Windows installer, onboarding, and updates

There are deliberately **two Windows installer executables** in each release.
They contain the same application, but they have different callers and must not
be substituted for one another:

| Release asset | Caller | Purpose |
|---|---|---|
| `*-universal-setup.exe` | A person downloading from GitHub | Native frameless Win32 bootstrapper with the branded first-install UI |
| `*-universal-updater.exe` + `.sig` | Tauri's updater plugin | Unmodified NSIS engine and the Tauri signature over those exact bytes |

`latest.json` always points at `*-universal-updater.exe`, never the bootstrapper.
The updater plugin expects an NSIS-compatible executable and verifies the exact
download against the adjacent signature. Embedding the NSIS engine in the
bootstrapper does not transfer that signature to the outer executable.

### Manual setup path

```text
build-universal-windows.ps1
  -> Tauri builds the universal NSIS engine
  -> build-installer-bootstrapper.ps1 embeds that engine as RCDATA
  -> user runs the frameless bootstrapper
  -> bootstrapper extracts + SHA-256 verifies the engine in %TEMP%
  -> engine runs silently and performs the real installation
  -> bootstrapper shows completion and launches meetily.exe
```

Relevant files:

| File | Responsibility |
|---|---|
| `frontend/src-tauri/installer-bootstrapper/bootstrapper.cpp` | Frameless `WS_POPUP` shell, custom close/minimize controls, folder selection, extraction, hash verification, process supervision, completion UI |
| `frontend/scripts/build-installer-bootstrapper.ps1` | Compiles the bootstrapper with MSVC `/MT`, embeds the finalized NSIS payload and its generated SHA-256 |
| `frontend/src-tauri/windows/installer.nsi` | Tauri NSIS template used as the actual install/update engine |
| `frontend/src-tauri/windows/installer-hooks.nsh` | Hardware backend detection, dependency checks, runtime staging, and selected-backend persistence |
| `frontend/scripts/build-universal-windows.ps1` | Builds CPU/Vulkan/CUDA variants, packages NSIS, builds the outer setup, signs updater bytes, and writes `latest.json`/checksums |

The bootstrapper shows byte-accurate determinate progress while extracting its
payload. During installation it reads the hidden NSIS progress control and
combines that with explicit phase-completion milestones under the temporary
`HKCU\Software\meetily\InstallerProgress\<token>` key. This gives a real percent
while still identifying runtime phases where NSIS itself is waiting on a child
installer. The key is unique per run and removed when the engine exits. Closing
is blocked once installation starts because externally terminating NSIS can
leave a partial installation. The wrapper also restores the previously
registered install path from `HKCU\Software\meetily\Meetily - Actually Free`
before offering the default.

Backend selection still belongs to `installer-hooks.nsh`; do not reimplement it
in the bootstrapper. The universal package stages three app executables and the
hook chooses CUDA, Vulkan, or CPU, then installs the chosen variant as the
canonical `meetily.exe`. In-app updates continue through the raw NSIS engine so
they retain Tauri's `/P /R /UPDATE /ARGS` behavior.

### Update-consent path

Update consent is an application preference, not an installer option:

```text
WelcomeStep.tsx
  -> invoke("set_check_updates_on_launch")
  -> src-tauri/src/lib.rs writes data/check-updates-on-launch.txt
  -> UpdateCheckProvider.tsx reads get_check_updates_on_launch on app startup
  -> updateService.ts / Tauri updater checks latest.json when enabled
```

The first app process has already started before the user answers onboarding,
so the preference takes effect on the next launch. A manual check remains
available from About. Setup must not write this preference or add the question
back to NSIS.

Onboarding itself is rendered by
`frontend/src/components/onboarding/OnboardingFlow.tsx`. The update choice is in
`steps/WelcomeStep.tsx`; the fork issue link is in `steps/SetupOverviewStep.tsx`
and uses the `open_external_url` Tauri command because browser-style
`target="_blank"` links are unreliable inside a desktop webview.

### Release rules

- Tauri updater signing and Windows Authenticode are separate. This fork's
  updater signature is required. Published builds are currently unsigned and
  must pass the explicit `-AllowUnsigned` build switch; Authenticode support
  remains available when `DIGICERT_KEYPAIR_ALIAS` is configured.
- Never modify `*-universal-updater.exe` after Tauri generates its `.sig`.
- The outer `setup.exe` has no Tauri `.sig`; `SHA256SUMS.txt` covers it for
  manual verification.
- Keep the updater private key and password under the ignored
  `.build-tools/updater/` directory. Losing them prevents compatible updates.
- `-PackageOnly` reuses staged CPU/Vulkan/CUDA binaries but still rebuilds NSIS,
  the bootstrapper, updater metadata, and checksums.
- `setup.exe --verify-payload` extracts and verifies the embedded engine without
  installing it; use this as a release smoke test.

### Branding assets

`frontend/src-tauri/icon-source.png` is the canonical high-resolution logo.
Tauri's icon generator produces the platform family under `src-tauri/icons/`.
Those generated files feed every native surface through these connections:

```text
icon-source.png
  -> icons/icon.ico  -> Windows app/taskbar + NSIS + bootstrapper executable
  -> icons/icon.png  -> native Windows notifications
  -> default app icon -> system tray (tray.rs)
  -> icons/icon.icns -> macOS bundle
  -> public/logo-collapsed.png + public/icon_*.png -> in-app/web assets
  -> src/app/favicon.ico -> Next.js favicon
```

`tauri.conf.json` and `build-installer-bootstrapper.ps1` both reference the
generated `icon.*` family. Do not introduce a second `app_icon.*` family: that
previous duplication allowed the tray/app and installer to silently use
different brands. The README intentionally renders `icon-source.png` from the
repository so GitHub uses the same canonical art.

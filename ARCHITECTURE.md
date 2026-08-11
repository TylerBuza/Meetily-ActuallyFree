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

Capture, recording, and transcription deliberately split into parallel paths in
`src-tauri/src/audio/`:

```
mic ─▶ normalize/limit ─┬─▶ mic VAD ─────▶ transcription worker
                       ├─▶ mic.mp4
                       └─┐
                         ├─▶ professional mix ─▶ audio.mp4 (playback)
sys ───────────────────┬─┘
                      ├─▶ system VAD ───▶ transcription worker
                      └─▶ system.mp4
```

### The mixed-audio trap ⚠️

Current live transcription receives **separate mic and system VAD segments**.
Mixing is only for `audio.mp4`, the user-facing playback track. Do not collapse
live STT back onto that mixed track: overlapping system speech can mask the
local user even when `mic.mp4` clearly contains their voice.

The old mixed-chunk `device_type = Microphone` placeholder can still appear in
legacy/import paths and must never be interpreted as speaker identity. Current
live source chunks preserve their actual capture source; final identity
refinement still comes from diarization (§4).

### Live audio levels

`pipeline.rs` computes per-source RMS/peak *before* mixing and emits them as
`recording-audio-levels` events (~25/sec per source), which drive the meters in
`RecordingControls`.

Mic and system speech use separate VAD instances. The mic path is intentionally
more permissive (`0.20/0.10`) than hot digital loopback (`0.50/0.35`). These mic
values were calibrated against the retained Logitech G733 track from the
"Vehicle Trade-In Discussion" failure: `0.42/0.30` and `0.30/0.20` found zero
speech, while `0.20/0.10` recovered 8 plausible segments / 16.9 seconds. Before
VAD, mic loudness normalization targets -20 LUFS, limits automatic gain to
0.5x-2.0x, smooths gain changes, and applies the user's gain before one final
-1 dB limiter. Do not move user gain after that limiter or restore unbounded
normalization; retained mic tracks showed hard 0 dBFS clipping under that design.

Note: the webview **cannot** capture system audio itself, so browser-side
`getUserMedia` visualizers can only ever show the microphone. That is why the
levels come from Rust.

### Live segmentation and shutdown invariants

- Live VAD redemption is 800 ms. Offline retranscription uses 2,000 ms because
  it has no live-latency constraint.
- Every window, including exact zero-filled padding, must handle the segments
  returned by `ContinuousVadProcessor`. Speech-end commonly arrives during the
  trailing silent window; discarding that return drops the whole utterance.
- Whisper's current `confidence` is text-length-derived, not a token
  probability. It is diagnostic and must not filter short valid phrases.
- During shutdown `RecordingManager` is temporarily outside its global slot.
  The transcript listener owns a cloned shared segment handle so final events
  remain writable until the worker finishes.
- Timed-out workers are aborted and awaited before listener removal and model
  unload. Dropping a Tokio `JoinHandle` only detaches it.
- Transcript-only sessions still write their final segment vector even when
  audio auto-save is disabled.

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
exactly. The post-call dialog therefore recommends an entered count, but offers
threshold-based **Auto-detect** when the user does not know it.

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

### Stable speaker colors

`VirtualizedTranscriptView.tsx` owns identity colors for both screens. `You` and
labels ending in `(You)` normalize to the same reserved blue, right-aligned user
identity. Blue is excluded from remote colors: Speaker 1 is purple, Speaker 2
emerald, followed by amber, pink, and cyan. Dot and text colors share one index
function, and normalized identity is also used when adjacent turns merge.

### Automatic post-call pipeline

`source=recording` transfers control to `PostCallProcessingDialog.tsx`:

```text
save live meeting and retained tracks
  -> ask for total speakers (exact count recommended; Auto-detect optional)
  -> retranscribe mic.mp4 and system.mp4 independently, unless skipped with X
  -> refetch replaced transcript rows
  -> diarize using the selected exact count or threshold-based Auto-detect
  -> refetch persisted labels
  -> summarize fresh SQLite transcript rows
```

Do not start automatic diarization without the user's explicit Auto-detect
choice, or generate a summary before this sequence. The count-prompt X skips
only retranscription: it keeps the live rows, still runs the selected exact or
automatic diarization, refetches labels, and then releases the summary gate.
Register retranscription listeners before invoking Rust,
filter events by meeting ID, and clean them once. Model fallback stays within the
configured local provider. Timeout cancellation waits for the native reservation
to clear before retry. Pre-diarization and post-diarization refresh failures are
distinct retry stages. Workflow refetch failures reject without replacing the
already-mounted page with its initial fatal-load screen.

Summary generation is gated by both the initial summary lookup and post-call
completion. It fetches all current rows directly from SQLite, not the paginated
React page. Both success-toast and delayed navigation paths must preserve
`source=recording`. Completed meeting IDs are recorded in `sessionStorage` to
prevent React remount duplication.

If audio saving was disabled or retained audio is unavailable, enhancement and
diarization are impossible. The error state offers **Use live transcript**, which
refetches the saved live rows, unblocks the sequence, and summarizes those rows
instead of trapping the user in a retry loop.

Summary prompts serialize every persisted transcript row with timestamp,
speaker label, and text. This is required for a regeneration after speaker
rename to actually expose the renamed identities to the model. Generated
meeting titles are written through `api_save_meeting_title` before meeting and
sidebar refetches; a local-only title is otherwise immediately replaced by the
stale database value. Meeting export owns content selection first (transcript,
summary, or both) and format selection second. It always fetches all transcript
rows from SQLite, and summary export must support markdown, BlockNote
`summary_json`, and legacy section representations.

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
  -> engine runs in passive mode with its stock window forced hidden
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
payload. During installation it launches NSIS with `/P` rather than `/S`, hides
the stock window before display, and reads its real progress control/current
operation text. It combines that with explicit phase-completion milestones
under the temporary
`HKCU\Software\meetily\InstallerProgress\<token>` key. This gives a real percent
while still identifying runtime phases where NSIS itself is waiting on a child
installer. For bundled files, `build-installer-bootstrapper.ps1` embeds the
ordered uncompressed file sizes; the wrapper combines NSIS's current-file
percentage with those sizes so large CUDA/runtime files advance smoothly rather
than jumping once per `File` command. Text uses GDI+ grayscale grid-fitted
antialiasing rather than GDI `DrawText`, and the
completion badge alone is supersampled before being composited into the normal
window buffer. Whole-window supersampling is unsafe because several GDI APIs
ignore world transforms and produce a quarter-size UI. Progress from NSIS,
milestones, and byte weighting is clamped monotonically because sources can
briefly report an older value during phase transitions. The key is unique per run and removed when
the engine exits. Closing
is blocked once installation starts because externally terminating NSIS can
leave a partial installation. The wrapper also restores the previously
registered install path from `HKCU\Software\meetily\Meetily - Actually Free`
before offering the default. Fresh installs default to
`%LOCALAPPDATA%\Meetily-ActuallyFree` (no spaces); do not derive the folder from
the display product name, which intentionally contains spaces.

Backend selection still belongs to `installer-hooks.nsh`; do not reimplement it
in the bootstrapper. The universal package stages three app executables and the
hook chooses CUDA, Vulkan, or CPU, then installs the chosen variant as the
canonical `meetily.exe`. In-app updates continue through the raw NSIS engine so
they retain Tauri's `/P /R /UPDATE /ARGS` behavior.

The raw engine detects `/UPDATE` before its install-files page is shown. Update
mode must use updater-specific chrome and language (`Meetily - Actually Free
Updater`, `Updating Meetily`, and `Updating app files`) rather than exposing the
setup wording. Keep the verbose NSIS extraction log collapsed, preserve the
stock MUI header font metrics so title/subtitle rectangles do not overlap at
scaled DPI, and show a monotonic overall percentage in the header. The update
progress color matches the blue native bootstrapper; setup-only pages and all
hardware/runtime decisions remain shared with the normal installer.
Every install/update rewrites uninstall-key `DisplayVersion`, then broadcasts a
shell/settings change notification. Without that notification, an Installed
Apps window left open during an update can continue showing the previous
version even though the registry and executable already contain the new one.

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
`target="_blank"` links are unreliable inside a desktop webview. On Windows that
command calls `ShellExecuteW` directly; do not regress it to `cmd /C start`,
which flashes a console and mishandles some URLs.

The main window has `center: true` in `tauri.conf.json` so first-run onboarding
opens on the center of the active display instead of inheriting Windows' default
top-left placement.

Model downloads are sequential: the required Parakeet transcription model owns
the connection until it reaches 100%, then the selected summary model starts.
The download step labels these as Step 1 and Step 2 and renders only the active
step's progress bar. After the user continues, active transfers appear as a
compact top-right indicator that expands on hover or keyboard focus; it must not
reserve space or shift later onboarding pages. Completion and errors use short
bottom-right Sonner notifications.

### Release rules

The updater is already "inside the app" from the user's perspective: the Tauri
plugin checks `latest.json`, downloads `*-universal-updater.exe`, verifies its
matching `.sig`, exits Meetily, and launches that payload to replace files that
the running process cannot overwrite. GitHub must expose the updater as a
release asset so installed clients can download it. Users manually launch only
`*-universal-setup.exe`; removing the updater asset breaks in-app updates.

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
  the bootstrapper, updater metadata, and checksums. Use it only for installer
  shell/template changes. Frontend, Rust, icon, or Tauri-command changes require
  a full universal build: the post-install hook replaces the freshly packaged
  placeholder with one of those staged variants, so stale variants silently
  install stale application code.
- `-BootstrapperOnly` is narrower: it re-embeds the existing universal updater
  engine, rebuilds only the native outer setup, and refreshes checksums. Use it
  only for `installer-bootstrapper/bootstrapper.cpp` presentation changes; it
  deliberately does not regenerate NSIS, application variants, or `latest.json`.
  It refuses to run unless the existing metadata version, URL, and signature
  match the updater engine.
- `tauri.updater.conf.json` deliberately clears `beforeBuildCommand`. The
  universal script builds Next.js once unless `-SkipFrontend` is passed; letting
  Tauri build it again changes the embedded assets and forces a redundant second
  CPU relink. The script also creates `universal.marker` before compiling any
  variants so that adding the resource later cannot invalidate the first CPU
  build. Do not restore the command in that overlay or move marker creation back
  below variant compilation.
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

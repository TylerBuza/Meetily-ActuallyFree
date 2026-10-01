# Nemotron background-download activation follow-up

The user reported having to select Nemotron manually after an optional setup
download. Read-back found the installed model and the manually saved Nemotron
selection; that alone did not prove automatic activation had succeeded.

The previous implementation downloaded in Rust, then saved the selection in a
separate JavaScript callback. Onboarding includes WebView reload actions, which
can discard that callback while the native download continues. This is a code
path vulnerability, not a confirmed reconstruction of the user's exact clicks.

`download_diarization_models` now saves the Nemotron selection itself after the
verified download succeeds, before returning success. It emits
`diarization-engine-changed` after the save. The optional-download provider,
Diarization Settings, and open speaker dialogs observe that event. Activation
save errors remain distinct from transfer errors. Pyannote downloads retain
their existing behavior. Version remains 0.2.17.

Six optional-provider tests and three engine-selection tests passed, including
provider remount, native activation error classification, and discarding stale
dialog lookups after a native activation event.

The production frontend and Windows CPU/Vulkan/CUDA builds passed. Release
payload verification passed, and the updated 0.2.17 was installed locally with
the installed executable matching the CUDA payload. A SQLite backup was taken;
the database file hash was unchanged across installation.

Installed-app IPC verification temporarily selected Pyannote, invoked the native
Nemotron download command with no JavaScript activation callback, and reloaded
the WebView. The command validated the already-installed pinned model and
automatically selected Nemotron. Both IPC read-back and `diarization_config.json`
confirmed Nemotron. This exercised the existing-model validation path rather
than a fresh network transfer. The app was then exited cleanly and reopened
without remote debugging. Installer remains
`dist/Meetily-ActuallyFree-0.2.17-x64-universal-setup.exe`.

## Background status panel follow-up (after v0.2.18)

The redesigned top-right `DownloadProgressToastProvider` subscribed only to
Parakeet and built-in summary-model events. Optional jobs continued downloading
but their progress appeared only in Settings/onboarding. The panel now also
reads `OptionalModelDownloadsContext.jobs`, using the same collapsible stack for
Whisper post-call transcription and Nemotron speaker identification. It consumes
existing app-owned state, so navigation and mounting the panel mid-download do
not start another transfer or lose optional progress. The dedicated onboarding
download step still owns its inline progress display.

Optional native events expose percentages, not transfer speed. Their background
cards show percentage and phase without fabricated size/speed figures. Nemotron
verification is identified explicitly. Final transfer events now keep app-owned
Whisper jobs and native Nemotron jobs in `activating` until the existing preference
save/engine-change/command completion settles. Success/error notifications and
retry ownership remain in the optional provider; the panel adds no duplicate
terminal notifications or activation calls.

`tests/download-progress/background.test.tsx` covers simultaneous primary and
optional downloads, navigation, panel mounting after progress, verification and
activation ordering, error/retry behavior, and restored native Whisper progress.
Optional-provider tests also cover uninstall, duplicate-operation rejection, and
failed-removal state recovery. Tests use mocked IPC, not network/model downloads.
Native downloads still require the app to remain open; Nemotron has no native
in-flight snapshot, so a remounted provider waits for its next progress event.

## Settings progress, activation, and uninstall

- `DiarizationSettings` uses the shared Nemotron job even if the download began
  in setup and Pyannote is still selected. The engine card shows overall percent,
  verification/enabling phase, and native **current-file** byte counts. Its
  download action now calls the shared owner. Cards use container-sized columns
  and wrapping badge rows rather than assuming two cards fit at a viewport
  breakpoint. Both Active badges were checked at 900, 1100, and 1440 px widths.
- `TranscriptSettings` shows the optional Whisper job in the post-call card and
  refreshes installed choices after completion/removal. Neither downloading nor
  enabling this optional model changes the live Parakeet preference.
- `whisper_download_model` accepts optional `enablePostCall`. With that flag it
  discovers an already installed model or finishes downloading, then saves the
  post-call preference **natively before returning success**. Save failure is an
  activation error; `post-call-transcript-config-changed` refreshes open settings.
  Generic/manual downloads retain their existing behavior without the flag.
- `optional_models.rs::uninstall_optional_model` owns disabling references and
  file removal, and emits `optional-model-removed` on success. Nemotron removal
  intentionally selects bundled Pyannote, deletes only its pinned ONNX/license
  files and partials, and leaves the shared model directory intact. Whisper
  removal resets only selections referencing the recommended optional model:
  post-call falls back to live, and an explicit live Whisper selection falls back
  to Parakeet. Other model selections and meeting data are untouched.
- Per-model native locks exclude downloads/activation/removal from each other.
  One optional Whisper activation may wait natively for a previously started
  manual transfer, with a one-hour wait limit; duplicate pending activation
  requests are rejected. A reload cannot discard the pending activation intent.
  Removal also takes the diarization operation and engine lifecycle locks and
  rejects an active recording/retranscription. A loaded optional Whisper model
  is unloaded before deletion. Disabling occurs first: if filesystem deletion
  fails, the UI re-reads native state and allows retry without claiming removal.
- The optional Settings menu exposes Uninstall only for installed models; setup
  retains Download & enable. Native change events refresh the active engine,
  post-call model, live configuration, and any open Whisper model manager.
  Whisper completion/error events mark native post-call ownership so other
  model-manager views update availability without changing the live selection
  or duplicating the optional owner's notifications.

Verification: frontend provider/panel/Settings tests cover progress that starts
elsewhere, completion activation, preserved live selection, and uninstall actions.
Native `optional_models` tests use temporary model-file fixtures and an in-memory
SQLite database to verify file boundaries, reference cleanup, idempotent Nemotron
removal, and operation exclusion. Browser preview uses simulated downloads and
uninstalls; no personal models or recordings were removed for qualification.

The final local checks passed: all 25 isolated frontend test files, production
Next build/type validation, and four targeted native CPU tests. Browser preview
confirmed both model progress cards, auto-selected settings, simulated removal,
and containment of both Active badges at the three widths above. These changes
are prepared for the next update; no new installer was installed or published.

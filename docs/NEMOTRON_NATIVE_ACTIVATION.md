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

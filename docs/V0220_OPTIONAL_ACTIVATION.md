# Enable recommended optional models after download

> Historical frontend-activation implementation. Nemotron activation was later
> moved into its native download task; see
> [NEMOTRON_NATIVE_ACTIVATION.md](NEMOTRON_NATIVE_ACTIVATION.md). The selected engine
> now also drives the live path described in [DEVELOPMENT_MAP.md](DEVELOPMENT_MAP.md).

Qualified locally as development build 0.2.20; included in the consolidated
0.2.17 candidate, one patch version after GitHub's latest release (0.2.16).

Both optional setup choices are marked Recommended and remain opt-in. A successful
Nemotron download enables the Nemotron engine for post-call Auto-detect. A
successful optional Whisper download saves `whisper / large-v3-turbo-q5_0` as the
post-call enhancement/retranscription default. Live transcription is not changed.

Activation is awaited only inside the app-owned background task, never by the
setup navigation. A failed download does not change preferences. A failed
preference save is shown as an activation error with a Retry activation action,
rather than reporting that the model is enabled. Already-installed models can be
enabled by the same opt-in controls. An existing native Whisper download is
observed until its completion event before enabling the model.

The main diarization settings downloader also activates Nemotron after success.
Open preference panels refresh following automatic activation, and the optional
download cards distinguish installed-but-disabled models from enabled ones.

Four background-provider tests cover deferred activation, model-specific persisted
settings, navigation/duplicate suppression, download failure, activation failure
and retry, and joining an already-running native Whisper download. No live-model
preference command is part of optional activation.

The local 0.2.20 build passed all four provider tests, production frontend build,
TypeScript, Windows CPU/Vulkan/CUDA builds, and installer payload verification.
The actual installed Settings controls were used to activate both previously
downloaded models; read-back confirmed Nemotron and Whisper post-call preferences,
with the live transcription preference unchanged. The app was reopened normally.

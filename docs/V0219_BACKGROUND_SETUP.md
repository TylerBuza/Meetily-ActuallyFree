# v0.2.19 — optional background setup downloads

Setup Overview offers opt-in Whisper Large v3 Turbo Q5 (~547 MB) and Nemotron-3
(~382 MB) downloads. Neither is selected by default, and downloading does not
silently change the live transcription model or diarization selection. After a
download completes, the user can choose the model in Settings.

`OptionalModelDownloadsProvider` lives above both onboarding and the main app.
Native download promises and progress subscriptions remain owned by that provider
when individual steps unmount or the user navigates to Settings. Duplicate clicks
are coalesced; failures leave the app usable and expose a Retry action. Whisper
downloads already running in the native engine are observed rather than restarted.
Available model status is rechecked when the provider mounts.

The same progress cards are shown in the setup download step and Settings. Users
must keep the app open for in-progress jobs. This does not introduce an OS-level
download service or promise automatic resume after quitting the app.

Parakeet no longer blocks moving past the setup download screen. Completion saves
the reported model-readiness flags rather than marking unfinished downloads as
installed. Existing native model-readiness checks continue to protect recording.

Verification: two provider tests cover navigation while both native requests are
pending, duplicate-start suppression, progress after leaving setup, completion,
and retry after failure. The existing 35 frontend tests, production build, and
TypeScript checks also passed. Mock-heavy test groups run in separate Bun
processes to avoid cross-suite module mock contamination.

Windows CPU/Vulkan/CUDA builds and final installer payload/signature checks passed.
The local installation was upgraded to 0.2.19 (installer exit code 0); its database
hash was unchanged before reopening, and the installed CUDA executable and
DirectML runtime matched the verified payload. Existing completed onboarding was
preserved. The application reopened successfully.

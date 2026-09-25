# v0.2.18 — download crash and engine selection

The 0.2.17 Windows crash reported while downloading Nemotron was an
`0xc00000fd` stack overflow. Matching local symbols resolved the exception to
`_alloca_probe`; stack candidate return addresses included Tauri's async IPC
spawn path. The stack probe requested `0xc3880` bytes. The diagnostic archive
itself only reported an unexpected exit; Windows events and the local dump
provided the additional evidence. Private dumps and application data are not
included in this repository.

The streaming SHA-256 helper had a 64 KiB inline array held across await points.
That array inflated its parent download futures and their IPC dispatch stack.
The buffer now uses a heap allocation, retaining bounded-memory streaming and
the same integrity checks. A regression test measures the actual generic
download-command future without launching a GUI: 1,656 bytes after the fix,
with a 32 KiB maximum budget. Another test verifies its checksum across multiple
buffer fills and asserts the hash helper's future remains below 4 KiB.

Nemotron is now Auto-detect-only in the post-call and manual speaker dialogs.
Manual counts remain available for Pyannote. Backend dispatch ignores stale
Nemotron count requests instead of silently changing engines. Dialogs refresh
the selected engine when opened, discard late responses from a previous opening,
and disable submission if settings cannot be read. Live labeling still uses
Pyannote; Nemotron refines labels after recording.

Validation: 16 reported targeted native passes (including the legacy diagnostic
which skips without external audio), two engine-selection hook tests, production
frontend build, and TypeScript. The opt-in real-model test remains separate from
the normal test count; DirectML qualification is documented in PR34_NEMOTRON.md.

All Windows variants and installer payload checks passed. The existing app was
upgraded to 0.2.18 with NSIS exit code 0 and unchanged database hash before launch.
The installed application's actual `download_diarization_models` IPC command
completed successfully for Nemotron; the resulting model matched the pinned
SHA-256 and status reported available. The app was then exited cleanly and reopened
without the temporary local WebView diagnostic port.

# Contributor and coding-agent orientation

Start with [docs/DEVELOPMENT_MAP.md](docs/DEVELOPMENT_MAP.md). It maps the recording,
transcription, speaker-labeling, model-download, and release paths to their owning
files. Feature qualification notes are linked there; read the relevant note before
changing that subsystem.

## Working conventions

- Inspect the current diff before editing; preserve unrelated local work.
- Keep explanations close to non-obvious code: ownership, timestamp units,
  concurrency, lifecycle ordering, and the reason for a constraint. Avoid comments
  that merely restate the next line.
- When changing behavior, update the architecture map or its linked feature note
  with the new data flow, affected interfaces, test coverage, and remaining limits.
- Distinguish implemented, tested, installed locally, and published. A local build
  or installer is not a GitHub release. Check the latest published version before
  choosing a release number; do not increment it for every development rebuild.
- Do not infer identity from a model's speaker number. Preserve microphone/source
  provenance and transcript text/timestamps when changing speaker labels.
- Keep capture nonblocking. Heavy inference belongs on a worker; queues, model
  state, and shutdown behavior need explicit owners and bounded behavior.
- Do not silently substitute another diarization engine after a selected-engine
  failure. Report the failure and retain source labels where appropriate.
- Keep optional-model activation tied to successful completion. Native operations
  can outlive the WebView that invoked them; a JS promise alone is not durable
  ownership of an operation's required native side effects.

## Verification pointers

- Run targeted frontend/native tests for the affected behavior. Mock-heavy Bun
  groups must run as separate invocations; see the map for known groups.
- Serialize Next production builds with native builds/tests embedding
  `frontend/out`. Do not run standalone TypeScript checking during a Next build.
- Windows release packaging is owned by
  `frontend/scripts/build-universal-windows.ps1`; verify the resulting payload with
  `node frontend/scripts/verify-windows-release.mjs`.
- Model/audio-dependent tests are explicitly ignored by default. Report whether
  they actually ran, which type of fixture was used, and what they establish.
- Never commit private recordings, databases, model binaries, crash dumps, local
  signing keys, or diagnostic artifacts. `.build-tools/` contains local helpers,
  not a portable or authoritative public test environment.

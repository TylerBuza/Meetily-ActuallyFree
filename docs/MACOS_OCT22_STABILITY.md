# October 22 macOS stability integration

## Scope and ownership

- #56: portable built-in microphone classification and Ogg fixture generation.
- #46: disable Core Audio tap auto-start so startup silence yields callbacks.
  The stream's five-second inactivity path emits one warning per stall and keeps
  microphone capture running. Arrival resumes the existing tap; stream end and
  sample-rate changes remain terminal. Both recording start commands install the
  warning callback; state cleanup releases it. No engine substitution is added.
- #53: pure recording-start error formatter handles strings, Error instances,
  serialized errors, and backend-specific unknown failures.
- #47: runtime-resolved read-only private TCC query distinguishes authorization
  from audible capture. A two-second short-lived same-binary query avoids TCC's
  per-process cache; it exits before app/logging startup. Missing API falls back
  to the existing audible probe. We additionally recheck cached grants and ensure
  an explicit denial invalidates session proof. No permissions are auto-granted.
- #42's separate live Nemotron error: mel transpose now explicitly produces
  standard contiguous `(batch, time, features)` storage before ORT receives a
  borrowed tensor. `ndarray::to_owned()` alone preserves transposed strides.
  A synthetic regression verifies the old layout, shorter live windows, and every
  feature's time/band ordering. This changes layout, not signal values or labels.

Contributor commits retain their authorship. #50's app identity/storage migration,
#52's per-app redesign, and the larger capture/echo/deletion PRs are not included.
Data paths, database migrations, saved recording formats, and model activation
contracts are unchanged. Windows release publication remains on hold.

## Qualification

- 34 isolated frontend test files passed after integration, including permission
  revocation and recording-error coverage.
- Candidate CI now runs the complete native library suite serially, then checks
  the packaged permission-helper entry point with a five-second timeout.
- Release version is 0.2.22, selected after checking published v0.2.21-macos.
  A build is not publication; completed CI/publication results will be recorded.
- Contributor physical tests are reported in #46/#47; they are not independent
  tests on the original reporter's Mac. This host is Windows. Physical Mac capture,
  Bluetooth/multi-output routing, macOS 14.2 runtime behavior, and real-model live
  Nemotron accuracy require separate confirmation. No private fixtures are added.
